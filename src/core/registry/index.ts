import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";

import type { BaseAdapter } from "../../adapters/base.js";
import {
  type AdapterType,
  AdapterTypeSchema,
  type InitResult,
  type PluginHealthRecord,
  type PluginHealthState,
  type PluginManifest,
  PluginManifestSchema,
  type RegistrationResult,
} from "../../schemas/adapters.js";
import type { EventBus } from "../event-bus/index.js";

// ── Constants ──────────────────────────────────────────────────────────────

/** Type-based initialization order. Communication first (error alerts), trigger last (produces events). */
const TYPE_PRIORITY: Record<AdapterType, number> = {
  communication: 1,
  llm: 2,
  tool: 3,
  git_hosting: 4,
  trigger: 5,
};

/** Basic semver regex — major.minor.patch with optional prerelease/build. */
const SEMVER_REGEX = /^\d+\.\d+\.\d+(-[\w.]+)?(\+[\w.]+)?$/;

const MANIFEST_FILENAME = "engineer.plugin.yaml";

// ── Internal Types ─────────────────────────────────────────────────────────

interface PluginRecord {
  manifest: PluginManifest;
  instance: BaseAdapter;
  health: PluginHealthRecord;
  initOrder: number;
}

interface DiscoveredManifest {
  manifest: PluginManifest;
  dir: string;
  entryPath: string;
}

export interface RegistryOptions {
  eventBus: EventBus;
  healthCheckIntervalMs?: number;
  healthCheckTimeoutMs?: number;
  consecutiveFailuresThreshold?: number;
}

export type ConfigResolver = (pluginId: string) => Promise<Record<string, unknown>>;

// ── Registry ───────────────────────────────────────────────────────────────

/**
 * Core component that manages plugin lifecycle — discovery, validation,
 * loading, initialization, health monitoring, and shutdown.
 *
 * Two entry paths:
 * - `loadFromDirectories(dirs)` — five-phase startup pipeline
 * - `register(manifest, instance)` — programmatic registration (tests, runtime)
 */
export class Registry {
  private readonly plugins = new Map<string, PluginRecord>();
  private readonly eventBus: EventBus;
  private readonly healthCheckIntervalMs: number;
  private readonly healthCheckTimeoutMs: number;
  private readonly consecutiveFailuresThreshold: number;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private nextInitOrder = 1;

  constructor(options: RegistryOptions) {
    this.eventBus = options.eventBus;
    this.healthCheckIntervalMs = options.healthCheckIntervalMs ?? 60_000;
    this.healthCheckTimeoutMs = options.healthCheckTimeoutMs ?? 5_000;
    this.consecutiveFailuresThreshold = options.consecutiveFailuresThreshold ?? 3;
  }

  // ── Five-Phase Loading Pipeline ────────────────────────────────────────

  /**
   * Full startup sequence: discover → validate → order → load → initialize.
   * Used by the Daemon at startup and by integration tests.
   *
   * @param dirs — directories to scan for `engineer.plugin.yaml` files
   * @param configResolver — resolves plugin config by ID (default: empty config)
   */
  async loadFromDirectories(
    dirs: string[],
    configResolver: ConfigResolver = async () => ({}),
  ): Promise<void> {
    // Phase 1: Discover
    const discovered = this.discover(dirs);
    if (discovered.length === 0) {
      console.log("Registry: no plugins discovered");
      return;
    }

    // Phase 2: Validate
    this.validate(discovered);

    // Phase 3: Order
    const ordered = this.order(discovered);
    console.log(`Registry: loading order: [${ordered.map((d) => d.manifest.id).join(", ")}]`);

    // Phase 4: Load
    await this.load(ordered);

    // Phase 5: Initialize
    await this.initializeAll(configResolver);
  }

  // ── Phase 1: Discover ─────────────────────────────────────────────────

  private discover(dirs: string[]): DiscoveredManifest[] {
    const results: DiscoveredManifest[] = [];

    for (const dir of dirs) {
      if (!existsSync(dir)) {
        continue;
      }
      this.scanDirectory(dir, results);
    }

    return results;
  }

