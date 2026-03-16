import type { PluginHealthRecord, PluginHealthState } from "../../schemas/adapters.js";
import { PluginHealthStates } from "../../schemas/adapters.js";
import { EventTypes } from "../../schemas/events.js";
import type { IEventBus } from "../interfaces/event-bus.interface.js";
import type { PluginRecord } from "./lifecycle.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface HealthMonitorDeps {
  eventBus: IEventBus;
  getRecord: (pluginId: string) => PluginRecord | undefined;
  getAllRecords: () => PluginRecord[];
  healthCheckTimeoutMs: number;
  consecutiveFailuresThreshold: number;
}

export interface HealthMonitor {
  healthCheckAll(): Promise<PluginHealthRecord[]>;
  getHealthRecord(pluginId: string): PluginHealthRecord | null;
  getAllHealthRecords(): PluginHealthRecord[];
}

// ── Factory ────────────────────────────────────────────────────────────────

export function createHealthMonitor(deps: HealthMonitorDeps): HealthMonitor {
  const { eventBus, getRecord, getAllRecords, healthCheckTimeoutMs, consecutiveFailuresThreshold } =
    deps;

  function withTimeout<T>(promise: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("health check timeout"));
      }, healthCheckTimeoutMs);

      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  function handleHealthy(
    record: PluginRecord,
    previousState: PluginHealthState,
    now: string,
  ): void {
    const { health, manifest } = record;
    health.consecutive_failures = 0;
    health.last_healthy_at = now;
    health.last_error = null;

    if (previousState !== PluginHealthStates.healthy) {
      health.state = PluginHealthStates.healthy;
      console.log(`Registry: plugin "${manifest.id}" recovered (was ${previousState})`);
      eventBus.publish({
        type: EventTypes["health.plugin_recovered"],
        source: "registry",
        task_id: null,
        payload: {
          plugin_id: manifest.id,
          plugin_type: manifest.type,
          previous_state: previousState,
        },
      });
    }
  }

  function handleUnhealthy(
    record: PluginRecord,
    previousState: PluginHealthState,
    errorMessage: string,
  ): void {
    const { health, manifest } = record;
    health.consecutive_failures++;
    health.last_error = errorMessage;

    if (previousState === PluginHealthStates.healthy) {
      // healthy → unhealthy
      health.state = PluginHealthStates.unhealthy;
      console.warn(
        `Registry: plugin "${manifest.id}" is unhealthy (${String(health.consecutive_failures)} failures): ${errorMessage}`,
      );
      eventBus.publish({
        type: EventTypes["health.plugin_unhealthy"],
        source: "registry",
        task_id: null,
        payload: {
          plugin_id: manifest.id,
          plugin_type: manifest.type,
          error: errorMessage,
          consecutive_failures: health.consecutive_failures,
        },
      });
    } else if (
      previousState === PluginHealthStates.unhealthy &&
      health.consecutive_failures >= consecutiveFailuresThreshold
    ) {
      // unhealthy → failed
      health.state = PluginHealthStates.failed;
      console.error(
        `Registry: plugin "${manifest.id}" has FAILED (${String(health.consecutive_failures)}/${String(consecutiveFailuresThreshold)} failures): ${errorMessage}`,
      );
      eventBus.publish({
        type: EventTypes["health.plugin_failed"],
        source: "registry",
        task_id: null,
        payload: {
          plugin_id: manifest.id,
          plugin_type: manifest.type,
          error: errorMessage,
          consecutive_failures: health.consecutive_failures,
          threshold: consecutiveFailuresThreshold,
        },
      });
    }
    // If already "failed", stays "failed" — no repeated events until recovery
  }

  async function checkPluginHealth(record: PluginRecord): Promise<void> {
    const { health } = record;
    const previousState = health.state;
    const now = new Date().toISOString();

    let status: { healthy: boolean; message: string | null };

    try {
      status = await withTimeout(record.instance.healthCheck());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      status = { healthy: false, message };
    }

    health.last_check_at = now;

    if (status.healthy) {
      handleHealthy(record, previousState, now);
    } else {
      handleUnhealthy(record, previousState, status.message ?? "unknown error");
    }
  }

  async function healthCheckAll(): Promise<PluginHealthRecord[]> {
    const records = getAllRecords();
    await Promise.allSettled(records.map((r) => checkPluginHealth(r)));
    return records.map((r) => ({ ...r.health }));
  }

  function getHealthRecord(pluginId: string): PluginHealthRecord | null {
    const record = getRecord(pluginId);
    if (!record) {
      return null;
    }
    return { ...record.health };
  }

  function getAllHealthRecords(): PluginHealthRecord[] {
    return getAllRecords().map((r) => ({ ...r.health }));
  }

  return {
    healthCheckAll,
    getHealthRecord,
    getAllHealthRecords,
  };
}
