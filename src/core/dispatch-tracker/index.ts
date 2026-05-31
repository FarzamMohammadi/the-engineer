import { ulid } from "ulid";
import { sanitizeErrorMessage } from "../../utils/sanitize.js";
import type { IObserver } from "../observer/index.js";
import type { ExecuteTaskResult, TerminationReason } from "../orchestrator/types.js";

// ── Types ──────────────────────────────────────────────────────────────────

/** Callbacks invoked when a dispatch settles. Mirrors today's scheduler callbacks. */
export interface DispatchCallbacks {
  onCompleted(taskId: string, result: ExecuteTaskResult): void;
  onError(taskId: string, error: unknown): void;
}

/** A function that runs the dispatch and reports its outcome; receives the signal so the work can honor abort. */
export type DispatchRunner = (signal: AbortSignal) => Promise<ExecuteTaskResult>;

/**
 * The single primitive for in-flight dispatch lifecycle:
 *
 * - Owns one `AbortController` per dispatch, exposing its `signal` to the runner.
 * - Mints a per-dispatch `dispatchId` so a late callback for an *old* dispatch
 *   cannot clobber a *new* dispatch for the same task — late callbacks no-op
 *   when the live entry's identity has moved on.
 * - `terminate(taskId, reason)` is the single force-end path. It records the
 *   reason and aborts the signal. When the late callback eventually fires,
 *   it returns an `Outcomes.terminated` result carrying the reason — the
 *   scheduler routes it to `queued` / `failed` / `blocked` from there.
 * - `drain(timeoutMs)` is the single shutdown path. Aborts every signal in
 *   parallel and waits up to one *shared* timeout for them all to settle.
 *   Stragglers still in flight after the timeout are marked
 *   `graceful_shutdown` so their late callback routes to `queued`.
 */
export interface DispatchTracker {
  /** Register and immediately start a dispatch for `taskId`. Returns the per-dispatch id. */
  register(taskId: string, run: DispatchRunner, callbacks: DispatchCallbacks): string;
  /** Force-end the in-flight dispatch for `taskId`. No-op if none is in flight. */
  terminate(taskId: string, reason: TerminationReason): void;
  /** Whether a dispatch is currently in flight for `taskId`. */
  isInFlight(taskId: string): boolean;
  /** Number of in-flight dispatches. */
  getActiveCount(): number;
  /** All in-flight task ids. */
  getActiveTaskIds(): string[];
  /**
   * Abort all in-flight dispatches and wait up to one shared `timeoutMs` for them
   * all to settle. Returns when every dispatch has either settled or been marked
   * `graceful_shutdown` for the late-callback path to handle.
   */
  drain(timeoutMs: number): Promise<void>;
}

// ── Factory ────────────────────────────────────────────────────────────────

interface Entry {
  readonly dispatchId: string;
  readonly controller: AbortController;
  readonly promise: Promise<void>;
  readonly callbacks: DispatchCallbacks;
  /** Set by `terminate` (or by `drain`). The late callback reads this and emits `Outcomes.terminated`. */
  terminationReason: TerminationReason | null;
}

interface DispatchTrackerDeps {
  readonly observer: IObserver;
}

