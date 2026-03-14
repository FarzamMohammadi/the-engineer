import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { PluginManifest } from "../../schemas/adapters.js";
import { orderByTypePriority, discoverPlugins as scanDirectories } from "./discovery.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface DiscoveryOptions {
  /** Directories to scan for plugins. */
  dirs: string[];
  /** Whether to include built-in plugins from src/plugins/. */
  includeBuiltins: boolean;
}

export interface DiscoveredPlugin {
  manifest: PluginManifest;
  dir: string;
  entryPath: string;
  isBuiltin: boolean;
}

// ── Constants ──────────────────────────────────────────────────────────────

const THIS_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the built-in plugins directory.
 *
 * In source (tsx): this file is at `src/core/registry/`, plugins at `src/plugins/`.
 * After build (tsdown): this file is in `dist/`, plugins copied to `dist/plugins/`.
 */
function resolveBuiltinsDir(): string {
  // From src/core/registry/ → src/plugins/ is ../../plugins
  // From dist/ → dist/plugins/ is ./plugins
  const srcPath = resolve(THIS_DIR, "..", "..", "plugins");
  return srcPath;
}

// ── Discovery ──────────────────────────────────────────────────────────────

/**
 * Scan directories for engineer.plugin.yaml files and return discovered plugins.
 *
 * Discovery order:
 * 1. Built-in plugins (src/plugins/) — if includeBuiltins is true
 * 2. User plugin directories (from config daemon.plugins.dirs)
 *
 * Validates each manifest against PluginManifestSchema.
 * Skips disabled plugins (enabled: false).
 * Throws on duplicate plugin IDs across all directories.
 */
export function discoverPlugins(options: DiscoveryOptions): DiscoveredPlugin[] {
  const results: DiscoveredPlugin[] = [];
  const seenIds = new Set<string>();

  // 1. Built-in plugins
  if (options.includeBuiltins) {
    const builtinsDir = resolveBuiltinsDir();
    const builtins = scanDirectories([builtinsDir]);
    for (const item of builtins) {
      seenIds.add(item.manifest.id);
      results.push({
        manifest: item.manifest,
        dir: item.dir,
        entryPath: item.entryPath,
        isBuiltin: true,
      });
    }
  }

  // 2. User plugin directories
  if (options.dirs.length > 0) {
    const userPlugins = scanDirectories(options.dirs);
    for (const item of userPlugins) {
      if (seenIds.has(item.manifest.id)) {
        throw new Error(
          `Duplicate plugin ID "${item.manifest.id}" found in user directory "${item.dir}" — conflicts with built-in plugin`,
        );
      }
      seenIds.add(item.manifest.id);
      results.push({
        manifest: item.manifest,
        dir: item.dir,
        entryPath: item.entryPath,
        isBuiltin: false,
      });
    }
  }

  // Sort by type priority, then alphabetically
  return orderByTypePriority(
    results.map((r) => ({ manifest: r.manifest, dir: r.dir, entryPath: r.entryPath })),
  ).map((ordered) => {
    const original = results.find((r) => r.manifest.id === ordered.manifest.id);
    return {
      manifest: ordered.manifest,
      dir: ordered.dir,
      entryPath: ordered.entryPath,
      isBuiltin: original?.isBuiltin ?? false,
    };
  });
}
