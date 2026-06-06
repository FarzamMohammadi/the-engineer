import type Database from "better-sqlite3";

import { toSqliteJson } from "../../db/serialize.js";
import type { PluginHealthRecord, PluginHealthState } from "../../schemas/adapters.js";
import { PluginHealthStates } from "../../schemas/adapters.js";
import { EventTypes } from "../../schemas/events.js";
import { ObservationTypes } from "../../schemas/observer.js";
import { sanitizeErrorMessage, sanitizeSecrets } from "../../utils/sanitize.js";
import type { IEventBus } from "../interfaces/event-bus.interface.js";
import type { IObserver } from "../observer/index.js";
import type { PluginRecord } from "./lifecycle.js";

/** `_meta` key under which the current plugin-health snapshot is cached (overwritten each cycle). */
const HEALTH_SNAPSHOT_META_KEY = "plugin_health_snapshot";

// ── Types ──────────────────────────────────────────────────────────────────

export interface PluginHealthMonitorDeps {
  observer: IObserver;
  eventBus: IEventBus;
  /** Database handle for the `_meta` snapshot cache (the current-state surface the dashboard reads back). */
  db: Database.Database;
  getRecord: (pluginId: string) => PluginRecord | undefined;
  getAllRecords: () => PluginRecord[];
  healthCheckTimeoutMs: number;
  consecutiveFailuresThreshold: number;
}

export interface PluginHealthMonitor {
  healthCheckAll(): Promise<PluginHealthRecord[]>;
  getHealthRecord(pluginId: string): PluginHealthRecord | null;
  getAllHealthRecords(): PluginHealthRecord[];
}

// ── Factory ────────────────────────────────────────────────────────────────

export function createPluginHealthMonitor(deps: PluginHealthMonitorDeps): PluginHealthMonitor {
  const { observer, eventBus, db, getRecord, getAllRecords, healthCheckTimeoutMs, consecutiveFailuresThreshold } = deps;

  // Prepared once: each cycle overwrites the single snapshot row (mirrors the cost tracker's safety_snapshot).
  const saveSnapshotStmt = db.prepare("INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)");

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

  /**
   * Record a plugin-health transition as a named `state_transition` observation so the dashboard-observer
   * sees the crossing on the trace timeline — not just the audit event. Edge-triggered by construction: the
   * callers only invoke this inside their transition guards, so it fires once per genuine change, never per
   * health-check tick. Plugin-agnostic — it carries whatever manifest identity is registered (Plugin Opacity).
   */
  function recordTransition(
    manifest: PluginRecord["manifest"],
    fromState: PluginHealthState,
    toState: PluginHealthState,
    consecutiveFailures: number,
  ): void {
    observer.observe(
      ObservationTypes.state_transition,
      "plugin_health_transition",
      {
        plugin_id: manifest.id,
        plugin_type: manifest.type,
        from_state: fromState,
        to_state: toState,
        consecutive_failures: consecutiveFailures,
      },
      { level: toState === PluginHealthStates.failed ? "error" : "info" },
    );
  }

  function handleHealthy(record: PluginRecord, previousState: PluginHealthState, now: string): void {
    const { health, manifest } = record;
    health.consecutive_failures = 0;
    health.last_healthy_at = now;
    health.last_error = null;

    if (previousState !== PluginHealthStates.healthy) {
      health.state = PluginHealthStates.healthy;
      observer.info("Plugin recovered — capability restored", {
        pluginId: manifest.id,
        adapterType: manifest.type,
        capability: `${manifest.type}_adapter`,
        previousState,
      });
      recordTransition(manifest, previousState, PluginHealthStates.healthy, 0);
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

  function handleUnhealthy(record: PluginRecord, previousState: PluginHealthState, errorMessage: string): void {
    const { health, manifest } = record;
    health.consecutive_failures++;
    health.last_error = errorMessage;

    if (previousState === PluginHealthStates.healthy) {
      // healthy → unhealthy
      health.state = PluginHealthStates.unhealthy;
      observer.warn("Plugin is unhealthy — capability degraded, retrying on next health check", {
        pluginId: manifest.id,
        adapterType: manifest.type,
        capability: `${manifest.type}_adapter`,
        consecutiveFailures: health.consecutive_failures,
        error: errorMessage,
      });
      recordTransition(manifest, previousState, PluginHealthStates.unhealthy, health.consecutive_failures);
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
      observer.error("Plugin has FAILED — capability disabled until manual intervention or self-recovery", {
        pluginId: manifest.id,
        adapterType: manifest.type,
        capability: `${manifest.type}_adapter`,
        consecutiveFailures: health.consecutive_failures,
        threshold: consecutiveFailuresThreshold,
        error: errorMessage,
      });
      recordTransition(manifest, previousState, PluginHealthStates.failed, health.consecutive_failures);
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
      const message = sanitizeErrorMessage(error);
      status = { healthy: false, message };
    }

    health.last_check_at = now;

    if (status.healthy) {
      handleHealthy(record, previousState, now);
    } else {
      handleUnhealthy(record, previousState, status.message ? sanitizeSecrets(status.message) : "unknown error");
    }
  }

  async function healthCheckAll(): Promise<PluginHealthRecord[]> {
    const records = getAllRecords();
    await Promise.allSettled(records.map((r) => checkPluginHealth(r)));
    const snapshot = records.map((r) => ({ ...r.health }));
    writeSnapshot(snapshot);
    return snapshot;
  }

  /**
   * Cache the full current-state snapshot of every plugin's health as a single `_meta` row, overwritten each
   * cycle — the durable, cross-process surface the dashboard's `/api/system/plugin-health` reads back (the
   * in-memory records are unreachable from the dashboard's separate process). It is a current-state cache, not
   * an event: writing it once per cycle keeps this high-frequency state off the audit ledger (and off the cost
   * tracker's full-replay scan path), mirroring the cost tracker's `safety_snapshot`. `updated_at` is the
   * health loop's liveness marker — it advances every cycle, including an unchanged one, so a stale timestamp
   * means the loop stopped. The transition events (`plugin_unhealthy`/`failed`/`recovered`) remain the audit
   * trail of *changes*. Plugin-agnostic: it carries whatever manifest identity is registered.
   */
  function writeSnapshot(records: PluginHealthRecord[]): void {
    const value = toSqliteJson({ records, updated_at: new Date().toISOString() });
    saveSnapshotStmt.run(HEALTH_SNAPSHOT_META_KEY, value);
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
