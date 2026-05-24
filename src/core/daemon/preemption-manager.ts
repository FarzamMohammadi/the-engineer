import { EventTypes } from "../../schemas/events.js";
import type { DispatchTracker } from "../dispatch-tracker/index.js";
import type { PublishInput } from "../interfaces/event-bus.interface.js";
import { isTaskEligible } from "./task-scheduler.js";
import type { PreemptionManagerContext } from "./types.js";

// ── Pure Functions ────────────────────────────────────────────────────────────

/** Whether a higher-priority task should preempt a lower-priority one. */
export function shouldPreempt(currentPriority: number, candidatePriority: number, threshold: number): boolean {
  return candidatePriority - currentPriority >= threshold;
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface PendingPreemption {
  targetTaskId: string;
  replacementTaskId: string;
  requestedAt: number;
  retried: boolean;
}

/** Minimal shape needed from queued tasks — covers priority comparison + eligibility filter. */
interface QueuedTaskEntry {
  id: string;
  priority: number;
  not_before: string | null;
}

// ── PreemptionManager Interface ──────────────────────────────────────────────

/** Evaluates preemption conditions and manages pending preemptions. */
export interface PreemptionManager {
  /** Evaluate whether preemption should occur. Pre-fetched tasks avoid redundant DB query. */
  evaluate(now: number, queuedTasks?: QueuedTaskEntry[]): void;
  /** Get the current pending preemption (if any). */
  getPending(): PendingPreemption | null;
  /** Clear the pending preemption (called after the cooperative or forced cycle settles). */
  clearPending(): void;
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function createPreemptionManager(
  ctx: PreemptionManagerContext,
  getActiveTaskIds: () => string[],
  dispatchTracker: DispatchTracker,
): PreemptionManager {
  const { config, eventBus, taskEngine, observer } = ctx;

  let pendingPreemption: PendingPreemption | null = null;

  /**
   * Policy: one preemption per tick — the cooperative-then-forced timeout is
   * inherently sequential. Multi-per-tick would either parallelize cooperation
   * (complex) or queue multiple pending preemptions (changes `pendingPreemption`
   * from singleton to map). v1 does not need this.
   */
  function evaluate(now: number, prefetchedTasks?: QueuedTaskEntry[]): void {
    if (pendingPreemption) {
      checkPreemptionTimeout(now);
      return;
    }

    const activeTaskIds = getActiveTaskIds();
    if (activeTaskIds.length === 0) {
      return;
    }

    const queuedTasks = prefetchedTasks ?? taskEngine.getQueuedByPriority();
    if (queuedTasks.length === 0) {
      return;
    }

    // Filter ineligible candidates BEFORE picking — otherwise the preempter
    // evicts an active task for a candidate that cannot dispatch (not_before
    // in the future), leaving the slot empty.
    const eligible = queuedTasks.filter((t) => isTaskEligible(t, now));
    if (eligible.length === 0) {
      return;
    }

    findAndInitiatePreemption(eligible, activeTaskIds, now);
  }

  function findAndInitiatePreemption(eligible: QueuedTaskEntry[], activeTaskIds: string[], now: number): void {
    const candidate = eligible[0];
    if (!candidate) {
      return;
    }

    for (const activeTaskId of activeTaskIds) {
      const activeTask = taskEngine.getTask(activeTaskId);
      if (!activeTask) {
        continue;
      }

      if (shouldPreempt(activeTask.priority, candidate.priority, config.preemption_threshold)) {
        observer.recordDecision(
          "preemption_initiate",
          `Higher-priority candidate ${candidate.id} (p=${String(candidate.priority)}) vs active ${activeTaskId} (p=${String(activeTask.priority)})`,
          [
            { id: "preempt", description: "Request cooperative yield from the active task" },
            { id: "wait", description: "Let the active task finish naturally" },
          ],
          "preempt",
          `Priority delta ${String(candidate.priority - activeTask.priority)} meets threshold ${String(config.preemption_threshold)}`,
          1,
          { task_id: activeTaskId },
        );
        initiatePreemption(activeTaskId, candidate.id, candidate.priority - activeTask.priority, now);
        break;
      }
    }
  }

  function initiatePreemption(
    targetTaskId: string,
    replacementTaskId: string,
    priorityDelta: number,
    now: number,
  ): void {
    pendingPreemption = {
      targetTaskId,
      replacementTaskId,
      requestedAt: now,
      retried: false,
    };

    eventBus.publish({
      type: EventTypes["preemption.requested"],
      source: "daemon",
      task_id: targetTaskId,
      payload: {
        target_task_id: targetTaskId,
        preempting_task_id: replacementTaskId,
        reason: "priority_delta_exceeded",
        priority_delta: priorityDelta,
      },
    } satisfies PublishInput<"preemption.requested">);

    observer.info("Preemption requested", { targetTaskId, replacementTaskId });
  }

  function checkPreemptionTimeout(now: number): void {
    if (!pendingPreemption) {
      return;
    }

    const elapsed = now - pendingPreemption.requestedAt;
    if (elapsed <= config.preemption_timeout_ms) {
      return;
    }

    if (pendingPreemption.retried) {
      // Second timeout: force-terminate via the dispatch-tracker. The terminate
      // routing in the scheduler transitions the task to queued.
      observer.recordDecision(
        "preemption_timeout",
        `Preemption of ${pendingPreemption.targetTaskId} timed out twice (cooperative window: ${String(config.preemption_timeout_ms)}ms)`,
        [
          { id: "retry_request", description: "Re-emit the preemption.requested event and wait again" },
          { id: "force_terminate", description: "Abort the dispatch via the dispatch-tracker" },
        ],
        "force_terminate",
        "Second timeout — cooperative yield is not happening; reclaim the slot now",
        1,
        { task_id: pendingPreemption.targetTaskId },
      );
      observer.error("Preemption double timeout — force-terminating dispatch", {
        targetTaskId: pendingPreemption.targetTaskId,
      });
      dispatchTracker.terminate(pendingPreemption.targetTaskId, "preemption_timeout");
      eventBus.publish({
        type: EventTypes["preemption.completed"],
        source: "daemon",
        task_id: pendingPreemption.targetTaskId,
        payload: {
          target_task_id: pendingPreemption.targetTaskId,
          preempting_task_id: pendingPreemption.replacementTaskId,
          method: "forced",
        },
      } satisfies PublishInput<"preemption.completed">);
      pendingPreemption = null;
      return;
    }

    // First timeout: re-request — the orchestrator may have missed the first signal.
    observer.warn("Preemption timeout — re-requesting", {
      targetTaskId: pendingPreemption.targetTaskId,
    });
    pendingPreemption.retried = true;
    pendingPreemption.requestedAt = now;

    eventBus.publish({
      type: EventTypes["preemption.requested"],
      source: "daemon",
      task_id: pendingPreemption.targetTaskId,
      payload: {
        target_task_id: pendingPreemption.targetTaskId,
        preempting_task_id: pendingPreemption.replacementTaskId,
        reason: "preemption_timeout_retry",
        priority_delta: 0,
      },
    } satisfies PublishInput<"preemption.requested">);
  }

  function getPending(): PendingPreemption | null {
    return pendingPreemption;
  }

  function clearPending(): void {
    if (pendingPreemption) {
      eventBus.publish({
        type: EventTypes["preemption.completed"],
        source: "daemon",
        task_id: pendingPreemption.targetTaskId,
        payload: {
          target_task_id: pendingPreemption.targetTaskId,
          preempting_task_id: pendingPreemption.replacementTaskId,
          method: "cooperative",
        },
      } satisfies PublishInput<"preemption.completed">);
    }
    observer.debug("Preemption cleared — cycle complete");
    pendingPreemption = null;
  }

  return {
    evaluate,
    getPending,
    clearPending,
  };
}
