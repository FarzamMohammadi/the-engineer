import { afterEach, describe, expect, it } from "vitest";

import { EventBus } from "../../src/core/event-bus/index.js";
import { Registry } from "../../src/core/registry/index.js";
import type { Event } from "../../src/schemas/events.js";
import { FakeLLMPlugin } from "../helpers/fake-plugins/fake-llm/index.js";
import { FakeTriggerPlugin } from "../helpers/fake-plugins/fake-trigger/index.js";
import { createMockManifest } from "../helpers/mock-factories.js";
import { type TestDatabaseHandle, createTestDatabase } from "../helpers/test-database.js";

describe("Health state machine (integration)", () => {
  let dbHandle: TestDatabaseHandle;
  let eventBus: EventBus;
  let registry: Registry;

  function setup(): void {
    dbHandle = createTestDatabase();
    eventBus = new EventBus(dbHandle.db);
    registry = new Registry({
      eventBus,
      healthCheckIntervalMs: 60_000,
      healthCheckTimeoutMs: 5_000,
      consecutiveFailuresThreshold: 3,
    });
  }

  afterEach(() => {
    registry?.stopHealthCheckLoop();
    dbHandle?.cleanup();
  });

  it("starts healthy after initialization", async () => {
    setup();
    const plugin = new FakeTriggerPlugin();
    registry.register(createMockManifest({ id: "p1", type: "trigger", name: "P1" }), plugin);
    await registry.initializePlugin("p1", {});

    const results = await registry.healthCheckAll();
    const p1 = results.find((r) => r.plugin_id === "p1");
    expect(p1?.state).toBe("healthy");
  });

  it("transitions to unhealthy when plugin reports unhealthy", async () => {
    setup();
    const healthEvents: Event[] = [];
    eventBus.subscribe("test-health", "health.*", (e) => healthEvents.push(e));

    const plugin = new FakeTriggerPlugin();
    registry.register(createMockManifest({ id: "p2", type: "trigger", name: "P2" }), plugin);
    await registry.initializePlugin("p2", {});

    plugin.setUnhealthy(true);
    await registry.healthCheckAll();

    const results = await registry.healthCheckAll();
    const p2 = results.find((r) => r.plugin_id === "p2");
    expect(p2?.state).toBe("unhealthy");

    const unhealthyEvents = healthEvents.filter((e) => e.type === "health.plugin_unhealthy");
    expect(unhealthyEvents.length).toBeGreaterThanOrEqual(1);
  });

  it("transitions to failed after consecutive failures reach threshold", async () => {
    setup();
    const healthEvents: Event[] = [];
    eventBus.subscribe("test-health", "health.*", (e) => healthEvents.push(e));

    const plugin = new FakeTriggerPlugin();
    registry.register(createMockManifest({ id: "p3", type: "trigger", name: "P3" }), plugin);
    await registry.initializePlugin("p3", {});

    plugin.setUnhealthy(true);

    // Run health checks 3 times (the threshold)
    await registry.healthCheckAll();
    await registry.healthCheckAll();
    await registry.healthCheckAll();

    const results = await registry.healthCheckAll();
    const p3 = results.find((r) => r.plugin_id === "p3");
    expect(p3?.state).toBe("failed");

    const failedEvents = healthEvents.filter((e) => e.type === "health.plugin_failed");
    expect(failedEvents.length).toBeGreaterThanOrEqual(1);
  });

  it("recovers from unhealthy to healthy", async () => {
    setup();
    const healthEvents: Event[] = [];
    eventBus.subscribe("test-health", "health.*", (e) => healthEvents.push(e));

    const plugin = new FakeTriggerPlugin();
    registry.register(createMockManifest({ id: "p4", type: "trigger", name: "P4" }), plugin);
    await registry.initializePlugin("p4", {});

    // Make unhealthy
    plugin.setUnhealthy(true);
    await registry.healthCheckAll();

    let results = await registry.healthCheckAll();
    expect(results.find((r) => r.plugin_id === "p4")?.state).toBe("unhealthy");

    // Recover
    plugin.setUnhealthy(false);
    await registry.healthCheckAll();

    results = await registry.healthCheckAll();
    const p4 = results.find((r) => r.plugin_id === "p4");
    expect(p4?.state).toBe("healthy");

    const recoveredEvents = healthEvents.filter((e) => e.type === "health.plugin_recovered");
    expect(recoveredEvents.length).toBeGreaterThanOrEqual(1);
  });

  it("tracks independent health states for multiple plugins", async () => {
    setup();

    const trigger = new FakeTriggerPlugin();
    const llm = new FakeLLMPlugin();

    registry.register(createMockManifest({ id: "t1", type: "trigger", name: "Trigger" }), trigger);
    registry.register(createMockManifest({ id: "l1", type: "llm", name: "LLM" }), llm);

    await registry.initializePlugin("t1", {});
    await registry.initializePlugin("l1", {});

    // Only trigger becomes unhealthy
    trigger.setUnhealthy(true);
    await registry.healthCheckAll();

    const results = await registry.healthCheckAll();
    expect(results.find((r) => r.plugin_id === "t1")?.state).toBe("unhealthy");
    expect(results.find((r) => r.plugin_id === "l1")?.state).toBe("healthy");
  });
});
