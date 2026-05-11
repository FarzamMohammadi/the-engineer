import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTriggerPoller } from "../../../../src/core/daemon/trigger-poller.js";
import type { TriggerPollerContext } from "../../../../src/core/daemon/types.js";
import { externalRefsMatch } from "../../../../src/core/daemon/unblock-resolver.js";
import type { DaemonConfig } from "../../../../src/schemas/config.js";
import { TaskStates } from "../../../../src/schemas/task.js";
import { createTestObserverFacade } from "../../../helpers/test-observer-facade.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeDaemonConfig(): DaemonConfig {
  return {
    max_concurrent: 1,
    tick_interval_ms: 5_000,
    preemption_threshold: 20,
    preemption_timeout_ms: 60_000,
    stuck_threshold_ms: 1_800_000,
    max_active_duration_ms: 28_800_000,
    shutdown_timeout_ms: 30_000,
    trigger_poll_interval_ms: 30_000,
    response_poll_interval_ms: 5000,
    seen_keys_ttl_ms: 86_400_000,
    logging: {
      level: "info" as const,
      dir: "logs",
      max_size_bytes: 524_288_000,
      max_files: 7,
      console: false,
    },
    plugins: {
      dirs: [],
      health_check_interval_ms: 60_000,
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
    evaluation: { enabled: false },
  };
}

function createMockContext(overrides?: Partial<TriggerPollerContext>): TriggerPollerContext {
  return {
    config: makeDaemonConfig(),
    eventBus: {
      publish: vi.fn(),
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      replay: vi.fn(),
      getEventsForTask: vi.fn().mockReturnValue([]),
      getEventsSince: vi.fn().mockReturnValue([]),
    },
    registry: { getPluginsByType: vi.fn().mockReturnValue([]) },
    taskEngine: {
      createTask: vi.fn((input: { title: string; priority?: number }) => ({
        id: "task-001",
        title: input.title,
        priority: input.priority ?? 50,
      })),
      requestTransition: vi.fn().mockReturnValue({ success: true }),
      getTasksByState: vi.fn().mockReturnValue([]),
      updateTaskField: vi.fn(),
      findByExternalRef: vi.fn().mockReturnValue(false),
    },
    clock: { now: () => 1000 },
    observer: createTestObserverFacade("daemon"),
    ...overrides,
  } as unknown as TriggerPollerContext;
}

function makeTriggerEvent(key: string, title = "Test issue") {
  return {
    idempotency_key: key,
    source: "test",
    event_type: "issue_opened",
    external_ref: { type: "test_issue", repo: "test/repo", id: "1" },
    title,
    body: "Test body",
    repo: "test/repo",
    clone_url: "https://github.com/test/repo.git",
    metadata: null,
  };
}

