import type { BaseAdapter } from "../../adapters/base.js";
import {
  type AdapterType,
  type InitResult,
  PluginHealthStates,
  type PluginManifest,
  type RegistrationResult,
} from "../../schemas/adapters.js";
import type { PluginHealthRecord } from "../../schemas/adapters.js";
import type { DiscoveredManifest } from "./discovery.js";
import { RegistryLoadError } from "./errors.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface PluginRecord {
  manifest: PluginManifest;
  instance: BaseAdapter;
  health: PluginHealthRecord;
  initOrder: number;
}

export type ConfigResolver = (pluginId: string) => Promise<Record<string, unknown>>;

export interface LifecycleManager {
  register(manifest: PluginManifest, instance: BaseAdapter): RegistrationResult;
  deregister(pluginId: string): void;
  initializePlugin(pluginId: string, config: Record<string, unknown>): Promise<InitResult>;
  initializeAll(configResolver: ConfigResolver): Promise<void>;
  loadModules(ordered: DiscoveredManifest[]): Promise<void>;
  shutdownAll(): Promise<void>;
  getPlugin<T extends BaseAdapter>(type: AdapterType, id: string): T | null;
  getPluginsByType<T extends BaseAdapter>(type: AdapterType): T[];
  getPrimaryPlugin<T extends BaseAdapter>(type: AdapterType): T | null;
  getManifest(pluginId: string): PluginManifest | null;
  getRecord(pluginId: string): PluginRecord | undefined;
  getAllRecords(): PluginRecord[];
}

// ── Factory ────────────────────────────────────────────────────────────────

export function createLifecycleManager(): LifecycleManager {
  const plugins = new Map<string, PluginRecord>();
  const typeCache = new Map<AdapterType, BaseAdapter[]>();
  let nextInitOrder = 1;

  function invalidateTypeCache(type: AdapterType): void {
    typeCache.delete(type);
  }

  function register(manifest: PluginManifest, instance: BaseAdapter): RegistrationResult {
    if (plugins.has(manifest.id)) {
      console.error(`Registry: rejected duplicate plugin ID "${manifest.id}"`);
      return {
        success: false,
        plugin_id: manifest.id,
        message: `Plugin with ID "${manifest.id}" is already registered`,
      };
    }

    instance.manifest = manifest;

    plugins.set(manifest.id, {
      manifest,
      instance,
      health: {
        plugin_id: manifest.id,
        state: PluginHealthStates.healthy,
        consecutive_failures: 0,
        last_check_at: null,
        last_healthy_at: null,
        last_error: null,
      },
      initOrder: nextInitOrder++,
    });

    invalidateTypeCache(manifest.type);
    console.log(`Registry: registered "${manifest.id}" (${manifest.type})`);
    return { success: true, plugin_id: manifest.id, message: null };
  }

  function deregister(pluginId: string): void {
    const record = plugins.get(pluginId);
    if (record) {
      invalidateTypeCache(record.manifest.type);
      plugins.delete(pluginId);
      console.log(`Registry: deregistered "${pluginId}"`);
    }
  }

  function getPlugin<T extends BaseAdapter>(type: AdapterType, id: string): T | null {
    const record = plugins.get(id);
    if (!record || record.manifest.type !== type) {
      return null;
    }
    return record.instance as T;
  }

  function getPluginsByType<T extends BaseAdapter>(type: AdapterType): T[] {
    const cached = typeCache.get(type);
    if (cached) {
      return cached as T[];
    }

    const results: BaseAdapter[] = [];
    for (const record of plugins.values()) {
      if (record.manifest.type === type) {
        results.push(record.instance);
      }
    }
    typeCache.set(type, results);
    return results as T[];
  }

  function getPrimaryPlugin<T extends BaseAdapter>(type: AdapterType): T | null {
    let best: PluginRecord | null = null;
    for (const record of plugins.values()) {
      if (record.manifest.type === type) {
        if (!best || record.initOrder < best.initOrder) {
          best = record;
        }
      }
    }
    return best ? (best.instance as T) : null;
  }

  function getManifest(pluginId: string): PluginManifest | null {
    return plugins.get(pluginId)?.manifest ?? null;
  }

  async function initializePlugin(
    pluginId: string,
    config: Record<string, unknown>,
  ): Promise<InitResult> {
    const record = plugins.get(pluginId);
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

  async function initializeAll(configResolver: ConfigResolver): Promise<void> {
    const records = [...plugins.values()].sort((a, b) => a.initOrder - b.initOrder);

    for (const record of records) {
      const { manifest } = record;
      const config = await configResolver(manifest.id);
      const result = await initializePlugin(manifest.id, config);

      if (!result.success) {
        if (manifest.critical) {
          console.error(
            `Registry: CRITICAL plugin "${manifest.id}" failed to initialize: ${result.message ?? "unknown error"}. Aborting startup.`,
          );
          throw new RegistryLoadError(
            manifest.id,
            `critical plugin failed to initialize: ${result.message ?? "unknown error"}`,
          );
        }
        console.warn(
          `Registry: plugin "${manifest.id}" failed to initialize: ${result.message ?? "unknown error"}. Skipping (non-critical).`,
        );
        deregister(manifest.id);
      }
    }
  }

  async function loadModules(ordered: DiscoveredManifest[]): Promise<void> {
    for (const item of ordered) {
      const { manifest, entryPath } = item;

      const module = (await import(entryPath)) as { createPlugin?: () => BaseAdapter };
      if (typeof module.createPlugin !== "function") {
        const message = `entry module does not export createPlugin(): ${entryPath}`;
        console.error(`Registry: load failed for "${manifest.id}": ${message}`);
        throw new RegistryLoadError(manifest.id, message);
      }

      const instance = module.createPlugin();
      register(manifest, instance);
    }
  }

  async function shutdownAll(): Promise<void> {
    const records = [...plugins.values()].sort((a, b) => b.initOrder - a.initOrder);

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

  function getRecord(pluginId: string): PluginRecord | undefined {
    return plugins.get(pluginId);
  }

  function getAllRecords(): PluginRecord[] {
    return [...plugins.values()];
  }

  return {
    register,
    deregister,
    initializePlugin,
    initializeAll,
    loadModules,
    shutdownAll,
    getPlugin,
    getPluginsByType,
    getPrimaryPlugin,
    getManifest,
    getRecord,
    getAllRecords,
  };
}
