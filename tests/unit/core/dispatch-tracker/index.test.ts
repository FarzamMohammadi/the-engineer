import { describe, expect, it, vi } from "vitest";

import { createDispatchTracker } from "../../../../src/core/dispatch-tracker/index.js";
import type { IObserver } from "../../../../src/core/observer/index.js";
import type { ExecuteTaskResult } from "../../../../src/core/orchestrator/types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeObserver(): IObserver {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as IObserver;
}

function defer<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeCompletedResult(): ExecuteTaskResult {
  return { outcome: "completed", phaseOutputs: new Map() };
}

// ── register + natural completion ───────────────────────────────────────────

describe("DispatchTracker.register", () => {
  it("runs the dispatch and invokes onCompleted with the runner's result", async () => {
    const tracker = createDispatchTracker({ observer: makeObserver() });
    const onCompleted = vi.fn();
    const onError = vi.fn();

    const settled = defer<ExecuteTaskResult>();
    tracker.register("task-1", () => settled.promise, { onCompleted, onError });

    expect(tracker.isInFlight("task-1")).toBe(true);
    expect(tracker.getActiveCount()).toBe(1);

    settled.resolve(makeCompletedResult());
    await new Promise((r) => setImmediate(r));

    expect(onCompleted).toHaveBeenCalledWith("task-1", { outcome: "completed", phaseOutputs: new Map() });
    expect(onError).not.toHaveBeenCalled();
    expect(tracker.isInFlight("task-1")).toBe(false);
  });

  it("forwards thrown errors to onError when no termination was requested", async () => {
    const tracker = createDispatchTracker({ observer: makeObserver() });
    const onCompleted = vi.fn();
    const onError = vi.fn();

    const failure = new Error("boom");
    tracker.register("task-1", () => Promise.reject(failure), { onCompleted, onError });
    await new Promise((r) => setImmediate(r));

    expect(onError).toHaveBeenCalledWith("task-1", failure);
    expect(onCompleted).not.toHaveBeenCalled();
    expect(tracker.isInFlight("task-1")).toBe(false);
  });

  it("throws when a second dispatch is registered for the same task while the first is in flight", () => {
    const tracker = createDispatchTracker({ observer: makeObserver() });
    tracker.register("task-1", () => defer<ExecuteTaskResult>().promise, {
      onCompleted: vi.fn(),
      onError: vi.fn(),
    });

    expect(() =>
      tracker.register("task-1", () => Promise.resolve(makeCompletedResult()), {
        onCompleted: vi.fn(),
        onError: vi.fn(),
      }),
    ).toThrow(/in-flight dispatch/);
  });
});

// ── terminate ─────────────────────────────────────────────────────────────────

