import { afterEach, describe, expect, it } from "vitest";

import type { TriggerEvent } from "../../src/schemas/adapters.js";
import type { Event } from "../../src/schemas/events.js";
import {
  type IntegrationContext,
  createIntegrationContext,
} from "../helpers/integration-context.js";

describe("Daemon trigger polling (integration)", () => {
  let ctx: IntegrationContext;

  function setup(options?: Parameters<typeof createIntegrationContext>[0]): IntegrationContext {
    ctx = createIntegrationContext(options);
    return ctx;
  }

  afterEach(async () => {
    if (ctx) {
      try {
        await ctx.daemon.stop();
      } catch {
        // May not be started
      }
      ctx.cleanup();
    }
  });

  function makeTriggerEvent(overrides?: Partial<TriggerEvent>): TriggerEvent {
    return {
      idempotency_key: `test:issue:repo:${String(Date.now())}:${String(Math.random()).slice(2, 8)}`,
      source: "fake-trigger",
      event_type: "issue_opened",
      external_ref: "https://github.com/test/repo/issues/1",
      title: "Test issue",
      body: "Test body",
      repo: "test/repo",
      metadata: null,
      ...overrides,
    };
  }

  it("creates a task from a trigger event on tick", async () => {
    setup();

    const event = makeTriggerEvent({ title: "Add dark mode" });
    ctx.fakes.trigger.setEvents([event]);

    // Initialize trigger plugin so poll() works
    await ctx.registry.initializePlugin("fake-trigger", {});

    await ctx.daemon.start();

    // Advance clock past poll interval and tick
    ctx.clock.advance(1_000);
    await ctx.daemon.tick();

    // Verify task was created (may be queued or already active/completed)
    const queued = ctx.taskEngine.getTasksByState("queued");
    const active = ctx.taskEngine.getTasksByState("active");
    const completed = ctx.taskEngine.getTasksByState("completed");
    const allTasks = [...queued, ...active, ...completed];
    expect(allTasks.length).toBeGreaterThanOrEqual(1);
    expect(allTasks.some((t) => t.title === "Add dark mode")).toBe(true);
  });

  it("deduplicates trigger events with the same idempotency key", async () => {
    setup();

    const event = makeTriggerEvent({
      idempotency_key: "test:issue:repo:42",
      title: "Duplicate issue",
    });
    ctx.fakes.trigger.setEvents([event]);

    await ctx.registry.initializePlugin("fake-trigger", {});
    await ctx.daemon.start();

    // First tick — creates task
    ctx.clock.advance(1_000);
    await ctx.daemon.tick();

    const afterFirst = ctx.taskEngine.getTasksByState("queued").length;

    // Second tick — same event, should be deduped
    ctx.clock.advance(1_000);
    await ctx.daemon.tick();

    const afterSecond = ctx.taskEngine.getTasksByState("queued").length;
    expect(afterSecond).toBe(afterFirst);
  });

  it("emits trigger.new_event to EventBus", async () => {
    setup();

    const triggerEvents: Event[] = [];
    ctx.eventBus.subscribe("test-trigger", "trigger.new_event", (e) => triggerEvents.push(e));

    ctx.fakes.trigger.setEvents([makeTriggerEvent({ title: "New event" })]);
    await ctx.registry.initializePlugin("fake-trigger", {});

    await ctx.daemon.start();
    ctx.clock.advance(1_000);
    await ctx.daemon.tick();

    expect(triggerEvents).toHaveLength(1);
    expect(triggerEvents[0]?.payload).toMatchObject({ title: "New event" });
  });

  it("counts trigger poll failures and emits health event", async () => {
    setup({ daemonConfig: { trigger_poll_interval_ms: 0 } });

    const healthEvents: Event[] = [];
    ctx.eventBus.subscribe("test-health", "health.trigger_failure", (e) => healthEvents.push(e));

    ctx.fakes.trigger.setFailNextPoll(true);
    await ctx.registry.initializePlugin("fake-trigger", {});

    await ctx.daemon.start();

    // Fail 3 times (threshold)
    for (let i = 0; i < 3; i++) {
      ctx.fakes.trigger.setFailNextPoll(true);
      ctx.clock.advance(1_000);
      await ctx.daemon.tick();
    }

    expect(healthEvents.length).toBeGreaterThanOrEqual(1);
  });

  it("respects trigger poll interval rate limiting", async () => {
    setup({
      daemonConfig: { trigger_poll_interval_ms: 30_000 },
    });

    ctx.fakes.trigger.setEvents([makeTriggerEvent({ title: "Rate limited" })]);
    await ctx.registry.initializePlugin("fake-trigger", {});

    await ctx.daemon.start();

    // First tick polls
    ctx.clock.advance(31_000);
    await ctx.daemon.tick();
    expect(ctx.fakes.trigger.getPollCount()).toBe(1);

    // Second tick within interval — should NOT poll
    ctx.clock.advance(5_000);
    await ctx.daemon.tick();
    expect(ctx.fakes.trigger.getPollCount()).toBe(1);

    // Third tick past interval — should poll
    ctx.clock.advance(30_000);
    await ctx.daemon.tick();
    expect(ctx.fakes.trigger.getPollCount()).toBe(2);
  });
});
