import { EventTypes } from "../../schemas/events.js";
import { TaskStates } from "../../schemas/task.js";
import type { PublishInput } from "../interfaces/event-bus.interface.js";
import type { ITaskEngine } from "../interfaces/task-engine.interface.js";
import { shouldPreempt } from "./index.js";
import type { PreemptionManagerContext } from "./types.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface PendingPreemption {
  targetTaskId: string;
  replacementTaskId: string;
  requestedAt: number;
  retried: boolean;
}

// ── PreemptionManager Interface ──────────────────────────────────────────────

/** Evaluates preemption conditions and manages pending preemptions. */
export interface PreemptionManager {
  /** Evaluate whether preemption should occur. */
  evaluate(now: number): void;
  /** Get the current pending preemption (if any). */
  getPending(): PendingPreemption | null;
  /** Clear the pending preemption (called after preemption completes). */
  clearPending(): void;
  /** Remove an active dispatch from tracking (for force-transition). */
  forceTransitionTarget(): void;
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function createPreemptionManager(
  ctx: PreemptionManagerContext,
  getActiveTaskIds: () => string[],
  removeActiveDispatch: (taskId: string) => void,
): PreemptionManager {
  const { config, eventBus, taskEngine, logger } = ctx;

  let pendingPreemption: PendingPreemption | null = null;

  function evaluate(now: number): void {
    if (pendingPreemption) {
      checkPreemptionTimeout(now);
      return;
    }

    const activeTaskIds = getActiveTaskIds();
    if (activeTaskIds.length === 0) {
      return;
    }

    const queuedTasks = taskEngine.getQueuedByPriority();
    if (queuedTasks.length === 0) {
      return;
    }

    findAndInitiatePreemption(queuedTasks, activeTaskIds, now);
  }

  function findAndInitiatePreemption(
    queuedTasks: ReturnType<ITaskEngine["getQueuedByPriority"]>,
    activeTaskIds: string[],
    now: number,
  ): void {
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
        initiatePreemption(
          activeTaskId,
          candidate.id,
          candidate.priority - activeTask.priority,
          now,
        );
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

    logger.info({ targetTaskId, replacementTaskId }, "Preemption requested");
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
      logger.error(
        { targetTaskId: pendingPreemption.targetTaskId },
        "Preemption double timeout — force-transitioning task to queued",
      );
      taskEngine.requestTransition(
        pendingPreemption.targetTaskId,
        TaskStates.queued,
        null,
        "preemption_timeout",
        "daemon",
      );
      removeActiveDispatch(pendingPreemption.targetTaskId);
      pendingPreemption = null;
    } else {
      // First timeout: re-request
      logger.warn(
        { targetTaskId: pendingPreemption.targetTaskId },
        "Preemption timeout — re-requesting",
      );
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
    pendingPreemption = null;
  }

  function forceTransitionTarget(): void {
    if (pendingPreemption) {
      removeActiveDispatch(pendingPreemption.targetTaskId);
      pendingPreemption = null;
    }
  }

  return {
    evaluate,
    getPending,
    clearPending,
    forceTransitionTarget,
  };
}