function makeTriggerPlugin(events: unknown[] = [makeTriggerEvent("key-1")]) {
  return {
    manifest: { id: "test-trigger", type: "trigger", version: "1.0.0", name: "Test Trigger" },
    poll: vi.fn().mockResolvedValue(events),
    hasCapability: vi.fn().mockReturnValue(false),
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("TriggerPoller", () => {
  let ctx: TriggerPollerContext;

  beforeEach(() => {
    ctx = createMockContext();
  });

  it("creates a task from a trigger event", async () => {
    const trigger = makeTriggerPlugin();
    (ctx.registry.getPluginsByType as ReturnType<typeof vi.fn>).mockReturnValue([trigger]);

    const poller = createTriggerPoller(ctx);
    await poller.poll(100_000);

    expect(ctx.taskEngine.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Test issue",
        repo: "test/repo",
        source: "test",
      }),
    );
    expect(ctx.taskEngine.requestTransition).toHaveBeenCalledWith(
      "task-001",
      TaskStates.queued,
      null,
      "new_trigger_event",
      "daemon",
    );
  });

  it("deduplicates events by idempotency_key within TTL", async () => {
    const trigger = makeTriggerPlugin([makeTriggerEvent("dup-key")]);
    (ctx.registry.getPluginsByType as ReturnType<typeof vi.fn>).mockReturnValue([trigger]);

    const poller = createTriggerPoller(ctx);

    // First poll — event should be processed
    await poller.poll(100_000);
    expect(ctx.taskEngine.createTask).toHaveBeenCalledTimes(1);

    // Second poll — same key, within TTL, should be skipped
    // Need to advance time past poll interval but within TTL
    await poller.poll(100_000 + 30_001);
    expect(ctx.taskEngine.createTask).toHaveBeenCalledTimes(1);
  });

  it("re-processes events after TTL expiry", async () => {
    const trigger = makeTriggerPlugin([makeTriggerEvent("expire-key")]);
    (ctx.registry.getPluginsByType as ReturnType<typeof vi.fn>).mockReturnValue([trigger]);

    const poller = createTriggerPoller(ctx);

    // First poll
    await poller.poll(100_000);
    expect(ctx.taskEngine.createTask).toHaveBeenCalledTimes(1);

    // Poll after TTL expiry (86_400_000ms default)
    await poller.poll(100_000 + 86_400_000 + 30_001);
    expect(ctx.taskEngine.createTask).toHaveBeenCalledTimes(2);
  });

  it("respects poll interval — skips polling if interval has not elapsed", async () => {
    const trigger = makeTriggerPlugin();
    (ctx.registry.getPluginsByType as ReturnType<typeof vi.fn>).mockReturnValue([trigger]);

    const poller = createTriggerPoller(ctx);

    await poller.poll(100_000);
    expect(trigger.poll).toHaveBeenCalledTimes(1);

    // Poll again before interval (30s) has elapsed
    await poller.poll(100_000 + 10_000);
    expect(trigger.poll).toHaveBeenCalledTimes(1);

    // Poll after interval has elapsed
    await poller.poll(100_000 + 30_001);
    expect(trigger.poll).toHaveBeenCalledTimes(2);
  });

  it("tracks failures and resets on success", async () => {
    const trigger = makeTriggerPlugin();
    trigger.poll.mockRejectedValueOnce(new Error("network error"));
    (ctx.registry.getPluginsByType as ReturnType<typeof vi.fn>).mockReturnValue([trigger]);

    const poller = createTriggerPoller(ctx);

    // First poll fails
    await poller.poll(100_000);
    expect(poller.getTriggerFailures()).toEqual({ "test-trigger": 1 });

    // Second poll succeeds (after backoff interval: 30_000 * 2^1 = 60_000)
    trigger.poll.mockResolvedValueOnce([]);
    await poller.poll(100_000 + 60_001);
    expect(poller.getTriggerFailures()).toEqual({ "test-trigger": 0 });
  });

  it("emits health.trigger_failure when consecutive failures exceed threshold", async () => {
    const trigger = makeTriggerPlugin();
    trigger.poll.mockRejectedValue(new Error("persistent failure"));
    (ctx.registry.getPluginsByType as ReturnType<typeof vi.fn>).mockReturnValue([trigger]);

    const poller = createTriggerPoller(ctx);

    // Fail 3 times (threshold is 3) with enough time between polls for backoff
    await poller.poll(100_000); // failure 1
    await poller.poll(100_000 + 60_001); // failure 2 (backoff: 30k*2^1 = 60k)
    await poller.poll(100_000 + 60_001 + 120_001); // failure 3 (backoff: 30k*2^2 = 120k)

    // Health event should be emitted on the 3rd failure
    const publishCalls = (ctx.eventBus.publish as ReturnType<typeof vi.fn>).mock.calls;
    const healthEvents = publishCalls.filter(
      (call: unknown[]) => (call[0] as { type: string }).type === "health.trigger_failure",
    );
    expect(healthEvents.length).toBe(1);
    expect((healthEvents[0]![0] as { payload: unknown }).payload).toEqual(
      expect.objectContaining({
        trigger_id: "test-trigger",
        consecutive_failures: 3,
        threshold: 3,
      }),
    );
  });

  it("applies exponential backoff on failures (2^n * base, capped at 300s)", async () => {
    // Backoff is checked against lastPoll time, which is only set on success.
    // So we need a success first to set lastPoll, then test failures against that.
    const trigger = makeTriggerPlugin([]);
    (ctx.registry.getPluginsByType as ReturnType<typeof vi.fn>).mockReturnValue([trigger]);

    const poller = createTriggerPoller(ctx);

    // Success at t=100_000 — sets lastPoll to 100_000
    await poller.poll(100_000);
    expect(trigger.poll).toHaveBeenCalledTimes(1);

    // Now switch to failures
    trigger.poll.mockRejectedValue(new Error("fail"));

    // After success, base interval = 30_000. Poll at t=130_001 (30_001 after lastPoll).
    await poller.poll(130_001);
    expect(trigger.poll).toHaveBeenCalledTimes(2);
    // Failure 1: effective interval now = 30_000 * 2^1 = 60_000
    // lastPoll is still 100_000 (not updated on failure)

    // At t=159_999: 159_999 - 100_000 = 59_999 < 60_000, skipped
    await poller.poll(159_999);
    expect(trigger.poll).toHaveBeenCalledTimes(2);

    // At t=160_001: 160_001 - 100_000 = 60_001 >= 60_000, polls
    await poller.poll(160_001);
    expect(trigger.poll).toHaveBeenCalledTimes(3);
    // Failure 2: effective interval now = 30_000 * 2^2 = 120_000

    // At t=219_999: 219_999 - 100_000 = 119_999 < 120_000, skipped
    await poller.poll(219_999);
    expect(trigger.poll).toHaveBeenCalledTimes(3);

    // At t=220_001: 220_001 - 100_000 = 120_001 >= 120_000, polls
    await poller.poll(220_001);
    expect(trigger.poll).toHaveBeenCalledTimes(4);
  });

  it("caps backoff at 300 seconds", async () => {
    const trigger = makeTriggerPlugin([]);
    (ctx.registry.getPluginsByType as ReturnType<typeof vi.fn>).mockReturnValue([trigger]);

    const poller = createTriggerPoller(ctx);

    // Success at t=1_000_000 — sets lastPoll
    await poller.poll(1_000_000);
    expect(trigger.poll).toHaveBeenCalledTimes(1);

    // Switch to failures and accumulate enough to hit the 300s cap
    trigger.poll.mockRejectedValue(new Error("fail"));

    // lastPoll stays at 1_000_000 since failures don't update it
    // f=0: interval=30k → need t>=1_030_000
    // f=1: interval=60k → need t>=1_060_000
    // f=2: interval=120k → need t>=1_120_000
    // f=3: interval=240k → need t>=1_240_000
    // f=4: interval=min(480k,300k)=300k → need t>=1_300_000 (cap hit!)
    await poller.poll(1_030_001); // f becomes 1
    await poller.poll(1_060_001); // f becomes 2
    await poller.poll(1_120_001); // f becomes 3
    await poller.poll(1_240_001); // f becomes 4
    expect(trigger.poll).toHaveBeenCalledTimes(5); // 1 success + 4 failures

    // Now f=4, effective interval = min(30_000 * 2^4, 300_000) = min(480_000, 300_000) = 300_000
    // Need now - 1_000_000 >= 300_000

    // At 1_299_999: 1_299_999 - 1_000_000 = 299_999 < 300_000, skip
    await poller.poll(1_299_999);
    expect(trigger.poll).toHaveBeenCalledTimes(5);

    // At 1_300_001: 1_300_001 - 1_000_000 = 300_001 >= 300_000, polls
    await poller.poll(1_300_001);
    expect(trigger.poll).toHaveBeenCalledTimes(6);
  });

  it("polls multiple triggers in parallel via Promise.allSettled", async () => {
    const order: string[] = [];

    const triggerA = makeTriggerPlugin([]);
    triggerA.manifest.id = "trigger-a";
    triggerA.poll.mockImplementation(
      () =>
        new Promise((resolve) => {
          order.push("a-start");
          setTimeout(() => {
            order.push("a-end");
            resolve([]);
          }, 10);
        }),
    );

    const triggerB = makeTriggerPlugin([]);
    triggerB.manifest.id = "trigger-b";
    triggerB.poll.mockImplementation(
      () =>
        new Promise((resolve) => {
          order.push("b-start");
          setTimeout(() => {
            order.push("b-end");
            resolve([]);
          }, 10);
        }),
    );

    (ctx.registry.getPluginsByType as ReturnType<typeof vi.fn>).mockReturnValue([triggerA, triggerB]);

    const poller = createTriggerPoller(ctx);
    await poller.poll(100_000);

    // Both should start before either ends (parallel)
    expect(order[0]).toBe("a-start");
    expect(order[1]).toBe("b-start");
    expect(triggerA.poll).toHaveBeenCalledTimes(1);
    expect(triggerB.poll).toHaveBeenCalledTimes(1);
  });

  it("cleans up expired keys", async () => {
    const trigger = makeTriggerPlugin([makeTriggerEvent("key-a"), makeTriggerEvent("key-b")]);
    (ctx.registry.getPluginsByType as ReturnType<typeof vi.fn>).mockReturnValue([trigger]);

    const poller = createTriggerPoller(ctx);
    await poller.poll(100_000);
    expect(poller.getSeenKeyCount()).toBe(2);

    // Clean up before TTL — nothing removed
    poller.cleanupExpiredKeys(100_000 + 1_000);
    expect(poller.getSeenKeyCount()).toBe(2);

    // Clean up after TTL (100_000 + 86_400_000 = 86_500_000)
    poller.cleanupExpiredKeys(100_000 + 86_400_000 + 1);
    expect(poller.getSeenKeyCount()).toBe(0);
  });

  it("emits trigger.new_event on EventBus for each new trigger event", async () => {
    const trigger = makeTriggerPlugin([makeTriggerEvent("evt-key", "My new issue")]);
    (ctx.registry.getPluginsByType as ReturnType<typeof vi.fn>).mockReturnValue([trigger]);

    const poller = createTriggerPoller(ctx);
    await poller.poll(100_000);

    const publishCalls = (ctx.eventBus.publish as ReturnType<typeof vi.fn>).mock.calls;
    const triggerEvents = publishCalls.filter(
      (call: unknown[]) => (call[0] as { type: string }).type === "trigger.new_event",
    );
    expect(triggerEvents.length).toBe(1);
    expect((triggerEvents[0]![0] as { payload: unknown }).payload).toEqual(
      expect.objectContaining({
        idempotency_key: "evt-key",
        title: "My new issue",
        source: "test",
        repo: "test/repo",
      }),
    );
  });

  it("handles no registered triggers gracefully", async () => {
    const poller = createTriggerPoller(ctx);
    await expect(poller.poll(100_000)).resolves.toBeUndefined();
    expect(poller.getSeenKeyCount()).toBe(0);
    expect(poller.getTriggerFailures()).toEqual({});
  });

  it("continues processing other events when one trigger rejects", async () => {
    const failTrigger = makeTriggerPlugin();
    failTrigger.manifest.id = "fail-trigger";
    failTrigger.poll.mockRejectedValue(new Error("boom"));

    const successTrigger = makeTriggerPlugin([makeTriggerEvent("ok-key")]);
    successTrigger.manifest.id = "success-trigger";

    (ctx.registry.getPluginsByType as ReturnType<typeof vi.fn>).mockReturnValue([failTrigger, successTrigger]);

    const poller = createTriggerPoller(ctx);
    await poller.poll(100_000);

    // The successful trigger's event should still create a task
    expect(ctx.taskEngine.createTask).toHaveBeenCalledTimes(1);
    // The failing trigger should be tracked
    expect(poller.getTriggerFailures()).toEqual(expect.objectContaining({ "fail-trigger": 1 }));
  });
});

// ── externalRefsMatch (pure function) ────────────────────────────────────────

describe("externalRefsMatch", () => {
  it("returns true for matching repo + id", () => {
    const a = { type: "test_issue", repo: "owner/repo", id: "42" };
    const b = { type: "test_issue", repo: "owner/repo", id: "42" };
    expect(externalRefsMatch(a, b)).toBe(true);
  });

  it("returns true when types differ (matches on repo + id only)", () => {
    const a = { type: "test_issue", repo: "owner/repo", id: "42" };
    const b = { type: "test_pr", repo: "owner/repo", id: "42" };
    expect(externalRefsMatch(a, b)).toBe(true);
  });

  it("returns false when repos differ", () => {
    const a = { type: "test_issue", repo: "owner/repo-a", id: "42" };
    const b = { type: "test_issue", repo: "owner/repo-b", id: "42" };
    expect(externalRefsMatch(a, b)).toBe(false);
  });

  it("returns false when ids differ", () => {
    const a = { type: "test_issue", repo: "owner/repo", id: "1" };
    const b = { type: "test_issue", repo: "owner/repo", id: "2" };
    expect(externalRefsMatch(a, b)).toBe(false);
  });
});
