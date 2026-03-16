import type { Dispatch } from "../../schemas/ephemeral.js";
import { EventTypes } from "../../schemas/events.js";
import { SubStates, TaskStates } from "../../schemas/task.js";
import type { PublishInput } from "../interfaces/event-bus.interface.js";
import type { ITaskEngine } from "../interfaces/task-engine.interface.js";
import type { ExecuteTaskResult } from "../orchestrator/index.js";
import { computeAgedPriority } from "./index.js";
import type { NotificationRouter } from "./notification-router.js";
import type { TaskSchedulerContext } from "./types.js";

// ── Types ────────────────────────────────────────────────────────────────────

/** Callback for task completion/error (injected by createDaemon). */
export interface SchedulerCallbacks {
  onTaskCompleted(taskId: string, result: ExecuteTaskResult): void;
  onTaskError(taskId: string, error: unknown): void;
}

// ── TaskScheduler Interface ──────────────────────────────────────────────────

/** Schedules, dispatches, and tracks task execution. */
export interface TaskScheduler {
  /** Schedule eligible queued tasks into available slots. */
  scheduleNext(): void;
  /** Dispatch a specific task to the Orchestrator. */
  dispatchTask(candidate: ReturnType<ITaskEngine["getQueuedByPriority"]>[number]): void;
  /** Apply priority aging to queued tasks. */
  applyPriorityAging(now: number): void;
  /** Get currently active dispatch task IDs. */
  getActiveTaskIds(): string[];
  /** Get count of completed tasks. */
  getTasksCompleted(): number;
  /** Get available concurrency slots. */
  getAvailableSlots(): number;
  /** Track a base priority for aging. */
  trackBasePriority(taskId: string, priority: number): void;
  /** Initialize base priorities from existing tasks (for crash recovery). */
  initializeBasePriorities(tasks: Array<{ id: string; priority: number }>): void;
  /** Remove an active dispatch (for preemption/shutdown). */
  removeActiveDispatch(taskId: string): void;
  /** Get the active dispatches map (for shutdown drain). */
  getActiveDispatches(): Map<string, Promise<ExecuteTaskResult>>;
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
  const { config, eventBus, taskEngine, orchestrator, logger } = ctx;
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
      return true; // Orphaned child — allow scheduling
    }

    if (parent.state !== TaskStates.active || parent.sub_state !== SubStates.supervising) {
      return false;
    }

    if (parent.cascade_policy === "pause_siblings") {
      const siblings = taskEngine.getChildren(task.parent_id);
      const activeSibling = siblings.find((s) => s.id !== task.id && s.state === TaskStates.active);
      if (activeSibling) {
        return false;
      }
    }

    return true;
  }

  function scheduleNext(): void {
    const available = getAvailableSlots();
    if (available <= 0) {
      return;
    }

    const queuedTasks = taskEngine.getQueuedByPriority();
    const eligible = queuedTasks.filter(isTaskEligible);

    const toSchedule = eligible.slice(0, available);
    for (const candidate of toSchedule) {
      dispatchTask(candidate);
    }
  }

  function dispatchTask(candidate: ReturnType<ITaskEngine["getQueuedByPriority"]>[number]): void {
    // Build dispatch package
    const rawCheckpoint = sessionMemory.getLatestCheckpoint(candidate.id);

    // Rework dispatches (unapplied feedback) must restart from intake so the LLM
    // sees the reviewer's comments — NOT resume from the old checkpoint.
    const hasUnappliedFeedback =
      candidate.review?.feedback_rounds?.some((r) => !r.applied) ?? false;
    const checkpoint = hasUnappliedFeedback ? null : rawCheckpoint;

    const repoKnowledge = candidate.workspace
      ? sessionMemory.getKnowledge("repo", candidate.workspace.repo)
      : [];
    const userKnowledge = sessionMemory.getKnowledge("user");

    const dispatch: Dispatch = {
      task: candidate,
      resume_from: checkpoint,
      knowledge: { repo: repoKnowledge, user: userKnowledge },
    };

    // Transition to active.working
    const transition = taskEngine.requestTransition(
      candidate.id,
      TaskStates.active,
      SubStates.working,
      checkpoint ? "resumed_from_checkpoint" : "scheduled",
      "daemon",
    );

    if (!transition.success) {
      logger.warn(
        { taskId: candidate.id, reason: transition.reason },
        "Failed to transition task to active.working",
      );
      return;
    }

    logger.info(
      { taskId: candidate.id, title: candidate.title },
      "Dispatching task to Orchestrator",
    );

    // TODO: Emit task.dispatched event for observability (requires schema update)

    // Fire-and-forget dispatch
    const promise = orchestrator.executeTask(dispatch);
    activeDispatches.set(candidate.id, promise);

    promise.then(
      (result) => callbacks.onTaskCompleted(candidate.id, result),
      (error) => callbacks.onTaskError(candidate.id, error),
    );
  }

  // ── Task Completion ─────────────────────────────────────────────────────

  /** Whether a task outcome represents a terminal state (for cleanup). */
  function isTerminalOutcome(outcome: string): boolean {
    return outcome === "completed" || outcome === "error";
  }

  function handleCompletedOutcome(taskId: string, taskTitle: string): void {
    taskEngine.requestTransition(
      taskId,
      TaskStates.completed,
      null,
      "pipeline_completed",
      "daemon",
    );
    checkAndEmitChildrenAllDone(taskId);
    try {
      workspaceManager.cleanupWorkspace(taskId, true);
    } catch {
      logger.warn({ taskId }, "Workspace cleanup failed after completion");
    }
    notifications.sendCompletion(taskId, taskTitle);
    notifications.commentOnTaskIssue(taskId, "Task completed successfully.");
    logger.info({ taskId }, "Task completed");
  }

  function handleErrorOutcome(taskId: string, taskTitle: string, result: ExecuteTaskResult): void {
    const reason = "reason" in result ? (result.reason as string) : "unknown";
    const phase = "phase" in result ? result.phase : undefined;
    logger.error({ taskId, phase, reason }, "Task error");
    taskEngine.requestTransition(taskId, TaskStates.blocked, null, reason, "daemon");
    checkAndEmitChildrenAllDone(taskId);
    notifications.sendTaskError(taskId, taskTitle, reason);
    notifications.commentOnTaskIssue(taskId, `Task encountered an error: ${reason}`);
  }

  function handleTaskCompletion(taskId: string, result: ExecuteTaskResult): void {
    activeDispatches.delete(taskId);
    tasksCompleted++;

    // Clean up base priority for terminal outcomes (prevents unbounded map growth)
    if (isTerminalOutcome(result.outcome)) {
      basePriorities.delete(taskId);
    }

    const task = taskEngine.getTask(taskId);
    const taskTitle = task?.title ?? taskId;

    if (result.outcome === "completed") {
      handleCompletedOutcome(taskId, taskTitle);
    } else if (result.outcome === "review_pending") {
      taskEngine.requestTransition(
        taskId,
        TaskStates.review_pending,
        SubStates.demo,
        "pr_created",
        "daemon",
      );
      notifications.sendReviewPending(taskId, taskTitle);
      notifications.commentOnTaskIssue(taskId, "Pull request created — awaiting review.");
      logger.info({ taskId }, "Task awaiting PR review");
    } else if (result.outcome === "decomposed") {
      logger.info(
        { taskId, childCount: result.childTaskIds.length },
        "Task decomposed — children queued for scheduling",
      );
    } else if (result.outcome === "preempted") {
      taskEngine.requestTransition(taskId, TaskStates.queued, null, "preempted", "daemon");
      logger.info({ taskId, lastPhase: result.lastPhase }, "Task preempted — returned to queue");
    } else if (result.outcome === "error") {
      handleErrorOutcome(taskId, taskTitle, result);
    }
  }

  function handleTaskError(taskId: string, error: unknown): void {
    activeDispatches.delete(taskId);
    logger.error({ taskId, error }, "Orchestrator crash during task execution");

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

    taskEngine.requestTransition(taskId, TaskStates.queued, null, "crash_recovery", "daemon");
  }

  // ── Child Completion Detection ──────────────────────────────────────────

  function checkAndEmitChildrenAllDone(childTaskId: string): void {
    const child = taskEngine.getTask(childTaskId);
    if (!child?.parent_id) {
      return;
    }

    const siblings = taskEngine.getChildren(child.parent_id);
    const allTerminal = siblings.every(
      (s) => s.state === TaskStates.completed || s.state === TaskStates.failed,
    );

    if (!allTerminal) {
      return;
    }

    const failedIds = siblings.filter((s) => s.state === TaskStates.failed).map((s) => s.id);

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

    logger.info(
      { parentTaskId: child.parent_id, allSucceeded: failedIds.length === 0, failedIds },
      "All children completed — emitting children_all_done",
    );
  }

  // ── Priority Aging ──────────────────────────────────────────────────────

  function applyPriorityAging(now: number): void {
    const queuedTasks = taskEngine.getTasksByState(TaskStates.queued);
    for (const task of queuedTasks) {
      const base = basePriorities.get(task.id) ?? task.priority;
      const elapsed = now - Date.parse(task.created_at);
      const newPriority = computeAgedPriority(base, elapsed, config);

      if (newPriority !== null && newPriority > task.priority) {
        taskEngine.updateTaskField(task.id, "priority", newPriority);
        logger.debug(
          { taskId: task.id, from: task.priority, to: newPriority },
          "Task priority aged",
        );
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

  function removeActiveDispatch(taskId: string): void {
    activeDispatches.delete(taskId);
  }

  function getActiveDispatches(): Map<string, Promise<ExecuteTaskResult>> {
    return activeDispatches;
  }

  return {
    scheduleNext,
    dispatchTask,
    applyPriorityAging,
    getActiveTaskIds,
    getTasksCompleted,
    getAvailableSlots,
    trackBasePriority,
    initializeBasePriorities,
    removeActiveDispatch,
    getActiveDispatches,
    handleTaskCompletion,
    handleTaskError,
    checkAndEmitChildrenAllDone,
  };
}
