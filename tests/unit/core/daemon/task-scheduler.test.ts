import { describe, expect, it, vi } from "vitest";

import type { NotificationRouter } from "../../../../src/core/daemon/notification-router.js";
import { type SchedulerCallbacks, createTaskScheduler } from "../../../../src/core/daemon/task-scheduler.js";
import type { TaskSchedulerContext } from "../../../../src/core/daemon/types.js";
import { createDispatchTracker } from "../../../../src/core/dispatch-tracker/index.js";
import type { ExecuteTaskResult } from "../../../../src/core/orchestrator/index.js";
import { createRetryPolicy } from "../../../../src/core/retry-policy/index.js";
import type { DaemonConfig } from "../../../../src/schemas/config.js";
import { EventTypes } from "../../../../src/schemas/events.js";
import { NotificationKinds } from "../../../../src/schemas/notifications.js";
import { BlockReasons, SubStates, type Task, TaskStates } from "../../../../src/schemas/task.js";
import { createTestObserverFacade } from "../../../helpers/test-observer-facade.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeDaemonConfig(overrides?: Partial<DaemonConfig>): DaemonConfig {
  return {
    max_concurrent: 2,
    tick_interval_ms: 5_000,
    preemption_threshold: 20,
    preemption_timeout_ms: 30_000,
    stuck_threshold_ms: 600_000,
    max_active_duration_ms: 3_600_000,
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
    review_polling: { failure_window_ms: 300_000, max_failures_before_pause: 3 },
    retry_policy: {
      crash: { backoff_minutes: [1, 5, 15, 30, 30], max_attempts: 5 },
      agent_unavailable: { backoff_minutes: [2, 5, 10, 15, 15], max_attempts: 5 },
    },
    evaluation: { enabled: false },
    ...overrides,
  };
}

function makeMockTask(overrides?: Record<string, unknown>): Task {
  return {
    id: "task-001",
    title: "Test task",
    state: TaskStates.queued,
    sub_state: null,
    priority: 50,
    workspace: null,
    review: null,
    created_at: new Date(1_000_000).toISOString(),
    started_at: null,
    decisions: [],
    description: "A test task",
    external_ref: null,
    not_before: null,
    consecutive_crash_count: 0,
    ...overrides,
  } as unknown as Task;
}

function makeNotifications(): NotificationRouter {
  return {
    notify: vi.fn(),
    syncStateToCommPlugin: vi.fn(),
  };
}

function makeCallbacks(): SchedulerCallbacks & Record<string, ReturnType<typeof vi.fn>> {
  return {
    onTaskCompleted: vi.fn(),
    onTaskError: vi.fn(),
  };
}

function makeContext(configOverrides?: Partial<DaemonConfig>) {
  const eventBus = { publish: vi.fn() };
  const taskEngine = {
    getQueuedByPriority: vi.fn().mockReturnValue([]),
    getTask: vi.fn().mockReturnValue(null),
    getTasksByState: vi.fn().mockReturnValue([]),
    requestTransition: vi.fn().mockReturnValue({ success: true }),
    updateTaskField: vi.fn(),
  };
  const orchestrator = {
    executeTask: vi.fn().mockResolvedValue({ outcome: "completed" }),
  };
  const sessionMemory = {
    checkpoints: {
      getLatest: vi.fn().mockReturnValue(null),
    },
  };
  const workspaceManager = {
    cleanupWorkspace: vi.fn(),
  };
  const clock = { now: vi.fn().mockReturnValue(Date.now()) };

  const ctx = {
    config: makeDaemonConfig(configOverrides),
    eventBus,
    taskEngine,
    orchestrator,
    sessionMemory,
    workspaceManager,
    clock,
    observer: createTestObserverFacade("daemon"),
  } as unknown as TaskSchedulerContext;

  return { ctx, eventBus, taskEngine, orchestrator, sessionMemory, workspaceManager, clock };
}

/** Flush microtask queue so fire-and-forget promises resolve. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Build a scheduler with the standard retry-policy and dispatch-tracker dependencies.
 * Centralized so tests don't have to repeat the wiring per call.
 */
