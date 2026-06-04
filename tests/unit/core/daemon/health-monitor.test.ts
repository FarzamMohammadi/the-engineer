import { describe, expect, it, vi } from "vitest";

import { createDaemonHealthMonitor } from "../../../../src/core/daemon/health-monitor.js";
import type { NotificationRouter } from "../../../../src/core/daemon/notification-router.js";
import type { HealthMonitorContext } from "../../../../src/core/daemon/types.js";
import { type DaemonConfig, TimeoutStageActions } from "../../../../src/schemas/config.js";
import { EventTypes } from "../../../../src/schemas/events.js";
import { NotificationKinds } from "../../../../src/schemas/notifications.js";
import { BlockReasons, SubStates, TaskStates } from "../../../../src/schemas/task.js";
import { createTestObserverFacade } from "../../../helpers/test-observer-facade.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeDaemonConfig(overrides?: Partial<DaemonConfig>): DaemonConfig {
  return {
    max_concurrent: 2,
    tick_interval_ms: 5_000,
    preemption_threshold: 20,
    preemption_timeout_ms: 30_000,
    stuck_threshold_ms: 1_800_000,
    max_active_duration_ms: 28_800_000,
    shutdown_timeout_ms: 10_000,
    trigger_poll_interval_ms: 60_000,
    response_poll_interval_ms: 5000,
    seen_keys_ttl_ms: 3_600_000,
    logging: {
      level: "error",
      dir: "/tmp/test-logs",
      max_size_bytes: 10_485_760,
      max_files: 5,
      console: false,
    },
    plugins: {
      dirs: [],
      health_check_interval_ms: 30_000,
      health_check_timeout_ms: 5_000,
      consecutive_failures_threshold: 3,
    },
    subscriber_warn_threshold_ms: 50,
    data_lifecycle: {
      enabled: false,
      interval_ms: 3_600_000,
      retention: {
        events: { max_age_days: 90 },
        observations: { max_age_days: 90 },
        journal_entries: { max_age_days: 90 },
        checkpoints: { max_age_days: 90 },
      },
    },
    workspace_reaper: { enabled: false, interval_ms: 3_600_000 },
    database: { cache_size_mb: 64 },
    notification_retry: { interval_ms: 30_000, max_attempts: 120, max_age_ms: 3_600_000 },
    review_polling: { failure_window_ms: 300_000, max_failures_before_pause: 3, max_blocker_reentries: 3 },
    retry_policy: {
      crash: { backoff_minutes: [1, 5, 15, 30, 30], max_attempts: 5 },
      agent_unavailable: { backoff_minutes: [2, 5, 10, 15, 15], max_attempts: 5 },
    },
    evaluation: { enabled: false },
    telemetry: { enabled: false, endpoint: "http://localhost:4318", ui_base: "http://localhost:16686" },
    ...overrides,
  };
}

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "task-1",
    title: "Test task",
    state: TaskStates.active,
    sub_state: SubStates.working,
    priority: 50,
    started_at: new Date(1_000_000).toISOString(),
    last_transition_at: new Date(1_000_000).toISOString(),
    created_at: new Date(0).toISOString(),
    updated_at: new Date(1_000_000).toISOString(),
    ...overrides,
  };
}

function makeNotifications(): NotificationRouter {
  return {
    notify: vi.fn(),
    syncStateToCommPlugin: vi.fn(),
  };
}

function makeTimeoutPolicy() {
  return {
    blocked: {
      stages: [
        {
          name: "reminder",
          after_ms: 14_400_000,
          action: TimeoutStageActions.send_reminder,
          repeat: true,
          repeat_interval_ms: 14_400_000,
        },
        {
          name: "self_unblock",
          after_ms: 28_800_000,
          action: TimeoutStageActions.evaluate_self_unblock,
          repeat: null,
          repeat_interval_ms: null,
        },
        {
          name: "escalation",
          after_ms: 172_800_000,
          action: TimeoutStageActions.escalation_alert,
          repeat: null,
          repeat_interval_ms: null,
        },
      ],
    },
    review_pending: {
      reminder_after_ms: 86_400_000,
      repeat_interval_ms: 86_400_000,
    },
  };
}