/** Create the dispatch-tracker — single owner of in-flight dispatch lifecycle. */
export function createDispatchTracker(deps: DispatchTrackerDeps): DispatchTracker {
  const { observer } = deps;
  const entries = new Map<string, Entry>();

  function register(taskId: string, run: DispatchRunner, callbacks: DispatchCallbacks): string {
    if (entries.has(taskId)) {
      // Calling register while a dispatch is already in flight is a scheduler bug:
      // it means two dispatches were issued for the same task without the first
      // one settling. Fail loud so the call site is forced to fix it.
      throw new Error(`Cannot register dispatch — task "${taskId}" already has an in-flight dispatch`);
    }

    const dispatchId = ulid();
    const controller = new AbortController();

    const settle = run(controller.signal).then(
      (result) => {
        const entry = entries.get(taskId);
        if (!entry || entry.dispatchId !== dispatchId) {
          // The live entry was replaced (terminated then re-registered) — the
          // new dispatch owns this taskId now, so this late callback no-ops.
          observer.debug("Late dispatch result ignored — dispatch identity superseded", {
            taskId,
            staleDispatchId: dispatchId,
          });
          return;
        }
        entries.delete(taskId);
        const finalResult = entry.terminationReason ? buildTerminatedResult(result, entry.terminationReason) : result;
        try {
          callbacks.onCompleted(taskId, finalResult);
        } catch (callbackError) {
          observer.error("Dispatch onCompleted callback threw", {
            taskId,
            error: sanitizeErrorMessage(callbackError),
          });
        }
      },
      (error) => {
        const entry = entries.get(taskId);
        if (!entry || entry.dispatchId !== dispatchId) {
          observer.debug("Late dispatch error ignored — dispatch identity superseded", {
            taskId,
            staleDispatchId: dispatchId,
          });
          return;
        }
        entries.delete(taskId);
        if (entry.terminationReason) {
          // The dispatch was force-terminated and *then* the runner threw. Treat the
          // termination as authoritative: emit Outcomes.terminated with the recorded
          // reason. The runner's error becomes a debug breadcrumb, not the disposition.
          observer.debug("Dispatch error preempted by termination — routing as terminated", {
            taskId,
            reason: entry.terminationReason,
            runnerError: sanitizeErrorMessage(error),
          });
          const synthetic: ExecuteTaskResult = {
            outcome: "terminated",
            reason: entry.terminationReason,
            lastPhase: null,
            checkpointId: null,
          };
          try {
            callbacks.onCompleted(taskId, synthetic);
          } catch (callbackError) {
            observer.error("Dispatch onCompleted callback threw (post-termination)", {
              taskId,
              error: sanitizeErrorMessage(callbackError),
            });
          }
          return;
        }
        try {
          callbacks.onError(taskId, error);
        } catch (callbackError) {
          observer.error("Dispatch onError callback threw", {
            taskId,
            error: sanitizeErrorMessage(callbackError),
          });
        }
      },
    );

    entries.set(taskId, {
      dispatchId,
      controller,
      promise: settle,
      callbacks,
      terminationReason: null,
    });

    return dispatchId;
  }

  function terminate(taskId: string, reason: TerminationReason): void {
    const entry = entries.get(taskId);
    if (!entry) {
      observer.debug("Terminate called for unknown dispatch — no-op", { taskId, reason });
      return;
    }
    if (entry.terminationReason) {
      observer.debug("Terminate called twice — keeping first reason", {
        taskId,
        firstReason: entry.terminationReason,
        ignoredReason: reason,
      });
      return;
    }
    entry.terminationReason = reason;
    observer.info("Dispatch termination requested", { taskId, reason });
    entry.controller.abort();
  }

  function isInFlight(taskId: string): boolean {
    return entries.has(taskId);
  }

  function getActiveCount(): number {
    return entries.size;
  }

  function getActiveTaskIds(): string[] {
    return [...entries.keys()];
  }

  async function drain(timeoutMs: number): Promise<void> {
    if (entries.size === 0) {
      return;
    }

    // Snapshot before aborting — the late callbacks delete from `entries`
    // as they fire, and we want a stable view.
    const snapshot = [...entries.values()];
    observer.info("Draining dispatches", { count: snapshot.length, timeoutMs });

    // Mark every entry that isn't already terminated as graceful_shutdown, then
    // abort. The late callback path will route them through Outcomes.terminated
    // if they actually settle in time.
    for (const entry of snapshot) {
      if (!entry.terminationReason) {
        entry.terminationReason = "graceful_shutdown";
        entry.controller.abort();
      }
    }

    // ONE shared timeout across all dispatches — worst-case drain is `timeoutMs`,
    // not `timeoutMs × snapshot.length`.
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const settled = Promise.allSettled(snapshot.map((e) => e.promise));
    const timeout = new Promise<"timeout">((resolve) => {
      timeoutHandle = setTimeout(() => resolve("timeout"), timeoutMs);
    });

    try {
      const outcome = await Promise.race([settled.then(() => "settled" as const), timeout]);
      if (outcome === "timeout") {
        synthesizeStragglerCallbacks(timeoutMs);
      } else {
        observer.info("Drain completed — all dispatches settled");
      }
    } finally {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  /** Flush entries that outlived the drain timeout by synthesizing Outcomes.terminated callbacks. */
  function synthesizeStragglerCallbacks(timeoutMs: number): void {
    const stragglers = [...entries.entries()];
    observer.warn("Drain timeout — synthesizing late callbacks for stragglers", {
      stillInFlight: stragglers.length,
      timeoutMs,
    });
    for (const [taskId, entry] of stragglers) {
      entries.delete(taskId);
      const synthetic: ExecuteTaskResult = {
        outcome: "terminated",
        reason: entry.terminationReason ?? "graceful_shutdown",
        lastPhase: null,
        checkpointId: null,
      };
      try {
        entry.callbacks.onCompleted(taskId, synthetic);
      } catch (callbackError) {
        observer.error("Synthesized drain onCompleted callback threw", {
          taskId,
          error: sanitizeErrorMessage(callbackError),
        });
      }
    }
  }

  return { register, terminate, isInFlight, getActiveCount, getActiveTaskIds, drain };
}

// ── Pure Helpers ───────────────────────────────────────────────────────────

/**
 * When a dispatch settles after being terminated, the recorded termination reason
 * is authoritative — preserve any phase/checkpoint context from the natural result
 * so the recovery path can resume.
 */
function buildTerminatedResult(natural: ExecuteTaskResult, reason: TerminationReason): ExecuteTaskResult {
  if (natural.outcome === "terminated") {
    // A dispatch that itself surfaced as terminated keeps that shape; trust the reason
    // recorded by `terminate()` — that request is the one that won.
    return { ...natural, reason };
  }
  const lastPhase = "phase" in natural ? natural.phase : null;
  return {
    outcome: "terminated",
    reason,
    lastPhase: lastPhase ?? null,
    checkpointId: null,
  };
}
