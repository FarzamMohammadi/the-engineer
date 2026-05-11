import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { IObserver } from "../../../../src/core/observer/index.js";
import type { PluginRecord } from "../../../../src/core/registry/lifecycle.js";
import {
  type PluginHealthMonitor,
  type PluginHealthMonitorDeps,
  createPluginHealthMonitor,
} from "../../../../src/core/registry/plugin-health.js";
import { PluginHealthStates } from "../../../../src/schemas/adapters.js";
import type { Event } from "../../../../src/schemas/events.js";
import { FakeTriggerPlugin } from "../../../helpers/fake-plugins/fake-trigger/index.js";
import { createMockManifest } from "../../../helpers/mock-factories.js";
import { type TestEventBusHandle, createTestEventBus } from "../../../helpers/test-event-bus.js";
import { createTestObserverFacade } from "../../../helpers/test-observer-facade.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function createRecord(id: string, instance?: FakeTriggerPlugin): PluginRecord {
  const plugin = instance ?? new FakeTriggerPlugin();
  const manifest = createMockManifest({ id, type: "trigger", name: id });
  plugin.manifest = manifest;
  return {
    manifest,
    instance: plugin,
    health: {
      plugin_id: id,
      state: PluginHealthStates.healthy,
      consecutive_failures: 0,
      last_check_at: null,
      last_healthy_at: null,
      last_error: null,
    },
    initOrder: 1,
  };
}