function makeScheduler(
  ctx: TaskSchedulerContext,
  notifications: NotificationRouter,
  callbacks: SchedulerCallbacks,
): ReturnType<typeof createTaskScheduler> {
  const retryPolicy = createRetryPolicy({
    config: ctx.config,
    taskEngine: ctx.taskEngine,
    clock: ctx.clock,
    observer: ctx.observer,
  });
  const dispatchTracker = createDispatchTracker({ observer: ctx.observer });
  return createTaskScheduler(ctx, notifications, callbacks, retryPolicy, dispatchTracker);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("TaskScheduler", () => {
  // 1. scheduleNext dispatches eligible queued tasks up to available slots
  it("scheduleNext dispatches eligible queued tasks up to available slots", () => {
    const { ctx, taskEngine } = makeContext({ max_concurrent: 2 });
    const notifications = makeNotifications();
    const callbacks = makeCallbacks();

    const task1 = makeMockTask({ id: "t1", title: "Task 1" });
    const task2 = makeMockTask({ id: "t2", title: "Task 2" });
    const task3 = makeMockTask({ id: "t3", title: "Task 3" });

    taskEngine.getQueuedByPriority.mockReturnValue([task1, task2, task3]);

    const scheduler = makeScheduler(ctx, notifications, callbacks);
    scheduler.scheduleNext();

    // Should dispatch exactly 2 (max_concurrent)
    expect(ctx.orchestrator.executeTask).toHaveBeenCalledTimes(2);
    expect(scheduler.getActiveTaskIds()).toHaveLength(2);
    expect(scheduler.getActiveTaskIds()).toEqual(["t1", "t2"]);
  });

  // 2. scheduleNext skips when no available slots
  it("scheduleNext skips when no available slots", () => {
    const { ctx, taskEngine, orchestrator } = makeContext({ max_concurrent: 1 });
    const notifications = makeNotifications();
    const callbacks = makeCallbacks();

    const task1 = makeMockTask({ id: "t1" });
    const task2 = makeMockTask({ id: "t2" });

    taskEngine.getQueuedByPriority.mockReturnValue([task1, task2]);

    const scheduler = makeScheduler(ctx, notifications, callbacks);

    // Fill the single slot
    scheduler.scheduleNext();
    expect(orchestrator.executeTask).toHaveBeenCalledTimes(1);

    // Try again — no slots available
    orchestrator.executeTask.mockClear();
    taskEngine.getQueuedByPriority.mockReturnValue([task2]);
    scheduler.scheduleNext();
    expect(orchestrator.executeTask).not.toHaveBeenCalled();
  });

  // 3. dispatchTask transitions to active.working and calls orchestrator.executeTask
  it("dispatchTask transitions to active.working and calls orchestrator.executeTask", () => {
    const { ctx, taskEngine, orchestrator } = makeContext();
    const notifications = makeNotifications();
    const callbacks = makeCallbacks();

    const task = makeMockTask({ id: "t1", title: "Fix bug" });

    const scheduler = makeScheduler(ctx, notifications, callbacks);
    scheduler.dispatchTask(task);

    expect(taskEngine.requestTransition).toHaveBeenCalledWith(
      "t1",
      TaskStates.active,
      SubStates.working,
      "scheduled",
      "daemon",
    );
    expect(orchestrator.executeTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task,
        resume_from: null,
      }),
    );
  });

  // 4. dispatchTask resumes from checkpoint if available
  it("dispatchTask resumes from checkpoint if available", () => {
    const { ctx, taskEngine, sessionMemory } = makeContext();
    const notifications = makeNotifications();
    const callbacks = makeCallbacks();

    const checkpoint = { phase: "execution", data: { step: 3 } };
    sessionMemory.checkpoints.getLatest.mockReturnValue(checkpoint);

    const task = makeMockTask({ id: "t1" });

    const scheduler = makeScheduler(ctx, notifications, callbacks);
    scheduler.dispatchTask(task);

    expect(taskEngine.requestTransition).toHaveBeenCalledWith(
      "t1",
      TaskStates.active,
      SubStates.working,
      "resumed_from_checkpoint",
      "daemon",
    );
    expect(ctx.orchestrator.executeTask).toHaveBeenCalledWith(expect.objectContaining({ resume_from: checkpoint }));
  });

  // 5. handleTaskCompletion on "completed" outcome
  it("handleTaskCompletion on completed outcome transitions, cleans up, and notifies", () => {
    const { ctx, taskEngine, workspaceManager } = makeContext();
    const notifications = makeNotifications();
    const callbacks = makeCallbacks();

    taskEngine.getTask.mockReturnValue(makeMockTask({ id: "t1", title: "Done task" }));

    const scheduler = makeScheduler(ctx, notifications, callbacks);
    // First dispatch to make it active
    const task = makeMockTask({ id: "t1", title: "Done task" });
    scheduler.dispatchTask(task);

    const result: ExecuteTaskResult = { outcome: "completed" };
    scheduler.handleTaskCompletion("t1", result);

    expect(taskEngine.requestTransition).toHaveBeenCalledWith(
      "t1",
      TaskStates.completed,
      null,
      "pipeline_completed",
      "daemon",
    );
    expect(workspaceManager.cleanupWorkspace).toHaveBeenCalledWith("t1", true);
    expect(notifications.notify).toHaveBeenCalledWith(
      expect.objectContaining({ kind: NotificationKinds.completion, taskId: "t1" }),
    );
    expect(notifications.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: NotificationKinds.ticket_comment,
        taskId: "t1",
        message: "Task completed successfully.",
      }),
    );
    expect(scheduler.getTasksCompleted()).toBe(1);
  });

  // 5b. A completed outcome resets both retry counters; a blocked outcome resets only crash,
  // leaving the agent_unavailable counter to handleAgentUnavailableBlocked (which may advance it).
  it("handleTaskCompletion resets both retry counters on completed but only crash on blocked", () => {
    const { ctx, taskEngine } = makeContext();
    const notifications = makeNotifications();
    const callbacks = makeCallbacks();

    const scheduler = makeScheduler(ctx, notifications, callbacks);

    // Completed: both counters reset to 0.
    scheduler.handleTaskCompletion("t1", { outcome: "completed" });
    expect(taskEngine.updateTaskField).toHaveBeenCalledWith("t1", "consecutive_crash_count", 0);
    expect(taskEngine.updateTaskField).toHaveBeenCalledWith("t1", "consecutive_agent_unavailable_count", 0);

    taskEngine.updateTaskField.mockClear();

    // Human-blocked (non-agent_unavailable): crash counter resets, agent_unavailable counter is left alone.
    taskEngine.getTask.mockReturnValue(makeMockTask({ id: "t2", blocked: { reason: BlockReasons.need_more_info } }));
    scheduler.handleTaskCompletion("t2", { outcome: "blocked", phase: "execution", reason: "need_more_info" });
    expect(taskEngine.updateTaskField).toHaveBeenCalledWith("t2", "consecutive_crash_count", 0);
    expect(taskEngine.updateTaskField).not.toHaveBeenCalledWith("t2", "consecutive_agent_unavailable_count", 0);
  });

  // 6. handleTaskCompletion on a blocked(pr_review_pending) outcome
  it("handleTaskCompletion on pr_review_pending blocked outcome notifies the reviewer", () => {
    const { ctx, taskEngine } = makeContext();
    const notifications = makeNotifications();
    const callbacks = makeCallbacks();

    // The phase-runner already blocked the task; the scheduler routes on the reason.
    taskEngine.getTask.mockReturnValue(
      makeMockTask({ id: "t1", title: "PR task", blocked: { reason: BlockReasons.pr_review_pending } }),
    );

    const scheduler = makeScheduler(ctx, notifications, callbacks);
    const task = makeMockTask({ id: "t1" });
    scheduler.dispatchTask(task);

    const result: ExecuteTaskResult = {
      outcome: "blocked",
      phase: "demo_prep",
      reason: "pr_review_pending",
    };
    scheduler.handleTaskCompletion("t1", result);

    expect(notifications.notify).toHaveBeenCalledWith(
      expect.objectContaining({ kind: NotificationKinds.review_pending, taskId: "t1" }),
    );
    expect(notifications.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: NotificationKinds.ticket_comment,
        taskId: "t1",
        message: "Pull request created — awaiting review.",
      }),
    );
  });

  // 7. handleTaskError increments crash count, sets backoff, transitions to queued
  it("handleTaskError increments crash count and schedules backoff retry", () => {
    const { ctx, taskEngine, eventBus, clock } = makeContext();
    const notifications = makeNotifications();
    const callbacks = makeCallbacks();
    const now = 1_700_000_000_000;
    clock.now.mockReturnValue(now);

    // Return a task with 0 crash count
    taskEngine.getTask.mockReturnValue(makeMockTask({ id: "t1", consecutive_crash_count: 0 }));

    const scheduler = makeScheduler(ctx, notifications, callbacks);
    const task = makeMockTask({ id: "t1" });
    scheduler.dispatchTask(task);

    scheduler.handleTaskError("t1", new Error("Orchestrator crashed"));

    // Should increment crash count to 1
    expect(taskEngine.updateTaskField).toHaveBeenCalledWith("t1", "consecutive_crash_count", 1);
    // Should set not_before with 1-minute backoff
    expect(taskEngine.updateTaskField).toHaveBeenCalledWith("t1", "not_before", new Date(now + 60_000).toISOString());
    // Should emit stuck event
    expect(eventBus.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: EventTypes["health.stuck_detected"],
        task_id: "t1",
      }),
    );
    // Should transition to queued with backoff reason
    expect(taskEngine.requestTransition).toHaveBeenCalledWith(
      "t1",
      TaskStates.queued,
      null,
      "crash_recovery_with_backoff",
      "daemon",
    );
    // Note: active-list cleanup is owned by the dispatch-tracker and verified there —
    // calling scheduler.handleTaskError directly bypasses the tracker's settle path.
  });

  // 8b. handleTaskError transitions to failed after max retries
  it("handleTaskError transitions to failed after max crash retries", () => {
    const { ctx, taskEngine } = makeContext();
    const notifications = makeNotifications();
    const callbacks = makeCallbacks();

    // Return a task at max retries (consecutive_crash_count = 4, will become 5)
    taskEngine.getTask.mockReturnValue(makeMockTask({ id: "t1", consecutive_crash_count: 4 }));

    const scheduler = makeScheduler(ctx, notifications, callbacks);
    const task = makeMockTask({ id: "t1" });
    scheduler.dispatchTask(task);

    scheduler.handleTaskError("t1", new Error("Orchestrator crashed"));

    // Should increment crash count to 5
    expect(taskEngine.updateTaskField).toHaveBeenCalledWith("t1", "consecutive_crash_count", 5);
    // Should transition to failed, NOT queued
    expect(taskEngine.requestTransition).toHaveBeenCalledWith(
      "t1",
      TaskStates.failed,
      null,
      expect.stringContaining("max_crash_retries_exceeded"),
      "daemon",
    );
    // Should notify about failure
    expect(notifications.notify).toHaveBeenCalledWith(
      expect.objectContaining({ kind: NotificationKinds.task_error, taskId: "t1" }),
    );
  });

  // 9. isTaskEligible: top-level tasks always eligible
  it("scheduleNext dispatches top-level tasks (no parent_id)", () => {
    const { ctx, taskEngine, orchestrator } = makeContext({ max_concurrent: 1 });
    const notifications = makeNotifications();
    const callbacks = makeCallbacks();

    const task = makeMockTask({ id: "t1", parent_id: null });
    taskEngine.getQueuedByPriority.mockReturnValue([task]);

    const scheduler = makeScheduler(ctx, notifications, callbacks);
    scheduler.scheduleNext();

    expect(orchestrator.executeTask).toHaveBeenCalledTimes(1);
  });

  // 16. dispatchTask aborts when transition fails
  it("dispatchTask does not call orchestrator when transition fails", () => {
    const { ctx, taskEngine, orchestrator } = makeContext();
    const notifications = makeNotifications();
    const callbacks = makeCallbacks();

    taskEngine.requestTransition.mockReturnValue({ success: false, reason: "invalid_transition" });

    const task = makeMockTask({ id: "t1" });

    const scheduler = makeScheduler(ctx, notifications, callbacks);
    scheduler.dispatchTask(task);

    expect(orchestrator.executeTask).not.toHaveBeenCalled();
    expect(scheduler.getActiveTaskIds()).toEqual([]);
  });

  // 20. handleTaskCompletion on terminated/cooperative_preemption transitions back to queued
  it("handleTaskCompletion on terminated/cooperative_preemption transitions back to queued", () => {
    const { ctx, taskEngine } = makeContext();
    const notifications = makeNotifications();
    const callbacks = makeCallbacks();

    taskEngine.getTask.mockReturnValue(makeMockTask({ id: "t1", title: "Preempted task" }));

    const scheduler = makeScheduler(ctx, notifications, callbacks);
    const task = makeMockTask({ id: "t1" });
    scheduler.dispatchTask(task);

    taskEngine.requestTransition.mockClear();

    const result: ExecuteTaskResult = {
      outcome: "terminated",
      reason: "cooperative_preemption",
      lastPhase: "research",
      checkpointId: "cp-1",
    };
    scheduler.handleTaskCompletion("t1", result);

    expect(taskEngine.requestTransition).toHaveBeenCalledWith(
      "t1",
      TaskStates.queued,
      null,
      "cooperative_preemption",
      "daemon",
    );
  });

  // 20b. handleTaskCompletion on terminated/hard_cap_exceeded transitions to failed and alerts owner
  it("handleTaskCompletion on terminated/hard_cap_exceeded transitions to failed and alerts owner", () => {
    const { ctx, taskEngine } = makeContext();
    const notifications = makeNotifications();
    const callbacks = makeCallbacks();

    taskEngine.getTask.mockReturnValue(makeMockTask({ id: "t1", title: "Runaway task" }));

    const scheduler = makeScheduler(ctx, notifications, callbacks);
    const task = makeMockTask({ id: "t1" });
    scheduler.dispatchTask(task);

    taskEngine.requestTransition.mockClear();
    (notifications.notify as ReturnType<typeof vi.fn>).mockClear();

    scheduler.handleTaskCompletion("t1", {
      outcome: "terminated",
      reason: "hard_cap_exceeded",
      lastPhase: "execution",
      checkpointId: null,
    });

    expect(taskEngine.requestTransition).toHaveBeenCalledWith(
      "t1",
      TaskStates.failed,
      null,
      "hard_cap_exceeded",
      "daemon",
    );
    expect(notifications.notify).toHaveBeenCalledWith(
      expect.objectContaining({ kind: NotificationKinds.alert, taskId: "t1" }),
    );
    const alertCall = (notifications.notify as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { message: string };
    expect(alertCall.message).toContain("Runaway task");
    expect(alertCall.message).toContain("minutes of total active time");
    expect(alertCall.message).toContain("engineer retry t1");
    expect(alertCall.message).toContain("root cause");
  });

  // 20c. handleTaskCompletion on terminated/cost_limit_reached transitions to blocked (notifications fired earlier by cost-limit-queue)
  it("handleTaskCompletion on terminated/cost_limit_reached transitions to blocked", () => {
    const { ctx, taskEngine } = makeContext();
    const notifications = makeNotifications();
    const callbacks = makeCallbacks();

    taskEngine.getTask.mockReturnValue(makeMockTask({ id: "t1" }));

    const scheduler = makeScheduler(ctx, notifications, callbacks);
    const task = makeMockTask({ id: "t1" });
    scheduler.dispatchTask(task);

    taskEngine.requestTransition.mockClear();

    scheduler.handleTaskCompletion("t1", {
      outcome: "terminated",
      reason: "cost_limit_reached",
      lastPhase: "execution",
      checkpointId: null,
    });

    expect(taskEngine.requestTransition).toHaveBeenCalledWith(
      "t1",
      TaskStates.blocked,
      null,
      "cost_limit_reached",
      "daemon",
    );
  });

  // 20d. handleTaskCompletion on terminated/graceful_shutdown re-queues for next start
  it("handleTaskCompletion on terminated/graceful_shutdown re-queues for next start", () => {
    const { ctx, taskEngine } = makeContext();
    const notifications = makeNotifications();
    const callbacks = makeCallbacks();

    taskEngine.getTask.mockReturnValue(makeMockTask({ id: "t1" }));

    const scheduler = makeScheduler(ctx, notifications, callbacks);
    const task = makeMockTask({ id: "t1" });
    scheduler.dispatchTask(task);

    taskEngine.requestTransition.mockClear();

    scheduler.handleTaskCompletion("t1", {
      outcome: "terminated",
      reason: "graceful_shutdown",
      lastPhase: "execution",
      checkpointId: null,
    });

    expect(taskEngine.requestTransition).toHaveBeenCalledWith(
      "t1",
      TaskStates.queued,
      null,
      "graceful_shutdown",
      "daemon",
    );
  });

  // 20e. handleTaskCompletion on terminated/user_cancelled observes + notifies, but does NOT re-transition
  it("handleTaskCompletion on terminated/user_cancelled does not re-transition and comments on the ticket", () => {
    const { ctx, taskEngine } = makeContext();
    const notifications = makeNotifications();
    const callbacks = makeCallbacks();

    const scheduler = makeScheduler(ctx, notifications, callbacks);
    const task = makeMockTask({ id: "t1" });
    scheduler.dispatchTask(task);

    // Clear the active.working transition from dispatch — the cancel path must add no further transition.
    taskEngine.requestTransition.mockClear();

    scheduler.handleTaskCompletion("t1", {
      outcome: "terminated",
      reason: "user_cancelled",
      lastPhase: "execution",
      checkpointId: null,
    });

    // The DB is already `cancelled` (the cross-process write set it); there is no cancelled→cancelled edge.
    expect(taskEngine.requestTransition).not.toHaveBeenCalled();
    expect(notifications.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: NotificationKinds.ticket_comment,
        taskId: "t1",
        message: "Task cancelled by the owner.",
      }),
    );
  });

  // 20f. handleCompletedOutcome logs info (not warn) when a cancel races the completion (expected interleave)
  it("handleTaskCompletion on completed logs info, not warn, when the task was cancelled mid-completion", () => {
    const { ctx, taskEngine, workspaceManager } = makeContext();
    const notifications = makeNotifications();
    const callbacks = makeCallbacks();
    const infoSpy = vi.spyOn(ctx.observer, "info");
    const warnSpy = vi.spyOn(ctx.observer, "warn");

    const scheduler = makeScheduler(ctx, notifications, callbacks);
    const task = makeMockTask({ id: "t1" });
    scheduler.dispatchTask(task);

    // The completed transition loses to a concurrent cancel; re-reading shows the task landed on `cancelled`.
    taskEngine.requestTransition.mockReturnValue({
      success: false,
      reason: "Invalid transition from cancelled to completed",
    });
    taskEngine.getTask.mockReturnValue(makeMockTask({ id: "t1", state: TaskStates.cancelled }));
    infoSpy.mockClear();
    warnSpy.mockClear();

    scheduler.handleTaskCompletion("t1", { outcome: "completed" });

    // Completion side effects are skipped, and the expected interleave is info — never the scary warn.
    expect(workspaceManager.cleanupWorkspace).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("cancelled as it completed"),
      expect.objectContaining({ taskId: "t1" }),
    );
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("Failed to transition task to completed"),
      expect.anything(),
    );
  });

  // 21. Callbacks are invoked after orchestrator promise resolves
  it("callbacks.onTaskCompleted is called when orchestrator promise resolves", async () => {
    const { ctx, orchestrator } = makeContext();
    const notifications = makeNotifications();
    const callbacks = makeCallbacks();

    const completedResult: ExecuteTaskResult = {
      outcome: "completed",
    };
    orchestrator.executeTask.mockResolvedValue(completedResult);

    const task = makeMockTask({ id: "t1" });
    const scheduler = makeScheduler(ctx, notifications, callbacks);
    scheduler.dispatchTask(task);

    await flush();

    expect(callbacks.onTaskCompleted).toHaveBeenCalledWith("t1", completedResult);
  });

  // 23. workspace cleanup failure does not prevent completion
  it("workspace cleanup failure is swallowed on completed outcome", () => {
    const { ctx, taskEngine, workspaceManager } = makeContext();
    const notifications = makeNotifications();
    const callbacks = makeCallbacks();

    taskEngine.getTask.mockReturnValue(makeMockTask({ id: "t1", title: "Clean fail task" }));
    workspaceManager.cleanupWorkspace.mockImplementation(() => {
      throw new Error("cleanup failed");
    });

    const scheduler = makeScheduler(ctx, notifications, callbacks);
    const task = makeMockTask({ id: "t1" });
    scheduler.dispatchTask(task);

    const result: ExecuteTaskResult = { outcome: "completed" };

    // Should not throw
    expect(() => scheduler.handleTaskCompletion("t1", result)).not.toThrow();
    // Notification should still be sent
    expect(notifications.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: NotificationKinds.completion }));
  });

  // SECURITY: handleTaskError sanitizes auth tokens in error messages before logging
  it("handleTaskError sanitizes token-bearing error message before observer logging", () => {
    const { ctx, taskEngine } = makeContext();
    const notifications = makeNotifications();
    const callbacks = makeCallbacks();
    const observerSpy = vi.spyOn(ctx.observer, "error");

    const scheduler = makeScheduler(ctx, notifications, callbacks);

    // Simulate an error whose message contains a git auth URL with a token
    const authError = new Error(
      "fatal: repository 'https://git:ghp_SECRETTOKEN1234567890abcdefgh@github.com/org/repo.git/' not found",
    );
    taskEngine.getTask.mockReturnValue(makeMockTask({ id: "task-crash" }));
    taskEngine.requestTransition.mockReturnValue({ success: true });

    scheduler.handleTaskError("task-crash", authError);

    const logged = observerSpy.mock.calls[0]?.[1] as { error?: string } | undefined;
    expect(logged?.error).toBeDefined();
    expect(logged?.error).not.toContain("ghp_SECRETTOKEN1234567890abcdefgh");
    expect(logged?.error).not.toContain("https://git:ghp_");
  });

  // 25. F1: handleCompletedOutcome skips cleanup and notifications when transition fails
  it("handleTaskCompletion on completed skips notifications when transition fails", () => {
    const { ctx, taskEngine, workspaceManager } = makeContext();
    const notifications = makeNotifications();
    const callbacks = makeCallbacks();

    taskEngine.getTask.mockReturnValue(makeMockTask({ id: "t1", title: "Done task" }));

    const scheduler = makeScheduler(ctx, notifications, callbacks);
    const task = makeMockTask({ id: "t1" });
    scheduler.dispatchTask(task as ReturnType<typeof taskEngine.getQueuedByPriority>[number]);

    // Dispatch was { success: true }; now simulate completed transition failing (e.g. race condition)
    taskEngine.requestTransition.mockReturnValue({ success: false, reason: "already_completed" });

    const result: ExecuteTaskResult = { outcome: "completed" };
    scheduler.handleTaskCompletion("t1", result);

    // Notifications and cleanup must be skipped when the transition fails
    expect(workspaceManager.cleanupWorkspace).not.toHaveBeenCalled();
    // notify should not have been called after the failed transition
    // (it may have been called during dispatch, so check no completion/ticket_comment kinds)
    const postDispatchCalls = (notifications.notify as ReturnType<typeof vi.fn>).mock.calls.filter((c: unknown[]) => {
      const kind = (c[0] as { kind: string }).kind;
      return kind === NotificationKinds.completion || kind === NotificationKinds.ticket_comment;
    });
    expect(postDispatchCalls).toHaveLength(0);
  });

  // 26. F2: unknown outcome transitions task to blocked instead of silently dropping it
  it("handleTaskCompletion on unknown outcome transitions task to blocked", () => {
    const { ctx, taskEngine } = makeContext();
    const notifications = makeNotifications();
    const callbacks = makeCallbacks();

    taskEngine.getTask.mockReturnValue(makeMockTask({ id: "t1" }));

    const scheduler = makeScheduler(ctx, notifications, callbacks);
    const task = makeMockTask({ id: "t1" });
    scheduler.dispatchTask(task as ReturnType<typeof taskEngine.getQueuedByPriority>[number]);

    taskEngine.requestTransition.mockClear();

    // Cast to sneak in an unknown outcome value
    const result = { outcome: "future_unknown_outcome" } as unknown as ExecuteTaskResult;
    scheduler.handleTaskCompletion("t1", result);

    expect(taskEngine.requestTransition).toHaveBeenCalledWith(
      "t1",
      TaskStates.blocked,
      null,
      expect.stringContaining("unknown_outcome"),
      "daemon",
    );
    // Note: dispatch entry cleanup is owned by the dispatch-tracker (covered in its tests).
  });

  // 30. F6: handleTaskError is resilient — catches inner errors and logs them
  it("handleTaskError catches exceptions from eventBus.publish and still attempts transition", () => {
    const { ctx, taskEngine, eventBus } = makeContext();
    const notifications = makeNotifications();
    const callbacks = makeCallbacks();

    // Simulate eventBus.publish throwing (e.g. DB failure)
    eventBus.publish.mockImplementation(() => {
      throw new Error("DB write failed");
    });

    const scheduler = makeScheduler(ctx, notifications, callbacks);
    const task = makeMockTask({ id: "t1" });
    scheduler.dispatchTask(task as ReturnType<typeof taskEngine.getQueuedByPriority>[number]);

    // Should not throw
    expect(() => scheduler.handleTaskError("t1", new Error("crash"))).not.toThrow();
  });

  // 31. F6: handleTaskError warns when transition back to queued fails
  it("handleTaskError warns when crash recovery transition fails", () => {
    const { ctx, taskEngine } = makeContext();
    const notifications = makeNotifications();
    const callbacks = makeCallbacks();

    // publish succeeds but transition to queued fails
    taskEngine.requestTransition.mockReturnValue({ success: false, reason: "invalid_transition" });

    const scheduler = makeScheduler(ctx, notifications, callbacks);
    const task = makeMockTask({ id: "t1" });
    scheduler.dispatchTask(task as ReturnType<typeof taskEngine.getQueuedByPriority>[number]);

    taskEngine.requestTransition.mockClear();
    taskEngine.requestTransition.mockReturnValue({ success: false, reason: "cannot_recover" });

    // Should not throw — handleTaskError wraps everything in try/catch
    expect(() => scheduler.handleTaskError("t1", new Error("crash"))).not.toThrow();
  });

  // 32. F12: callback throwing does not produce unhandled promise rejection
  it("callback throwing is caught and does not propagate as unhandled rejection", async () => {
    const { ctx, taskEngine, orchestrator } = makeContext();
    const notifications = makeNotifications();

    const throwingCallbacks: SchedulerCallbacks = {
      onTaskCompleted: () => {
        throw new Error("callback bug");
      },
      onTaskError: () => {
        throw new Error("callback bug");
      },
    };

    const completedResult: ExecuteTaskResult = {
      outcome: "completed",
    };
    orchestrator.executeTask.mockResolvedValue(completedResult);

    const task = makeMockTask({ id: "t1" });
    const scheduler = makeScheduler(ctx, notifications, throwingCallbacks);
    scheduler.dispatchTask(task as ReturnType<typeof taskEngine.getQueuedByPriority>[number]);

    // Should flush without unhandled rejection
    await expect(flush()).resolves.toBeUndefined();
  });

  // 33. handleAgentUnavailableBlocked: re-queues task when retry budget remains
  it("handleTaskCompletion on blocked agent_unavailable re-queues when retry budget remains", () => {
    const { ctx, taskEngine, clock } = makeContext();
    const notifications = makeNotifications();
    const callbacks = makeCallbacks();
    const now = 1_700_000_000_000;
    clock.now.mockReturnValue(now);

    taskEngine.getTask.mockReturnValue(
      makeMockTask({
        id: "t1",
        state: TaskStates.blocked,
        blocked: {
          reason: "agent_unavailable",
          efforts_made: [],
          contacted: [],
          needed: "x",
          waiting_for: "llm_adapter",
        },
        consecutive_agent_unavailable_count: 0,
      }),
    );

    const scheduler = makeScheduler(ctx, notifications, callbacks);
    scheduler.handleTaskCompletion("t1", { outcome: "blocked", phase: "execution", reason: "agent_unavailable" });

    expect(taskEngine.updateTaskField).toHaveBeenCalledWith("t1", "consecutive_agent_unavailable_count", 1);
    expect(taskEngine.requestTransition).toHaveBeenCalledWith(
      "t1",
      TaskStates.queued,
      null,
      "agent_unavailable_retry",
      "daemon",
    );
  });

  // 34. handleAgentUnavailableBlocked: stays blocked when retry budget exhausted
  it("handleTaskCompletion on blocked agent_unavailable stays blocked when budget exhausted", () => {
    const { ctx, taskEngine } = makeContext();
    const notifications = makeNotifications();
    const callbacks = makeCallbacks();

    taskEngine.getTask.mockReturnValue(
      makeMockTask({
        id: "t1",
        state: TaskStates.blocked,
        blocked: {
          reason: "agent_unavailable",
          efforts_made: [],
          contacted: [],
          needed: "x",
          waiting_for: "llm_adapter",
        },
        consecutive_agent_unavailable_count: 4, // becomes 5 = max_attempts → terminal
      }),
    );

    const scheduler = makeScheduler(ctx, notifications, callbacks);
    scheduler.handleTaskCompletion("t1", { outcome: "blocked", phase: "execution", reason: "agent_unavailable" });

    expect(taskEngine.updateTaskField).toHaveBeenCalledWith("t1", "consecutive_agent_unavailable_count", 5);
    expect(taskEngine.requestTransition).not.toHaveBeenCalledWith(
      "t1",
      TaskStates.queued,
      null,
      "agent_unavailable_retry",
      "daemon",
    );
    expect(notifications.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: NotificationKinds.alert,
        taskId: "t1",
        message: expect.stringContaining("blocked until you respond"),
      }),
    );
  });
});

