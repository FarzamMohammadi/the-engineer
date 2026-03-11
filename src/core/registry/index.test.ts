import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeCommunicationPlugin } from "../../../test/helpers/fake-plugins/fake-comm/index.js";
import { FakeLLMPlugin } from "../../../test/helpers/fake-plugins/fake-llm/index.js";
import { FakeTriggerPlugin } from "../../../test/helpers/fake-plugins/fake-trigger/index.js";
import { createMockManifest } from "../../../test/helpers/mock-factories.js";
import {
  type TestEventBusHandle,
  createTestEventBus,
} from "../../../test/helpers/test-event-bus.js";
import type { TriggerAdapter } from "../../adapters/trigger.js";
import type { AdapterType, PluginManifest } from "../../schemas/adapters.js";
import { Registry, type RegistryOptions } from "./index.js";

// ── Test Helpers ──────────────────────────────────────────────────────────

function createTestRegistry(
  handle: TestEventBusHandle,
  overrides?: Partial<Omit<RegistryOptions, "eventBus">>,
): Registry {
  return new Registry({
    eventBus: handle.eventBus,
    healthCheckIntervalMs: 60_000,
    healthCheckTimeoutMs: 1_000,
    consecutiveFailuresThreshold: 3,
    ...overrides,
  });
}

function createManifest(
  type: AdapterType,
  id: string,
  overrides?: Partial<PluginManifest>,
): PluginManifest {
  return createMockManifest({ type, id, name: `Test ${id}`, ...overrides });
}

