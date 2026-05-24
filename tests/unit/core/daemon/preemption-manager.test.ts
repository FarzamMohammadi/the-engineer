import { describe, expect, it, vi } from "vitest";

import { createPreemptionManager } from "../../../../src/core/daemon/preemption-manager.js";
import type { PreemptionManagerContext } from "../../../../src/core/daemon/types.js";
import type { DaemonConfig } from "../../../../src/schemas/config.js";
import { TaskStates } from "../../../../src/schemas/task.js";
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
    database: { cache_size_mb: 64 },
    notification_retry: { interval_ms: 30_000, max_attempts: 120, max_age_ms: 3_600_000 },
    review_polling: { failure_window_ms: 300_000, max_failures_before_pause: 3 },
    retry_policy: {
      crash: { backoff_minutes: [1, 5, 15, 30, 30], max_attempts: 5 },
      llm_unavailable: { backoff_minutes: [2, 5, 10, 15, 15], max_attempts: 5 },
    },
    evaluation: { enabled: false },
    ...overrides,
  };
}

function makeContext(configOverrides?: Partial<DaemonConfig>): {
  ctx: PreemptionManagerContext;
  eventBus: { publish: ReturnType<typeof vi.fn> };
  taskEngine: {
    getQueuedByPriority: ReturnType<typeof vi.fn>;
    getTask: ReturnType<typeof vi.fn>;
    requestTransition: ReturnType<typeof vi.fn>;
  };
} {
  const eventBus = { publish: vi.fn() };
  const taskEngine = {
    getQueuedByPriority: vi.fn().mockReturnValue([]),
    getTask: vi.fn().mockReturnValue(null),
    requestTransition: vi.fn().mockReturnValue({ success: true }),
  };

  const ctx: PreemptionManagerContext = {
    config: makeDaemonConfig(configOverrides),
    eventBus: eventBus as unknown as PreemptionManagerContext["eventBus"],
    taskEngine: taskEngine as unknown as PreemptionManagerContext["taskEngine"],
    clock: { now: () => Date.now() },
    observer: createTestObserverFacade("daemon"),
  };

  return { ctx, eventBus, taskEngine };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("PreemptionManager", () => {
  it("initiates preemption when priority delta exceeds threshold", () => {
    const { ctx, eventBus, taskEngine } = makeContext({ preemption_threshold: 20 });

    taskEngine.getQueuedByPriority.mockReturnValue([{ id: "queued-1", priority: 80 }]);
    taskEngine.getTask.mockReturnValue({ id: "active-1", priority: 50 });

    const getActiveTaskIds = vi.fn(() => ["active-1"]);
    const removeActiveDispatch = vi.fn();

    const pm = createPreemptionManager(ctx, getActiveTaskIds, removeActiveDispatch);
    pm.evaluate(1000);

    expect(pm.getPending()).not.toBeNull();
    expect(pm.getPending()?.targetTaskId).toBe("active-1");
    expect(pm.getPending()?.replacementTaskId).toBe("queued-1");
    expect(eventBus.publish).toHaveBeenCalledOnce();
    expect(eventBus.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "preemption.requested",
        task_id: "active-1",
        payload: expect.objectContaining({
          target_task_id: "active-1",
          preempting_task_id: "queued-1",
          reason: "priority_delta_exceeded",
          priority_delta: 30,
        }),
      }),
    );
  });

  it("does not preempt when delta is below threshold", () => {
    const { ctx, eventBus, taskEngine } = makeContext({ preemption_threshold: 20 });

    taskEngine.getQueuedByPriority.mockReturnValue([{ id: "queued-1", priority: 60 }]);
    taskEngine.getTask.mockReturnValue({ id: "active-1", priority: 50 });

    const getActiveTaskIds = vi.fn(() => ["active-1"]);
    const removeActiveDispatch = vi.fn();

    const pm = createPreemptionManager(ctx, getActiveTaskIds, removeActiveDispatch);
    pm.evaluate(1000);

    expect(pm.getPending()).toBeNull();
    expect(eventBus.publish).not.toHaveBeenCalled();
  });

  it("re-requests preemption on first timeout", () => {
    const { ctx, eventBus, taskEngine } = makeContext({
      preemption_threshold: 20,
      preemption_timeout_ms: 30_000,
    });

    taskEngine.getQueuedByPriority.mockReturnValue([{ id: "queued-1", priority: 80 }]);
    taskEngine.getTask.mockReturnValue({ id: "active-1", priority: 50 });

    const getActiveTaskIds = vi.fn(() => ["active-1"]);
    const removeActiveDispatch = vi.fn();

    const pm = createPreemptionManager(ctx, getActiveTaskIds, removeActiveDispatch);

    // Initiate preemption at t=1000
    pm.evaluate(1000);
    expect(eventBus.publish).toHaveBeenCalledOnce();

    // First timeout at t=32000 (elapsed > 30_000)
    pm.evaluate(32_000);

    expect(eventBus.publish).toHaveBeenCalledTimes(2);
    expect(eventBus.publish).toHaveBeenLastCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          reason: "preemption_timeout_retry",
        }),
      }),
    );

    // Pending should still exist, with retried=true
    const pending = pm.getPending();
    expect(pending).not.toBeNull();
    expect(pending?.retried).toBe(true);
    expect(removeActiveDispatch).not.toHaveBeenCalled();
    expect(taskEngine.requestTransition).not.toHaveBeenCalled();
  });

  it("force-transitions task to queued on double timeout", () => {
    const { ctx, taskEngine } = makeContext({
      preemption_threshold: 20,
      preemption_timeout_ms: 30_000,
    });

    taskEngine.getQueuedByPriority.mockReturnValue([{ id: "queued-1", priority: 80 }]);
    taskEngine.getTask.mockReturnValue({ id: "active-1", priority: 50 });

    const getActiveTaskIds = vi.fn(() => ["active-1"]);
    const removeActiveDispatch = vi.fn();

    const pm = createPreemptionManager(ctx, getActiveTaskIds, removeActiveDispatch);

    // Initiate at t=0
    pm.evaluate(0);

    // First timeout at t=31000
    pm.evaluate(31_000);
    expect(pm.getPending()?.retried).toBe(true);

    // Second timeout at t=62000 (31000 + 31000)
    pm.evaluate(62_000);

    expect(taskEngine.requestTransition).toHaveBeenCalledWith(
      "active-1",
      TaskStates.queued,
      null,
      "preemption_timeout",
      "daemon",
    );
    expect(removeActiveDispatch).toHaveBeenCalledWith("active-1");
    expect(pm.getPending()).toBeNull();
  });

  it("skips evaluation when a pending preemption already exists", () => {
    const { ctx, eventBus, taskEngine } = makeContext({
      preemption_threshold: 20,
      preemption_timeout_ms: 300_000, // large timeout so no timeout triggers
    });

    taskEngine.getQueuedByPriority.mockReturnValue([{ id: "queued-1", priority: 80 }]);
    taskEngine.getTask.mockReturnValue({ id: "active-1", priority: 50 });

    const getActiveTaskIds = vi.fn(() => ["active-1"]);
    const removeActiveDispatch = vi.fn();

    const pm = createPreemptionManager(ctx, getActiveTaskIds, removeActiveDispatch);

    // Initiate preemption
    pm.evaluate(1000);
    expect(eventBus.publish).toHaveBeenCalledOnce();

    // Second evaluate should not initiate new preemption (no timeout either)
    pm.evaluate(2000);
    expect(eventBus.publish).toHaveBeenCalledOnce(); // still 1
    expect(getActiveTaskIds).toHaveBeenCalledOnce(); // not called on second evaluate
  });

  it("skips evaluation when there are no active tasks", () => {
    const { ctx, eventBus, taskEngine } = makeContext();

    taskEngine.getQueuedByPriority.mockReturnValue([{ id: "queued-1", priority: 80 }]);

    const getActiveTaskIds = vi.fn(() => []);
    const removeActiveDispatch = vi.fn();

    const pm = createPreemptionManager(ctx, getActiveTaskIds, removeActiveDispatch);
    pm.evaluate(1000);

    expect(pm.getPending()).toBeNull();
    expect(eventBus.publish).not.toHaveBeenCalled();
    // Should not even check queued tasks since no active tasks
    expect(taskEngine.getQueuedByPriority).not.toHaveBeenCalled();
  });

  it("clearPending resets pending state", () => {
    const { ctx, taskEngine } = makeContext({ preemption_threshold: 20 });

    taskEngine.getQueuedByPriority.mockReturnValue([{ id: "queued-1", priority: 80 }]);
    taskEngine.getTask.mockReturnValue({ id: "active-1", priority: 50 });

    const getActiveTaskIds = vi.fn(() => ["active-1"]);
    const removeActiveDispatch = vi.fn();

    const pm = createPreemptionManager(ctx, getActiveTaskIds, removeActiveDispatch);

    pm.evaluate(1000);
    expect(pm.getPending()).not.toBeNull();

    pm.clearPending();
    expect(pm.getPending()).toBeNull();
  });

  it("abandonPending removes active dispatch and clears pending", () => {
    const { ctx, taskEngine } = makeContext({ preemption_threshold: 20 });

    taskEngine.getQueuedByPriority.mockReturnValue([{ id: "queued-1", priority: 80 }]);
    taskEngine.getTask.mockReturnValue({ id: "active-1", priority: 50 });

    const getActiveTaskIds = vi.fn(() => ["active-1"]);
    const removeActiveDispatch = vi.fn();

    const pm = createPreemptionManager(ctx, getActiveTaskIds, removeActiveDispatch);

    pm.evaluate(1000);
    expect(pm.getPending()).not.toBeNull();

    pm.abandonPending();
    expect(removeActiveDispatch).toHaveBeenCalledWith("active-1");
    expect(pm.getPending()).toBeNull();
  });

  it("abandonPending is a no-op when no pending preemption", () => {
    const { ctx } = makeContext();

    const getActiveTaskIds = vi.fn(() => []);
    const removeActiveDispatch = vi.fn();

    const pm = createPreemptionManager(ctx, getActiveTaskIds, removeActiveDispatch);

    pm.abandonPending();
    expect(removeActiveDispatch).not.toHaveBeenCalled();
    expect(pm.getPending()).toBeNull();
  });

  it("skips evaluation when no queued tasks exist", () => {
    const { ctx, eventBus, taskEngine } = makeContext();

    taskEngine.getQueuedByPriority.mockReturnValue([]);
    taskEngine.getTask.mockReturnValue({ id: "active-1", priority: 50 });

    const getActiveTaskIds = vi.fn(() => ["active-1"]);
    const removeActiveDispatch = vi.fn();

    const pm = createPreemptionManager(ctx, getActiveTaskIds, removeActiveDispatch);
    pm.evaluate(1000);

    expect(pm.getPending()).toBeNull();
    expect(eventBus.publish).not.toHaveBeenCalled();
  });
});
