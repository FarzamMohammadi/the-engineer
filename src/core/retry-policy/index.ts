import type { DaemonConfig } from "../../schemas/config.js";
import type { Clock } from "../../utils/clock.js";
import type { ITaskEngine } from "../interfaces/task-engine.interface.js";
import type { IObserver } from "../observer/index.js";

// ── Types ──────────────────────────────────────────────────────────────────

/** Retry categories — each has its own counter field, backoff schedule, and terminal disposition. */
export type RetryCategory = "crash" | "agent_unavailable";

/** Counter field on the task row for each category. */
const COUNTER_FIELDS: Record<RetryCategory, "consecutive_crash_count" | "consecutive_agent_unavailable_count"> = {
  crash: "consecutive_crash_count",
  agent_unavailable: "consecutive_agent_unavailable_count",
} as const;

/** Terminal state when a category's retry budget is exhausted. */
const TERMINAL_STATES: Record<RetryCategory, "failed" | "blocked"> = {
  crash: "failed",
  agent_unavailable: "blocked",
} as const;

/** Result of recording a failure — either retry with backoff or terminal. */
export type FailureDisposition =
  | { readonly disposition: "retry"; readonly not_before: string; readonly count: number }
  | { readonly disposition: "terminal"; readonly state: "failed" | "blocked"; readonly count: number };

/** Single source of truth for per-category retry semantics. */
export interface RetryPolicy {
  /** Record a failure — increments the counter, computes backoff, and returns the disposition. */
  recordFailure(category: RetryCategory, taskId: string): FailureDisposition;
  /** Record a success — resets the counter for this category and clears not_before. */
  recordSuccess(category: RetryCategory, taskId: string): void;
}

// ── Pure Functions ─────────────────────────────────────────────────────────

/** Compute backoff duration in ms for a given retry count (1-based) against a schedule. */
export function computeBackoffMs(retryCount: number, backoffMinutes: readonly number[]): number {
  const index = Math.min(retryCount - 1, backoffMinutes.length - 1);
  return (backoffMinutes[index] ?? backoffMinutes[backoffMinutes.length - 1] ?? 30) * 60_000;
}

// ── Factory ────────────────────────────────────────────────────────────────

interface RetryPolicyDeps {
  readonly config: Pick<DaemonConfig, "retry_policy">;
  readonly taskEngine: ITaskEngine;
  readonly clock: Clock;
  readonly observer: IObserver;
}

/** Create the retry-policy module — single source of truth for per-category retry semantics. */
export function createRetryPolicy(deps: RetryPolicyDeps): RetryPolicy {
  const { config, taskEngine, clock, observer } = deps;

  function getCategoryConfig(category: RetryCategory): { backoff_minutes: number[]; max_attempts: number } {
    return config.retry_policy[category];
  }

  function recordFailure(category: RetryCategory, taskId: string): FailureDisposition {
    const task = taskEngine.getTask(taskId);
    const counterField = COUNTER_FIELDS[category];
    const currentCount = task?.[counterField] ?? 0;
    const newCount = currentCount + 1;

    const categoryConfig = getCategoryConfig(category);

    taskEngine.updateTaskField(taskId, counterField, newCount);

    const dispositionOptions = [
      { id: "retry", description: "Schedule another attempt with backoff" },
      { id: "terminal", description: `Move task to ${TERMINAL_STATES[category]} — budget exhausted` },
    ];

    if (newCount >= categoryConfig.max_attempts) {
      const terminalState = TERMINAL_STATES[category];
      observer.recordDecision(
        "retry_policy",
        `${category} failure #${String(newCount)} for task ${taskId}`,
        dispositionOptions,
        "terminal",
        `Reached max_attempts (${String(categoryConfig.max_attempts)}) — no more retries; moving to ${terminalState}`,
        1,
        { task_id: taskId },
      );
      observer.info("Retry budget exhausted — terminal disposition", {
        taskId,
        category,
        count: newCount,
        maxAttempts: categoryConfig.max_attempts,
        terminalState,
      });
      return { disposition: "terminal", state: terminalState, count: newCount };
    }

    const backoffMs = computeBackoffMs(newCount, categoryConfig.backoff_minutes);
    const notBefore = new Date(clock.now() + backoffMs).toISOString();
    taskEngine.updateTaskField(taskId, "not_before", notBefore);

    observer.recordDecision(
      "retry_policy",
      `${category} failure #${String(newCount)} for task ${taskId}`,
      dispositionOptions,
      "retry",
      `Under max_attempts (${String(newCount)}/${String(categoryConfig.max_attempts)}) — backoff ${String(backoffMs)}ms before next attempt`,
      1,
      { task_id: taskId },
    );
    observer.info("Retry scheduled with backoff", {
      taskId,
      category,
      count: newCount,
      backoffMs,
      notBefore,
    });

    return { disposition: "retry", not_before: notBefore, count: newCount };
  }

  function recordSuccess(category: RetryCategory, taskId: string): void {
    const counterField = COUNTER_FIELDS[category];
    taskEngine.updateTaskField(taskId, counterField, 0);
    taskEngine.updateTaskField(taskId, "not_before", null);
  }

  return { recordFailure, recordSuccess };
}
