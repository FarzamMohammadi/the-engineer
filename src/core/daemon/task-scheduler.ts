import type { Dispatch } from "../../schemas/ephemeral.js";
import { EventTypes } from "../../schemas/events.js";
import { NotificationKinds } from "../../schemas/notifications.js";
import { CascadePolicies, SubStates, type Task, TaskStates } from "../../schemas/task.js";
import { sanitizeErrorMessage } from "../../utils/sanitize.js";
import type { EvaluationManager } from "../evaluation/types.js";
import type { PublishInput } from "../interfaces/event-bus.interface.js";
import { type ExecuteTaskResult, Outcomes } from "../orchestrator/index.js";
import { MAX_LLM_UNAVAILABLE_RETRIES } from "../orchestrator/phase-runner.js";
import type { NotificationRouter } from "./notification-router.js";
import type { TaskSchedulerContext } from "./types.js";

// ── Pure Functions ────────────────────────────────────────────────────────────

/** Whether a task in the given state consumes a working slot. */
export function isSlotConsuming(state: string, subState: string | null): boolean {
  return (
    state === TaskStates.active &&
    (subState === SubStates.working || subState === SubStates.integrating)
  );
}

// ── Retry Backoff ────────────────────────────────────────────────────────────

/** Backoff schedule in minutes for crash retries: 1, 5, 15, 30, 30. */
const BACKOFF_MINUTES = [1, 5, 15, 30, 30] as const;

/** Maximum crash retries before transitioning to failed. */
export const MAX_CRASH_RETRIES = BACKOFF_MINUTES.length;

/** Compute backoff duration in milliseconds for a given crash count (1-based). */
export function computeBackoffMs(crashCount: number): number {
  const index = Math.min(crashCount - 1, BACKOFF_MINUTES.length - 1);
  return (BACKOFF_MINUTES[index] ?? BACKOFF_MINUTES[BACKOFF_MINUTES.length - 1] ?? 30) * 60_000;
}

// ── Types ────────────────────────────────────────────────────────────────────

/** Callback for task completion/error (injected by createDaemon). */
export interface SchedulerCallbacks {
  onTaskCompleted(taskId: string, result: ExecuteTaskResult): void;
  onTaskError(taskId: string, error: unknown): void;
}

// ── TaskScheduler Interface ──────────────────────────────────────────────────