/** Assert value is non-null and return it (avoids non-null assertions). */
function assertDefined<T>(value: T | null | undefined, label = "value"): T {
  if (value == null) {
    throw new Error(`Expected ${label} to be defined`);
  }
  return value;
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("Registry", () => {
  let handle: TestEventBusHandle;
  let registry: Registry;

  beforeEach(() => {
    handle = createTestEventBus();
    registry = createTestRegistry(handle);
    // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op to suppress console output in tests
    vi.spyOn(console, "log").mockImplementation(() => {});
    // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op to suppress console output in tests
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op to suppress console output in tests
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    registry.stopHealthCheckLoop();
    handle.cleanup();
    vi.restoreAllMocks();
  });

  // ── Registration ──────────────────────────────────────────────────────

  describe("register", () => {
    it("stores a plugin and returns success", () => {
      const manifest = createManifest("trigger", "test-trigger");
      const instance = new FakeTriggerPlugin();

      const result = registry.register(manifest, instance);

      expect(result.success).toBe(true);
      expect(result.plugin_id).toBe("test-trigger");
      expect(result.message).toBeNull();
    });

    it("injects manifest into the instance", () => {
      const manifest = createManifest("trigger", "test-trigger");
      const instance = new FakeTriggerPlugin();

      registry.register(manifest, instance);

      expect(instance.manifest).toBe(manifest);
    });

    it("rejects duplicate plugin ID", () => {
      const manifest = createManifest("trigger", "dup-id");
      registry.register(manifest, new FakeTriggerPlugin());

      const result = registry.register(
        createManifest("trigger", "dup-id"),
        new FakeTriggerPlugin(),
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain("already registered");
    });

    it("initializes health record as healthy", () => {
      const manifest = createManifest("trigger", "test-trigger");
      registry.register(manifest, new FakeTriggerPlugin());

      const health = assertDefined(registry.getHealthRecord("test-trigger"));

      expect(health.state).toBe("healthy");
      expect(health.consecutive_failures).toBe(0);
      expect(health.last_check_at).toBeNull();
      expect(health.last_error).toBeNull();
    });

    it("logs registration", () => {
      const manifest = createManifest("trigger", "test-trigger");
      registry.register(manifest, new FakeTriggerPlugin());

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('registered "test-trigger"'),
      );
    });
  });

  describe("deregister", () => {
    it("removes a registered plugin", () => {
      const manifest = createManifest("trigger", "test-trigger");
      registry.register(manifest, new FakeTriggerPlugin());

      registry.deregister("test-trigger");

      expect(registry.getPlugin("trigger", "test-trigger")).toBeNull();
    });

    it("is a no-op for unknown IDs", () => {
      // Should not throw
      registry.deregister("nonexistent");
    });

    it("logs deregistration", () => {
      const manifest = createManifest("trigger", "test-trigger");
      registry.register(manifest, new FakeTriggerPlugin());

      registry.deregister("test-trigger");

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('deregistered "test-trigger"'),
      );
    });
  });

  // ── Discovery ─────────────────────────────────────────────────────────

  describe("getPlugin", () => {
    it("returns the instance for a matching type and id", () => {
      const instance = new FakeTriggerPlugin();
      registry.register(createManifest("trigger", "t1"), instance);

      expect(registry.getPlugin("trigger", "t1")).toBe(instance);
    });

    it("returns null for unknown id", () => {
      expect(registry.getPlugin("trigger", "nonexistent")).toBeNull();
    });

    it("returns null when type does not match", () => {
      registry.register(createManifest("trigger", "t1"), new FakeTriggerPlugin());

      expect(registry.getPlugin("communication", "t1")).toBeNull();
    });
  });

  describe("getPluginsByType", () => {
    it("returns all plugins of the given type", () => {
      const t1 = new FakeTriggerPlugin();
      const t2 = new FakeTriggerPlugin();
      registry.register(createManifest("trigger", "t1"), t1);
      registry.register(createManifest("trigger", "t2"), t2);
      registry.register(createManifest("llm", "l1"), new FakeLLMPlugin());

      const triggers = registry.getPluginsByType<TriggerAdapter>("trigger");

      expect(triggers).toHaveLength(2);
      expect(triggers).toContain(t1);
      expect(triggers).toContain(t2);
    });

    it("returns empty array for a type with no plugins", () => {
      expect(registry.getPluginsByType("tool")).toEqual([]);
    });
  });

  describe("getPrimaryPlugin", () => {
    it("returns the first registered plugin of a type", () => {
      const first = new FakeTriggerPlugin();
      const second = new FakeTriggerPlugin();
      registry.register(createManifest("trigger", "t-first"), first);
      registry.register(createManifest("trigger", "t-second"), second);

      expect(registry.getPrimaryPlugin("trigger")).toBe(first);
    });

    it("returns null when no plugins of the type exist", () => {
      expect(registry.getPrimaryPlugin("git_hosting")).toBeNull();
    });
  });

  describe("getManifest", () => {
    it("returns the manifest for a registered plugin", () => {
      const manifest = createManifest("trigger", "t1");
      registry.register(manifest, new FakeTriggerPlugin());

      expect(registry.getManifest("t1")).toEqual(manifest);
    });

    it("returns null for unknown plugin", () => {
      expect(registry.getManifest("nonexistent")).toBeNull();
    });
  });

  // ── Lifecycle ─────────────────────────────────────────────────────────

  describe("initializePlugin", () => {
    it("calls initialize on the plugin with the given config", async () => {
      const instance = new FakeTriggerPlugin();
      registry.register(createManifest("trigger", "t1"), instance);

      const result = await registry.initializePlugin("t1", { key: "value" });

      expect(result.success).toBe(true);
      expect(instance.getInitConfig()).toEqual({ key: "value" });
    });

    it("returns failure for unregistered plugin", async () => {
      const result = await registry.initializePlugin("nonexistent", {});

      expect(result.success).toBe(false);
      expect(result.message).toContain("not registered");
    });

    it("logs successful initialization with timing", async () => {
      registry.register(createManifest("trigger", "t1"), new FakeTriggerPlugin());

      await registry.initializePlugin("t1", {});

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('initialized "t1"'));
    });
  });

  describe("shutdownAll", () => {
    it("calls shutdown on all registered plugins", async () => {
      const t1 = new FakeTriggerPlugin();
      const c1 = new FakeCommunicationPlugin();
      registry.register(createManifest("trigger", "t1"), t1);
      registry.register(createManifest("communication", "c1"), c1);

      await registry.shutdownAll();

      expect(t1.wasShutdownCalled()).toBe(true);
      expect(c1.wasShutdownCalled()).toBe(true);
    });

    it("shuts down in reverse init order", async () => {
      const order: string[] = [];

      const t1 = new FakeTriggerPlugin();
      const c1 = new FakeCommunicationPlugin();
      const l1 = new FakeLLMPlugin();

      // Register in order: t1(1), c1(2), l1(3)
      registry.register(createManifest("trigger", "t1"), t1);
      registry.register(createManifest("communication", "c1"), c1);
      registry.register(createManifest("llm", "l1"), l1);

      // Spy on shutdown to track order
      vi.spyOn(t1, "shutdown").mockImplementation(() => {
        order.push("t1");
        return Promise.resolve();
      });
      vi.spyOn(c1, "shutdown").mockImplementation(() => {
        order.push("c1");
        return Promise.resolve();
      });
      vi.spyOn(l1, "shutdown").mockImplementation(() => {
        order.push("l1");
        return Promise.resolve();
      });

      await registry.shutdownAll();

      // Reverse of registration: l1, c1, t1
      expect(order).toEqual(["l1", "c1", "t1"]);
    });

    it("continues after individual shutdown failure", async () => {
      const t1 = new FakeTriggerPlugin();
      const c1 = new FakeCommunicationPlugin();
      registry.register(createManifest("trigger", "t1"), t1);
      registry.register(createManifest("communication", "c1"), c1);

      vi.spyOn(c1, "shutdown").mockRejectedValueOnce(new Error("shutdown boom"));

      await registry.shutdownAll();

      expect(t1.wasShutdownCalled()).toBe(true);
    });

    it("stops health check loop", async () => {
      registry.startHealthCheckLoop();
      const stopSpy = vi.spyOn(registry, "stopHealthCheckLoop");

      await registry.shutdownAll();

      expect(stopSpy).toHaveBeenCalled();
    });

    it("logs completion", async () => {
      await registry.shutdownAll();

      expect(console.log).toHaveBeenCalledWith("Registry: all plugins shut down");
    });
  });

  // ── Health State Machine ──────────────────────────────────────────────

  describe("health state machine", () => {
    it("starts all plugins as healthy", () => {
      registry.register(createManifest("trigger", "t1"), new FakeTriggerPlugin());

      const health = assertDefined(registry.getHealthRecord("t1"));
      expect(health.state).toBe("healthy");
    });

    it("transitions healthy → unhealthy on 1 failed check", async () => {
      const instance = new FakeTriggerPlugin();
      registry.register(createManifest("trigger", "t1"), instance);

      instance.setUnhealthy(true);
      await registry.healthCheckAll();

      const health = assertDefined(registry.getHealthRecord("t1"));
      expect(health.state).toBe("unhealthy");
      expect(health.consecutive_failures).toBe(1);
    });

    it("emits health.plugin_unhealthy on first failure", async () => {
      const instance = new FakeTriggerPlugin();
      registry.register(createManifest("trigger", "t1"), instance);

      instance.setUnhealthy(true);
      await registry.healthCheckAll();

      handle.assertEventEmitted("health.plugin_unhealthy", (p) => p["plugin_id"] === "t1");
    });

    it("transitions unhealthy → healthy on successful check", async () => {
      const instance = new FakeTriggerPlugin();
      registry.register(createManifest("trigger", "t1"), instance);

      // Make unhealthy
      instance.setUnhealthy(true);
      await registry.healthCheckAll();
      expect(assertDefined(registry.getHealthRecord("t1")).state).toBe("unhealthy");

      // Recover
      instance.setUnhealthy(false);
      await registry.healthCheckAll();

      const health = assertDefined(registry.getHealthRecord("t1"));
      expect(health.state).toBe("healthy");
      expect(health.consecutive_failures).toBe(0);
    });

    it("transitions unhealthy → failed after N consecutive failures", async () => {
      const instance = new FakeTriggerPlugin();
      registry = createTestRegistry(handle, { consecutiveFailuresThreshold: 3 });
      registry.register(createManifest("trigger", "t1"), instance);

      instance.setUnhealthy(true);

      // 1st fail: healthy → unhealthy
      await registry.healthCheckAll();
      expect(assertDefined(registry.getHealthRecord("t1")).state).toBe("unhealthy");

      // 2nd fail: stays unhealthy
      await registry.healthCheckAll();
      expect(assertDefined(registry.getHealthRecord("t1")).state).toBe("unhealthy");

      // 3rd fail: unhealthy → failed
      await registry.healthCheckAll();
      expect(assertDefined(registry.getHealthRecord("t1")).state).toBe("failed");
      expect(assertDefined(registry.getHealthRecord("t1")).consecutive_failures).toBe(3);
    });

    it("emits health.plugin_failed on threshold breach", async () => {
      const instance = new FakeTriggerPlugin();
      registry = createTestRegistry(handle, { consecutiveFailuresThreshold: 2 });
      registry.register(createManifest("trigger", "t1"), instance);

      instance.setUnhealthy(true);
      await registry.healthCheckAll(); // → unhealthy
      await registry.healthCheckAll(); // → failed

      handle.assertEventEmitted(
        "health.plugin_failed",
        (p) => p["plugin_id"] === "t1" && p["threshold"] === 2,
      );
    });

    it("transitions failed → healthy on recovery", async () => {
      const instance = new FakeTriggerPlugin();
      registry = createTestRegistry(handle, { consecutiveFailuresThreshold: 2 });
      registry.register(createManifest("trigger", "t1"), instance);

      instance.setUnhealthy(true);
      await registry.healthCheckAll(); // → unhealthy
      await registry.healthCheckAll(); // → failed

      instance.setUnhealthy(false);
      await registry.healthCheckAll(); // → healthy

      const health = assertDefined(registry.getHealthRecord("t1"));
      expect(health.state).toBe("healthy");
      expect(health.consecutive_failures).toBe(0);
    });

    it("emits health.plugin_recovered on recovery from failed", async () => {
      const instance = new FakeTriggerPlugin();
      registry = createTestRegistry(handle, { consecutiveFailuresThreshold: 2 });
      registry.register(createManifest("trigger", "t1"), instance);

      instance.setUnhealthy(true);
      await registry.healthCheckAll(); // → unhealthy
      await registry.healthCheckAll(); // → failed

      instance.setUnhealthy(false);
      await registry.healthCheckAll(); // → healthy

      handle.assertEventEmitted(
        "health.plugin_recovered",
        (p) => p["plugin_id"] === "t1" && p["previous_state"] === "failed",
      );
    });

    it("emits health.plugin_recovered on recovery from unhealthy", async () => {
      const instance = new FakeTriggerPlugin();
      registry.register(createManifest("trigger", "t1"), instance);

      instance.setUnhealthy(true);
      await registry.healthCheckAll(); // → unhealthy

      instance.setUnhealthy(false);
      await registry.healthCheckAll(); // → healthy

      handle.assertEventEmitted(
        "health.plugin_recovered",
        (p) => p["plugin_id"] === "t1" && p["previous_state"] === "unhealthy",
      );
    });

    it("does not emit events on healthy → healthy", async () => {
      const instance = new FakeTriggerPlugin();
      registry.register(createManifest("trigger", "t1"), instance);

      await registry.healthCheckAll();
      await registry.healthCheckAll();

      const events = handle.getEmittedEvents();
      const healthEvents = events.filter((e) => e.type.startsWith("health.plugin_"));
      expect(healthEvents).toHaveLength(0);
    });

    it("does not emit repeated events on failed → failed", async () => {
      const instance = new FakeTriggerPlugin();
      registry = createTestRegistry(handle, { consecutiveFailuresThreshold: 2 });
      registry.register(createManifest("trigger", "t1"), instance);

      instance.setUnhealthy(true);
      await registry.healthCheckAll(); // → unhealthy (1 event)
      await registry.healthCheckAll(); // → failed (1 event)
      await registry.healthCheckAll(); // stays failed (no new event)
      await registry.healthCheckAll(); // stays failed (no new event)

      const failedEvents = handle.getEmittedEvents("health.plugin_failed");
      expect(failedEvents).toHaveLength(1);
    });

    it("treats timeout as a failed check", async () => {
      const instance = new FakeTriggerPlugin();
      registry = createTestRegistry(handle, { healthCheckTimeoutMs: 10 });
      registry.register(createManifest("trigger", "t1"), instance);

      // Override healthCheck to hang
      vi.spyOn(instance, "healthCheck").mockImplementation(
        // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional never-resolving promise for timeout test
        () => new Promise(() => {}),
      );

      await registry.healthCheckAll();

      const health = assertDefined(registry.getHealthRecord("t1"));
      expect(health.state).toBe("unhealthy");
      expect(health.last_error).toContain("timeout");
    });

    it("updates last_check_at on every check", async () => {
      const instance = new FakeTriggerPlugin();
      registry.register(createManifest("trigger", "t1"), instance);

      await registry.healthCheckAll();

      const health = assertDefined(registry.getHealthRecord("t1"));
      expect(health.last_check_at).not.toBeNull();
    });

    it("updates last_healthy_at on successful check", async () => {
      const instance = new FakeTriggerPlugin();
      registry.register(createManifest("trigger", "t1"), instance);

      await registry.healthCheckAll();

      const health = assertDefined(registry.getHealthRecord("t1"));
      expect(health.last_healthy_at).not.toBeNull();
    });

    it("preserves last_healthy_at on failed check", async () => {
      const instance = new FakeTriggerPlugin();
      registry.register(createManifest("trigger", "t1"), instance);

      await registry.healthCheckAll(); // healthy
      const healthyAt = assertDefined(registry.getHealthRecord("t1")).last_healthy_at;

      instance.setUnhealthy(true);
      await registry.healthCheckAll(); // unhealthy

      expect(assertDefined(registry.getHealthRecord("t1")).last_healthy_at).toBe(healthyAt);
    });

    it("records error message on failed check", async () => {
      const instance = new FakeTriggerPlugin();
      registry.register(createManifest("trigger", "t1"), instance);

      instance.setUnhealthy(true);
      await registry.healthCheckAll();

      const health = assertDefined(registry.getHealthRecord("t1"));
      expect(health.last_error).toBe("Fake trigger unhealthy");
    });
  });

  // ── Health Check Loop ─────────────────────────────────────────────────

  describe("health check loop", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("startHealthCheckLoop initiates periodic checks", async () => {
      const instance = new FakeTriggerPlugin();
      registry = createTestRegistry(handle, { healthCheckIntervalMs: 100 });
      registry.register(createManifest("trigger", "t1"), instance);

      const spy = vi.spyOn(registry, "healthCheckAll");
      registry.startHealthCheckLoop();

      await vi.advanceTimersByTimeAsync(100);
      expect(spy).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(100);
      expect(spy).toHaveBeenCalledTimes(2);

      registry.stopHealthCheckLoop();
    });

    it("stopHealthCheckLoop clears the interval", async () => {
      registry = createTestRegistry(handle, { healthCheckIntervalMs: 100 });
      const spy = vi.spyOn(registry, "healthCheckAll");

      registry.startHealthCheckLoop();
      registry.stopHealthCheckLoop();

      await vi.advanceTimersByTimeAsync(200);
      expect(spy).not.toHaveBeenCalled();
    });

    it("startHealthCheckLoop is idempotent", () => {
      registry.startHealthCheckLoop();
      registry.startHealthCheckLoop(); // should not create a second interval
      registry.stopHealthCheckLoop();
    });
  });

  // ── getAllHealthRecords ────────────────────────────────────────────────

  describe("getAllHealthRecords", () => {
    it("returns health records for all registered plugins", () => {
      registry.register(createManifest("trigger", "t1"), new FakeTriggerPlugin());
      registry.register(createManifest("llm", "l1"), new FakeLLMPlugin());

      const records = registry.getAllHealthRecords();

      expect(records).toHaveLength(2);
      expect(records.map((r) => r.plugin_id).sort()).toEqual(["l1", "t1"]);
    });

    it("returns copies (not mutable references)", () => {
      registry.register(createManifest("trigger", "t1"), new FakeTriggerPlugin());

      const records = registry.getAllHealthRecords();
      assertDefined(records[0]).state = "failed";

      expect(assertDefined(registry.getHealthRecord("t1")).state).toBe("healthy");
    });
  });

  // ── Five-Phase Loading ────────────────────────────────────────────────

  describe("loadFromDirectories", () => {
    it("discovers and loads plugins from directories", async () => {
      const dir = join(process.cwd(), "test/helpers/fake-plugins");

      await registry.loadFromDirectories([dir]);

      // Should have loaded all 5 fake plugins
      expect(registry.getPluginsByType("trigger")).toHaveLength(1);
      expect(registry.getPluginsByType("communication")).toHaveLength(1);
      expect(registry.getPluginsByType("llm")).toHaveLength(1);
      expect(registry.getPluginsByType("tool")).toHaveLength(1);
      expect(registry.getPluginsByType("git_hosting")).toHaveLength(1);
    });

    it("skips disabled plugins", async () => {
      // Create a temp dir with a disabled plugin
      const tmpDir = mkdtempSync("/tmp/registry-test-");
      const pluginDir = join(tmpDir, "disabled-plugin");
      mkdirSync(pluginDir);
      writeFileSync(
        join(pluginDir, "engineer.plugin.yaml"),
        `id: disabled\ntype: trigger\nversion: "1.0.0"\nname: Disabled\ndescription: test\nenabled: false\nentry: index.ts`,
      );
      writeFileSync(join(pluginDir, "index.ts"), "export function createPlugin() { return null; }");

      await registry.loadFromDirectories([tmpDir]);

      expect(registry.getPlugin("trigger", "disabled")).toBeNull();

      // Cleanup
      rmSync(tmpDir, { recursive: true });
    });

    it("rejects duplicate IDs", async () => {
      const tmpDir = mkdtempSync("/tmp/registry-test-");

      // Create two plugins with the same ID
      for (const subdir of ["p1", "p2"]) {
        const pluginDir = join(tmpDir, subdir);
        mkdirSync(pluginDir);
        writeFileSync(
          join(pluginDir, "engineer.plugin.yaml"),
          `id: same-id\ntype: trigger\nversion: "1.0.0"\nname: Dup\ndescription: test\nentry: index.ts`,
        );
        writeFileSync(
          join(pluginDir, "index.ts"),
          "export function createPlugin() { return null; }",
        );
      }

      await expect(registry.loadFromDirectories([tmpDir])).rejects.toThrow("duplicate");

      rmSync(tmpDir, { recursive: true });
    });

    it("rejects invalid version", async () => {
      const tmpDir = mkdtempSync("/tmp/registry-test-");
      const pluginDir = join(tmpDir, "bad");
      mkdirSync(pluginDir);
      writeFileSync(
        join(pluginDir, "engineer.plugin.yaml"),
        "id: bad\ntype: trigger\nversion: not-semver\nname: Bad\ndescription: test\nentry: index.ts",
      );
      writeFileSync(join(pluginDir, "index.ts"), "export function createPlugin() { return null; }");

      await expect(registry.loadFromDirectories([tmpDir])).rejects.toThrow("semver");

      rmSync(tmpDir, { recursive: true });
    });

    it("rejects missing entry file", async () => {
      const tmpDir = mkdtempSync("/tmp/registry-test-");
      const pluginDir = join(tmpDir, "missing");
      mkdirSync(pluginDir);
      writeFileSync(
        join(pluginDir, "engineer.plugin.yaml"),
        `id: missing\ntype: trigger\nversion: "1.0.0"\nname: Missing\ndescription: test\nentry: nonexistent.ts`,
      );

      await expect(registry.loadFromDirectories([tmpDir])).rejects.toThrow("entry file not found");

      rmSync(tmpDir, { recursive: true });
    });

    it("loads plugins in type-based order", async () => {
      const dir = join(process.cwd(), "test/helpers/fake-plugins");

      const registerSpy = vi.spyOn(registry, "register");
      await registry.loadFromDirectories([dir]);

      const registeredTypes = registerSpy.mock.calls.map(
        (call) => (call[0] as PluginManifest).type,
      );

      // Communication (1) < LLM (2) < Tool (3) < Git Hosting (4) < Trigger (5)
      const typeOrder = registeredTypes.map((t) => {
        const priorities: Record<string, number> = {
          communication: 1,
          llm: 2,
          tool: 3,
          git_hosting: 4,
          trigger: 5,
        };
        return assertDefined(priorities[t], `priority for ${t}`);
      });

      for (let i = 1; i < typeOrder.length; i++) {
        expect(typeOrder[i]).toBeGreaterThanOrEqual(assertDefined(typeOrder[i - 1]));
      }
    });

    it("handles empty directories", async () => {
      const tmpDir = mkdtempSync("/tmp/registry-test-");

      await registry.loadFromDirectories([tmpDir]);

      expect(registry.getAllHealthRecords()).toHaveLength(0);

      rmSync(tmpDir, { recursive: true });
    });

    it("handles nonexistent directories", async () => {
      await registry.loadFromDirectories(["/tmp/definitely-does-not-exist-registry-test"]);

      expect(registry.getAllHealthRecords()).toHaveLength(0);
    });

    it("uses configResolver to provide plugin config", async () => {
      const dir = join(process.cwd(), "test/helpers/fake-plugins/fake-trigger");

      await registry.loadFromDirectories([dir], (pluginId) => {
        if (pluginId === "fake-trigger") {
          return Promise.resolve({ api_key: "test-key" });
        }
        return Promise.resolve({});
      });

      const trigger = assertDefined(
        registry.getPlugin<FakeTriggerPlugin>("trigger", "fake-trigger"),
      );
      expect(trigger.getInitConfig()).toEqual({ api_key: "test-key" });
    });

    it("aborts on critical plugin init failure", async () => {
      // Test via programmatic API: register a plugin that fails init,
      // then verify the loadFromDirectories behavior through a focused test.
      const instance = new FakeTriggerPlugin();
      // Override doInitialize to fail
      vi.spyOn(instance, "initialize").mockResolvedValueOnce({
        success: false,
        message: "init failed",
      });

      const manifest = createManifest("trigger", "critical-plugin", { critical: true });
      registry.register(manifest, instance);

      // Simulate Phase 5 (initializeAll) behavior: critical failure should propagate
      const result = await registry.initializePlugin("critical-plugin", {});
      expect(result.success).toBe(false);
      expect(result.message).toBe("init failed");
    });

    it("aborts loadFromDirectories on critical plugin init failure", async () => {
      const tmpDir = mkdtempSync("/tmp/registry-test-");
      const pluginDir = join(tmpDir, "fail-critical");
      mkdirSync(pluginDir);
      writeFileSync(
        join(pluginDir, "engineer.plugin.yaml"),
        `id: fail-critical\ntype: trigger\nversion: "1.0.0"\nname: Fail\ndescription: test\ncritical: true\nentry: index.ts`,
      );
      // Self-contained plugin — no project imports
      writeFileSync(
        join(pluginDir, "index.ts"),
        [
          "class FailPlugin {",
          "  manifest;",
          "  hasCapability() { return false; }",
          "  async initialize() { return { success: false, message: 'init failed' }; }",
          "  async shutdown() {}",
          "  async healthCheck() { return { healthy: true, message: null, details: null }; }",
          "}",
          "export function createPlugin() { return new FailPlugin(); }",
        ].join("\n"),
      );

      await expect(registry.loadFromDirectories([tmpDir])).rejects.toThrow("critical");

      rmSync(tmpDir, { recursive: true });
    });

    it("skips non-critical plugin on init failure", async () => {
      const tmpDir = mkdtempSync("/tmp/registry-test-");
      const pluginDir = join(tmpDir, "fail-optional");
      mkdirSync(pluginDir);
      writeFileSync(
        join(pluginDir, "engineer.plugin.yaml"),
        `id: fail-optional\ntype: trigger\nversion: "1.0.0"\nname: Optional\ndescription: test\ncritical: false\nentry: index.ts`,
      );
      // Self-contained plugin — no project imports
      writeFileSync(
        join(pluginDir, "index.ts"),
        [
          "class FailPlugin {",
          "  manifest;",
          "  hasCapability() { return false; }",
          "  async initialize() { return { success: false, message: 'init failed' }; }",
          "  async shutdown() {}",
          "  async healthCheck() { return { healthy: true, message: null, details: null }; }",
          "}",
          "export function createPlugin() { return new FailPlugin(); }",
        ].join("\n"),
      );

      await registry.loadFromDirectories([tmpDir]);

      // Plugin should have been deregistered
      expect(registry.getPlugin("trigger", "fail-optional")).toBeNull();

      rmSync(tmpDir, { recursive: true });
    });
  });
});
