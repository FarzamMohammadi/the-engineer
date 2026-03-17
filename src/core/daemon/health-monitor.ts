import { EventTypes } from "../../schemas/events.js";
import { SubStates, type Task, TaskStates } from "../../schemas/task.js";
import type { PublishInput } from "../interfaces/event-bus.interface.js";
import { evaluateTaskStuckness } from "./index.js";
import type { NotificationRouter } from "./notification-router.js";
import type { HealthMonitorContext } from "./types.js";

// ── DaemonHealthMonitor Interface ────────────────────────────────────────────

/** Monitors task health: stuck detection, blocked escalation, review reminders, cost limits. */
export interface DaemonHealthMonitor {
  /** Check stuck tasks for active dispatches. */
  checkStuckTasks(now: number): void;
  /** Check blocked task escalation. */
  checkBlockedEscalation(now: number): void;
  /** Check review pending reminders. Pre-fetched tasks avoid redundant DB queries. */
  checkReviewPendingReminders(now: number, reviewPendingTasks?: Task[]): void;
  /** Process cost limit events (drain pending cost limit tasks). */
  processCostLimits(): void;
  /** Register a cost limit task (called from EventBus subscription). */
  addCostLimitTask(taskId: string): void;
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function createDaemonHealthMonitor(
  ctx: HealthMonitorContext,
  notifications: NotificationRouter,
  getActiveTaskIds: () => string[],
): DaemonHealthMonitor {
  const { config, eventBus, taskEngine, safetyLayer, orchestrator, sessionMemory, observer } = ctx;

  // ── Internal State ──────────────────────────────────────────────────────
  const blockedEscalationState = new Map<
    string,
    { lastStageIndex: number; lastActionAt: number }
  >();
  const reviewReminderTimes = new Map<string, number>();
  const costLimitTasks: string[] = [];

  // ── Stuck Detection ─────────────────────────────────────────────────────

  function checkStuckTasks(now: number): void {
    for (const taskId of getActiveTaskIds()) {
      checkSingleTaskStuck(taskId, now);
    }
  }

  function checkSingleTaskStuck(taskId: string, now: number): void {
    const task = taskEngine.getTask(taskId);
    if (!task?.started_at) {
      return;
    }

    const activeElapsed = now - Date.parse(task.started_at);
    const entries =
      activeElapsed > config.stuck_threshold_ms ? sessionMemory.queryJournal(taskId) : [];
    const latestTimestamp =
      entries.length > 0
        ? entries.map((e) => Date.parse(e.timestamp)).reduce((a, b) => Math.max(a, b), 0)
        : null;

    const result = evaluateTaskStuckness(
      activeElapsed,
      latestTimestamp,
      now,
      config.stuck_threshold_ms,
      config.max_active_duration_ms,
    );

    if (result) {
      emitStuckDetected(taskId, result.condition, result.elapsedMs);
    }
  }

  function emitStuckDetected(
    taskId: string,
    condition: "no_journal_entries" | "no_state_transition" | "orchestrator_crash",
    elapsedMs: number,
  ): void {
    eventBus.publish({
      type: EventTypes["health.stuck_detected"],
      source: "daemon",
      task_id: taskId,
      payload: {
        task_id: taskId,
        condition,
        threshold_ms:
          condition === "no_state_transition"
            ? config.max_active_duration_ms
            : config.stuck_threshold_ms,
        elapsed_ms: elapsedMs,
        last_activity: null,
      },
    } satisfies PublishInput<"health.stuck_detected">);
    observer.warn("Stuck task detected", { taskId, condition, elapsedMs });
  }

  // ── Blocked Escalation ──────────────────────────────────────────────────

  function checkBlockedEscalation(now: number): void {
    const blockedTasks = taskEngine.getTasksByState(TaskStates.blocked);
    const timeoutPolicy = safetyLayer.getTimeoutPolicy();
    const stages = timeoutPolicy.blocked.stages;

    // Clean up escalation state for tasks no longer blocked (Set for O(1) lookup)
    const blockedIds = new Set(blockedTasks.map((t) => t.id));
    for (const taskId of blockedEscalationState.keys()) {
      if (!blockedIds.has(taskId)) {
        blockedEscalationState.delete(taskId);
      }
    }

    for (const task of blockedTasks) {
      if (!task.last_transition_at) {
        continue;
      }
      const elapsedMs = now - Date.parse(task.last_transition_at);
      processBlockedStages(task.id, task.title, elapsedMs, stages, now);
    }
  }

  function processBlockedStages(
    taskId: string,
    taskTitle: string,
    elapsedMs: number,
    stages: Array<{
      name: string;
      after_ms: number;
      action: string;
      repeat: boolean | null;
      repeat_interval_ms: number | null;
    }>,
    now: number,
  ): void {
    const state = blockedEscalationState.get(taskId) ?? { lastStageIndex: -1, lastActionAt: 0 };

    for (let i = 0; i < stages.length; i++) {
      const stage = stages[i];
      if (!stage || elapsedMs < stage.after_ms) {
        continue;
      }

      if (!shouldFireStage(i, stage, state, now)) {
        continue;
      }

      executeBlockedStageAction(taskId, taskTitle, stage);
      blockedEscalationState.set(taskId, { lastStageIndex: i, lastActionAt: now });
    }
  }

  function shouldFireStage(
    stageIndex: number,
    stage: { repeat: boolean | null; repeat_interval_ms: number | null },
    state: { lastStageIndex: number; lastActionAt: number },
    now: number,
  ): boolean {
    if (stageIndex > state.lastStageIndex) {
      return true; // New stage not yet reached
    }
    // Already processed — only re-fire if repeatable and interval elapsed
    if (stage.repeat && stage.repeat_interval_ms) {
      return now - state.lastActionAt >= stage.repeat_interval_ms;
    }
    return false;
  }

  function executeBlockedStageAction(
    taskId: string,
    taskTitle: string,
    stage: { name: string; action: string },
  ): void {
    if (stage.action === "send_reminder") {
      notifications.sendBlockedReminder(taskId, taskTitle);
      observer.info("Blocked task reminder sent", { taskId, stage: stage.name });
    } else if (stage.action === "evaluate_self_unblock") {
      orchestrator.attemptSelfUnblock(taskId).then(
        (resolved) => {
          if (resolved) {
            taskEngine.requestTransition(
              taskId,
              TaskStates.active,
              SubStates.working,
              "self_unblocked",
              "daemon",
            );
            blockedEscalationState.delete(taskId);
            observer.info("Task self-unblocked", { taskId });
          } else {
            observer.info("Self-unblock check failed — continuing escalation", { taskId });
          }
        },
        (err) => {
          observer.error("Self-unblock check error", { taskId, err });
        },
      );
    } else if (stage.action === "escalation_alert") {
      taskEngine.requestTransition(
        taskId,
        TaskStates.failed,
        null,
        "blocked_timeout_escalation",
        "daemon",
      );
      notifications.sendEscalationAlert(taskId, taskTitle);
      blockedEscalationState.delete(taskId);
      observer.warn("Blocked task escalated to failed", { taskId, stage: stage.name });
    }
  }

  // ── Review Pending Reminders ────────────────────────────────────────────

  function checkReviewPendingReminders(now: number, prefetchedTasks?: Task[]): void {
    const reviewPendingTasks =
      prefetchedTasks ?? taskEngine.getTasksByState(TaskStates.review_pending);
    const timeoutPolicy = safetyLayer.getTimeoutPolicy();
    const reviewConfig = timeoutPolicy.review_pending;

    cleanupStaleReminderTimes(reviewPendingTasks);

    for (const task of reviewPendingTasks) {
      evaluateReviewReminder(task, reviewConfig, now);
    }
  }

  function cleanupStaleReminderTimes(activeTasks: Array<{ id: string }>): void {
    const activeIds = new Set(activeTasks.map((t) => t.id));
    for (const taskId of reviewReminderTimes.keys()) {
      if (!activeIds.has(taskId)) {
        reviewReminderTimes.delete(taskId);
      }
    }
  }

  function evaluateReviewReminder(
    task: { id: string; title: string; last_transition_at: string },
    reviewConfig: { reminder_after_ms: number; repeat_interval_ms: number },
    now: number,
  ): void {
    if (!task.last_transition_at) {
      return;
    }

    const elapsedMs = now - Date.parse(task.last_transition_at);
    if (elapsedMs < reviewConfig.reminder_after_ms) {
      return;
    }

    const lastReminder = reviewReminderTimes.get(task.id) ?? 0;
    if (now - lastReminder < reviewConfig.repeat_interval_ms) {
      return;
    }

    notifications.sendReviewReminder(task.id, task.title, elapsedMs);
    reviewReminderTimes.set(task.id, now);
  }

  // ── Cost Limit Processing ───────────────────────────────────────────────

  function processCostLimits(): void {
    if (costLimitTasks.length === 0) {
      return;
    }

    // Drain and clear in one pass (FIFO order)
    const pending = costLimitTasks.splice(0);
    for (const taskId of pending) {
      const task = taskEngine.getTask(taskId);
      if (task && task.state === TaskStates.active) {
        observer.warn("Task blocked due to cost limit", { taskId });
        taskEngine.requestTransition(
          taskId,
          TaskStates.blocked,
          null,
          "cost_limit_reached",
          "daemon",
        );
        notifications.sendCostLimit(taskId, task.title);
        notifications.commentOnTaskIssue(taskId, "Task blocked \u2014 cost limit reached.");
      }
    }
  }

  function addCostLimitTask(taskId: string): void {
    costLimitTasks.push(taskId);
  }

  return {
    checkStuckTasks,
    checkBlockedEscalation,
    checkReviewPendingReminders,
    processCostLimits,
    addCostLimitTask,
  };
}