/** Schedules, dispatches, and tracks task execution. */
export interface TaskScheduler {
  /** Schedule eligible queued tasks into available slots. Pre-fetched tasks avoid redundant DB query. */
  scheduleNext(queuedTasks?: Task[]): void;
  /** Dispatch a specific task to the Orchestrator. */
  dispatchTask(task: Task): void;
  /** Get currently active dispatch task IDs. */
  getActiveTaskIds(): string[];
  /** Get count of completed tasks. */
  getTasksCompleted(): number;
  /** Remove an active dispatch (for preemption/shutdown). */
  removeActiveDispatch(taskId: string): void;
  /**
   * Drain all active dispatches during shutdown.
   * Waits up to timeoutMs for each task, then transitions active tasks back to queued.
   */
  drainForShutdown(timeoutMs: number): Promise<void>;
  /** Handle task completion after orchestrator finishes. */
  handleTaskCompletion(taskId: string, result: ExecuteTaskResult): void;
  /** Handle task error from orchestrator crash. */
  handleTaskError(taskId: string, error: unknown): void;
  /**
   * After a child task reaches a terminal state, check if all siblings are done.
   * If so, emit task.children_all_done so the Daemon can resume the parent.
   */
  checkAndEmitChildrenAllDone(childTaskId: string): void;
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function createTaskScheduler(
  ctx: TaskSchedulerContext,
  notifications: NotificationRouter,
  callbacks: SchedulerCallbacks,
  evaluationManager?: EvaluationManager | null,
): TaskScheduler {
  const { config, eventBus, taskEngine, orchestrator, clock, observer } = ctx;
  const { sessionMemory, workspaceManager } = ctx;

  // ── Internal State ──────────────────────────────────────────────────────
  const activeDispatches = new Map<string, Promise<ExecuteTaskResult>>();
  let tasksCompleted = 0;

  // ── Evaluation ─────────────────────────────────────────────────────────

  function triggerEvaluationIfEnabled(taskId: string): void {
    if (!evaluationManager) {
      return;
    }
    const worktreePath = workspaceManager.getWorktreePath(taskId);
    const record = workspaceManager.getWorkspaceRecord(taskId);
    if (worktreePath && record?.thoughtsDir) {
      evaluationManager.triggerEvaluation(taskId, worktreePath, record.thoughtsDir);
    }
  }

  // ── Scheduling ──────────────────────────────────────────────────────────

  function getAvailableSlots(): number {
    return config.max_concurrent - activeDispatches.size;
  }

  function isTaskEligible(task: Task): boolean {
    // Retry backoff gate: skip tasks whose not_before is in the future
    if (task.not_before && new Date(task.not_before).getTime() > clock.now()) {
      observer.debug("Task not eligible: not_before gate", {
        taskId: task.id,
        notBefore: task.not_before,
      });
      return false;
    }

    if (!task.parent_id) {
      return true;
    }

    const parent = taskEngine.getTask(task.parent_id);
    if (!parent) {
      observer.debug("Task eligible: orphaned child (no parent record)", {
        taskId: task.id,
        parentId: task.parent_id,
      });
      return true; // Orphaned child — allow scheduling
    }

    if (parent.state !== TaskStates.active || parent.sub_state !== SubStates.supervising) {
      observer.debug("Task not eligible: parent not in active.supervising", {
        taskId: task.id,
        parentId: task.parent_id,
        parentState: parent.state,
        parentSubState: parent.sub_state,
      });
      return false;
    }

    if (parent.cascade_policy === CascadePolicies.pause_siblings) {
      const siblings = taskEngine.getChildren(task.parent_id);
      const activeSibling = siblings.find((s) => s.id !== task.id && s.state === TaskStates.active);
      if (activeSibling) {
        observer.debug("Task not eligible: pause_siblings — sibling still active", {
          taskId: task.id,
          parentId: task.parent_id,
          activeSiblingId: activeSibling.id,
        });
        return false;
      }
    }

    return true;
  }

  function scheduleNext(prefetchedTasks?: Task[]): void {
    const available = getAvailableSlots();
    if (available <= 0) {
      return;
    }

    const queuedTasks = prefetchedTasks ?? taskEngine.getQueuedByPriority();
    const eligible = queuedTasks.filter(isTaskEligible);
    const tasksToDispatch = eligible.slice(0, available);

    observer.debug("scheduleNext: slot evaluation", {
      available,
      queued: queuedTasks.length,
      eligible: eligible.length,
      dispatching: tasksToDispatch.length,
    });

    for (const task of tasksToDispatch) {
      dispatchTask(task);
    }
  }

  function dispatchTask(task: Task): void {
    // Build dispatch package
    const rawCheckpoint = sessionMemory.getLatestCheckpoint(task.id);

    // Rework dispatches (unapplied feedback) must restart from intake so the LLM
    // sees the reviewer's comments — NOT resume from the old checkpoint.
    // Pipeline fix also adds a synthetic unapplied feedback round, so this
    // naturally covers CI failure rework too.
    const hasUnappliedFeedback = task.review?.feedback_rounds?.some((r) => !r.applied) ?? false;
    const checkpoint = hasUnappliedFeedback ? null : rawCheckpoint;

    const repoKnowledge = task.workspace
      ? sessionMemory.getKnowledge("repo", task.workspace.repo)
      : [];
    const userKnowledge = sessionMemory.getKnowledge("user");

    const dispatch: Dispatch = {
      task,
      resume_from: checkpoint,
      knowledge: { repo: repoKnowledge, user: userKnowledge },
    };

    // Transition to active.working
    const transition = taskEngine.requestTransition(
      task.id,
      TaskStates.active,
      SubStates.working,
      checkpoint ? "resumed_from_checkpoint" : "scheduled",
      "daemon",
    );

    if (!transition.success) {
      observer.warn("Failed to transition task to active.working", {
        taskId: task.id,
        reason: transition.reason,
      });
      return;
    }

    observer.info("Dispatching task to Orchestrator", {
      taskId: task.id,
      title: task.title,
      resumeFrom: checkpoint?.phase ?? null,
      isRework: hasUnappliedFeedback,
      knowledgeEntries: { repo: repoKnowledge.length, user: userKnowledge.length },
    });

    // Fire-and-forget dispatch
    const promise = orchestrator.executeTask(dispatch);
    activeDispatches.set(task.id, promise);

    promise.then(
      (result) => {
        try {
          callbacks.onTaskCompleted(task.id, result);
        } catch (callbackError) {
          observer.error("onTaskCompleted callback threw unexpectedly", {
            taskId: task.id,
            error: sanitizeErrorMessage(callbackError),
          });
        }
      },
      (error) => {
        try {
          callbacks.onTaskError(task.id, error);
        } catch (callbackError) {
          observer.error("onTaskError callback threw unexpectedly", {
            taskId: task.id,
            error: sanitizeErrorMessage(callbackError),
          });
        }
      },
    );
  }

  // ── Task Completion ─────────────────────────────────────────────────────

  function handleCompletedOutcome(taskId: string): void {
    const transition = taskEngine.requestTransition(
      taskId,
      TaskStates.completed,
      null,
      "pipeline_completed",
      "daemon",
    );
    if (!transition.success) {
      observer.warn("Failed to transition task to completed — skipping cleanup and notifications", {
        taskId,
        reason: transition.reason,
      });
      return;
    }
    // Trigger evaluation before cleanup — worktree must still exist for snapshot
    triggerEvaluationIfEnabled(taskId);
    try {
      workspaceManager.cleanupWorkspace(taskId, true);
    } catch (err) {
      observer.warn("Workspace cleanup failed after completion", {
        taskId,
        error: sanitizeErrorMessage(err),
      });
    }
    notifications.notify({ kind: NotificationKinds.completion, taskId });
    notifications.notify({
      kind: NotificationKinds.ticket_comment,
      taskId,
      message: "Task completed successfully.",
    });
    checkAndEmitChildrenAllDone(taskId);
    const completedTask = taskEngine.getTask(taskId);
    observer.info("Task completed", {
      taskId,
      title: completedTask?.title,
      prNumber: completedTask?.review?.pr_number,
    });
  }

  function handleErrorOutcome(taskId: string, result: ExecuteTaskResult): void {
    const reason = "reason" in result ? (result.reason as string) : "unknown";
    const phase = "phase" in result ? result.phase : undefined;
    observer.error("Task error", { taskId, phase, reason: reason.slice(0, 500) });
    const transition = taskEngine.requestTransition(
      taskId,
      TaskStates.blocked,
      null,
      reason,
      "daemon",
    );
    if (!transition.success) {
      observer.warn("Failed to transition task to blocked — skipping notifications", {
        taskId,
        reason: transition.reason,
      });
      return;
    }
    checkAndEmitChildrenAllDone(taskId);
    // Truncate reason for notifications — full error details are in logs and journal entries
    const notifyReason =
      reason.length > 2000 ? `${reason.slice(0, 2000)}... [see logs for full details]` : reason;
    notifications.notify({ kind: NotificationKinds.task_error, taskId, reason: notifyReason });
    notifications.notify({
      kind: NotificationKinds.ticket_comment,
      taskId,
      message: `Task encountered an error: ${notifyReason}`,
    });
  }

  function handleReviewPendingOutcome(taskId: string): void {
    const reviewTransition = taskEngine.requestTransition(
      taskId,
      TaskStates.review_pending,
      SubStates.code,
      "pr_created",
      "daemon",
    );
    if (reviewTransition.success) {
      // Trigger evaluation — worktree survives during review_pending
      triggerEvaluationIfEnabled(taskId);
      notifications.notify({ kind: NotificationKinds.review_pending, taskId });
      notifications.notify({
        kind: NotificationKinds.ticket_comment,
        taskId,
        message: "Pull request created — awaiting review.",
      });
      observer.info("Task awaiting PR review", { taskId });
    } else {
      observer.warn("Failed to transition task to review_pending — skipping notifications", {
        taskId,
        reason: reviewTransition.reason,
      });
    }
  }

  function handlePreemptedOutcome(taskId: string, lastPhase: unknown): void {
    const preemptTransition = taskEngine.requestTransition(
      taskId,
      TaskStates.queued,
      null,
      "preempted",
      "daemon",
    );
    if (preemptTransition.success) {
      observer.info("Task preempted — returned to queue", { taskId, lastPhase });
    } else {
      observer.warn("Failed to transition preempted task back to queued", {
        taskId,
        reason: preemptTransition.reason,
      });
    }
  }

  function handleUnknownOutcome(taskId: string, outcome: string): void {
    observer.error("Unknown task outcome — transitioning task to blocked", { taskId, outcome });
    taskEngine.requestTransition(
      taskId,
      TaskStates.blocked,
      null,
      `unknown_outcome_${outcome}`,
      "daemon",
    );
  }

  /** Handle blocked tasks with llm_unavailable reason: re-queue or final alert. */
  function handleLlmUnavailableBlocked(taskId: string): void {
    const blockedTask = taskEngine.getTask(taskId);
    const retryCount = blockedTask?.consecutive_crash_count ?? 0;

    if (retryCount >= MAX_LLM_UNAVAILABLE_RETRIES) {
      // Exhausted all retry cycles — stay blocked until owner explicitly unblocks
      observer.error(
        "LLM unavailability retries exhausted — task stays blocked until manual unblock",
        { taskId, retryCount },
      );
      notifications.notify({
        kind: NotificationKinds.alert,
        taskId,
        message: `LLM adapter unavailable after ${String(retryCount)} retry cycles (~47 minutes). Task blocked until you respond to unblock.`,
      });
      notifications.notify({
        kind: NotificationKinds.ticket_comment,
        taskId,
        message:
          "LLM adapter has been unavailable for ~47 minutes. Task is blocked. Reply to this issue or use any communication channel to retry when the issue is resolved.",
      });
    } else {
      // Re-queue for retry — not_before already set by phase-runner
      const requeue = taskEngine.requestTransition(
        taskId,
        TaskStates.queued,
        null,
        "llm_unavailable_retry",
        "daemon",
      );
      if (requeue.success) {
        observer.info("Task re-queued for LLM unavailability retry", {
          taskId,
          retryCount,
          notBefore: blockedTask?.not_before,
        });
      } else {
        observer.warn("Failed to re-queue task for LLM retry", {
          taskId,
          reason: requeue.reason,
        });
      }
    }
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: discriminated union routing over 7 outcome types — extraction would fragment related state handling
  function handleTaskCompletion(taskId: string, result: ExecuteTaskResult): void {
    activeDispatches.delete(taskId);
    tasksCompleted++;

    // Reset crash backoff on any non-crash completion
    taskEngine.updateTaskField(taskId, "consecutive_crash_count", 0);
    taskEngine.updateTaskField(taskId, "not_before", null);

    if (result.outcome === Outcomes.completed) {
      handleCompletedOutcome(taskId);
    } else if (result.outcome === Outcomes.review_pending) {
      handleReviewPendingOutcome(taskId);
    } else if (result.outcome === Outcomes.decomposed) {
      observer.info("Task decomposed — children queued for scheduling", {
        taskId,
        childCount: result.childTaskIds.length,
      });
    } else if (result.outcome === Outcomes.preempted) {
      handlePreemptedOutcome(taskId, result.lastPhase);
    } else if (result.outcome === Outcomes.blocked) {
      // Task already transitioned to blocked by the phase-runner.
      const blockedTask = taskEngine.getTask(taskId);
      const blockedReason = blockedTask?.blocked?.reason;

      if (blockedReason === "llm_unavailable") {
        handleLlmUnavailableBlocked(taskId);
      } else {
        // Human-blocked tasks stay blocked — no re-transition needed
        observer.info("Task blocked awaiting human input", {
          taskId,
          phase: "phase" in result ? result.phase : undefined,
          reason: "reason" in result ? result.reason : undefined,
        });
      }
    } else if (result.outcome === Outcomes.error) {
      handleErrorOutcome(taskId, result);
    } else {
      handleUnknownOutcome(taskId, (result as { outcome: string }).outcome);
    }
  }

  function handleTaskError(taskId: string, error: unknown): void {
    activeDispatches.delete(taskId);
    try {
      observer.error("Orchestrator crash during task execution", {
        taskId,
        error: sanitizeErrorMessage(error),
      });

      // Increment crash count
      const task = taskEngine.getTask(taskId);
      const crashCount = (task?.consecutive_crash_count ?? 0) + 1;
      taskEngine.updateTaskField(taskId, "consecutive_crash_count", crashCount);

      // Emit health event
      eventBus.publish({
        type: EventTypes["health.stuck_detected"],
        source: "daemon",
        task_id: taskId,
        payload: {
          task_id: taskId,
          condition: "orchestrator_crash",
          threshold_ms: config.stuck_threshold_ms,
          elapsed_ms: 0,
          last_activity: null,
        },
      } satisfies PublishInput<"health.stuck_detected">);

      if (crashCount >= MAX_CRASH_RETRIES) {
        // Max retries exceeded → failed
        const transition = taskEngine.requestTransition(
          taskId,
          TaskStates.failed,
          null,
          `max_crash_retries_exceeded (${crashCount})`,
          "daemon",
        );
        if (!transition.success) {
          observer.warn("Failed to transition crashed task to failed", {
            taskId,
            reason: transition.reason,
          });
        }
        observer.error("Task exceeded max crash retries — marking failed", { taskId, crashCount });
        notifications.notify({
          kind: NotificationKinds.task_error,
          taskId,
          reason: `Task crashed ${crashCount} times — exceeded max retries`,
        });
        return;
      }

      // Set not_before for backoff
      const backoffMs = computeBackoffMs(crashCount);
      const notBefore = new Date(clock.now() + backoffMs).toISOString();
      taskEngine.updateTaskField(taskId, "not_before", notBefore);

      // Transition back to queued
      const transition = taskEngine.requestTransition(
        taskId,
        TaskStates.queued,
        null,
        "crash_recovery_with_backoff",
        "daemon",
      );
      if (!transition.success) {
        observer.warn("Failed to transition crashed task back to queued", {
          taskId,
          reason: transition.reason,
        });
      }

      observer.info("Task crash — backoff retry scheduled", {
        taskId,
        crashCount,
        backoffMs,
        notBefore,
      });
    } catch (innerError) {
      // Last-resort: if crash recovery itself fails, log and leave stuck detection to find it
      observer.error("Critical: handleTaskError recovery failed — task may be stuck", {
        taskId,
        recoveryError: sanitizeErrorMessage(innerError),
      });
    }
  }

  // ── Child Completion Detection ──────────────────────────────────────────

  function checkAndEmitChildrenAllDone(childTaskId: string): void {
    const child = taskEngine.getTask(childTaskId);
    if (!child?.parent_id) {
      return;
    }

    const siblings = taskEngine.getChildren(child.parent_id);
    // blocked counts as terminal: an errored child transitions to blocked, not failed.
    // The parent must not wait forever for a child that cannot make progress.
    const allTerminal = siblings.every(
      (s) =>
        s.state === TaskStates.completed ||
        s.state === TaskStates.failed ||
        s.state === TaskStates.blocked,
    );

    if (!allTerminal) {
      return;
    }

    // Include blocked tasks alongside failed ones so the parent knows not all succeeded
    const failedIds = siblings
      .filter((s) => s.state === TaskStates.failed || s.state === TaskStates.blocked)
      .map((s) => s.id);

    eventBus.publish({
      type: EventTypes["task.children_all_done"],
      source: "daemon",
      task_id: child.parent_id,
      payload: {
        parent_task_id: child.parent_id,
        child_ids: siblings.map((s) => s.id),
        all_succeeded: failedIds.length === 0,
        failed_ids: failedIds,
      },
    } satisfies PublishInput<"task.children_all_done">);

    observer.info("All children completed — emitting children_all_done", {
      parentTaskId: child.parent_id,
      allSucceeded: failedIds.length === 0,
      failedIds,
    });
  }

  // ── Accessors ───────────────────────────────────────────────────────────

  function getActiveTaskIds(): string[] {
    return [...activeDispatches.keys()];
  }

  function getTasksCompleted(): number {
    return tasksCompleted;
  }

  function removeActiveDispatch(taskId: string): void {
    activeDispatches.delete(taskId);
  }

  async function drainForShutdown(timeoutMs: number): Promise<void> {
    const total = activeDispatches.size;
    if (total === 0) {
      return;
    }

    // Drain all dispatches in parallel — worst-case shutdown time is timeoutMs,
    // not timeoutMs × activeDispatches.size.
    const entries = [...activeDispatches.entries()];
    const results = await Promise.allSettled(
      entries.map(([taskId, promise], index) => {
        observer.debug("Draining active dispatch for shutdown", {
          taskId,
          index: index + 1,
          total,
        });
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        return Promise.race([
          promise,
          new Promise<never>((_, reject) => {
            timeoutHandle = setTimeout(() => reject(new Error("shutdown_timeout")), timeoutMs);
          }),
        ]).finally(() => {
          if (timeoutHandle !== undefined) {
            clearTimeout(timeoutHandle);
          }
        });
      }),
    );

    let drained = 0;
    let transitioned = 0;

    for (let i = 0; i < entries.length; i++) {
      // biome-ignore lint/style/noNonNullAssertion: entries and results have same length
      const [taskId] = entries[i]!;
      // biome-ignore lint/style/noNonNullAssertion: entries and results have same length
      const result = results[i]!;

      if (result.status === "fulfilled") {
        drained++;
      } else {
        observer.warn("Shutdown timeout waiting for task", { taskId });
      }

      // Transition active tasks back to queued so they resume on next start
      const task = taskEngine.getTask(taskId);
      if (task && task.state === TaskStates.active) {
        const transition = taskEngine.requestTransition(
          taskId,
          TaskStates.queued,
          null,
          "graceful_shutdown",
          "daemon",
        );
        if (transition.success) {
          transitioned++;
        } else {
          observer.warn("Shutdown: failed to transition task back to queued", {
            taskId,
            reason: transition.reason,
          });
        }
      }
    }
    activeDispatches.clear();

    observer.info("Active dispatches drained", { total, drained, transitioned });
  }

  return {
    scheduleNext,
    dispatchTask,
    getActiveTaskIds,
    getTasksCompleted,
    removeActiveDispatch,
    drainForShutdown,
    handleTaskCompletion,
    handleTaskError,
    checkAndEmitChildrenAllDone,
  };
}