function makeContext(configOverrides?: Partial<DaemonConfig>) {
  const eventBus = { publish: vi.fn() };
  const taskEngine = {
    getTask: vi.fn().mockReturnValue(null),
    getTasksByState: vi.fn().mockReturnValue([]),
    getBlockedTasksByReason: vi.fn().mockReturnValue([]),
    requestTransition: vi.fn().mockReturnValue({ success: true }),
  };
  const safetyLayer = {
    getTimeoutPolicy: vi.fn().mockReturnValue(makeTimeoutPolicy()),
    flushCostSnapshot: vi.fn(),
  };
  const orchestrator = {
    attemptSelfUnblock: vi.fn().mockResolvedValue(false),
  };
  const sessionMemory = {
    journal: {
      query: vi.fn().mockReturnValue([]),
      getLatestTimestamp: vi.fn().mockReturnValue(null),
    },
  };

  const ctx: HealthMonitorContext = {
    config: makeDaemonConfig(configOverrides),
    eventBus: eventBus as unknown as HealthMonitorContext["eventBus"],
    taskEngine: taskEngine as unknown as HealthMonitorContext["taskEngine"],
    safetyLayer: safetyLayer as unknown as HealthMonitorContext["safetyLayer"],
    orchestrator: orchestrator as unknown as HealthMonitorContext["orchestrator"],
    sessionMemory: sessionMemory as unknown as HealthMonitorContext["sessionMemory"],
    clock: { now: () => Date.now() },
    observer: createTestObserverFacade("daemon"),
  };

  return { ctx, eventBus, taskEngine, safetyLayer, orchestrator, sessionMemory };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("DaemonHealthMonitor", () => {
  // ── Stuck Detection ──────────────────────────────────────────────────────

  describe("checkStuckTasks", () => {
    it("emits stuck_detected for tasks with no journal entries past threshold", () => {
      const { ctx, eventBus, taskEngine, sessionMemory } = makeContext({
        stuck_threshold_ms: 1_800_000,
      });

      const now = 1_000_000 + 2_000_000; // 2_000_000ms after started_at (> 1_800_000 threshold)
      const task = makeTask({ started_at: new Date(1_000_000).toISOString() });
      taskEngine.getTask.mockReturnValue(task);
      sessionMemory.journal.getLatestTimestamp.mockReturnValue(null);

      const notifications = makeNotifications();
      const getActiveTaskIds = vi.fn(() => ["task-1"]);

      const hm = createDaemonHealthMonitor(ctx, notifications, getActiveTaskIds);
      hm.checkStuckTasks(now);

      expect(eventBus.publish).toHaveBeenCalledOnce();
      expect(eventBus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          type: EventTypes["health.stuck_detected"],
          task_id: "task-1",
          payload: expect.objectContaining({
            task_id: "task-1",
            condition: "no_journal_entries",
          }),
        }),
      );
    });

    it("emits stuck_detected for tasks exceeding max active duration", () => {
      const { ctx, eventBus, taskEngine, sessionMemory } = makeContext({
        stuck_threshold_ms: 1_800_000,
        max_active_duration_ms: 28_800_000,
      });

      const startedAt = 1_000_000;
      const now = startedAt + 30_000_000; // 30M ms > 28_800_000 max active duration
      const task = makeTask({ started_at: new Date(startedAt).toISOString() });
      taskEngine.getTask.mockReturnValue(task);
      // Recent journal timestamp (not stale), but total duration exceeded
      sessionMemory.journal.getLatestTimestamp.mockReturnValue(new Date(now - 100_000).toISOString());

      const notifications = makeNotifications();
      const getActiveTaskIds = vi.fn(() => ["task-1"]);

      const hm = createDaemonHealthMonitor(ctx, notifications, getActiveTaskIds);
      hm.checkStuckTasks(now);

      expect(eventBus.publish).toHaveBeenCalledOnce();
      expect(eventBus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          type: EventTypes["health.stuck_detected"],
          payload: expect.objectContaining({
            condition: "no_state_transition",
            threshold_ms: 28_800_000,
          }),
        }),
      );
    });

    it("does not emit for healthy active tasks within thresholds", () => {
      const { ctx, eventBus, taskEngine } = makeContext({
        stuck_threshold_ms: 1_800_000,
        max_active_duration_ms: 28_800_000,
      });

      const startedAt = 1_000_000;
      const now = startedAt + 1_000_000; // 1M ms < 1_800_000 threshold
      const task = makeTask({ started_at: new Date(startedAt).toISOString() });
      taskEngine.getTask.mockReturnValue(task);

      const notifications = makeNotifications();
      const getActiveTaskIds = vi.fn(() => ["task-1"]);

      const hm = createDaemonHealthMonitor(ctx, notifications, getActiveTaskIds);
      hm.checkStuckTasks(now);

      expect(eventBus.publish).not.toHaveBeenCalled();
    });
  });

  // ── Blocked Escalation ───────────────────────────────────────────────────

  describe("checkBlockedEscalation", () => {
    it("fires send_reminder at first stage", () => {
      const { ctx, taskEngine } = makeContext();
      const notifications = makeNotifications();

      const transitionTime = 1_000_000;
      const now = transitionTime + 15_000_000; // 15M ms > 14_400_000 reminder threshold
      const task = makeTask({
        id: "blocked-1",
        title: "Blocked task",
        state: TaskStates.blocked,
        last_transition_at: new Date(transitionTime).toISOString(),
      });
      taskEngine.getTasksByState.mockReturnValue([task]);

      const getActiveTaskIds = vi.fn(() => []);
      const hm = createDaemonHealthMonitor(ctx, notifications, getActiveTaskIds);
      hm.checkBlockedEscalation(now);

      expect(notifications.notify).toHaveBeenCalledWith(
        expect.objectContaining({ kind: NotificationKinds.blocked_reminder, taskId: "blocked-1" }),
      );
    });

    it("fires evaluate_self_unblock at second stage", async () => {
      const { ctx, taskEngine, orchestrator } = makeContext();
      const notifications = makeNotifications();

      const transitionTime = 1_000_000;
      const now = transitionTime + 29_000_000; // 29M ms > 28_800_000 self_unblock threshold
      const task = makeTask({
        id: "blocked-2",
        title: "Blocked task 2",
        state: TaskStates.blocked,
        last_transition_at: new Date(transitionTime).toISOString(),
      });
      taskEngine.getTasksByState.mockReturnValue([task]);
      orchestrator.attemptSelfUnblock.mockResolvedValue(false);

      const getActiveTaskIds = vi.fn(() => []);
      const hm = createDaemonHealthMonitor(ctx, notifications, getActiveTaskIds);
      hm.checkBlockedEscalation(now);

      expect(orchestrator.attemptSelfUnblock).toHaveBeenCalledWith("blocked-2");
      // Also fires reminder since elapsed > reminder threshold too
      expect(notifications.notify).toHaveBeenCalledWith(
        expect.objectContaining({ kind: NotificationKinds.blocked_reminder }),
      );
    });

    it("fires escalation_alert at third stage and transitions to failed", () => {
      const { ctx, taskEngine } = makeContext();
      const notifications = makeNotifications();

      const transitionTime = 1_000_000;
      const now = transitionTime + 173_000_000; // 173M ms > 172_800_000 escalation threshold
      const task = makeTask({
        id: "blocked-3",
        title: "Blocked task 3",
        state: TaskStates.blocked,
        last_transition_at: new Date(transitionTime).toISOString(),
      });
      taskEngine.getTasksByState.mockReturnValue([task]);

      const getActiveTaskIds = vi.fn(() => []);
      const hm = createDaemonHealthMonitor(ctx, notifications, getActiveTaskIds);
      hm.checkBlockedEscalation(now);

      expect(notifications.notify).toHaveBeenCalledWith(
        expect.objectContaining({ kind: NotificationKinds.escalation_alert, taskId: "blocked-3" }),
      );
      expect(taskEngine.requestTransition).toHaveBeenCalledWith(
        "blocked-3",
        TaskStates.failed,
        null,
        "blocked_timeout_escalation",
        "daemon",
      );
    });

    it("never escalates a PR-review-pending task — it resumes via PR events, not the escalation ladder", () => {
      const { ctx, taskEngine } = makeContext();
      const notifications = makeNotifications();

      const transitionTime = 1_000_000;
      const now = transitionTime + 173_000_000; // past the escalation-to-failed stage
      const task = makeTask({
        id: "review-pending-1",
        state: TaskStates.blocked,
        blocked: {
          reason: BlockReasons.pr_review_pending,
          category: "awaiting_pr_review",
          sub_phase: "await-review",
          needed: "waiting on the PR",
        },
        last_transition_at: new Date(transitionTime).toISOString(),
      });
      taskEngine.getTasksByState.mockReturnValue([task]);

      const getActiveTaskIds = vi.fn(() => []);
      const hm = createDaemonHealthMonitor(ctx, notifications, getActiveTaskIds);
      hm.checkBlockedEscalation(now);

      expect(notifications.notify).not.toHaveBeenCalled();
      expect(taskEngine.requestTransition).not.toHaveBeenCalled();
    });

    it("cleans up escalation state for tasks no longer blocked", () => {
      const { ctx, taskEngine } = makeContext();
      const notifications = makeNotifications();

      const transitionTime = 1_000_000;
      const task = makeTask({
        id: "blocked-cleanup",
        title: "Will unblock",
        state: TaskStates.blocked,
        last_transition_at: new Date(transitionTime).toISOString(),
      });

      // First call: task is blocked, fires reminder
      taskEngine.getTasksByState.mockReturnValue([task]);
      const getActiveTaskIds = vi.fn(() => []);
      const hm = createDaemonHealthMonitor(ctx, notifications, getActiveTaskIds);
      const now1 = transitionTime + 15_000_000;
      hm.checkBlockedEscalation(now1);
      expect(notifications.notify).toHaveBeenCalledOnce();

      // Second call: task is no longer blocked (empty list)
      taskEngine.getTasksByState.mockReturnValue([]);
      const now2 = now1 + 15_000_000;
      hm.checkBlockedEscalation(now2);

      // Third call: task comes back as blocked — should fire reminder again (state was cleaned)
      taskEngine.getTasksByState.mockReturnValue([task]);
      const now3 = now2 + 15_000_000;
      hm.checkBlockedEscalation(now3);
      const blockedReminderCalls = (notifications.notify as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c: unknown[]) => (c[0] as { kind: string }).kind === NotificationKinds.blocked_reminder,
      );
      expect(blockedReminderCalls).toHaveLength(2);
    });
  });

  // ── Review Pending Reminders ─────────────────────────────────────────────

  describe("checkReviewPendingReminders", () => {
    it("sends reminder after threshold elapsed", () => {
      const { ctx, taskEngine } = makeContext();
      const notifications = makeNotifications();

      const transitionTime = 1_000_000;
      const now = transitionTime + 87_000_000; // 87M ms > 86_400_000 reminder threshold
      const task = makeTask({
        id: "review-1",
        title: "Review task",
        state: TaskStates.blocked,
        last_transition_at: new Date(transitionTime).toISOString(),
      });
      taskEngine.getBlockedTasksByReason.mockReturnValue([task]);

      const getActiveTaskIds = vi.fn(() => []);
      const hm = createDaemonHealthMonitor(ctx, notifications, getActiveTaskIds);
      hm.checkReviewPendingReminders(now);

      expect(notifications.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: NotificationKinds.review_reminder,
          taskId: "review-1",
          elapsedMs: 87_000_000,
        }),
      );
    });

    it("respects repeat interval — does not fire again too soon", () => {
      const { ctx, taskEngine } = makeContext();
      const notifications = makeNotifications();

      const transitionTime = 1_000_000;
      const task = makeTask({
        id: "review-2",
        title: "Review task 2",
        state: TaskStates.blocked,
        last_transition_at: new Date(transitionTime).toISOString(),
      });
      taskEngine.getBlockedTasksByReason.mockReturnValue([task]);

      const getActiveTaskIds = vi.fn(() => []);
      const hm = createDaemonHealthMonitor(ctx, notifications, getActiveTaskIds);

      const notifyFn = notifications.notify as ReturnType<typeof vi.fn>;
      const countReviewReminders = () =>
        notifyFn.mock.calls.filter(
          (c: unknown[]) => (c[0] as { kind: string }).kind === NotificationKinds.review_reminder,
        ).length;

      // First reminder
      const now1 = transitionTime + 87_000_000;
      hm.checkReviewPendingReminders(now1);
      expect(countReviewReminders()).toBe(1);

      // Too soon for repeat (only 1M ms later, need 86_400_000)
      const now2 = now1 + 1_000_000;
      hm.checkReviewPendingReminders(now2);
      expect(countReviewReminders()).toBe(1); // still 1

      // After repeat interval
      const now3 = now1 + 86_400_000;
      hm.checkReviewPendingReminders(now3);
      expect(countReviewReminders()).toBe(2);
    });
  });
});
