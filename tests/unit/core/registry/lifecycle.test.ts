import { beforeEach, describe, expect, it, vi } from "vitest";

import { createLifecycleManager } from "../../../../src/core/registry/lifecycle.js";
import type { AdapterType, PluginManifest } from "../../../../src/schemas/adapters.js";
import { PluginHealthStates } from "../../../../src/schemas/adapters.js";
import { FakeLLMPlugin } from "../../../helpers/fake-plugins/fake-llm/index.js";
import { FakeTriggerPlugin } from "../../../helpers/fake-plugins/fake-trigger/index.js";
import { createMockManifest } from "../../../helpers/mock-factories.js";
import { createTestObserverFacade } from "../../../helpers/test-observer-facade.js";
import { createTestPluginContext } from "../../../helpers/test-plugin-context.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function createManifest(type: AdapterType, id: string, overrides?: Partial<PluginManifest>) {
  return createMockManifest({ id, type, name: id, ...overrides });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("createLifecycleManager", () => {
  let lifecycle: ReturnType<typeof createLifecycleManager>;

  beforeEach(() => {
    const observer = createTestObserverFacade("registry");
    lifecycle = createLifecycleManager(observer);
  });

  describe("register", () => {
    it("stores a plugin and returns success", () => {
      const instance = new FakeTriggerPlugin();
      const manifest = createManifest("trigger", "t1");

      const result = lifecycle.register(manifest, instance);

      expect(result.success).toBe(true);
      expect(result.plugin_id).toBe("t1");
    });

    it("injects manifest into the instance", () => {
      const instance = new FakeTriggerPlugin();
      const manifest = createManifest("trigger", "t1");

      lifecycle.register(manifest, instance);

      expect(instance.manifest).toBe(manifest);
    });

    it("rejects duplicate plugin ID", () => {
      const manifest = createManifest("trigger", "dup");
      lifecycle.register(manifest, new FakeTriggerPlugin());

      const result = lifecycle.register(manifest, new FakeTriggerPlugin());

      expect(result.success).toBe(false);
    });

    it("initializes health record as healthy", () => {
      const instance = new FakeTriggerPlugin();
      lifecycle.register(createManifest("trigger", "t1"), instance);

      const record = lifecycle.getRecord("t1");
      expect(record?.health.state).toBe(PluginHealthStates.healthy);
      expect(record?.health.consecutive_failures).toBe(0);
    });
  });

  describe("deregister", () => {
    it("removes a registered plugin", () => {
      lifecycle.register(createManifest("trigger", "t1"), new FakeTriggerPlugin());
      lifecycle.deregister("t1");

      expect(lifecycle.getPlugin("trigger", "t1")).toBeNull();
    });
  });

  describe("getPluginsByType", () => {
    it("returns all plugins of the given type", () => {
      lifecycle.register(createManifest("trigger", "t1"), new FakeTriggerPlugin());
      lifecycle.register(createManifest("trigger", "t2"), new FakeTriggerPlugin());
      lifecycle.register(createManifest("llm", "l1"), new FakeLLMPlugin());

      const triggers = lifecycle.getPluginsByType("trigger");

      expect(triggers).toHaveLength(2);
    });

    it("returns empty array for a type with no plugins", () => {
      expect(lifecycle.getPluginsByType("communication")).toEqual([]);
    });
  });

  describe("per-type cache", () => {
    it("returns same results on repeated calls", () => {
      lifecycle.register(createManifest("trigger", "t1"), new FakeTriggerPlugin());

      const first = lifecycle.getPluginsByType("trigger");
      const second = lifecycle.getPluginsByType("trigger");

      expect(first).toEqual(second);
    });

    it("invalidates cache on register", () => {
      lifecycle.register(createManifest("trigger", "t1"), new FakeTriggerPlugin());
      const before = lifecycle.getPluginsByType("trigger");

      lifecycle.register(createManifest("trigger", "t2"), new FakeTriggerPlugin());
      const after = lifecycle.getPluginsByType("trigger");

      expect(before).toHaveLength(1);
      expect(after).toHaveLength(2);
    });

    it("invalidates cache on deregister", () => {
      lifecycle.register(createManifest("trigger", "t1"), new FakeTriggerPlugin());
      lifecycle.register(createManifest("trigger", "t2"), new FakeTriggerPlugin());
      const before = lifecycle.getPluginsByType("trigger");

      lifecycle.deregister("t1");
      const after = lifecycle.getPluginsByType("trigger");

      expect(before).toHaveLength(2);
      expect(after).toHaveLength(1);
    });
  });

  describe("getPrimaryPlugin", () => {
    it("returns the first registered plugin of a type", () => {
      const first = new FakeTriggerPlugin();
      const second = new FakeTriggerPlugin();
      lifecycle.register(createManifest("trigger", "t1"), first);
      lifecycle.register(createManifest("trigger", "t2"), second);

      const primary = lifecycle.getPrimaryPlugin("trigger");

      expect(primary).toBe(first);
    });

    it("returns null when no plugins of the type exist", () => {
      expect(lifecycle.getPrimaryPlugin("communication")).toBeNull();
    });
  });

  describe("initializePlugin", () => {
    it("calls initialize on the plugin with the given config", async () => {
      const instance = new FakeTriggerPlugin();
      lifecycle.register(createManifest("trigger", "t1"), instance);
      instance.context = createTestPluginContext("t1");

      const result = await lifecycle.initializePlugin("t1", { key: "value" });

      expect(result.success).toBe(true);
      expect(instance.getInitConfig()).toEqual({ key: "value" });
    });

    it("returns failure for unregistered plugin", async () => {
      const result = await lifecycle.initializePlugin("unknown", {});

      expect(result.success).toBe(false);
    });
  });

  describe("shutdownAll", () => {
    it("calls shutdown on all registered plugins", async () => {
      const t1 = new FakeTriggerPlugin();
      const t2 = new FakeTriggerPlugin();
      lifecycle.register(createManifest("trigger", "t1"), t1);
      lifecycle.register(createManifest("trigger", "t2"), t2);

      await lifecycle.shutdownAll();

      expect(t1.wasShutdownCalled()).toBe(true);
      expect(t2.wasShutdownCalled()).toBe(true);
    });

    it("shuts down in reverse init order", async () => {
      const shutdownOrder: string[] = [];
      const t1 = new FakeTriggerPlugin();
      const t2 = new FakeLLMPlugin();

      lifecycle.register(createManifest("trigger", "t1"), t1);
      lifecycle.register(createManifest("llm", "l1"), t2);

      vi.spyOn(t1, "shutdown").mockImplementation(() => {
        shutdownOrder.push("t1");
        return Promise.resolve();
      });
      vi.spyOn(t2, "shutdown").mockImplementation(() => {
        shutdownOrder.push("l1");
        return Promise.resolve();
      });

      await lifecycle.shutdownAll();

      // l1 was registered second (higher initOrder), so shuts down first
      expect(shutdownOrder).toEqual(["l1", "t1"]);
    });
  });

  describe("getManifest", () => {
    it("returns the manifest for a registered plugin", () => {
      const manifest = createManifest("trigger", "t1");
      lifecycle.register(manifest, new FakeTriggerPlugin());

      expect(lifecycle.getManifest("t1")).toEqual(manifest);
    });

    it("returns null for unknown plugin", () => {
      expect(lifecycle.getManifest("unknown")).toBeNull();
    });
  });

  describe("getAllRecords", () => {
    it("returns all registered records", () => {
      lifecycle.register(createManifest("trigger", "t1"), new FakeTriggerPlugin());
      lifecycle.register(createManifest("llm", "llm1"), new FakeLLMPlugin());

      const records = lifecycle.getAllRecords();

      expect(records).toHaveLength(2);
    });
  });
});