describe("DispatchTracker.terminate", () => {
  it("aborts the signal and routes the late callback through Outcomes.terminated", async () => {
    const tracker = createDispatchTracker({ observer: makeObserver() });
    const onCompleted = vi.fn();

    const signals: AbortSignal[] = [];
    const settled = defer<ExecuteTaskResult>();
    tracker.register(
      "task-1",
      (signal) => {
        signals.push(signal);
        return settled.promise;
      },
      { onCompleted, onError: vi.fn() },
    );

    tracker.terminate("task-1", "preemption_timeout");

    expect(signals[0]?.aborted).toBe(true);
    expect(tracker.isInFlight("task-1")).toBe(true);

    // The runner eventually settles (best-effort — Slice 8 makes this fast)
    settled.resolve(makeCompletedResult());
    await new Promise((r) => setImmediate(r));

    expect(onCompleted).toHaveBeenCalledWith("task-1", {
      outcome: "terminated",
      reason: "preemption_timeout",
      lastPhase: null,
      checkpointId: null,
    });
    expect(tracker.isInFlight("task-1")).toBe(false);
  });

  it("routes a runner error after termination as Outcomes.terminated (termination wins)", async () => {
    const tracker = createDispatchTracker({ observer: makeObserver() });
    const onCompleted = vi.fn();
    const onError = vi.fn();

    const settled = defer<ExecuteTaskResult>();
    tracker.register("task-1", () => settled.promise, { onCompleted, onError });

    tracker.terminate("task-1", "cost_limit_reached");
    settled.reject(new Error("abort propagated as error"));
    await new Promise((r) => setImmediate(r));

    expect(onCompleted).toHaveBeenCalledWith("task-1", {
      outcome: "terminated",
      reason: "cost_limit_reached",
      lastPhase: null,
      checkpointId: null,
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it("is a no-op when no dispatch is in flight for the task", () => {
    const tracker = createDispatchTracker({ observer: makeObserver() });
    expect(() => tracker.terminate("unknown", "hard_cap_exceeded")).not.toThrow();
  });

  it("keeps the first reason when called twice", async () => {
    const tracker = createDispatchTracker({ observer: makeObserver() });
    const onCompleted = vi.fn();

    const settled = defer<ExecuteTaskResult>();
    tracker.register("task-1", () => settled.promise, { onCompleted, onError: vi.fn() });

    tracker.terminate("task-1", "preemption_timeout");
    tracker.terminate("task-1", "graceful_shutdown");

    settled.resolve(makeCompletedResult());
    await new Promise((r) => setImmediate(r));

    expect(onCompleted).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({ outcome: "terminated", reason: "preemption_timeout" }),
    );
  });
});

// ── idempotent late callbacks ────────────────────────────────────────────────

describe("DispatchTracker identity", () => {
  it("ignores a late callback for an old dispatch after a re-register", async () => {
    const tracker = createDispatchTracker({ observer: makeObserver() });
    const firstOnCompleted = vi.fn();
    const secondOnCompleted = vi.fn();

    const first = defer<ExecuteTaskResult>();
    tracker.register("task-1", () => first.promise, {
      onCompleted: firstOnCompleted,
      onError: vi.fn(),
    });

    // Terminate the first dispatch. Late callback hasn't fired yet — its dispatchId is now stale.
    tracker.terminate("task-1", "preemption_timeout");

    // Force the entry out so a new dispatch can take its place. In production the
    // late callback of the terminated dispatch deletes the entry; we trigger that
    // explicitly here by letting it settle.
    first.resolve(makeCompletedResult());
    await new Promise((r) => setImmediate(r));
    expect(tracker.isInFlight("task-1")).toBe(false);

    // Re-register for the same task — new dispatchId.
    const second = defer<ExecuteTaskResult>();
    tracker.register("task-1", () => second.promise, {
      onCompleted: secondOnCompleted,
      onError: vi.fn(),
    });

    // First callback already fired; new dispatch still in flight.
    expect(firstOnCompleted).toHaveBeenCalledTimes(1);
    expect(secondOnCompleted).not.toHaveBeenCalled();
    expect(tracker.isInFlight("task-1")).toBe(true);

    second.resolve(makeCompletedResult());
    await new Promise((r) => setImmediate(r));

    expect(secondOnCompleted).toHaveBeenCalledTimes(1);
    expect(secondOnCompleted).toHaveBeenCalledWith("task-1", { outcome: "completed", phaseOutputs: new Map() });
  });
});

// ── drain ────────────────────────────────────────────────────────────────────

describe("DispatchTracker.drain", () => {
  it("returns immediately when no dispatches are in flight", async () => {
    const tracker = createDispatchTracker({ observer: makeObserver() });
    await expect(tracker.drain(1_000)).resolves.toBeUndefined();
  });

  it("aborts and waits for cooperating dispatches", async () => {
    const tracker = createDispatchTracker({ observer: makeObserver() });
    const onCompleted = vi.fn();

    const signals: AbortSignal[] = [];
    const deferred = [defer<ExecuteTaskResult>(), defer<ExecuteTaskResult>()];
    tracker.register(
      "task-1",
      (signal) => {
        signals.push(signal);
        return deferred[0]!.promise;
      },
      { onCompleted, onError: vi.fn() },
    );
    tracker.register(
      "task-2",
      (signal) => {
        signals.push(signal);
        return deferred[1]!.promise;
      },
      { onCompleted, onError: vi.fn() },
    );

    const drainPromise = tracker.drain(1_000);
    // Both signals abort immediately, even before drain awaits.
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(true);

    // Cooperating dispatches settle on abort.
    deferred[0]!.resolve(makeCompletedResult());
    deferred[1]!.resolve(makeCompletedResult());
    await drainPromise;

    expect(onCompleted).toHaveBeenCalledTimes(2);
    expect(onCompleted.mock.calls.every(([, result]) => result.outcome === "terminated")).toBe(true);
    expect(onCompleted.mock.calls.every(([, result]) => result.reason === "graceful_shutdown")).toBe(true);
  });

  it("returns within a SHARED timeout when dispatches refuse to settle (worst-case = timeoutMs, not timeoutMs × N) and synthesizes callbacks for stragglers", async () => {
    const tracker = createDispatchTracker({ observer: makeObserver() });
    const NUM_STUCK = 5;
    const completedCallbacks: Array<ReturnType<typeof vi.fn>> = [];
    for (let i = 0; i < NUM_STUCK; i++) {
      const onCompleted = vi.fn();
      completedCallbacks.push(onCompleted);
      tracker.register(`task-${i}`, () => defer<ExecuteTaskResult>().promise, { onCompleted, onError: vi.fn() });
    }

    const start = Date.now();
    await tracker.drain(100);
    const elapsed = Date.now() - start;

    // With per-task multiplication this would be >= 500ms. With a shared timeout
    // it must return inside one timeout window plus a small scheduling buffer.
    expect(elapsed).toBeLessThan(300);
    // Every straggler gets a synthesized terminated/graceful_shutdown callback so
    // the scheduler can re-queue them — the daemon must still shut down cleanly.
    expect(tracker.getActiveCount()).toBe(0);
    for (const onCompleted of completedCallbacks) {
      expect(onCompleted).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ outcome: "terminated", reason: "graceful_shutdown" }),
      );
    }
  });

  it("preserves a termination reason set before drain — drain does not overwrite it", async () => {
    const tracker = createDispatchTracker({ observer: makeObserver() });
    const onCompleted = vi.fn();

    const settled = defer<ExecuteTaskResult>();
    tracker.register("task-1", () => settled.promise, { onCompleted, onError: vi.fn() });

    tracker.terminate("task-1", "hard_cap_exceeded");
    const drainPromise = tracker.drain(1_000);
    settled.resolve(makeCompletedResult());
    await drainPromise;

    expect(onCompleted).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({ outcome: "terminated", reason: "hard_cap_exceeded" }),
    );
  });
});
