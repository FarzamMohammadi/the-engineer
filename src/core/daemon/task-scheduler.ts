import type { Dispatch } from "../../schemas/ephemeral.js";
import { EventTypes } from "../../schemas/events.js";
import { SubStates, type Task, TaskStates } from "../../schemas/task.js";
import { sanitizeErrorMessage } from "../../utils/sanitize.js";
import type { PublishInput } from "../interfaces/event-bus.interface.js";
import { type ExecuteTaskResult, Outcomes } from "../orchestrator/index.js";
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

/**
 * Compute the aged priority for a queued task.
 * Returns the new priority or null if no change needed.
 */
export function computeAgedPriority(
  basePriority: number,
  elapsedMs: number,
  config: {
    aging_threshold_ms: number;
    aging_interval_ms: number;
    aging_increment: number;
    aging_cap: number;
  },
): number | null {
  if (elapsedMs < config.aging_threshold_ms) {
    return null;
  }

  const periods =
    Math.floor((elapsedMs - config.aging_threshold_ms) / config.aging_interval_ms) + 1;
  const aged = Math.min(basePriority + periods * config.aging_increment, config.aging_cap);

  return aged > basePriority ? aged : null;
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
  /** Apply priority aging to queued tasks. Pre-fetched tasks avoid redundant DB query. */
  applyPriorityAging(now: number, queuedTasks?: Task[]): void;
  /** Get currently active dispatch task IDs. */
  getActiveTaskIds(): string[];
  /** Get count of completed tasks. */
  getTasksCompleted(): number;
  /** Track a base priority for aging. */
  trackBasePriority(taskId: string, priority: number): void;
  /** Initialize base priorities from existing tasks (for crash recovery). */
  initializeBasePriorities(tasks: Array<{ id: string; priority: number }>): void;
  /** Remove a tracked base priority (for cleanup when tasks leave scheduling). */
  removeBasePriority(taskId: string): void;
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
): TaskScheduler {
  const { config, eventBus, taskEngine, orchestrator, observer } = ctx;
  const { sessionMemory, workspaceManager } = ctx;

  // ── Internal State ──────────────────────────────────────────────────────
  const activeDispatches = new Map<string, Promise<ExecuteTaskResult>>();
  const basePriorities = new Map<string, number>();
  let tasksCompleted = 0;

  // ── Scheduling ──────────────────────────────────────────────────────────

  function getAvailableSlots(): number {
    return config.max_concurrent - activeDispatches.size;
  }

  function isTaskEligible(task: { id: string; parent_id: string | null }): boolean {
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

    if (parent.cascade_policy === "pause_siblings") {
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

  /** Whether a task outcome means it no longer needs base priority tracking. */
  function shouldCleanupBasePriority(outcome: string): boolean {
    // review_pending and decomposed tasks leave the scheduling queue.
    // If they return (rework), dispatchTask re-tracks via trackBasePriority.
    return (
      outcome === Outcomes.completed ||
      outcome === Outcomes.error ||
      outcome === Outcomes.blocked ||
      outcome === Outcomes.review_pending ||
      outcome === Outcomes.decomposed
    );
  }

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
    try {
      workspaceManager.cleanupWorkspace(taskId, true);
    } catch (err) {
      observer.warn("Workspace cleanup failed after completion", {
        taskId,
        error: sanitizeErrorMessage(err),
      });
    }
    notifications.sendCompletion(taskId);
    notifications.commentOnTaskIssue(taskId, "Task completed successfully.");
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
    observer.error("Task error", { taskId, phase, reason });
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
    notifications.sendTaskError(taskId, reason);
    notifications.commentOnTaskIssue(taskId, `Task encountered an error: ${reason}`);
  }

  function handleReviewPendingOutcome(taskId: string): void {
    const reviewTransition = taskEngine.requestTransition(
      taskId,
      TaskStates.review_pending,
      SubStates.demo,
      "pr_created",
      "daemon",
    );
    if (reviewTransition.success) {
      notifications.sendReviewPending(taskId);
      notifications.commentOnTaskIssue(taskId, "Pull request created — awaiting review.");
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

  function handleTaskCompletion(taskId: string, result: ExecuteTaskResult): void {
    activeDispatches.delete(taskId);
    tasksCompleted++;

    // Clean up base priority when task leaves the scheduling queue
    if (shouldCleanupBasePriority(result.outcome)) {
      basePriorities.delete(taskId);
    }

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
      // Task already transitioned to blocked by the phase-runner. No re-transition needed.
      observer.info("Task blocked awaiting human input", {
        taskId,
        phase: result.phase,
        reason: result.reason,
      });
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

      const transition = taskEngine.requestTransition(
        taskId,
        TaskStates.queued,
        null,
        "crash_recovery",
        "daemon",
      );
      if (!transition.success) {
        observer.warn("Failed to transition crashed task back to queued", {
          taskId,
          reason: transition.reason,
        });
      }
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

  // ── Priority Aging ──────────────────────────────────────────────────────

  function applyPriorityAging(now: number, prefetchedTasks?: Task[]): void {
    const queuedTasks = prefetchedTasks ?? taskEngine.getTasksByState(TaskStates.queued);
    for (const task of queuedTasks) {
      const base = basePriorities.get(task.id) ?? task.priority;
      const elapsed = now - Date.parse(task.created_at);
      const newPriority = computeAgedPriority(base, elapsed, config);

      if (newPriority !== null && newPriority > task.priority) {
        taskEngine.updateTaskField(task.id, "priority", newPriority);
        observer.debug("Task priority aged", {
          taskId: task.id,
          from: task.priority,
          to: newPriority,
        });
      }
    }
  }

  // ── Accessors ───────────────────────────────────────────────────────────

  function getActiveTaskIds(): string[] {
    return [...activeDispatches.keys()];
  }

  function getTasksCompleted(): number {
    return tasksCompleted;
  }

  function trackBasePriority(taskId: string, priority: number): void {
    basePriorities.set(taskId, priority);
  }

  function initializeBasePriorities(tasks: Array<{ id: string; priority: number }>): void {
    for (const task of tasks) {
      basePriorities.set(task.id, task.priority);
    }
  }

  function removeBasePriority(taskId: string): void {
    basePriorities.delete(taskId);
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
    applyPriorityAging,
    getActiveTaskIds,
    getTasksCompleted,
    trackBasePriority,
    initializeBasePriorities,
    removeBasePriority,
    removeActiveDispatch,
    drainForShutdown,
    handleTaskCompletion,
    handleTaskError,
    checkAndEmitChildrenAllDone,
  };
}
