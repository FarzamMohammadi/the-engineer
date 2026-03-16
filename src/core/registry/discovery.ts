import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";

import {
  type AdapterType,
  type PluginManifest,
  PluginManifestSchema,
} from "../../schemas/adapters.js";
import type { IObserver } from "../observer/facade.js";
import { RegistryValidationError } from "./errors.js";

// ── Constants ──────────────────────────────────────────────────────────────

/** Type-based initialization order. Communication first (error alerts), trigger last (produces events). */
export const TYPE_PRIORITY: Record<AdapterType, number> = {
  communication: 1,
  llm: 2,
  tool: 3,
  git_hosting: 4,
  trigger: 5,
};

/** Basic semver regex — major.minor.patch with optional prerelease/build. */
export const SEMVER_REGEX = /^\d+\.\d+\.\d+(-[\w.]+)?(\+[\w.]+)?$/;

export const MANIFEST_FILENAME = "engineer.plugin.yaml";

// ── Types ──────────────────────────────────────────────────────────────────

export interface DiscoveredManifest {
  manifest: PluginManifest;
  dir: string;
  entryPath: string;
}

// ── Pure Functions ─────────────────────────────────────────────────────────

/**
 * Recursively scan directories for `engineer.plugin.yaml` files.
 * Parses and validates each manifest via Zod schema.
 * Skips disabled plugins. Skips nonexistent directories.
 */
export function discoverPlugins(dirs: string[], observer: IObserver): DiscoveredManifest[] {
  const results: DiscoveredManifest[] = [];

  for (const dir of dirs) {
    if (!existsSync(dir)) {
      continue;
    }
    scanDirectory(dir, results, observer);
  }

  return results;
}

/**
 * Validate discovered plugins: unique IDs, valid semver versions, entry file existence.
 * Throws on the first validation failure.
 */
export function validateDiscoveredPlugins(
  discovered: DiscoveredManifest[],
  observer: IObserver,
): void {
  const seenIds = new Set<string>();

  for (const item of discovered) {
    const { manifest, entryPath } = item;

    // Unique ID
    if (seenIds.has(manifest.id)) {
      const message = `duplicate plugin ID "${manifest.id}"`;
      observer.error("Plugin validation failed", { pluginId: manifest.id, error: message });
      throw new RegistryValidationError(manifest.id, message);
    }
    seenIds.add(manifest.id);

    // Semver version
    if (!SEMVER_REGEX.test(manifest.version)) {
      const message = `invalid version "${manifest.version}" (must be semver)`;
      observer.error("Plugin validation failed", { pluginId: manifest.id, error: message });
      throw new RegistryValidationError(manifest.id, message);
    }

    // Entry file exists
    if (!existsSync(entryPath)) {
      const message = `entry file not found: ${entryPath}`;
      observer.error("Plugin validation failed", { pluginId: manifest.id, error: message });
      throw new RegistryValidationError(manifest.id, message);
    }
  }
}

/**
 * Sort discovered plugins by type priority, then alphabetically by ID.
 * Returns a new sorted array (does not mutate the input).
 */
export function orderByTypePriority(discovered: DiscoveredManifest[]): DiscoveredManifest[] {
  return [...discovered].sort((a, b) => {
    const typeDiff = TYPE_PRIORITY[a.manifest.type] - TYPE_PRIORITY[b.manifest.type];
    if (typeDiff !== 0) {
      return typeDiff;
    }
    return a.manifest.id.localeCompare(b.manifest.id);
  });
}

// ── Private Helpers ────────────────────────────────────────────────────────

function scanDirectory(dir: string, results: DiscoveredManifest[], observer: IObserver): void {
  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      scanDirectory(fullPath, results, observer);
    } else if (entry.name === MANIFEST_FILENAME) {
      const raw = readFileSync(fullPath, "utf-8");
      const parsed = parseYaml(raw) as Record<string, unknown>;
      const manifest = PluginManifestSchema.parse(parsed);

      if (!manifest.enabled) {
        observer.info("Skipping disabled plugin", { pluginId: manifest.id, dir });
        continue;
      }

      const entryPath = join(dir, manifest.entry);
      observer.info("Discovered plugin", { pluginId: manifest.id, type: manifest.type, dir });
      results.push({ manifest, dir, entryPath });
    }
  }
}
