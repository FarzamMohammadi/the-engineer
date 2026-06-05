import { describe, expect, it, vi } from "vitest";

import { createPreemptionManager } from "../../../../src/core/daemon/preemption-manager.js";
import type { PreemptionManagerContext } from "../../../../src/core/daemon/types.js";
import type { DispatchTracker } from "../../../../src/core/dispatch-tracker/index.js";
import type { DaemonConfig } from "../../../../src/schemas/config.js";
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
    notification_suppress_window_ms: 300_000,
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

function makeDispatchTracker(): DispatchTracker {
  return {
    register: vi.fn(),
    terminate: vi.fn(),
    isInFlight: vi.fn().mockReturnValue(true),
    getActiveCount: vi.fn().mockReturnValue(0),
    getActiveTaskIds: vi.fn().mockReturnValue([]),
    drain: vi.fn().mockResolvedValue(undefined),
  };
}

function makeEligible(id: string, priority: number): { id: string; priority: number; not_before: string | null } {
  return { id, priority, not_before: null };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("PreemptionManager", () => {
  it("initiates preemption when priority delta exceeds threshold", () => {
    const { ctx, eventBus, taskEngine } = makeContext({ preemption_threshold: 20 });

    taskEngine.getQueuedByPriority.mockReturnValue([makeEligible("queued-1", 80)]);
    taskEngine.getTask.mockReturnValue({ id: "active-1", priority: 50 });

    const getActiveTaskIds = vi.fn(() => ["active-1"]);
    const dispatchTracker = makeDispatchTracker();

    const pm = createPreemptionManager(ctx, getActiveTaskIds, dispatchTracker);
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

    taskEngine.getQueuedByPriority.mockReturnValue([makeEligible("queued-1", 60)]);
    taskEngine.getTask.mockReturnValue({ id: "active-1", priority: 50 });

    const getActiveTaskIds = vi.fn(() => ["active-1"]);
    const dispatchTracker = makeDispatchTracker();

    const pm = createPreemptionManager(ctx, getActiveTaskIds, dispatchTracker);
    pm.evaluate(1000);

    expect(pm.getPending()).toBeNull();
    expect(eventBus.publish).not.toHaveBeenCalled();
  });

  it("re-requests preemption on first timeout", () => {
    const { ctx, eventBus, taskEngine } = makeContext({
      preemption_threshold: 20,
      preemption_timeout_ms: 30_000,
    });

    taskEngine.getQueuedByPriority.mockReturnValue([makeEligible("queued-1", 80)]);
    taskEngine.getTask.mockReturnValue({ id: "active-1", priority: 50 });

    const getActiveTaskIds = vi.fn(() => ["active-1"]);
    const dispatchTracker = makeDispatchTracker();

    const pm = createPreemptionManager(ctx, getActiveTaskIds, dispatchTracker);

    pm.evaluate(1000);
    expect(eventBus.publish).toHaveBeenCalledOnce();

    pm.evaluate(32_000);

    expect(eventBus.publish).toHaveBeenCalledTimes(2);
    expect(eventBus.publish).toHaveBeenLastCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          reason: "preemption_timeout_retry",
        }),
      }),
    );

    const pending = pm.getPending();
    expect(pending).not.toBeNull();
    expect(pending?.retried).toBe(true);
    expect(dispatchTracker.terminate).not.toHaveBeenCalled();
    expect(taskEngine.requestTransition).not.toHaveBeenCalled();
  });

  it("terminates the dispatch with reason preemption_timeout on double timeout", () => {
    const { ctx, taskEngine } = makeContext({
      preemption_threshold: 20,
      preemption_timeout_ms: 30_000,
    });

    taskEngine.getQueuedByPriority.mockReturnValue([makeEligible("queued-1", 80)]);
    taskEngine.getTask.mockReturnValue({ id: "active-1", priority: 50 });

    const getActiveTaskIds = vi.fn(() => ["active-1"]);
    const dispatchTracker = makeDispatchTracker();

    const pm = createPreemptionManager(ctx, getActiveTaskIds, dispatchTracker);

    pm.evaluate(0);
    pm.evaluate(31_000);
    expect(pm.getPending()?.retried).toBe(true);

    pm.evaluate(62_000);

    expect(dispatchTracker.terminate).toHaveBeenCalledWith("active-1", "preemption_timeout");
    // The scheduler's terminate routing handles the queued transition — preemption-manager
    // no longer issues it directly.
    expect(taskEngine.requestTransition).not.toHaveBeenCalled();
    expect(pm.getPending()).toBeNull();
  });

  it("filters out ineligible candidates before picking — does not preempt for a not_before-blocked candidate", () => {
    const { ctx, eventBus, taskEngine } = makeContext({ preemption_threshold: 20 });

    const future = new Date(2000).toISOString();
    taskEngine.getQueuedByPriority.mockReturnValue([
      { id: "queued-blocked", priority: 80, not_before: future },
      makeEligible("queued-eligible", 70),
    ]);
    taskEngine.getTask.mockReturnValue({ id: "active-1", priority: 50 });

    const getActiveTaskIds = vi.fn(() => ["active-1"]);
    const dispatchTracker = makeDispatchTracker();

    const pm = createPreemptionManager(ctx, getActiveTaskIds, dispatchTracker);
    pm.evaluate(1000);

    // The 80-priority candidate is ineligible; the eligible 70 should be picked instead.
    expect(pm.getPending()?.replacementTaskId).toBe("queued-eligible");
    expect(eventBus.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ preempting_task_id: "queued-eligible", priority_delta: 20 }),
      }),
    );
  });

  it("does not preempt when every queued candidate is ineligible", () => {
    const { ctx, eventBus, taskEngine } = makeContext({ preemption_threshold: 20 });

    const future = new Date(2000).toISOString();
    taskEngine.getQueuedByPriority.mockReturnValue([{ id: "queued-blocked", priority: 90, not_before: future }]);
    taskEngine.getTask.mockReturnValue({ id: "active-1", priority: 50 });

    const getActiveTaskIds = vi.fn(() => ["active-1"]);
    const dispatchTracker = makeDispatchTracker();

    const pm = createPreemptionManager(ctx, getActiveTaskIds, dispatchTracker);
    pm.evaluate(1000);

    expect(pm.getPending()).toBeNull();
    expect(eventBus.publish).not.toHaveBeenCalled();
  });

  it("skips evaluation when a pending preemption already exists", () => {
    const { ctx, eventBus, taskEngine } = makeContext({
      preemption_threshold: 20,
      preemption_timeout_ms: 300_000,
    });

    taskEngine.getQueuedByPriority.mockReturnValue([makeEligible("queued-1", 80)]);
    taskEngine.getTask.mockReturnValue({ id: "active-1", priority: 50 });

    const getActiveTaskIds = vi.fn(() => ["active-1"]);
    const dispatchTracker = makeDispatchTracker();

    const pm = createPreemptionManager(ctx, getActiveTaskIds, dispatchTracker);

    pm.evaluate(1000);
    expect(eventBus.publish).toHaveBeenCalledOnce();

    pm.evaluate(2000);
    expect(eventBus.publish).toHaveBeenCalledOnce();
    expect(getActiveTaskIds).toHaveBeenCalledOnce();
  });

  it("skips evaluation when there are no active tasks", () => {
    const { ctx, eventBus, taskEngine } = makeContext();

    taskEngine.getQueuedByPriority.mockReturnValue([makeEligible("queued-1", 80)]);

    const getActiveTaskIds = vi.fn(() => []);
    const dispatchTracker = makeDispatchTracker();

    const pm = createPreemptionManager(ctx, getActiveTaskIds, dispatchTracker);
    pm.evaluate(1000);

    expect(pm.getPending()).toBeNull();
    expect(eventBus.publish).not.toHaveBeenCalled();
    expect(taskEngine.getQueuedByPriority).not.toHaveBeenCalled();
  });

  it("clearPending resets pending state", () => {
    const { ctx, taskEngine } = makeContext({ preemption_threshold: 20 });

    taskEngine.getQueuedByPriority.mockReturnValue([makeEligible("queued-1", 80)]);
    taskEngine.getTask.mockReturnValue({ id: "active-1", priority: 50 });

    const getActiveTaskIds = vi.fn(() => ["active-1"]);
    const dispatchTracker = makeDispatchTracker();

    const pm = createPreemptionManager(ctx, getActiveTaskIds, dispatchTracker);

    pm.evaluate(1000);
    expect(pm.getPending()).not.toBeNull();

    pm.clearPending();
    expect(pm.getPending()).toBeNull();
  });

  it("skips evaluation when no queued tasks exist", () => {
    const { ctx, eventBus, taskEngine } = makeContext();

    taskEngine.getQueuedByPriority.mockReturnValue([]);
    taskEngine.getTask.mockReturnValue({ id: "active-1", priority: 50 });

    const getActiveTaskIds = vi.fn(() => ["active-1"]);
    const dispatchTracker = makeDispatchTracker();

    const pm = createPreemptionManager(ctx, getActiveTaskIds, dispatchTracker);
    pm.evaluate(1000);

    expect(pm.getPending()).toBeNull();
    expect(eventBus.publish).not.toHaveBeenCalled();
  });
});
