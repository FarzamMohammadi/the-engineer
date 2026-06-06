import { TimeoutStageActions } from "../../schemas/config.js";
import { EventTypes } from "../../schemas/events.js";
import { NotificationKinds } from "../../schemas/notifications.js";
import { ObservationTypes } from "../../schemas/observer.js";
import { BlockCategories, BlockReasons, SubStates, type Task, TaskStates } from "../../schemas/task.js";
import type { PublishInput } from "../interfaces/event-bus.interface.js";
import type { NotificationRouter } from "./notification-router.js";
import type { HealthMonitorContext } from "./types.js";

// ── Pure Functions ────────────────────────────────────────────────────────────

/** The condition under which an active task is judged stuck. */
type StuckCondition = "no_journal_entries" | "stale_journal" | "no_state_transition";

/** Check if an active task is stuck based on journal entry staleness. Returns null if not stuck. */
export function evaluateTaskStuckness(
  activeElapsedMs: number,
  latestEntryTimestamp: number | null,
  nowMs: number,
  stuckThresholdMs: number,
  maxActiveDurationMs: number,
): { condition: StuckCondition; elapsedMs: number } | null {
  if (activeElapsedMs > maxActiveDurationMs) {
    return { condition: "no_state_transition", elapsedMs: activeElapsedMs };
  }

  if (activeElapsedMs > stuckThresholdMs) {
    if (latestEntryTimestamp === null) {
      return { condition: "no_journal_entries", elapsedMs: activeElapsedMs };
    }
    const staleness = nowMs - latestEntryTimestamp;
    if (staleness > stuckThresholdMs) {
      return { condition: "stale_journal", elapsedMs: staleness };
    }
  }

  return null;
}

// ── DaemonHealthMonitor Interface ────────────────────────────────────────────

/** Monitors task health: stuck detection, blocked escalation, review reminders. */
export interface DaemonHealthMonitor {
  /** Check stuck tasks for active dispatches. */
  checkStuckTasks(now: number): void;
  /** Check blocked task escalation. */
  checkBlockedEscalation(now: number): void;
  /** Check review pending reminders. Pre-fetched tasks avoid redundant DB queries. */
  checkReviewPendingReminders(now: number, reviewPendingTasks?: Task[]): void;
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function createDaemonHealthMonitor(
  ctx: HealthMonitorContext,
  notifications: NotificationRouter,
  getActiveTaskIds: () => string[],
): DaemonHealthMonitor {
  const { config, eventBus, taskEngine, safetyLayer, orchestrator, sessionMemory, observer } = ctx;

  // ── Internal State ──────────────────────────────────────────────────────
  const blockedEscalationState = new Map<string, { lastStageIndex: number; lastActionAt: number }>();
  const reviewReminderTimes = new Map<string, number>();
  // Edge-trigger latch for stuck detection: the condition a task is currently latched as stuck on, or absent
  // when it is not latched. `checkStuckTasks` runs every tick, so without this latch a still-stuck task would
  // re-publish `health.stuck_detected` and re-warn EVERY tick — the heartbeat anti-pattern §14 forbids
  // ("every tick a plugin is still down buries the real transition under repeats"). We emit once on the
  // crossing into stuck (or when the condition escalates, e.g. stale_journal → no_state_transition) and
  // re-arm only when the task is no longer active or no longer stuck.
  const stuckLatch = new Map<string, StuckCondition>();

  // ── Stuck Detection ─────────────────────────────────────────────────────

  function checkStuckTasks(now: number): void {
    const activeTaskIds = new Set(getActiveTaskIds());
    for (const taskId of activeTaskIds) {
      checkSingleTaskStuck(taskId, now);
    }
    // Re-arm the latch for any task that left the active set (completed, blocked, terminated): its next stuck
    // episode must emit a fresh crossing. Prevents the map from leaking entries for long-gone tasks, too.
    for (const taskId of stuckLatch.keys()) {
      if (!activeTaskIds.has(taskId)) {
        stuckLatch.delete(taskId);
      }
    }
  }

  function checkSingleTaskStuck(taskId: string, now: number): void {
    const task = taskEngine.getTask(taskId);
    if (!task?.started_at) {
      return;
    }

    const activeElapsed = now - Date.parse(task.started_at);
    const latestTimestampStr =
      activeElapsed > config.stuck_threshold_ms ? sessionMemory.journal.getLatestTimestamp(taskId) : null;
    const latestTimestamp = latestTimestampStr ? Date.parse(latestTimestampStr) : null;

    const result = evaluateTaskStuckness(
      activeElapsed,
      latestTimestamp,
      now,
      config.stuck_threshold_ms,
      config.max_active_duration_ms,
    );

    if (!result) {
      // No longer stuck — re-arm so a future stuck episode emits a fresh crossing.
      stuckLatch.delete(taskId);
      return;
    }

    // Edge-trigger: emit only on the crossing into stuck, or when the condition genuinely escalates to a
    // different (worse) condition. A still-stuck task on the same condition stays silent until it changes.
    if (stuckLatch.get(taskId) === result.condition) {
      return;
    }
    stuckLatch.set(taskId, result.condition);
    // last_activity is meaningful only for stale_journal — the timestamp of the last journal entry that went
    // stale. no_journal_entries has no activity to point at, and no_state_transition fires on total runtime,
    // not journal staleness, so both stay null rather than report a misleading time.
    const lastActivity = result.condition === "stale_journal" ? latestTimestampStr : null;
    emitStuckDetected(taskId, result.condition, result.elapsedMs, lastActivity);
  }

  function emitStuckDetected(
    taskId: string,
    condition: StuckCondition,
    elapsedMs: number,
    lastActivity: string | null,
  ): void {
    const thresholdMs = condition === "no_state_transition" ? config.max_active_duration_ms : config.stuck_threshold_ms;
    eventBus.publish({
      type: EventTypes["health.stuck_detected"],
      source: "daemon",
      task_id: taskId,
      payload: {
        task_id: taskId,
        condition,
        threshold_ms: thresholdMs,
        elapsed_ms: elapsedMs,
        last_activity: lastActivity,
      },
    } satisfies PublishInput<"health.stuck_detected">);
    // Dashboard-observer surface: the stuck verdict on the task's trace timeline (the durable event is the
    // audit trail; this is what the owner watching the dashboard sees). Edge-triggered with the event above.
    observer.observe(
      ObservationTypes.state_transition,
      "task_stuck_detected",
      { task_id: taskId, condition, elapsed_ms: elapsedMs, threshold_ms: thresholdMs, last_activity: lastActivity },
      { task_id: taskId, level: "warn" },
    );
    observer.warn("Stuck task detected", { taskId, condition, elapsedMs, thresholdMs });
  }

  // ── Blocked Escalation ──────────────────────────────────────────────────

  function checkBlockedEscalation(now: number): void {
    // Exclude tasks awaiting PR review: pr_review_pending is expected waiting, not stuck.
    // Their reminders run separately in checkReviewPendingReminders; escalating them would
    // wrongly self-unblock and eventually fail a healthy PR sitting in review.
    const blockedTasks = taskEngine
      .getTasksByState(TaskStates.blocked)
      .filter((task) => task.blocked?.reason !== BlockReasons.pr_review_pending);
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
      processBlockedStages(task.id, task.blocked?.category ?? null, elapsedMs, stages, now);
    }
  }