  private scanDirectory(dir: string, results: DiscoveredManifest[]): void {
    const entries = readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        this.scanDirectory(fullPath, results);
      } else if (entry.name === MANIFEST_FILENAME) {
        const raw = readFileSync(fullPath, "utf-8");
        const parsed = parseYaml(raw) as Record<string, unknown>;
        const manifest = PluginManifestSchema.parse(parsed);

        if (!manifest.enabled) {
          console.log(`Registry: skipping disabled plugin "${manifest.id}" at ${dir}`);
          continue;
        }

        const entryPath = join(dir, manifest.entry);
        console.log(`Registry: discovered plugin "${manifest.id}" (${manifest.type}) at ${dir}`);
        results.push({ manifest, dir, entryPath });
      }
    }
  }

  // ── Phase 2: Validate ─────────────────────────────────────────────────

  private validate(discovered: DiscoveredManifest[]): void {
    const seenIds = new Set<string>();

    for (const item of discovered) {
      const { manifest, entryPath } = item;

      // Unique ID
      if (seenIds.has(manifest.id)) {
        const message = `duplicate plugin ID "${manifest.id}"`;
        console.error(`Registry: validation failed for "${manifest.id}": ${message}`);
        throw new Error(`Registry: validation failed: ${message}`);
      }
      seenIds.add(manifest.id);

      // Valid adapter type (already parsed by Zod, but explicit check for clarity)
      const typeResult = AdapterTypeSchema.safeParse(manifest.type);
      if (!typeResult.success) {
        const message = `invalid adapter type "${String(manifest.type)}"`;
        console.error(`Registry: validation failed for "${manifest.id}": ${message}`);
        throw new Error(`Registry: validation failed for "${manifest.id}": ${message}`);
      }

      // Semver version
      if (!SEMVER_REGEX.test(manifest.version)) {
        const message = `invalid version "${manifest.version}" (must be semver)`;
        console.error(`Registry: validation failed for "${manifest.id}": ${message}`);
        throw new Error(`Registry: validation failed for "${manifest.id}": ${message}`);
      }

      // Entry file exists
      if (!existsSync(entryPath)) {
        const message = `entry file not found: ${entryPath}`;
        console.error(`Registry: validation failed for "${manifest.id}": ${message}`);
        throw new Error(`Registry: validation failed for "${manifest.id}": ${message}`);
      }
    }
  }

  // ── Phase 3: Order ────────────────────────────────────────────────────

  private order(discovered: DiscoveredManifest[]): DiscoveredManifest[] {
    return [...discovered].sort((a, b) => {
      const typeDiff = TYPE_PRIORITY[a.manifest.type] - TYPE_PRIORITY[b.manifest.type];
      if (typeDiff !== 0) {
        return typeDiff;
      }
      return a.manifest.id.localeCompare(b.manifest.id);
    });
  }

  // ── Phase 4: Load ─────────────────────────────────────────────────────

  private async load(ordered: DiscoveredManifest[]): Promise<void> {
    for (const item of ordered) {
      const { manifest, entryPath } = item;

      const module = (await import(entryPath)) as { createPlugin?: () => BaseAdapter };
      if (typeof module.createPlugin !== "function") {
        const message = `entry module does not export createPlugin(): ${entryPath}`;
        console.error(`Registry: load failed for "${manifest.id}": ${message}`);
        throw new Error(`Registry: load failed for "${manifest.id}": ${message}`);
      }

      const instance = module.createPlugin();
      instance.manifest = manifest;
      this.register(manifest, instance);

      console.log(
        `Registry: loaded plugin "${manifest.id}" (${manifest.type} v${manifest.version})`,
      );
    }
  }

  // ── Phase 5: Initialize All ───────────────────────────────────────────

  private async initializeAll(configResolver: ConfigResolver): Promise<void> {
    // Initialize in init order
    const records = [...this.plugins.values()].sort((a, b) => a.initOrder - b.initOrder);

    for (const record of records) {
      const { manifest } = record;
      const config = await configResolver(manifest.id);
      const result = await this.initializePlugin(manifest.id, config);

      if (!result.success) {
        if (manifest.critical) {
          console.error(
            `Registry: CRITICAL plugin "${manifest.id}" failed to initialize: ${result.message ?? "unknown error"}. Aborting startup.`,
          );
          throw new Error(
            `Registry: critical plugin "${manifest.id}" failed to initialize: ${result.message ?? "unknown error"}`,
          );
        }
        console.warn(
          `Registry: plugin "${manifest.id}" failed to initialize: ${result.message ?? "unknown error"}. Skipping (non-critical).`,
        );
        this.deregister(manifest.id);
      }
    }
  }

  // ── Programmatic Registration ─────────────────────────────────────────

  /**
   * Register a plugin instance with its manifest.
   * Does NOT auto-initialize — caller is responsible for calling `initializePlugin()`.
   * Injects the manifest into the instance immediately.
   */
  register(manifest: PluginManifest, instance: BaseAdapter): RegistrationResult {
    if (this.plugins.has(manifest.id)) {
      console.error(`Registry: rejected duplicate plugin ID "${manifest.id}"`);
      return {
        success: false,
        plugin_id: manifest.id,
        message: `Plugin with ID "${manifest.id}" is already registered`,
      };
    }

    instance.manifest = manifest;

    this.plugins.set(manifest.id, {
      manifest,
      instance,
      health: {
        plugin_id: manifest.id,
        state: "healthy",
        consecutive_failures: 0,
        last_check_at: null,
        last_healthy_at: null,
        last_error: null,
      },
      initOrder: this.nextInitOrder++,
    });

    console.log(`Registry: registered "${manifest.id}" (${manifest.type})`);
    return { success: true, plugin_id: manifest.id, message: null };
  }

  /**
   * Remove a plugin from the registry.
   * No-op if the plugin ID is not registered.
   */
  deregister(pluginId: string): void {
    if (this.plugins.delete(pluginId)) {
      console.log(`Registry: deregistered "${pluginId}"`);
    }
  }

  // ── Discovery ─────────────────────────────────────────────────────────

  /**
   * Get a specific plugin by type and ID.
   * Returns null if not found or type doesn't match.
   */
  getPlugin<T extends BaseAdapter>(type: AdapterType, id: string): T | null {
    const record = this.plugins.get(id);
    if (!record || record.manifest.type !== type) {
      return null;
    }
    return record.instance as T;
  }

  /**
   * Get all plugins of a given type.
   */
  getPluginsByType<T extends BaseAdapter>(type: AdapterType): T[] {
    const results: T[] = [];
    for (const record of this.plugins.values()) {
      if (record.manifest.type === type) {
        results.push(record.instance as T);
      }
    }
    return results;
  }

  /**
   * Get the primary plugin of a given type.
   * Primary = first registered of that type (by init order).
   */
  getPrimaryPlugin<T extends BaseAdapter>(type: AdapterType): T | null {
    let best: PluginRecord | null = null;
    for (const record of this.plugins.values()) {
      if (record.manifest.type === type) {
        if (!best || record.initOrder < best.initOrder) {
          best = record;
        }
      }
    }
    return best ? (best.instance as T) : null;
  }

  /**
   * Get the manifest for a registered plugin.
   */
  getManifest(pluginId: string): PluginManifest | null {
    return this.plugins.get(pluginId)?.manifest ?? null;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  /**
   * Initialize a specific registered plugin with the given config.
   * Returns the InitResult from the plugin's `initialize()` call.
   */
  async initializePlugin(pluginId: string, config: Record<string, unknown>): Promise<InitResult> {
    const record = this.plugins.get(pluginId);
    if (!record) {
      return { success: false, message: `Plugin "${pluginId}" not registered` };
    }

    const start = Date.now();
    const result = await record.instance.initialize(config);
    const elapsed = Date.now() - start;

    if (result.success) {
      console.log(`Registry: initialized "${pluginId}" in ${String(elapsed)}ms`);
    }

    return result;
  }

  /**
   * Shut down all plugins in reverse initialization order.
   * Continues to next plugin if one shutdown fails.
   */
  async shutdownAll(): Promise<void> {
    this.stopHealthCheckLoop();

    const records = [...this.plugins.values()].sort((a, b) => b.initOrder - a.initOrder);

    for (const record of records) {
      console.log(`Registry: shutting down "${record.manifest.id}"...`);
      try {
        await record.instance.shutdown();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(
          `Registry: shutdown error for "${record.manifest.id}" (non-fatal): ${message}`,
        );
      }
    }

    console.log("Registry: all plugins shut down");
  }

  // ── Health ────────────────────────────────────────────────────────────

  /**
   * Run a health check on all registered plugins.
   * Updates internal health records and emits events on state transitions.
   */
  async healthCheckAll(): Promise<PluginHealthRecord[]> {
    const results: PluginHealthRecord[] = [];

    for (const record of this.plugins.values()) {
      await this.checkPluginHealth(record);
      results.push({ ...record.health });
    }

    return results;
  }

  /**
   * Get the health record for a specific plugin.
   */
  getHealthRecord(pluginId: string): PluginHealthRecord | null {
    const record = this.plugins.get(pluginId);
    if (!record) {
      return null;
    }
    return { ...record.health };
  }

  /**
   * Get health records for all registered plugins.
   */
  getAllHealthRecords(): PluginHealthRecord[] {
    return [...this.plugins.values()].map((r) => ({ ...r.health }));
  }

  // ── Health Check Loop ─────────────────────────────────────────────────

  /**
   * Start the periodic health check loop.
   * The Daemon starts this after loading completes.
   */
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

  /**
   * Stop the periodic health check loop.
   */
  stopHealthCheckLoop(): void {
    if (this.healthCheckTimer !== null) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  // ── Private: Health State Machine ─────────────────────────────────────

  private async checkPluginHealth(record: PluginRecord): Promise<void> {
    const { health } = record;
    const previousState = health.state;
    const now = new Date().toISOString();

    let status: { healthy: boolean; message: string | null };

    try {
      status = await Promise.race([record.instance.healthCheck(), this.rejectAfterTimeout()]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      status = { healthy: false, message };
    }

    health.last_check_at = now;

    if (status.healthy) {
      this.handleHealthy(record, previousState, now);
    } else {
      this.handleUnhealthy(record, previousState, status.message ?? "unknown error");
    }
  }

  private handleHealthy(record: PluginRecord, previousState: PluginHealthState, now: string): void {
    const { health, manifest } = record;
    health.consecutive_failures = 0;
    health.last_healthy_at = now;
    health.last_error = null;

    if (previousState !== "healthy") {
      health.state = "healthy";
      console.log(`Registry: plugin "${manifest.id}" recovered (was ${previousState})`);
      this.eventBus.publish({
        type: "health.plugin_recovered",
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

  private handleUnhealthy(
    record: PluginRecord,
    previousState: PluginHealthState,
    errorMessage: string,
  ): void {
    const { health, manifest } = record;
    health.consecutive_failures++;
    health.last_error = errorMessage;

    if (previousState === "healthy") {
      // healthy → unhealthy
      health.state = "unhealthy";
      console.warn(
        `Registry: plugin "${manifest.id}" is unhealthy (${String(health.consecutive_failures)} failures): ${errorMessage}`,
      );
      this.eventBus.publish({
        type: "health.plugin_unhealthy",
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
      previousState === "unhealthy" &&
      health.consecutive_failures >= this.consecutiveFailuresThreshold
    ) {
      // unhealthy → failed
      health.state = "failed";
      console.error(
        `Registry: plugin "${manifest.id}" has FAILED (${String(health.consecutive_failures)}/${String(this.consecutiveFailuresThreshold)} failures): ${errorMessage}`,
      );
      this.eventBus.publish({
        type: "health.plugin_failed",
        source: "registry",
        task_id: null,
        payload: {
          plugin_id: manifest.id,
          plugin_type: manifest.type,
          error: errorMessage,
          consecutive_failures: health.consecutive_failures,
          threshold: this.consecutiveFailuresThreshold,
        },
      });
    }
    // If already "failed", stays "failed" — no repeated events until recovery
  }

  private rejectAfterTimeout(): Promise<never> {
    return new Promise((_resolve, reject) => {
      setTimeout(() => {
        reject(new Error("health check timeout"));
      }, this.healthCheckTimeoutMs);
    });
  }
}
