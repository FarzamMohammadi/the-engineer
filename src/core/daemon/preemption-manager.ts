import { EventTypes } from "../../schemas/events.js";
import { TaskStates } from "../../schemas/task.js";
import type { PublishInput } from "../interfaces/event-bus.interface.js";
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

/** Minimal shape needed from queued tasks — decoupled from ITaskEngine. */
interface QueuedTaskEntry {
  id: string;
  priority: number;
}

// ── PreemptionManager Interface ──────────────────────────────────────────────

/** Evaluates preemption conditions and manages pending preemptions. */
export interface PreemptionManager {
  /** Evaluate whether preemption should occur. Pre-fetched tasks avoid redundant DB query. */
  evaluate(now: number, queuedTasks?: QueuedTaskEntry[]): void;
  /** Get the current pending preemption (if any). */
  getPending(): PendingPreemption | null;
  /** Clear the pending preemption (called after preemption completes). */
  clearPending(): void;
  /** Give up on the pending preemption and remove the active dispatch. */
  abandonPending(): void;
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function createPreemptionManager(
  ctx: PreemptionManagerContext,
  getActiveTaskIds: () => string[],
  removeActiveDispatch: (taskId: string) => void,
): PreemptionManager {
  const { config, eventBus, taskEngine, observer } = ctx;

  let pendingPreemption: PendingPreemption | null = null;

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

    findAndInitiatePreemption(queuedTasks, activeTaskIds, now);
  }

  function findAndInitiatePreemption(queuedTasks: QueuedTaskEntry[], activeTaskIds: string[], now: number): void {
    const candidate = queuedTasks[0];
    if (!candidate) {
      return;
    }

    for (const activeTaskId of activeTaskIds) {
      const activeTask = taskEngine.getTask(activeTaskId);
      if (!activeTask) {
        continue;
      }

      if (shouldPreempt(activeTask.priority, candidate.priority, config.preemption_threshold)) {
        initiatePreemption(activeTaskId, candidate.id, candidate.priority - activeTask.priority, now);
        break; // One preemption per tick
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
      // Second timeout: force-transition
      observer.error("Preemption double timeout — force-transitioning task to queued", {
        targetTaskId: pendingPreemption.targetTaskId,
      });
      const result = taskEngine.requestTransition(
        pendingPreemption.targetTaskId,
        TaskStates.queued,
        null,
        "preemption_timeout",
        "daemon",
      );
      if (!result.success) {
        observer.warn("Preemption force-transition failed — task may have already changed state", {
          targetTaskId: pendingPreemption.targetTaskId,
          reason: result.reason,
        });
      }
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
      removeActiveDispatch(pendingPreemption.targetTaskId);
      pendingPreemption = null;
    } else {
      // First timeout: re-request
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

  function abandonPending(): void {
    if (pendingPreemption) {
      observer.warn("Preemption abandoned", {
        targetTaskId: pendingPreemption.targetTaskId,
        replacementTaskId: pendingPreemption.replacementTaskId,
      });
      removeActiveDispatch(pendingPreemption.targetTaskId);
      pendingPreemption = null;
    }
  }

  return {
    evaluate,
    getPending,
    clearPending,
    abandonPending,
  };
}
