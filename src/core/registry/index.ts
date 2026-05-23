import type { BaseAdapter, StateStore } from "../../adapters/base.js";
import type {
  AdapterType,
  InitResult,
  PluginHealthRecord,
  PluginManifest,
  RegistrationResult,
} from "../../schemas/adapters.js";
import {
  HealthPluginFailedPayloadSchema,
  HealthPluginRecoveredPayloadSchema,
  HealthPluginUnhealthyPayloadSchema,
} from "../../schemas/events.js";
import type { EventDeclaration } from "../event-bus/topology.js";
import type { IEventBus } from "../interfaces/event-bus.interface.js";
import type { IPluginLookup } from "../interfaces/plugin-lookup.interface.js";
import type { IObserver } from "../observer/index.js";
import { createLifecycleManager } from "./lifecycle.js";
import { createPluginHealthMonitor } from "./plugin-health.js";

// ── Event Declarations ──────────────────────────────────────────────────────

export const EVENTS: EventDeclaration[] = [
  {
    type: "health.plugin_unhealthy",
    description: "Emitted when a plugin fails a health check",
    payloadSchema: HealthPluginUnhealthyPayloadSchema,
    publishers: ["registry"],
    subscribers: ["daemon"],
  },
  {
    type: "health.plugin_failed",
    description: "Emitted when a plugin exceeds the failure threshold and is marked failed",
    payloadSchema: HealthPluginFailedPayloadSchema,
    publishers: ["registry"],
    subscribers: ["daemon"],
  },
  {
    type: "health.plugin_recovered",
    description: "Emitted when a previously unhealthy/failed plugin passes a health check",
    payloadSchema: HealthPluginRecoveredPayloadSchema,
    publishers: ["registry"],
    subscribers: [],
  },
];

// ── Options ────────────────────────────────────────────────────────────────

export interface RegistryOptions {
  eventBus: IEventBus;
  observer: IObserver;
  /** Builds a per-plugin state store. Injected so the Registry stays decoupled from the database. */
  createStateStore: (pluginId: string) => StateStore;
  healthCheckIntervalMs?: number;
  healthCheckTimeoutMs?: number;
  consecutiveFailuresThreshold?: number;
}

// ── Registry Facade ────────────────────────────────────────────────────────

/**
 * Core component that manages plugin lifecycle — registration,
 * initialization, health monitoring, and shutdown.
 *
 * Thin facade that delegates to focused subsystems:
 * - Lifecycle: plugin registration, initialization, lookup, and shutdown
 * - Health: periodic health checks and state machine transitions
 */
export class Registry implements IPluginLookup {
  private readonly lifecycle;
  private readonly healthMonitor;
  private readonly observer: IObserver;
  private readonly createStateStore: (pluginId: string) => StateStore;
  private readonly healthCheckIntervalMs: number;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: RegistryOptions) {
    this.observer = options.observer;
    this.createStateStore = options.createStateStore;
    this.lifecycle = createLifecycleManager(options.observer);
    this.healthCheckIntervalMs = options.healthCheckIntervalMs ?? 60_000;
    this.healthMonitor = createPluginHealthMonitor({
      observer: options.observer,
      eventBus: options.eventBus,
      getRecord: (pluginId) => this.lifecycle.getRecord(pluginId),
      getAllRecords: () => this.lifecycle.getAllRecords(),
      healthCheckTimeoutMs: options.healthCheckTimeoutMs ?? 5_000,
      consecutiveFailuresThreshold: options.consecutiveFailuresThreshold ?? 3,
    });
  }

  // ── Registration ───────────────────────────────────────────────────────

  register(manifest: PluginManifest, instance: BaseAdapter): RegistrationResult {
    instance.context = {
      logger: this.observer.childPlugin(manifest.id),
      stateStore: this.createStateStore(manifest.id),
    };
    return this.lifecycle.register(manifest, instance);
  }

  deregister(pluginId: string): void {
    this.lifecycle.deregister(pluginId);
  }

  // ── Lookup ─────────────────────────────────────────────────────────────

  getPlugin<T extends BaseAdapter>(type: AdapterType, id: string): T | null {
    return this.lifecycle.getPlugin<T>(type, id);
  }

  getPluginsByType<T extends BaseAdapter>(type: AdapterType): T[] {
    return this.lifecycle.getPluginsByType<T>(type);
  }

  getPrimaryPlugin<T extends BaseAdapter>(type: AdapterType): T | null {
    return this.lifecycle.getPrimaryPlugin<T>(type);
  }

  getManifest(pluginId: string): PluginManifest | null {
    return this.lifecycle.getManifest(pluginId);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  initializePlugin(pluginId: string, config: Record<string, unknown>): Promise<InitResult> {
    return this.lifecycle.initializePlugin(pluginId, config);
  }

  async shutdownAll(): Promise<void> {
    this.stopHealthCheckLoop();
    await this.lifecycle.shutdownAll();
  }

  // ── Health ─────────────────────────────────────────────────────────────

  healthCheckAll(): Promise<PluginHealthRecord[]> {
    return this.healthMonitor.healthCheckAll();
  }

  getHealthRecord(pluginId: string): PluginHealthRecord | null {
    return this.healthMonitor.getHealthRecord(pluginId);
  }

  getAllHealthRecords(): PluginHealthRecord[] {
    return this.healthMonitor.getAllHealthRecords();
  }

  startHealthCheckLoop(): void {
    if (this.healthCheckTimer !== null) {
      return;
    }
    this.healthCheckTimer = setInterval(() => {
      this.healthCheckAll().catch((error: unknown) => {
        // Per-plugin failures are handled inside healthCheckAll. A throw here means
        // the loop machinery itself failed (e.g., DB lock, scheduler crash) — surface
        // it so degradation is visible instead of silent.
        this.observer.error("Plugin health check loop failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, this.healthCheckIntervalMs);
  }

  stopHealthCheckLoop(): void {
    if (this.healthCheckTimer !== null) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }
}
