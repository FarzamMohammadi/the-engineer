import type { BaseAdapter } from "../../adapters/base.js";
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
import type { EventBus } from "../event-bus/index.js";
import type { EventDeclaration } from "../event-bus/topology.js";
import type { HookRegistry } from "../hooks/index.js";
import { discoverPlugins, orderByTypePriority, validateDiscoveredPlugins } from "./discovery.js";
import { createHealthMonitor } from "./health.js";
import { type ConfigResolver, createLifecycleManager } from "./lifecycle.js";

// ── Re-exports ─────────────────────────────────────────────────────────────

export {
  discoverPlugins,
  validateDiscoveredPlugins,
  orderByTypePriority,
  MANIFEST_FILENAME,
  SEMVER_REGEX,
  TYPE_PRIORITY,
} from "./discovery.js";
export type { DiscoveredManifest } from "./discovery.js";
export type { PluginRecord, LifecycleManager, ConfigResolver } from "./lifecycle.js";
export type { HealthMonitor, HealthMonitorDeps } from "./health.js";

// ── Event Declarations ──────────────────────────────────────────────────────

export const EVENTS: EventDeclaration[] = [
  {
    type: "health.plugin_unhealthy",
    description: "Emitted when a plugin fails a health check",
    payloadSchema: HealthPluginUnhealthyPayloadSchema,
    publishers: ["registry"],
    subscribers: [],
  },
  {
    type: "health.plugin_failed",
    description: "Emitted when a plugin exceeds the failure threshold and is marked failed",
    payloadSchema: HealthPluginFailedPayloadSchema,
    publishers: ["registry"],
    subscribers: [],
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
  eventBus: EventBus;
  healthCheckIntervalMs?: number;
  healthCheckTimeoutMs?: number;
  consecutiveFailuresThreshold?: number;
  hookRegistry?: HookRegistry | undefined;
}

// ── Registry Facade ────────────────────────────────────────────────────────

/**
 * Core component that manages plugin lifecycle — discovery, validation,
 * loading, initialization, health monitoring, and shutdown.
 *
 * Thin facade that delegates to focused subsystems:
 * - Discovery: pure functions for finding and validating plugins
 * - Lifecycle: plugin registration, initialization, lookup, and shutdown
 * - Health: periodic health checks and state machine transitions
 *
 * Two entry paths:
 * - `loadFromDirectories(dirs)` — five-phase startup pipeline
 * - `register(manifest, instance)` — programmatic registration (tests, runtime)
 */
export class Registry {
  private readonly lifecycle = createLifecycleManager();
  private readonly healthMonitor;
  private readonly eventBus: EventBus;
  private readonly hookRegistry?: HookRegistry | undefined;
  private readonly healthCheckIntervalMs: number;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: RegistryOptions) {
    this.eventBus = options.eventBus;
    this.hookRegistry = options.hookRegistry;
    this.healthCheckIntervalMs = options.healthCheckIntervalMs ?? 60_000;
    this.healthMonitor = createHealthMonitor({
      eventBus: options.eventBus,
      getRecord: (pluginId) => this.lifecycle.getRecord(pluginId),
      getAllRecords: () => this.lifecycle.getAllRecords(),
      healthCheckTimeoutMs: options.healthCheckTimeoutMs ?? 5_000,
      consecutiveFailuresThreshold: options.consecutiveFailuresThreshold ?? 3,
    });
  }

  // ── Five-Phase Loading Pipeline ────────────────────────────────────────

  async loadFromDirectories(
    dirs: string[],
    configResolver: ConfigResolver = () => Promise.resolve({}),
  ): Promise<void> {
    const discovered = discoverPlugins(dirs);
    if (discovered.length === 0) {
      console.log("Registry: no plugins discovered");
      return;
    }

    validateDiscoveredPlugins(discovered);

    const ordered = orderByTypePriority(discovered);
    console.log(`Registry: loading order: [${ordered.map((d) => d.manifest.id).join(", ")}]`);

    await this.lifecycle.loadModules(ordered);
    await this.lifecycle.initializeAll(configResolver);
  }

  // ── Registration ───────────────────────────────────────────────────────

  register(manifest: PluginManifest, instance: BaseAdapter): RegistrationResult {
    if (this.hookRegistry) {
      instance.hookRegistry = this.hookRegistry;
    }
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

  // biome-ignore lint/suspicious/useAwait: delegates to lifecycle manager which returns a Promise
  async initializePlugin(pluginId: string, config: Record<string, unknown>): Promise<InitResult> {
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
      this.healthCheckAll().catch(() => {
        /* health check errors are handled internally */
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
