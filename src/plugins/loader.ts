import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";

import { YAML_EXTENSION_PATTERN } from "../cli/constants.js";
import { resolveEnvVars } from "../config/loader.js";
import type { IObserver } from "../core/observer/facade.js";
import type { Registry } from "../core/registry/index.js";
import { BUILTIN_PLUGINS } from "./builtin.js";

// ── Plugin Config Loading ─────────────────────────────────────────────────────

/** Load plugin config from YAML file, resolving env vars. Returns null on error for non-critical plugins. */
function loadPluginConfig(
  configPath: string,
  pluginId: string,
  critical: boolean,
): Record<string, unknown> | null {
  if (!existsSync(configPath)) {
    return {};
  }
  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = parseYaml(raw) as Record<string, unknown> | null;
    return (parsed ? resolveEnvVars(parsed, configPath) : {}) as Record<string, unknown>;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (critical) {
      throw new Error(`Failed to load config for critical plugin "${pluginId}": ${errorMessage}`);
    }
    return null;
  }
}

// ── Plugin Discovery & Loading ────────────────────────────────────────────────

/**
 * Discover and load all enabled builtin plugins.
 *
 * A plugin is "enabled" if its config YAML exists in pluginConfigDir
 * (e.g. ~/.engineer/config/plugins/github-trigger.yaml).
 */
export async function loadBuiltinPlugins(
  registry: Registry,
  pluginConfigDir: string,
  observer: IObserver,
): Promise<void> {
  const enabledIds = new Set(
    existsSync(pluginConfigDir)
      ? readdirSync(pluginConfigDir)
          .filter((filename) => filename.endsWith(".yaml"))
          .map((filename) => filename.replace(YAML_EXTENSION_PATTERN, ""))
      : [],
  );
  const plugins = BUILTIN_PLUGINS.filter((plugin) => enabledIds.has(plugin.manifest.id));
  let loadedCount = 0;

  for (const plugin of plugins) {
    const pluginId = plugin.manifest.id;
    const instance = plugin.create();
    const registrationResult = registry.register(plugin.manifest, instance);
    if (!registrationResult.success) {
      observer.warn("Plugin registration failed", { pluginId, reason: registrationResult.message });
      continue;
    }

    const configPath = join(pluginConfigDir, `${pluginId}.yaml`);
    const pluginConfig = loadPluginConfig(configPath, pluginId, plugin.manifest.critical);
    if (pluginConfig === null) {
      observer.warn("Plugin config load failed, skipping", { pluginId });
      registry.deregister(pluginId);
      continue;
    }

    const initializationResult = await registry.initializePlugin(pluginId, pluginConfig);
    if (!initializationResult.success) {
      if (plugin.manifest.critical) {
        throw new Error(
          `Critical plugin "${pluginId}" failed to initialize: ${initializationResult.message}`,
        );
      }
      observer.warn("Plugin init failed, deregistering", {
        pluginId,
        reason: initializationResult.message,
      });
      registry.deregister(pluginId);
      continue;
    }

    loadedCount++;
    observer.info("Plugin initialized", {
      pluginId,
      type: plugin.manifest.type,
      critical: plugin.manifest.critical,
    });
  }

  observer.info("Plugin loading complete", { loaded: loadedCount, total: plugins.length });
}