  function processBlockedStages(
    taskId: string,
    blockCategory: string | null,
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

      executeBlockedStageAction(taskId, blockCategory, stage);
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
    blockCategory: string | null,
    stage: { name: string; action: string },
  ): void {
    if (stage.action === TimeoutStageActions.send_reminder) {
      notifications.notify({ kind: NotificationKinds.blocked_reminder, taskId });
      observer.info("Blocked task reminder sent", { taskId, stage: stage.name });
    } else if (stage.action === TimeoutStageActions.evaluate_self_unblock) {
      // A discretionary autonomy block (the owner's policy asked them to confirm a decision the agent
      // made) must NOT be auto-resolved: only the owner can decide. Reminders and the final escalation
      // still fire — just not the self-unblock auto-resume. A genuine "stuck, needs info" block is still
      // eligible (the agent may be able to diagnose it).
      if (blockCategory === BlockCategories.awaiting_human_decision) {
        observer.info("Skipping self-unblock for a discretionary decision block — only the owner can decide", {
          taskId,
          stage: stage.name,
        });
        return;
      }
      orchestrator.attemptSelfUnblock(taskId).then(
        (resolved) => {
          if (resolved) {
            const result = taskEngine.requestTransition(
              taskId,
              TaskStates.active,
              SubStates.working,
              "self_unblocked",
              "daemon",
            );
            if (result.success) {
              taskEngine.updateTaskField(taskId, "blocked", null);
              blockedEscalationState.delete(taskId);
              observer.info("Task self-unblocked", { taskId });
            } else {
              observer.warn("Self-unblock transition failed — keeping escalation state", {
                taskId,
                reason: result.reason,
              });
            }
          } else {
            observer.info("Self-unblock check failed — continuing escalation", { taskId });
          }
        },
        (err) => {
          observer.error("Self-unblock check error", { taskId, err });
        },
      );
    } else if (stage.action === TimeoutStageActions.escalation_alert) {
      const result = taskEngine.requestTransition(
        taskId,
        TaskStates.failed,
        null,
        "blocked_timeout_escalation",
        "daemon",
      );
      if (result.success) {
        notifications.notify({ kind: NotificationKinds.escalation_alert, taskId });
        blockedEscalationState.delete(taskId);
        observer.warn("Blocked task escalated to failed", { taskId, stage: stage.name });
      } else {
        observer.warn("Escalation transition failed — skipping notifications", {
          taskId,
          reason: result.reason,
        });
      }
    }
  }

  // ── Review Pending Reminders ────────────────────────────────────────────

  function checkReviewPendingReminders(now: number, prefetchedTasks?: Task[]): void {
    const reviewPendingTasks = prefetchedTasks ?? taskEngine.getBlockedTasksByReason(BlockReasons.pr_review_pending);
    const timeoutPolicy = safetyLayer.getTimeoutPolicy();
    const reviewConfig = timeoutPolicy.review_pending;

    cleanupStaleReminderTimes(reviewPendingTasks);

    for (const task of reviewPendingTasks) {
      evaluateReviewReminder(task, reviewConfig, now);
    }
  }

  function cleanupStaleReminderTimes(currentTasks: Array<{ id: string }>): void {
    const currentIds = new Set(currentTasks.map((t) => t.id));
    for (const taskId of reviewReminderTimes.keys()) {
      if (!currentIds.has(taskId)) {
        reviewReminderTimes.delete(taskId);
      }
    }
  }

  function evaluateReviewReminder(
    task: { id: string; last_transition_at: string },
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

    notifications.notify({ kind: NotificationKinds.review_reminder, taskId: task.id, elapsedMs });
    reviewReminderTimes.set(task.id, now);
    observer.info("Review pending reminder sent", {
      taskId: task.id,
      elapsedMs,
      elapsedHours: Math.floor(elapsedMs / 3_600_000),
    });
  }

  return {
    checkStuckTasks,
    checkBlockedEscalation,
    checkReviewPendingReminders,
  };
}
