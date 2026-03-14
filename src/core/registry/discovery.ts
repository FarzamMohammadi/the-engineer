import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";

import {
  type AdapterType,
  type PluginManifest,
  PluginManifestSchema,
} from "../../schemas/adapters.js";

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
export function discoverPlugins(dirs: string[]): DiscoveredManifest[] {
  const results: DiscoveredManifest[] = [];

  for (const dir of dirs) {
    if (!existsSync(dir)) {
      continue;
    }
    scanDirectory(dir, results);
  }

  return results;
}

/**
 * Validate discovered plugins: unique IDs, valid semver versions, entry file existence.
 * Throws on the first validation failure.
 */
export function validateDiscoveredPlugins(discovered: DiscoveredManifest[]): void {
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

function scanDirectory(dir: string, results: DiscoveredManifest[]): void {
  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      scanDirectory(fullPath, results);
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
