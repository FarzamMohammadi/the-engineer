import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";

import { resolveEnvVars } from "../config/loader.js";
import type { IObserver } from "../core/observer/index.js";
import type { Registry } from "../core/registry/index.js";
import { extractErrorMessage } from "../utils/errors.js";
import type { BuiltinPlugin } from "./builtin.js";
import { BUILTIN_PLUGINS } from "./builtin.js";

const YAML_EXTENSION = /\.yaml$/;

// ── Types ────────────────────────────────────────────────────────────────────

/** Summary of a plugin load pass — which plugins loaded, which failed, and any startup hints to surface. */
export interface PluginLoadResult {
  /** Plugin IDs that loaded successfully. */
  readonly loaded: string[];
  /** Plugin IDs that failed to load, with reasons. */
  readonly failed: Array<{ id: string; reason: string }>;
  /** Startup hints from loaded plugins. */
  readonly hints: Array<{ pluginName: string; message: string }>;
}

// ── Plugin Loading ───────────────────────────────────────────────────────────

/**
 * Discover and load all enabled builtin plugins.
 *
 * Uses {@link discoverEnabledPlugins} for discovery, then registers,
 * configures, and initializes each plugin via the Registry.
 *
 * @param sharedConfigByType — Shared config keyed by adapter type (e.g. `{ communication: { people } }`).
 *   Merged into every plugin whose `manifest.type` matches the key. Avoids hardcoding plugin IDs
 *   in Core (Plugin Blindness).
 */
export async function loadBuiltinPlugins(
  registry: Registry,
  pluginConfigDir: string,
  observer: IObserver,
  sharedConfigByType?: Record<string, Record<string, unknown>>,
): Promise<PluginLoadResult> {
  const span = observer.startSpan("lifecycle", "load-builtin-plugins", { pluginConfigDir });
  try {
    const plugins = discoverEnabledPlugins(pluginConfigDir);
    const result: PluginLoadResult = { loaded: [], failed: [], hints: [] };

    for (const plugin of plugins) {
      // Critical plugin failures throw from loadSinglePlugin — let them propagate
      const loaded = await loadSinglePlugin(plugin, registry, pluginConfigDir, observer, sharedConfigByType);
      if (loaded) {
        result.loaded.push(plugin.manifest.id);
        // Collect startup hints from successfully loaded plugins
        for (const hint of plugin.manifest.startup_hints) {
          result.hints.push({ pluginName: plugin.manifest.name, message: hint });
        }
      } else {
        result.failed.push({ id: plugin.manifest.id, reason: "initialization failed" });
      }
    }

    observer.info("Plugin loading complete", {
      loaded: result.loaded.length,
      failed: result.failed.length,
      total: plugins.length,
    });
    span.end({ loaded: result.loaded.length, failed: result.failed.length, total: plugins.length });
    return result;
  } catch (error) {
    span.setError(error);
    throw error;
  }
}

// ── Plugin Discovery ─────────────────────────────────────────────────────────

/**
 * Discover which builtin plugins are enabled by checking for config YAML files.
 *
 * A plugin is "enabled" if its config YAML exists in pluginConfigDir
 * (e.g. ~/.engineer/config/plugins/github-trigger.yaml).
 */
export function discoverEnabledPlugins(pluginConfigDir: string): BuiltinPlugin[] {
  let filenames: string[];
  if (existsSync(pluginConfigDir)) {
    try {
      filenames = readdirSync(pluginConfigDir)
        .filter((filename) => filename.endsWith(".yaml"))
        .map((filename) => filename.replace(YAML_EXTENSION, ""));
    } catch (error) {
      throw new Error(`Cannot read plugin config directory "${pluginConfigDir}": ${extractErrorMessage(error)}`, {
        cause: error,
      });
    }
  } else {
    filenames = [];
  }
  const enabledIds = new Set(filenames);
  return BUILTIN_PLUGINS.filter((plugin) => enabledIds.has(plugin.manifest.id));
}

// ── Single Plugin Lifecycle ──────────────────────────────────────────────────

