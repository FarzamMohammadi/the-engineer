import { describe, expect, it, vi } from "vitest";

import type { ITaskEngine } from "../../../../src/core/interfaces/task-engine.interface.js";
import type { IObserver } from "../../../../src/core/observer/index.js";
import { computeBackoffMs, createRetryPolicy } from "../../../../src/core/retry-policy/index.js";
import type { DaemonConfig } from "../../../../src/schemas/config.js";
import type { Task } from "../../../../src/schemas/task.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeConfig(overrides?: Partial<DaemonConfig["retry_policy"]>): Pick<DaemonConfig, "retry_policy"> {
  return {
    retry_policy: {
      crash: { backoff_minutes: [1, 5, 15, 30, 30], max_attempts: 5 },
      llm_unavailable: { backoff_minutes: [2, 5, 10, 15, 15], max_attempts: 5 },
      ...overrides,
    },
  };
}

function makeTaskEngine(taskOverrides?: Partial<Task>): ITaskEngine {
  return {
    getTask: vi.fn().mockReturnValue({
      id: "task-1",
      consecutive_crash_count: 0,
      consecutive_llm_unavailable_count: 0,
      ...taskOverrides,
    }),
    updateTaskField: vi.fn(),
  } as unknown as ITaskEngine;
}

function makeObserver(): IObserver {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as IObserver;
}

function makeClock(now = 1_000_000_000): { now: () => number } {
  return { now: () => now };
}

// ── computeBackoffMs (pure function) ────────────────────────────────────────

describe("computeBackoffMs", () => {
  const schedule = [1, 5, 15, 30, 30];

  it("returns first schedule entry for count 1", () => {
    expect(computeBackoffMs(1, schedule)).toBe(1 * 60_000);
  });

  it("returns correct entry for count 3", () => {
    expect(computeBackoffMs(3, schedule)).toBe(15 * 60_000);
  });

  it("clamps at the last schedule entry for count beyond length", () => {
    expect(computeBackoffMs(10, schedule)).toBe(30 * 60_000);
  });

  it("uses the last entry for count equal to length", () => {
    expect(computeBackoffMs(5, schedule)).toBe(30 * 60_000);
  });
});

// ── RetryPolicy ─────────────────────────────────────────────────────────────

describe("RetryPolicy", () => {
  describe("recordFailure", () => {
    it("increments crash counter and sets not_before on first failure", () => {
      const taskEngine = makeTaskEngine({ consecutive_crash_count: 0 });
      const clock = makeClock(1_000_000_000);
      const policy = createRetryPolicy({ config: makeConfig(), taskEngine, clock, observer: makeObserver() });

      const result = policy.recordFailure("crash", "task-1");

      expect(result.disposition).toBe("retry");
      expect(result.count).toBe(1);
      expect(taskEngine.updateTaskField).toHaveBeenCalledWith("task-1", "consecutive_crash_count", 1);
      expect(taskEngine.updateTaskField).toHaveBeenCalledWith("task-1", "not_before", expect.any(String));
    });

    it("increments llm_unavailable counter and sets not_before", () => {
      const taskEngine = makeTaskEngine({ consecutive_llm_unavailable_count: 0 });
      const policy = createRetryPolicy({
        config: makeConfig(),
        taskEngine,
        clock: makeClock(),
        observer: makeObserver(),
      });

      const result = policy.recordFailure("llm_unavailable", "task-1");

      expect(result.disposition).toBe("retry");
      expect(result.count).toBe(1);
      expect(taskEngine.updateTaskField).toHaveBeenCalledWith("task-1", "consecutive_llm_unavailable_count", 1);
    });

    it("returns terminal disposition when crash budget exhausted", () => {
      const taskEngine = makeTaskEngine({ consecutive_crash_count: 4 });
      const policy = createRetryPolicy({
        config: makeConfig(),
        taskEngine,
        clock: makeClock(),
        observer: makeObserver(),
      });

      const result = policy.recordFailure("crash", "task-1");

      expect(result).toEqual({ disposition: "terminal", state: "failed", count: 5 });
      expect(taskEngine.updateTaskField).toHaveBeenCalledWith("task-1", "consecutive_crash_count", 5);
      expect(taskEngine.updateTaskField).not.toHaveBeenCalledWith("task-1", "not_before", expect.any(String));
    });

    it("returns terminal disposition when llm_unavailable budget exhausted", () => {
      const taskEngine = makeTaskEngine({ consecutive_llm_unavailable_count: 4 });
      const policy = createRetryPolicy({
        config: makeConfig(),
        taskEngine,
        clock: makeClock(),
        observer: makeObserver(),
      });

      const result = policy.recordFailure("llm_unavailable", "task-1");

      expect(result).toEqual({ disposition: "terminal", state: "blocked", count: 5 });
    });

    it("uses config-driven backoff schedule", () => {
      const taskEngine = makeTaskEngine({ consecutive_crash_count: 1 });
      const now = 1_000_000_000;
      const policy = createRetryPolicy({
        config: makeConfig({ crash: { backoff_minutes: [10, 20], max_attempts: 3 } }),
        taskEngine,
        clock: makeClock(now),
        observer: makeObserver(),
      });

      const result = policy.recordFailure("crash", "task-1");

      expect(result.disposition).toBe("retry");
      if (result.disposition === "retry") {
        const expectedNotBefore = new Date(now + 20 * 60_000).toISOString();
        expect(result.not_before).toBe(expectedNotBefore);
      }
    });

    it("respects custom max_attempts from config", () => {
      const taskEngine = makeTaskEngine({ consecutive_crash_count: 1 });
      const policy = createRetryPolicy({
        config: makeConfig({ crash: { backoff_minutes: [1], max_attempts: 2 } }),
        taskEngine,
        clock: makeClock(),
        observer: makeObserver(),
      });

      const result = policy.recordFailure("crash", "task-1");

      expect(result).toEqual({ disposition: "terminal", state: "failed", count: 2 });
    });
  });

  describe("recordSuccess", () => {
    it("resets crash counter and clears not_before", () => {
      const taskEngine = makeTaskEngine({ consecutive_crash_count: 3 });
      const policy = createRetryPolicy({
        config: makeConfig(),
        taskEngine,
        clock: makeClock(),
        observer: makeObserver(),
      });

      policy.recordSuccess("crash", "task-1");

      expect(taskEngine.updateTaskField).toHaveBeenCalledWith("task-1", "consecutive_crash_count", 0);
      expect(taskEngine.updateTaskField).toHaveBeenCalledWith("task-1", "not_before", null);
    });

    it("resets llm_unavailable counter and clears not_before", () => {
      const taskEngine = makeTaskEngine({ consecutive_llm_unavailable_count: 3 });
      const policy = createRetryPolicy({
        config: makeConfig(),
        taskEngine,
        clock: makeClock(),
        observer: makeObserver(),
      });

      policy.recordSuccess("llm_unavailable", "task-1");

      expect(taskEngine.updateTaskField).toHaveBeenCalledWith("task-1", "consecutive_llm_unavailable_count", 0);
      expect(taskEngine.updateTaskField).toHaveBeenCalledWith("task-1", "not_before", null);
    });
  });
});
