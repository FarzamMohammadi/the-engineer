import type { Dispatch } from "../../schemas/ephemeral.js";
import { EventTypes } from "../../schemas/events.js";
import { NotificationKinds } from "../../schemas/notifications.js";
import { SubStates, type Task, TaskStates } from "../../schemas/task.js";
import { sanitizeErrorMessage } from "../../utils/sanitize.js";
import type { DispatchTracker } from "../dispatch-tracker/index.js";
import type { EvaluationManager } from "../evaluation/types.js";
import type { PublishInput } from "../interfaces/event-bus.interface.js";
import { type ExecuteTaskResult, Outcomes } from "../orchestrator/index.js";
import type { TerminationReason } from "../orchestrator/types.js";
import type { RetryPolicy } from "../retry-policy/index.js";
import type { NotificationRouter } from "./notification-router.js";
import type { TaskSchedulerContext } from "./types.js";

// ── Pure Functions ────────────────────────────────────────────────────────────

/** Whether a task in the given state consumes a working slot. */
export function isSlotConsuming(state: string, subState: string | null): boolean {
  return state === TaskStates.active && subState === SubStates.working;
}

/**
 * Whether a queued task is eligible to dispatch right now.
 *
 * The only gate is `not_before` — set by retry-policy after a crash or
 * LLM-unavailable failure to defer the next attempt. Slot availability is a
 * separate concern handled by the scheduler.
 */
