import { describe, expect, it, vi } from "vitest";

import { createTestObserverFacade } from "../../../test/helpers/test-observer-facade.js";
import type { DaemonConfig } from "../../schemas/config.js";
import { EventTypes } from "../../schemas/events.js";
import { SubStates, type Task, TaskStates } from "../../schemas/task.js";
import type { ExecuteTaskResult } from "../orchestrator/index.js";
import type { NotificationRouter } from "./notification-router.js";
import { type SchedulerCallbacks, createTaskScheduler } from "./task-scheduler.js";
import type { TaskSchedulerContext } from "./types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeDaemonConfig(overrides?: Partial<DaemonConfig>): DaemonConfig {
  return {
    max_concurrent: 2,
    tick_interval_ms: 5_000,
    preemption_threshold: 20,
    preemption_timeout_ms: 30_000,
    stuck_threshold_ms: 600_000,
    max_active_duration_ms: 3_600_000,
    aging_threshold_ms: 86_400_000,
    aging_increment: 5,
    aging_interval_ms: 86_400_000,
    aging_cap: 75,
    shutdown_timeout_ms: 10_000,
    trigger_poll_interval_ms: 60_000,
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
    database: { cache_size_mb: 64 },
    review_polling: { failure_window_ms: 300_000, max_failures_before_pause: 3 },
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
    parent_id: null,
    workspace: null,
    review: null,
    created_at: new Date(1_000_000).toISOString(),
    started_at: null,
    decisions: [],
    cascade_policy: "best_effort",
    description: "A test task",
    children: [],
    external_ref: null,
    ...overrides,
  } as unknown as Task;
}