function createMonitor(
  records: PluginRecord[],
  handle: TestEventBusHandle,
  observer: IObserver,
  overrides?: Partial<PluginHealthMonitorDeps>,
): PluginHealthMonitor {
  const recordMap = new Map(records.map((r) => [r.manifest.id, r]));
  return createPluginHealthMonitor({
    observer,
    eventBus: handle.eventBus,
    getRecord: (id) => recordMap.get(id),
    getAllRecords: () => [...recordMap.values()],
    healthCheckTimeoutMs: 1_000,
    consecutiveFailuresThreshold: 3,
    ...overrides,
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("createPluginHealthMonitor", () => {
  let handle: TestEventBusHandle;
  let observer: IObserver;

  beforeEach(() => {
    observer = createTestObserverFacade("registry");
    handle = createTestEventBus();
  });

  afterEach(() => {
    handle.cleanup();
  });

  describe("healthCheckAll", () => {
    it("transitions healthy → unhealthy on failed check", async () => {
      const instance = new FakeTriggerPlugin();
      instance.setUnhealthy(true);
      const record = createRecord("t1", instance);
      const monitor = createMonitor([record], handle, observer);

      await monitor.healthCheckAll();

      expect(record.health.state).toBe(PluginHealthStates.unhealthy);
      expect(record.health.consecutive_failures).toBe(1);
    });

    it("transitions unhealthy → failed after threshold", async () => {
      const instance = new FakeTriggerPlugin();
      instance.setUnhealthy(true);
      const record = createRecord("t1", instance);
      const monitor = createMonitor([record], handle, observer, {
        consecutiveFailuresThreshold: 3,
      });

      // First check: healthy → unhealthy
      await monitor.healthCheckAll();
      expect(record.health.state).toBe(PluginHealthStates.unhealthy);

      // Checks 2 and 3: unhealthy → failed at threshold
      await monitor.healthCheckAll();
      await monitor.healthCheckAll();
      expect(record.health.state).toBe(PluginHealthStates.failed);
      expect(record.health.consecutive_failures).toBe(3);
    });

    it("transitions failed → healthy on recovery", async () => {
      const instance = new FakeTriggerPlugin();
      instance.setUnhealthy(true);
      const record = createRecord("t1", instance);
      const monitor = createMonitor([record], handle, observer, {
        consecutiveFailuresThreshold: 2,
      });

      // Drive to failed state
      await monitor.healthCheckAll(); // healthy → unhealthy
      await monitor.healthCheckAll(); // unhealthy → failed

      // Recover
      instance.setUnhealthy(false);
      await monitor.healthCheckAll();

      expect(record.health.state).toBe(PluginHealthStates.healthy);
      expect(record.health.consecutive_failures).toBe(0);
    });

    it("emits health.plugin_unhealthy on first failure", async () => {
      const instance = new FakeTriggerPlugin();
      instance.setUnhealthy(true);
      const record = createRecord("t1", instance);
      const monitor = createMonitor([record], handle, observer);
      const events: Event[] = [];
      handle.eventBus.subscribe("health-test", "health.*", (e) => events.push(e));

      await monitor.healthCheckAll();

      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe("health.plugin_unhealthy");
    });

    it("emits health.plugin_recovered on recovery", async () => {
      const instance = new FakeTriggerPlugin();
      instance.setUnhealthy(true);
      const record = createRecord("t1", instance);
      const monitor = createMonitor([record], handle, observer);

      await monitor.healthCheckAll(); // healthy → unhealthy

      const events: Event[] = [];
      handle.eventBus.subscribe("health-test", "health.*", (e) => events.push(e));

      instance.setUnhealthy(false);
      await monitor.healthCheckAll(); // unhealthy → healthy

      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe("health.plugin_recovered");
    });

    it("does not emit events on healthy → healthy", async () => {
      const record = createRecord("t1");
      const monitor = createMonitor([record], handle, observer);
      const events: Event[] = [];
      handle.eventBus.subscribe("health-test", "health.*", (e) => events.push(e));

      await monitor.healthCheckAll();

      expect(events).toHaveLength(0);
    });

    it("does not emit repeated events on failed → failed", async () => {
      const instance = new FakeTriggerPlugin();
      instance.setUnhealthy(true);
      const record = createRecord("t1", instance);
      const monitor = createMonitor([record], handle, observer, {
        consecutiveFailuresThreshold: 2,
      });

      await monitor.healthCheckAll(); // healthy → unhealthy
      await monitor.healthCheckAll(); // unhealthy → failed

      const events: Event[] = [];
      handle.eventBus.subscribe("health-test", "health.*", (e) => events.push(e));

      await monitor.healthCheckAll(); // failed → failed (no event)

      expect(events).toHaveLength(0);
    });

    it("updates last_check_at on every check", async () => {
      const record = createRecord("t1");
      const monitor = createMonitor([record], handle, observer);

      await monitor.healthCheckAll();

      expect(record.health.last_check_at).not.toBeNull();
    });

    it("treats timeout as a failed check", async () => {
      const instance = new FakeTriggerPlugin();
      // Override healthCheck to never resolve
      vi.spyOn(instance, "healthCheck").mockReturnValue(
        new Promise(() => {
          /* never resolves */
        }),
      );
      const record = createRecord("t1", instance);
      const monitor = createMonitor([record], handle, observer, { healthCheckTimeoutMs: 10 });

      await monitor.healthCheckAll();

      expect(record.health.state).toBe(PluginHealthStates.unhealthy);
      expect(record.health.last_error).toBe("health check timeout");
    }, 5_000);

    it("sanitizes secret tokens in health check error messages", async () => {
      const secretToken = `ghp_${"a".repeat(40)}`;
      const instance = new FakeTriggerPlugin();
      vi.spyOn(instance, "healthCheck").mockRejectedValue(new Error(`Auth failed with token ${secretToken}`));
      const record = createRecord("t1", instance);
      const monitor = createMonitor([record], handle, observer);

      await monitor.healthCheckAll();

      expect(record.health.last_error).not.toContain(secretToken);
      expect(record.health.last_error).toContain("[REDACTED:token]");
    });

    it("sanitizes secrets in unhealthy status messages from plugins", async () => {
      const secretToken = `ghp_${"a".repeat(40)}`;
      const instance = new FakeTriggerPlugin();
      vi.spyOn(instance, "healthCheck").mockResolvedValue({
        healthy: false,
        message: `Connection to https://git:${secretToken}@github.com failed`,
        details: null,
      });
      const record = createRecord("t1", instance);
      const monitor = createMonitor([record], handle, observer);

      await monitor.healthCheckAll();

      expect(record.health.last_error).not.toContain(secretToken);
      expect(record.health.last_error).toContain("https://git:***@");
    });

    it("sanitizes secrets in event payloads", async () => {
      const secretToken = `ghp_${"a".repeat(40)}`;
      const instance = new FakeTriggerPlugin();
      vi.spyOn(instance, "healthCheck").mockRejectedValue(new Error(`Token ${secretToken} expired`));
      const record = createRecord("t1", instance);
      const monitor = createMonitor([record], handle, observer);
      const events: Event[] = [];
      handle.eventBus.subscribe("sec-test", "health.*", (e) => events.push(e));

      await monitor.healthCheckAll();

      expect(events).toHaveLength(1);
      const payload = events[0]!.payload as { error: string };
      expect(payload.error).not.toContain(secretToken);
      expect(payload.error).toContain("[REDACTED:token]");
    });
  });

  describe("getHealthRecord", () => {
    it("returns a copy of the health record", () => {
      const record = createRecord("t1");
      const monitor = createMonitor([record], handle, observer);

      const health = monitor.getHealthRecord("t1");

      expect(health).not.toBeNull();
      expect(health).toEqual(record.health);
      expect(health).not.toBe(record.health);
    });

    it("returns null for unknown plugin", () => {
      const monitor = createMonitor([], handle, observer);

      expect(monitor.getHealthRecord("unknown")).toBeNull();
    });
  });

  describe("getAllHealthRecords", () => {
    it("returns copies of all health records", () => {
      const r1 = createRecord("t1");
      const r2 = createRecord("t2");
      const monitor = createMonitor([r1, r2], handle, observer);

      const records = monitor.getAllHealthRecords();

      expect(records).toHaveLength(2);
      expect(records[0]).not.toBe(r1.health);
      expect(records[1]).not.toBe(r2.health);
    });
  });
});