export function isTaskEligible(task: { id: string; not_before: string | null }, now: number): boolean {
  if (task.not_before && new Date(task.not_before).getTime() > now) {
    return false;
  }
  return true;
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
  /** Get currently active dispatch task IDs (delegates to dispatch-tracker). */
  getActiveTaskIds(): string[];
  /** Get count of completed tasks. */
  getTasksCompleted(): number;
  /**
   * Drain all active dispatches during shutdown via the dispatch-tracker primitive.
   * Single shared timeout — worst case is `timeoutMs`, not `timeoutMs × N`.
   */
  drainForShutdown(timeoutMs: number): Promise<void>;
  /** Handle task completion after orchestrator finishes (idempotency provided by dispatch-tracker). */
  handleTaskCompletion(taskId: string, result: ExecuteTaskResult): void;
  /** Handle task error from orchestrator crash (idempotency provided by dispatch-tracker). */
  handleTaskError(taskId: string, error: unknown): void;
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function createTaskScheduler(
  ctx: TaskSchedulerContext,
  notifications: NotificationRouter,
  callbacks: SchedulerCallbacks,
  retryPolicy: RetryPolicy,
  dispatchTracker: DispatchTracker,
  evaluationManager?: EvaluationManager | null,
): TaskScheduler {
  const { config, eventBus, taskEngine, orchestrator, clock, observer } = ctx;
  const { sessionMemory, workspaceManager } = ctx;

  // ── Internal State ──────────────────────────────────────────────────────
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
    return config.max_concurrent - dispatchTracker.getActiveCount();
  }

  function scheduleNext(prefetchedTasks?: Task[]): void {
    const available = getAvailableSlots();
    if (available <= 0) {
      return;
    }

    const now = clock.now();
    const queuedTasks = prefetchedTasks ?? taskEngine.getQueuedByPriority();
    const eligible = queuedTasks.filter((t) => {
      const ok = isTaskEligible(t, now);
      if (!ok) {
        observer.debug("Task not eligible: not_before gate", { taskId: t.id, notBefore: t.not_before });
      }
      return ok;
    });
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
    });

    // dispatch-tracker owns the AbortController, mints the dispatchId, and routes
    // late callbacks idempotently — the scheduler is purely the policy layer.
    dispatchTracker.register(
      task.id,
      (signal) => {
        const dispatch: Dispatch = {
          task,
          resume_from: checkpoint,
          signal,
        };
        return orchestrator.executeTask(dispatch);
      },
      {
        onCompleted: callbacks.onTaskCompleted,
        onError: callbacks.onTaskError,
      },
    );
  }

  // ── Task Completion ─────────────────────────────────────────────────────

  function handleCompletedOutcome(taskId: string): void {
    const transition = taskEngine.requestTransition(taskId, TaskStates.completed, null, "pipeline_completed", "daemon");
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
    const transition = taskEngine.requestTransition(taskId, TaskStates.blocked, null, reason, "daemon");
    if (!transition.success) {
      observer.warn("Failed to transition task to blocked — skipping notifications", {
        taskId,
        reason: transition.reason,
      });
      return;
    }
    // Truncate reason for notifications — full error details are in logs and journal entries
    const notifyReason = reason.length > 2000 ? `${reason.slice(0, 2000)}... [see logs for full details]` : reason;
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

  /**
   * Single routing surface for `Outcomes.terminated`. Each reason maps to one
   * recovery state — preemption returns to the queue, hard-cap fails the task,
   * cost-limit blocks for owner unblock, shutdown re-queues for the next start.
   */
  function handleTerminatedOutcome(taskId: string, reason: TerminationReason, lastPhase: unknown): void {
    const routingOptions = [
      { id: "queued", description: "Return to queue for the next scheduling tick" },
      { id: "failed", description: "Mark task failed — owner must retry manually" },
      { id: "blocked", description: "Block for owner unblock action" },
    ];
    const routeForReason: Record<TerminationReason, string> = {
      cooperative_preemption: "queued",
      preemption_timeout: "queued",
      graceful_shutdown: "queued",
      hard_cap_exceeded: "failed",
      cost_limit_reached: "blocked",
    };
    observer.recordDecision(
      "termination_routing",
      `Dispatch terminated for task ${taskId} (reason: ${reason}, lastPhase: ${String(lastPhase)})`,
      routingOptions,
      routeForReason[reason],
      `Reason "${reason}" maps to ${routeForReason[reason]} per the terminate routing table`,
      1,
      { task_id: taskId },
    );

    if (reason === "cooperative_preemption" || reason === "preemption_timeout" || reason === "graceful_shutdown") {
      const transition = taskEngine.requestTransition(taskId, TaskStates.queued, null, reason, "daemon");
      if (transition.success) {
        observer.info("Task terminated — returned to queue", { taskId, reason, lastPhase });
      } else {
        observer.warn("Failed to transition terminated task back to queued", {
          taskId,
          reason,
          transitionReason: transition.reason,
        });
      }
      return;
    }

    if (reason === "hard_cap_exceeded") {
      const transition = taskEngine.requestTransition(taskId, TaskStates.failed, null, reason, "daemon");
      if (!transition.success) {
        observer.warn("Failed to transition hard-cap victim to failed", {
          taskId,
          transitionReason: transition.reason,
        });
        return;
      }
      observer.error("Task exceeded max active duration — marking failed", { taskId, lastPhase });
      const title = taskEngine.getTask(taskId)?.title ?? taskId;
      const thresholdMinutes = Math.round(config.max_active_duration_ms / 60_000);
      notifications.notify({
        kind: NotificationKinds.alert,
        taskId,
        message: `Task "${title}" exceeded ${String(thresholdMinutes)} minutes of total active time and was marked failed. Run \`engineer retry ${taskId}\` after addressing the root cause.`,
      });
      return;
    }

    if (reason === "cost_limit_reached") {
      // cost-limit-queue already fired the owner notifications immediately when the
      // limit hit. The terminate routing just performs the deferred state transition.
      const transition = taskEngine.requestTransition(taskId, TaskStates.blocked, null, reason, "daemon");
      if (transition.success) {
        observer.info("Task terminated by cost limit — blocked for owner unblock", { taskId, lastPhase });
      } else {
        observer.warn("Failed to block cost-limited task", {
          taskId,
          transitionReason: transition.reason,
        });
      }
      return;
    }

    // Defensive — exhaustiveness check.
    const exhaustive: never = reason;
    observer.error("Unhandled termination reason", { taskId, reason: exhaustive });
  }

  function handleUnknownOutcome(taskId: string, outcome: string): void {
    observer.error("Unknown task outcome — transitioning task to blocked", { taskId, outcome });
    taskEngine.requestTransition(taskId, TaskStates.blocked, null, `unknown_outcome_${outcome}`, "daemon");
  }

  /** Handle blocked tasks with llm_unavailable reason: increment counter, then re-queue or final alert. */
  function handleLlmUnavailableBlocked(taskId: string): void {
    const disposition = retryPolicy.recordFailure("llm_unavailable", taskId);

    if (disposition.disposition === "terminal") {
      observer.error("LLM unavailability retries exhausted — task stays blocked until manual unblock", {
        taskId,
        retryCount: disposition.count,
      });
      notifications.notify({
        kind: NotificationKinds.alert,
        taskId,
        message: `LLM adapter unavailable after ${String(disposition.count)} retry cycles. Task blocked until you respond to unblock.`,
      });
      notifications.notify({
        kind: NotificationKinds.ticket_comment,
        taskId,
        message:
          "LLM adapter is unavailable. Task is blocked until you respond. Reply to this issue or use any communication channel to retry when the issue is resolved.",
      });
      return;
    }

    // Retry: re-queue. The not_before set by retry-policy keeps the task from dispatching until backoff elapses.
    const backoffMs = new Date(disposition.not_before).getTime() - clock.now();
    const backoffMinutes = Math.max(0, Math.round(backoffMs / 60_000));

    const requeue = taskEngine.requestTransition(taskId, TaskStates.queued, null, "llm_unavailable_retry", "daemon");
    if (!requeue.success) {
      observer.warn("Failed to re-queue task for LLM retry", {
        taskId,
        reason: requeue.reason,
      });
      return;
    }

    observer.info("Task re-queued for LLM unavailability retry", {
      taskId,
      retryCount: disposition.count,
      notBefore: disposition.not_before,
    });
    notifications.notify({
      kind: NotificationKinds.alert,
      taskId,
      message: `LLM adapter unavailable — task blocked, will retry in ${String(backoffMinutes)} minutes. Respond to unblock manually.`,
    });
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: discriminated union routing over the outcome types — extraction would fragment related state handling
  function handleTaskCompletion(taskId: string, result: ExecuteTaskResult): void {
    // dispatch-tracker already removed the entry and verified dispatch identity
    // before invoking this callback — no local cleanup needed.
    tasksCompleted++;

    // Reset both retry counters on any successful (non-crash, non-llm_unavailable) outcome.
    // The llm_unavailable path manages its own counter inside handleLlmUnavailableBlocked below.
    if (result.outcome !== Outcomes.blocked) {
      retryPolicy.recordSuccess("crash", taskId);
      retryPolicy.recordSuccess("llm_unavailable", taskId);
    } else {
      // Blocked outcome: reset crash counter (this wasn't a crash), leave llm_unavailable to its own handler.
      retryPolicy.recordSuccess("crash", taskId);
    }

    if (result.outcome === Outcomes.completed) {
      handleCompletedOutcome(taskId);
    } else if (result.outcome === Outcomes.review_pending) {
      handleReviewPendingOutcome(taskId);
    } else if (result.outcome === Outcomes.terminated) {
      handleTerminatedOutcome(taskId, result.reason, result.lastPhase);
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
    // dispatch-tracker already removed the entry and verified dispatch identity
    // before invoking this callback — no local cleanup needed.
    try {
      observer.error("Orchestrator crash during task execution", {
        taskId,
        error: sanitizeErrorMessage(error),
      });

      // Emit health event for observability
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

      const disposition = retryPolicy.recordFailure("crash", taskId);

      if (disposition.disposition === "terminal") {
        const transition = taskEngine.requestTransition(
          taskId,
          TaskStates.failed,
          null,
          `max_crash_retries_exceeded (${disposition.count})`,
          "daemon",
        );
        if (!transition.success) {
          observer.warn("Failed to transition crashed task to failed", {
            taskId,
            reason: transition.reason,
          });
        }
        observer.error("Task exceeded max crash retries — marking failed", {
          taskId,
          crashCount: disposition.count,
        });
        notifications.notify({
          kind: NotificationKinds.task_error,
          taskId,
          reason: `Task crashed ${String(disposition.count)} times — exceeded max retries`,
        });
        return;
      }

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
        crashCount: disposition.count,
        notBefore: disposition.not_before,
      });
    } catch (innerError) {
      // Last-resort: if crash recovery itself fails, log and leave stuck detection to find it
      observer.error("Critical: handleTaskError recovery failed — task may be stuck", {
        taskId,
        recoveryError: sanitizeErrorMessage(innerError),
      });
    }
  }

  // ── Accessors ───────────────────────────────────────────────────────────

  function getActiveTaskIds(): string[] {
    return dispatchTracker.getActiveTaskIds();
  }

  function getTasksCompleted(): number {
    return tasksCompleted;
  }

  /**
   * Drain on shutdown. The dispatch-tracker aborts every in-flight signal,
   * waits one shared timeout for cooperative settle, and routes each settle
   * through the late callback. Late callbacks see `Outcomes.terminated` with
   * reason `graceful_shutdown` and re-queue the task via `handleTerminatedOutcome`.
   */
  async function drainForShutdown(timeoutMs: number): Promise<void> {
    await dispatchTracker.drain(timeoutMs);
  }

  return {
    scheduleNext,
    dispatchTask,
    getActiveTaskIds,
    getTasksCompleted,
    drainForShutdown,
    handleTaskCompletion,
    handleTaskError,
  };
}