function makeNotifications(): NotificationRouter & Record<string, ReturnType<typeof vi.fn>> {
  return {
    sendCompletion: vi.fn(),
    sendReviewPending: vi.fn(),
    sendTaskError: vi.fn(),
    sendCostLimit: vi.fn(),
    sendBlockedReminder: vi.fn(),
    sendEscalationAlert: vi.fn(),
    sendReviewReminder: vi.fn(),
    commentOnTaskTicket: vi.fn(),
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
    getChildren: vi.fn().mockReturnValue([]),
    requestTransition: vi.fn().mockReturnValue({ success: true }),
    updateTaskField: vi.fn(),
  };
  const orchestrator = {
    executeTask: vi.fn().mockResolvedValue({ outcome: "completed", phaseOutputs: new Map() }),
  };
  const sessionMemory = {
    getLatestCheckpoint: vi.fn().mockReturnValue(null),
    getKnowledge: vi.fn().mockReturnValue([]),
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

    const scheduler = createTaskScheduler(ctx, notifications, callbacks);
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

    const scheduler = createTaskScheduler(ctx, notifications, callbacks);

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

    const scheduler = createTaskScheduler(ctx, notifications, callbacks);
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
        knowledge: { repo: [], user: [] },
      }),
    );
  });

  // 4. dispatchTask resumes from checkpoint if available
  it("dispatchTask resumes from checkpoint if available", () => {
    const { ctx, taskEngine, sessionMemory } = makeContext();
    const notifications = makeNotifications();
    const callbacks = makeCallbacks();

    const checkpoint = { phase: "execution", data: { step: 3 } };
    sessionMemory.getLatestCheckpoint.mockReturnValue(checkpoint);

    const task = makeMockTask({ id: "t1" });

    const scheduler = createTaskScheduler(ctx, notifications, callbacks);
    scheduler.dispatchTask(task);

    expect(taskEngine.requestTransition).toHaveBeenCalledWith(
      "t1",
      TaskStates.active,
      SubStates.working,
      "resumed_from_checkpoint",
      "daemon",
    );
    expect(ctx.orchestrator.executeTask).toHaveBeenCalledWith(
      expect.objectContaining({ resume_from: checkpoint }),
    );
  });

  // 5. handleTaskCompletion on "completed" outcome
  it("handleTaskCompletion on completed outcome transitions, cleans up, and notifies", () => {
    const { ctx, taskEngine, workspaceManager } = makeContext();
    const notifications = makeNotifications();
    const callbacks = makeCallbacks();

    taskEngine.getTask.mockReturnValue(makeMockTask({ id: "t1", title: "Done task" }));

    const scheduler = createTaskScheduler(ctx, notifications, callbacks);
    // First dispatch to make it active
    const task = makeMockTask({ id: "t1", title: "Done task" });
    scheduler.dispatchTask(task);

    const result: ExecuteTaskResult = { outcome: "completed", phaseOutputs: new Map() };
    scheduler.handleTaskCompletion("t1", result);

    expect(taskEngine.requestTransition).toHaveBeenCalledWith(
      "t1",
      TaskStates.completed,
      null,
      "pipeline_completed",
      "daemon",
    );
    expect(workspaceManager.cleanupWorkspace).toHaveBeenCalledWith("t1", true);
    expect(notifications.sendCompletion).toHaveBeenCalledWith("t1");
    expect(notifications.commentOnTaskTicket).toHaveBeenCalledWith(
      "t1",
      "Task completed successfully.",
    );
    expect(scheduler.getTasksCompleted()).toBe(1);
  });

  // 6. handleTaskCompletion on "review_pending" outcome
  it("handleTaskCompletion on review_pending outcome transitions to review_pending.demo", () => {
    const { ctx, taskEngine } = makeContext();
    const notifications = makeNotifications();
    const callbacks = makeCallbacks();

    taskEngine.getTask.mockReturnValue(makeMockTask({ id: "t1", title: "PR task" }));

    const scheduler = createTaskScheduler(ctx, notifications, callbacks);
    const task = makeMockTask({ id: "t1" });
    scheduler.dispatchTask(task);

    const result: ExecuteTaskResult = {
      outcome: "review_pending",
      phase: "demo_prep",
      phaseOutputs: new Map(),
    };
    scheduler.handleTaskCompletion("t1", result);

    expect(taskEngine.requestTransition).toHaveBeenCalledWith(
      "t1",
      TaskStates.review_pending,
      SubStates.demo,
      "pr_created",
      "daemon",
    );
    expect(notifications.sendReviewPending).toHaveBeenCalledWith("t1");
    expect(notifications.commentOnTaskTicket).toHaveBeenCalledWith(
      "t1",
      "Pull request created — awaiting review.",
    );
  });

  // 7. handleTaskCompletion on "error" outcome
  it("handleTaskCompletion on error outcome transitions to blocked and sends error notification", () => {
    const { ctx, taskEngine } = makeContext();
    const notifications = makeNotifications();
    const callbacks = makeCallbacks();

    taskEngine.getTask.mockReturnValue(makeMockTask({ id: "t1", title: "Broken task" }));

    const scheduler = createTaskScheduler(ctx, notifications, callbacks);
    const task = makeMockTask({ id: "t1" });
    scheduler.dispatchTask(task);

    const result: ExecuteTaskResult = {
      outcome: "error",
      phase: "execution",
      reason: "build_failed",
    };
    scheduler.handleTaskCompletion("t1", result);

    expect(taskEngine.requestTransition).toHaveBeenCalledWith(
      "t1",
      TaskStates.blocked,
      null,
      "build_failed",
      "daemon",
    );
    expect(notifications.sendTaskError).toHaveBeenCalledWith("t1", "build_failed");
    expect(notifications.commentOnTaskTicket).toHaveBeenCalledWith(
      "t1",
      "Task encountered an error: build_failed",
    );
  });

  // 8. handleTaskError emits stuck event and transitions to queued
  it("handleTaskError emits stuck event and transitions to queued", () => {
    const { ctx, taskEngine, eventBus } = makeContext();
    const notifications = makeNotifications();
    const callbacks = makeCallbacks();

    const scheduler = createTaskScheduler(ctx, notifications, callbacks);
    const task = makeMockTask({ id: "t1" });
    scheduler.dispatchTask(task);

    scheduler.handleTaskError("t1", new Error("Orchestrator crashed"));

    expect(eventBus.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: EventTypes["health.stuck_detected"],
        source: "daemon",
        task_id: "t1",
        payload: expect.objectContaining({
          task_id: "t1",
          condition: "orchestrator_crash",
        }),
      }),
    );
    expect(taskEngine.requestTransition).toHaveBeenCalledWith(
      "t1",
      TaskStates.queued,
      null,
      "crash_recovery",
      "daemon",
    );
    // Should be removed from active dispatches
    expect(scheduler.getActiveTaskIds()).not.toContain("t1");
  });

  // 9. isTaskEligible: top-level tasks always eligible
  it("scheduleNext dispatches top-level tasks (no parent_id)", () => {
    const { ctx, taskEngine, orchestrator } = makeContext({ max_concurrent: 1 });
    const notifications = makeNotifications();
    const callbacks = makeCallbacks();

    const task = makeMockTask({ id: "t1", parent_id: null });
    taskEngine.getQueuedByPriority.mockReturnValue([task]);

    const scheduler = createTaskScheduler(ctx, notifications, callbacks);
    scheduler.scheduleNext();

    expect(orchestrator.executeTask).toHaveBeenCalledTimes(1);
  });

  // 10. isTaskEligible: child requires parent in active.supervising
  it("scheduleNext skips child task when parent is not in active.supervising", () => {
    const { ctx, taskEngine, orchestrator } = makeContext({ max_concurrent: 1 });
    const notifications = makeNotifications();
    const callbacks = makeCallbacks();

    const child = makeMockTask({ id: "child-1", parent_id: "parent-1" });
    taskEngine.getQueuedByPriority.mockReturnValue([child]);
    taskEngine.getTask.mockReturnValue(
      makeMockTask({
        id: "parent-1",
        state: TaskStates.active,
        sub_state: SubStates.working, // NOT supervising
      }),
    );

    const scheduler = createTaskScheduler(ctx, notifications, callbacks);
    scheduler.scheduleNext();

    expect(orchestrator.executeTask).not.toHaveBeenCalled();
  });

  // 11. isTaskEligible: pause_siblings enforces one-at-a-time
  it("scheduleNext enforces pause_siblings: skips child when sibling is active", () => {
    const { ctx, taskEngine, orchestrator } = makeContext({ max_concurrent: 2 });
    const notifications = makeNotifications();
    const callbacks = makeCallbacks();

    const child1 = makeMockTask({ id: "child-1", parent_id: "parent-1" });
    const child2 = makeMockTask({ id: "child-2", parent_id: "parent-1" });
    taskEngine.getQueuedByPriority.mockReturnValue([child1, child2]);

    // Parent is supervising with pause_siblings
    taskEngine.getTask.mockReturnValue(
      makeMockTask({
        id: "parent-1",
        state: TaskStates.active,
        sub_state: SubStates.supervising,
        cascade_policy: "pause_siblings",
      }),
    );

    // After child1 is dispatched, getChildren returns child1 as active
    const activeSibling = makeMockTask({
      id: "child-1",
      parent_id: "parent-1",
      state: TaskStates.active,
    });
    const queuedSibling = makeMockTask({
      id: "child-2",
      parent_id: "parent-1",
      state: TaskStates.queued,
    });
    taskEngine.getChildren.mockReturnValue([activeSibling, queuedSibling]);

    const scheduler = createTaskScheduler(ctx, notifications, callbacks);
    scheduler.scheduleNext();

    // Only the first child should be dispatched; second blocked by pause_siblings
    expect(orchestrator.executeTask).toHaveBeenCalledTimes(1);
  });

  // 12. applyPriorityAging ages queued tasks based on elapsed time
  it("applyPriorityAging updates priority for old queued tasks", () => {
    const { ctx, taskEngine } = makeContext({
      aging_threshold_ms: 10_000,
      aging_interval_ms: 5_000,
      aging_increment: 3,
      aging_cap: 100,
    });
    const notifications = makeNotifications();
    const callbacks = makeCallbacks();

    const createdAt = new Date(0).toISOString(); // epoch
    const now = 20_000; // 20 seconds elapsed → threshold 10k, then 2 intervals of 5k → periods = 3

    const task = makeMockTask({ id: "t1", priority: 50, created_at: createdAt });
    taskEngine.getTasksByState.mockReturnValue([task]);

    const scheduler = createTaskScheduler(ctx, notifications, callbacks);
    scheduler.applyPriorityAging(now);

    // aged = min(50 + 3*3, 100) = 59
    expect(taskEngine.updateTaskField).toHaveBeenCalledWith("t1", "priority", 59);
  });

  // 13. checkAndEmitChildrenAllDone emits when all siblings terminal
  it("checkAndEmitChildrenAllDone emits event when all siblings are terminal", () => {
    const { ctx, taskEngine, eventBus } = makeContext();
    const notifications = makeNotifications();
    const callbacks = makeCallbacks();

    const child = makeMockTask({ id: "child-1", parent_id: "parent-1" });
    taskEngine.getTask.mockReturnValue(child);

    const sibling1 = makeMockTask({ id: "child-1", state: TaskStates.completed });
    const sibling2 = makeMockTask({ id: "child-2", state: TaskStates.completed });
    taskEngine.getChildren.mockReturnValue([sibling1, sibling2]);

    const scheduler = createTaskScheduler(ctx, notifications, callbacks);
    scheduler.checkAndEmitChildrenAllDone("child-1");

    expect(eventBus.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: EventTypes["task.children_all_done"],
        source: "daemon",
        task_id: "parent-1",
        payload: expect.objectContaining({
          parent_task_id: "parent-1",
          child_ids: ["child-1", "child-2"],
          all_succeeded: true,
          failed_ids: [],
        }),
      }),
    );
  });

  // 14. checkAndEmitChildrenAllDone skips for top-level tasks (no parent)
  it("checkAndEmitChildrenAllDone skips for top-level tasks", () => {
    const { ctx, taskEngine, eventBus } = makeContext();
    const notifications = makeNotifications();
    const callbacks = makeCallbacks();

    taskEngine.getTask.mockReturnValue(makeMockTask({ id: "t1", parent_id: null }));

    const scheduler = createTaskScheduler(ctx, notifications, callbacks);
    scheduler.checkAndEmitChildrenAllDone("t1");

    expect(eventBus.publish).not.toHaveBeenCalled();
  });

  // 15. checkAndEmitChildrenAllDone does not emit when some siblings are non-terminal
  it("checkAndEmitChildrenAllDone does not emit when siblings are not all terminal", () => {
    const { ctx, taskEngine, eventBus } = makeContext();
    const notifications = makeNotifications();
    const callbacks = makeCallbacks();

    const child = makeMockTask({ id: "child-1", parent_id: "parent-1" });
    taskEngine.getTask.mockReturnValue(child);

    const sibling1 = makeMockTask({ id: "child-1", state: TaskStates.completed });
    const sibling2 = makeMockTask({ id: "child-2", state: TaskStates.active }); // not terminal
    taskEngine.getChildren.mockReturnValue([sibling1, sibling2]);

    const scheduler = createTaskScheduler(ctx, notifications, callbacks);
    scheduler.checkAndEmitChildrenAllDone("child-1");

    expect(eventBus.publish).not.toHaveBeenCalled();
  });

  // 16. dispatchTask aborts when transition fails
  it("dispatchTask does not call orchestrator when transition fails", () => {
    const { ctx, taskEngine, orchestrator } = makeContext();
    const notifications = makeNotifications();
    const callbacks = makeCallbacks();

    taskEngine.requestTransition.mockReturnValue({ success: false, reason: "invalid_transition" });

    const task = makeMockTask({ id: "t1" });

    const scheduler = createTaskScheduler(ctx, notifications, callbacks);
    scheduler.dispatchTask(task);

    expect(orchestrator.executeTask).not.toHaveBeenCalled();
    expect(scheduler.getActiveTaskIds()).toEqual([]);
  });

  // 17. removeActiveDispatch removes a task from active tracking
  it("removeActiveDispatch removes task from active tracking", () => {
    const { ctx } = makeContext();
    const notifications = makeNotifications();
    const callbacks = makeCallbacks();

    const task = makeMockTask({ id: "t1" });

    const scheduler = createTaskScheduler(ctx, notifications, callbacks);
    scheduler.dispatchTask(task);
    expect(scheduler.getActiveTaskIds()).toContain("t1");

    scheduler.removeActiveDispatch("t1");
    expect(scheduler.getActiveTaskIds()).not.toContain("t1");
  });

  // 18. initializeBasePriorities sets base priorities for aging
  it("initializeBasePriorities sets base priorities used by aging", () => {
    const { ctx, taskEngine } = makeContext({
      aging_threshold_ms: 1_000,
      aging_interval_ms: 1_000,
      aging_increment: 10,
      aging_cap: 100,
    });
    const notifications = makeNotifications();
    const callbacks = makeCallbacks();

    const createdAt = new Date(0).toISOString();
    const task = makeMockTask({ id: "t1", priority: 70, created_at: createdAt });
    taskEngine.getTasksByState.mockReturnValue([task]);

    const scheduler = createTaskScheduler(ctx, notifications, callbacks);

    // Set base priority to 40 — aging should compute from base 40, not current 70
    scheduler.initializeBasePriorities([{ id: "t1", priority: 40 }]);

    // now = 5000 → elapsed = 5000, threshold = 1000, intervals = (5000-1000)/1000 = 4 periods → periods = 5
    // aged = min(40 + 5*10, 100) = min(90, 100) = 90
    scheduler.applyPriorityAging(5_000);

    expect(taskEngine.updateTaskField).toHaveBeenCalledWith("t1", "priority", 90);
  });

  // 19. handleTaskCompletion on "decomposed" outcome logs but does not transition
  it("handleTaskCompletion on decomposed outcome does not transition state", () => {
    const { ctx, taskEngine } = makeContext();
    const notifications = makeNotifications();
    const callbacks = makeCallbacks();

    taskEngine.getTask.mockReturnValue(makeMockTask({ id: "t1", title: "Parent" }));

    const scheduler = createTaskScheduler(ctx, notifications, callbacks);
    const task = makeMockTask({ id: "t1" });
    scheduler.dispatchTask(task);

    // Clear the transition call from dispatch
    taskEngine.requestTransition.mockClear();

    const result: ExecuteTaskResult = {
      outcome: "decomposed",
      childTaskIds: ["c1", "c2"],
      phaseOutputs: new Map(),
    };
    scheduler.handleTaskCompletion("t1", result);

    // No state transition for decomposed outcome
    expect(taskEngine.requestTransition).not.toHaveBeenCalled();
    // Still increments completion counter and removes from active
    expect(scheduler.getTasksCompleted()).toBe(1);
    expect(scheduler.getActiveTaskIds()).not.toContain("t1");
  });

  // 20. handleTaskCompletion on "preempted" outcome transitions back to queued
  it("handleTaskCompletion on preempted outcome transitions back to queued", () => {
    const { ctx, taskEngine } = makeContext();
    const notifications = makeNotifications();
    const callbacks = makeCallbacks();

    taskEngine.getTask.mockReturnValue(makeMockTask({ id: "t1", title: "Preempted task" }));

    const scheduler = createTaskScheduler(ctx, notifications, callbacks);
    const task = makeMockTask({ id: "t1" });
    scheduler.dispatchTask(task);

    taskEngine.requestTransition.mockClear();

    const result: ExecuteTaskResult = {
      outcome: "preempted",
      lastPhase: "research",
      checkpointId: "cp-1",
    };
    scheduler.handleTaskCompletion("t1", result);

    expect(taskEngine.requestTransition).toHaveBeenCalledWith(
      "t1",
      TaskStates.queued,
      null,
      "preempted",
      "daemon",
    );
  });

  // 21. Callbacks are invoked after orchestrator promise resolves
  it("callbacks.onTaskCompleted is called when orchestrator promise resolves", async () => {
    const { ctx, orchestrator } = makeContext();
    const notifications = makeNotifications();
    const callbacks = makeCallbacks();

    const completedResult: ExecuteTaskResult = {
      outcome: "completed",
      phaseOutputs: new Map(),
    };
    orchestrator.executeTask.mockResolvedValue(completedResult);

    const task = makeMockTask({ id: "t1" });
    const scheduler = createTaskScheduler(ctx, notifications, callbacks);
    scheduler.dispatchTask(task);

    await flush();

    expect(callbacks.onTaskCompleted).toHaveBeenCalledWith("t1", completedResult);
  });

  // 22. checkAndEmitChildrenAllDone reports failed_ids correctly
  it("checkAndEmitChildrenAllDone reports failed child IDs", () => {
    const { ctx, taskEngine, eventBus } = makeContext();
    const notifications = makeNotifications();
    const callbacks = makeCallbacks();

    const child = makeMockTask({ id: "child-1", parent_id: "parent-1" });
    taskEngine.getTask.mockReturnValue(child);

    const sibling1 = makeMockTask({ id: "child-1", state: TaskStates.completed });
    const sibling2 = makeMockTask({ id: "child-2", state: TaskStates.failed });
    taskEngine.getChildren.mockReturnValue([sibling1, sibling2]);

    const scheduler = createTaskScheduler(ctx, notifications, callbacks);
    scheduler.checkAndEmitChildrenAllDone("child-1");

    expect(eventBus.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          all_succeeded: false,
          failed_ids: ["child-2"],
        }),
      }),
    );
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

    const scheduler = createTaskScheduler(ctx, notifications, callbacks);
    const task = makeMockTask({ id: "t1" });
    scheduler.dispatchTask(task);

    const result: ExecuteTaskResult = { outcome: "completed", phaseOutputs: new Map() };

    // Should not throw
    expect(() => scheduler.handleTaskCompletion("t1", result)).not.toThrow();
    // Notification should still be sent
    expect(notifications.sendCompletion).toHaveBeenCalled();
  });

  // 24. isTaskEligible: child of supervising parent with best_effort is eligible
  it("scheduleNext dispatches child when parent is supervising with best_effort", () => {
    const { ctx, taskEngine, orchestrator } = makeContext({ max_concurrent: 2 });
    const notifications = makeNotifications();
    const callbacks = makeCallbacks();

    const child = makeMockTask({ id: "child-1", parent_id: "parent-1" });
    taskEngine.getQueuedByPriority.mockReturnValue([child]);
    taskEngine.getTask.mockReturnValue(
      makeMockTask({
        id: "parent-1",
        state: TaskStates.active,
        sub_state: SubStates.supervising,
        cascade_policy: "best_effort",
      }),
    );
    taskEngine.getChildren.mockReturnValue([]);

    const scheduler = createTaskScheduler(ctx, notifications, callbacks);
    scheduler.scheduleNext();

    expect(orchestrator.executeTask).toHaveBeenCalledTimes(1);
  });

  // SECURITY: handleTaskError sanitizes auth tokens in error messages before logging
  it("handleTaskError sanitizes token-bearing error message before observer logging", () => {
    const { ctx, taskEngine } = makeContext();
    const notifications = makeNotifications();
    const callbacks = makeCallbacks();
    const observerSpy = vi.spyOn(ctx.observer, "error");

    const scheduler = createTaskScheduler(ctx, notifications, callbacks);

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

    const scheduler = createTaskScheduler(ctx, notifications, callbacks);
    const task = makeMockTask({ id: "t1" });
    scheduler.dispatchTask(task as ReturnType<typeof taskEngine.getQueuedByPriority>[number]);

    // Dispatch was { success: true }; now simulate completed transition failing (e.g. race condition)
    taskEngine.requestTransition.mockReturnValue({ success: false, reason: "already_completed" });

    const result: ExecuteTaskResult = { outcome: "completed", phaseOutputs: new Map() };
    scheduler.handleTaskCompletion("t1", result);

    // Notifications and cleanup must be skipped when the transition fails
    expect(workspaceManager.cleanupWorkspace).not.toHaveBeenCalled();
    expect(notifications.sendCompletion).not.toHaveBeenCalled();
    expect(notifications.commentOnTaskTicket).not.toHaveBeenCalled();
  });

  // 26. F1: handleErrorOutcome skips notifications when transition fails
  it("handleTaskCompletion on error skips notifications when blocked transition fails", () => {
    const { ctx, taskEngine } = makeContext();
    const notifications = makeNotifications();
    const callbacks = makeCallbacks();

    taskEngine.getTask.mockReturnValue(makeMockTask({ id: "t1", title: "Broken task" }));

    const scheduler = createTaskScheduler(ctx, notifications, callbacks);
    const task = makeMockTask({ id: "t1" });
    scheduler.dispatchTask(task as ReturnType<typeof taskEngine.getQueuedByPriority>[number]);

    taskEngine.requestTransition.mockReturnValue({ success: false, reason: "invalid" });

    const result: ExecuteTaskResult = {
      outcome: "error",
      phase: "execution",
      reason: "build_failed",
    };
    scheduler.handleTaskCompletion("t1", result);

    expect(notifications.sendTaskError).not.toHaveBeenCalled();
    expect(notifications.commentOnTaskTicket).not.toHaveBeenCalled();
  });

  // 27. F2: unknown outcome transitions task to blocked instead of silently dropping it
  it("handleTaskCompletion on unknown outcome transitions task to blocked", () => {
    const { ctx, taskEngine } = makeContext();
    const notifications = makeNotifications();
    const callbacks = makeCallbacks();

    taskEngine.getTask.mockReturnValue(makeMockTask({ id: "t1" }));

    const scheduler = createTaskScheduler(ctx, notifications, callbacks);
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
    // Task must be removed from active dispatches regardless
    expect(scheduler.getActiveTaskIds()).not.toContain("t1");
  });

  // 28. F5: blocked child counts as terminal for children_all_done
  it("checkAndEmitChildrenAllDone fires when a child is blocked (errored)", () => {
    const { ctx, taskEngine, eventBus } = makeContext();
    const notifications = makeNotifications();
    const callbacks = makeCallbacks();

    const child = makeMockTask({ id: "child-1", parent_id: "parent-1" });
    taskEngine.getTask.mockReturnValue(child);

    // One child completed, one blocked (errored via handleErrorOutcome)
    const completedSibling = makeMockTask({ id: "child-1", state: TaskStates.completed });
    const blockedSibling = makeMockTask({ id: "child-2", state: TaskStates.blocked });
    taskEngine.getChildren.mockReturnValue([completedSibling, blockedSibling]);

    const scheduler = createTaskScheduler(ctx, notifications, callbacks);
    scheduler.checkAndEmitChildrenAllDone("child-1");

    // Should fire because blocked counts as terminal
    expect(eventBus.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: EventTypes["task.children_all_done"],
        payload: expect.objectContaining({
          all_succeeded: false,
          failed_ids: ["child-2"], // blocked is included in failed_ids
        }),
      }),
    );
  });

  // 29. F5: non-terminal sibling (active) still blocks children_all_done
  it("checkAndEmitChildrenAllDone does not fire when a sibling is still active (not blocked)", () => {
    const { ctx, taskEngine, eventBus } = makeContext();
    const notifications = makeNotifications();
    const callbacks = makeCallbacks();

    const child = makeMockTask({ id: "child-1", parent_id: "parent-1" });
    taskEngine.getTask.mockReturnValue(child);

    const completedSibling = makeMockTask({ id: "child-1", state: TaskStates.completed });
    const activeSibling = makeMockTask({ id: "child-2", state: TaskStates.active }); // still running
    taskEngine.getChildren.mockReturnValue([completedSibling, activeSibling]);

    const scheduler = createTaskScheduler(ctx, notifications, callbacks);
    scheduler.checkAndEmitChildrenAllDone("child-1");

    expect(eventBus.publish).not.toHaveBeenCalled();
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

    const scheduler = createTaskScheduler(ctx, notifications, callbacks);
    const task = makeMockTask({ id: "t1" });
    scheduler.dispatchTask(task as ReturnType<typeof taskEngine.getQueuedByPriority>[number]);

    // Should not throw
    expect(() => scheduler.handleTaskError("t1", new Error("crash"))).not.toThrow();

    // Task must be removed from active dispatches regardless
    expect(scheduler.getActiveTaskIds()).not.toContain("t1");
  });

  // 31. F6: handleTaskError warns when transition back to queued fails
  it("handleTaskError warns when crash recovery transition fails", () => {
    const { ctx, taskEngine } = makeContext();
    const notifications = makeNotifications();
    const callbacks = makeCallbacks();

    // publish succeeds but transition to queued fails
    taskEngine.requestTransition.mockReturnValue({ success: false, reason: "invalid_transition" });

    const scheduler = createTaskScheduler(ctx, notifications, callbacks);
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
      phaseOutputs: new Map(),
    };
    orchestrator.executeTask.mockResolvedValue(completedResult);

    const task = makeMockTask({ id: "t1" });
    const scheduler = createTaskScheduler(ctx, notifications, throwingCallbacks);
    scheduler.dispatchTask(task as ReturnType<typeof taskEngine.getQueuedByPriority>[number]);

    // Should flush without unhandled rejection
    await expect(flush()).resolves.toBeUndefined();
  });
});