/** Register, configure, and initialize a single plugin. Returns true if successful. */
async function loadSinglePlugin(
  plugin: BuiltinPlugin,
  registry: Registry,
  pluginConfigDir: string,
  observer: IObserver,
  sharedConfigByType?: Record<string, Record<string, unknown>>,
): Promise<boolean> {
  const pluginId = plugin.manifest.id;

  const instance = createPluginInstance(plugin, observer);
  if (!instance) {
    return false;
  }

  const registrationResult = registry.register(plugin.manifest, instance);
  if (!registrationResult.success) {
    observer.warn("Plugin registration failed — adapter capability unavailable", {
      pluginId,
      adapterType: plugin.manifest.type,
      capability: `${plugin.manifest.type}_adapter`,
      reason: registrationResult.message,
    });
    if (plugin.manifest.critical) {
      throw new Error(`Critical plugin "${pluginId}" failed to register: ${registrationResult.message}`);
    }
    return false;
  }

  const configPath = join(pluginConfigDir, `${pluginId}.yaml`);
  const pluginConfig = loadPluginConfig(configPath, pluginId, plugin.manifest.critical, observer, plugin.manifest.type);
  if (pluginConfig === null) {
    registry.deregister(pluginId);
    return false;
  }

  // Merge shared config for this adapter type (e.g. people data for communication plugins)
  const shared = sharedConfigByType?.[plugin.manifest.type];
  if (shared) {
    Object.assign(pluginConfig, shared);
  }

  const initializationResult = await registry.initializePlugin(pluginId, pluginConfig);
  if (!initializationResult.success) {
    if (plugin.manifest.critical) {
      throw new Error(`Critical plugin "${pluginId}" failed to initialize: ${initializationResult.message}`);
    }
    observer.warn("Plugin init failed — adapter capability unavailable until next daemon start", {
      pluginId,
      adapterType: plugin.manifest.type,
      capability: `${plugin.manifest.type}_adapter`,
      reason: initializationResult.message,
    });
    registry.deregister(pluginId);
    return false;
  }

  observer.info("Plugin initialized", {
    pluginId,
    type: plugin.manifest.type,
    critical: plugin.manifest.critical,
  });
  return true;
}

/** Create and validate a plugin instance. Throws for critical failures, returns null for non-critical. */
function createPluginInstance(plugin: BuiltinPlugin, observer: IObserver): ReturnType<BuiltinPlugin["create"]> | null {
  const pluginId = plugin.manifest.id;
  try {
    return plugin.create();
  } catch (error) {
    const errorMessage = extractErrorMessage(error);
    if (plugin.manifest.critical) {
      throw new Error(`Critical plugin "${pluginId}" failed to create: ${errorMessage}`, {
        cause: error,
      });
    }
    observer.warn("Plugin creation failed — adapter capability unavailable until next daemon start", {
      pluginId,
      adapterType: plugin.manifest.type,
      capability: `${plugin.manifest.type}_adapter`,
      error: errorMessage,
    });
    return null;
  }
}

/** Load plugin config from YAML file, resolving env vars. Returns null on error for non-critical plugins. */
function loadPluginConfig(
  configPath: string,
  pluginId: string,
  critical: boolean,
  observer: IObserver,
  adapterType: string,
): Record<string, unknown> | null {
  if (!existsSync(configPath)) {
    return {};
  }
  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = parseYaml(raw) as Record<string, unknown> | null;
    return (parsed ? resolveEnvVars(parsed, configPath) : {}) as Record<string, unknown>;
  } catch (error) {
    const errorMessage = extractErrorMessage(error);
    if (critical) {
      throw new Error(`Failed to load config for critical plugin "${pluginId}": ${errorMessage}`, {
        cause: error,
      });
    }
    observer.warn("Plugin config load failed — adapter capability unavailable until next daemon start", {
      pluginId,
      adapterType,
      capability: `${adapterType}_adapter`,
      error: errorMessage,
    });
    return null;
  }
}