// ── not_before eligibility ───────────────────────────────────────────────────

describe("isTaskEligible not_before gate", () => {
  it("skips task when not_before is in the future", () => {
    const now = 1_700_000_000_000;
    const { ctx, taskEngine, orchestrator, clock } = makeContext({ max_concurrent: 1 });
    clock.now.mockReturnValue(now);
    const notifications = makeNotifications();
    const callbacks = makeCallbacks();

    const future = new Date(now + 60_000).toISOString();
    const task = makeMockTask({ id: "t1", parent_id: null, not_before: future });
    taskEngine.getQueuedByPriority.mockReturnValue([task]);

    const scheduler = makeScheduler(ctx, notifications, callbacks);
    scheduler.scheduleNext();

    // Task should NOT be dispatched
    expect(orchestrator.executeTask).not.toHaveBeenCalled();
  });

  it("dispatches task when not_before is in the past", () => {
    const now = 1_700_000_000_000;
    const { ctx, taskEngine, orchestrator, clock } = makeContext({ max_concurrent: 1 });
    clock.now.mockReturnValue(now);
    const notifications = makeNotifications();
    const callbacks = makeCallbacks();

    const past = new Date(now - 60_000).toISOString();
    const task = makeMockTask({ id: "t1", parent_id: null, not_before: past });
    taskEngine.getQueuedByPriority.mockReturnValue([task]);

    const scheduler = makeScheduler(ctx, notifications, callbacks);
    scheduler.scheduleNext();

    expect(orchestrator.executeTask).toHaveBeenCalledTimes(1);
  });

  it("dispatches task when not_before is null", () => {
    const { ctx, taskEngine, orchestrator } = makeContext({ max_concurrent: 1 });
    const notifications = makeNotifications();
    const callbacks = makeCallbacks();

    const task = makeMockTask({ id: "t1", parent_id: null, not_before: null });
    taskEngine.getQueuedByPriority.mockReturnValue([task]);

    const scheduler = makeScheduler(ctx, notifications, callbacks);
    scheduler.scheduleNext();

    expect(orchestrator.executeTask).toHaveBeenCalledTimes(1);
  });
});

// ── handleTaskCompletion resets crash backoff ────────────────────────────────

describe("handleTaskCompletion crash reset", () => {
  it("resets crash count and not_before on successful completion", () => {
    const { ctx, taskEngine } = makeContext();
    const notifications = makeNotifications();
    const callbacks = makeCallbacks();

    const scheduler = makeScheduler(ctx, notifications, callbacks);
    const task = makeMockTask({
      id: "t1",
      consecutive_crash_count: 3,
      not_before: "2026-01-01T00:00:00.000Z",
    });
    scheduler.dispatchTask(task);

    // Simulate successful completion callback
    const completedResult: ExecuteTaskResult = { outcome: "completed" };
    scheduler.handleTaskCompletion("t1", completedResult);

    expect(taskEngine.updateTaskField).toHaveBeenCalledWith("t1", "consecutive_crash_count", 0);
    expect(taskEngine.updateTaskField).toHaveBeenCalledWith("t1", "not_before", null);
  });
});
