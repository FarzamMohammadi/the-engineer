import { afterEach, describe, expect, it } from "vitest";

import { EventBus } from "../../src/core/event-bus/index.js";
import { Registry } from "../../src/core/registry/index.js";
import { AdapterTypes, PluginHealthStates } from "../../src/schemas/adapters.js";
import { FakeCommunicationPlugin } from "../helpers/fake-plugins/fake-comm/index.js";
import { FakeGitHostingPlugin } from "../helpers/fake-plugins/fake-git-hosting/index.js";
import { FakeLLMPlugin } from "../helpers/fake-plugins/fake-llm/index.js";
import { FakeTriggerPlugin } from "../helpers/fake-plugins/fake-trigger/index.js";
import { createMockManifest } from "../helpers/mock-factories.js";
import { type TestDatabaseHandle, createTestDatabase } from "../helpers/test-database.js";
import { createTestObserverFacade } from "../helpers/test-observer-facade.js";

describe("Registry plugin loading (integration)", () => {
  let dbHandle: TestDatabaseHandle;
  let eventBus: EventBus;
  let registry: Registry;

  function setup(): Registry {
    dbHandle = createTestDatabase();
    const observer = createTestObserverFacade("event-bus");
    eventBus = new EventBus(dbHandle.db, { observer });
    registry = new Registry({
      eventBus,
      observer: createTestObserverFacade("registry"),
      healthCheckIntervalMs: 60_000,
      healthCheckTimeoutMs: 1_000,
      consecutiveFailuresThreshold: 3,
    });
    return registry;
  }

  afterEach(() => {
    registry?.stopHealthCheckLoop();
    dbHandle?.cleanup();
  });

  describe("registration and retrieval", () => {
    it("registers all 4 fake plugin types and retrieves them", () => {
      setup();

      registry.register(
        createMockManifest({ id: "t1", type: AdapterTypes.trigger, name: "Trigger" }),
        new FakeTriggerPlugin(),
      );
      registry.register(
        createMockManifest({ id: "c1", type: AdapterTypes.communication, name: "Comm" }),
        new FakeCommunicationPlugin(),
      );
      registry.register(createMockManifest({ id: "l1", type: AdapterTypes.llm, name: "LLM" }), new FakeLLMPlugin());
      registry.register(
        createMockManifest({ id: "g1", type: AdapterTypes.git_hosting, name: "Git" }),
        new FakeGitHostingPlugin(),
      );

      expect(registry.getPlugin("trigger", "t1")).toBeInstanceOf(FakeTriggerPlugin);
      expect(registry.getPlugin("communication", "c1")).toBeInstanceOf(FakeCommunicationPlugin);
      expect(registry.getPlugin("llm", "l1")).toBeInstanceOf(FakeLLMPlugin);
      expect(registry.getPlugin("git_hosting", "g1")).toBeInstanceOf(FakeGitHostingPlugin);
    });

    it("getPluginsByType returns only plugins of the given type", () => {
      setup();

      registry.register(
        createMockManifest({ id: "t1", type: AdapterTypes.trigger, name: "T1" }),
        new FakeTriggerPlugin(),
      );
      registry.register(
        createMockManifest({ id: "t2", type: AdapterTypes.trigger, name: "T2" }),
        new FakeTriggerPlugin(),
      );
      registry.register(createMockManifest({ id: "l1", type: AdapterTypes.llm, name: "LLM" }), new FakeLLMPlugin());

      const triggers = registry.getPluginsByType("trigger");
      expect(triggers).toHaveLength(2);

      const llms = registry.getPluginsByType("llm");
      expect(llms).toHaveLength(1);
    });

    it("getPrimaryPlugin returns the first plugin of a type", () => {
      setup();

      const first = new FakeLLMPlugin();
      registry.register(createMockManifest({ id: "l1", type: AdapterTypes.llm, name: "Primary" }), first);
      registry.register(
        createMockManifest({ id: "l2", type: AdapterTypes.llm, name: "Secondary" }),
        new FakeLLMPlugin(),
      );

      expect(registry.getPrimaryPlugin("llm")).toBe(first);
    });

    it("returns null for unregistered plugin", () => {
      setup();
      expect(registry.getPlugin("trigger", "nonexistent")).toBeNull();
      expect(registry.getPrimaryPlugin("trigger")).toBeNull();
    });
  });

  describe("duplicate rejection", () => {
    it("rejects registration with duplicate ID", () => {
      setup();

      const first = registry.register(
        createMockManifest({ id: "dup", type: AdapterTypes.trigger, name: "First" }),
        new FakeTriggerPlugin(),
      );
      expect(first.success).toBe(true);

      const second = registry.register(
        createMockManifest({ id: "dup", type: AdapterTypes.trigger, name: "Second" }),
        new FakeTriggerPlugin(),
      );
      expect(second.success).toBe(false);
      expect(second.message).toMatch(/already registered/i);
    });
  });

  describe("deregistration", () => {
    it("removes a plugin and it is no longer retrievable", () => {
      setup();

      registry.register(
        createMockManifest({ id: "rem", type: AdapterTypes.trigger, name: "Removable" }),
        new FakeTriggerPlugin(),
      );

      expect(registry.getPlugin("trigger", "rem")).not.toBeNull();

      registry.deregister("rem");

      expect(registry.getPlugin("trigger", "rem")).toBeNull();
    });
  });

  describe("health checks", () => {
    it("reports healthy for properly initialized plugins", async () => {
      setup();

      const plugin = new FakeTriggerPlugin();
      registry.register(createMockManifest({ id: "h1", type: AdapterTypes.trigger, name: "Healthy" }), plugin);
      await registry.initializePlugin("h1", {});

      const results = await registry.healthCheckAll();
      const h1Result = results.find((r) => r.plugin_id === "h1");
      expect(h1Result?.state).toBe(PluginHealthStates.healthy);
    });

    it("reports unhealthy when plugin health check fails", async () => {
      setup();

      const plugin = new FakeTriggerPlugin();
      registry.register(createMockManifest({ id: "h2", type: AdapterTypes.trigger, name: "Unhealthy" }), plugin);
      await registry.initializePlugin("h2", {});

      plugin.setUnhealthy(true);

      const results = await registry.healthCheckAll();
      const h2Result = results.find((r) => r.plugin_id === "h2");
      expect(h2Result?.state).toBe(PluginHealthStates.unhealthy);
    });
  });

  describe("shutdown", () => {
    it("shuts down all registered plugins", async () => {
      setup();

      const trigger = new FakeTriggerPlugin();
      const comm = new FakeCommunicationPlugin();

      registry.register(createMockManifest({ id: "s1", type: AdapterTypes.trigger, name: "S1" }), trigger);
      registry.register(createMockManifest({ id: "s2", type: AdapterTypes.communication, name: "S2" }), comm);

      await registry.initializePlugin("s1", {});
      await registry.initializePlugin("s2", {});
      await registry.shutdownAll();

      expect(trigger.wasShutdownCalled()).toBe(true);
      expect(comm.wasShutdownCalled()).toBe(true);
    });
  });
});
