import fs from "node:fs";

import type { z } from "zod";

import { ConfigError } from "./loader.js";
import type { ConfigReloadResult } from "./loader.js";
import { loadConfigSafe } from "./loader.js";

// ── Constants ────────────────────────────────────────────────────────────────────

const DEBOUNCE_MS = 500;

// ── Config Watcher ───────────────────────────────────────────────────────────────

export interface WatcherHandle {
  stop(): void;
}

/**
 * Watches a config file for changes and reloads it on modification.
 * Uses `node:fs.watch()` with 500ms debounce to handle rapid saves
 * and atomic write patterns (temp file → rename).
 *
 * On valid change: calls `onChange({ ok: true, config })`.
 * On invalid change: calls `onChange({ ok: false, error })`.
 * The caller is responsible for keeping the previous valid config.
 */
export function createConfigWatcher<S extends z.ZodTypeAny>(
  filePath: string,
  schema: S,
  onChange: (result: ConfigReloadResult<z.output<S>>) => void,
): WatcherHandle {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const watcher = fs.watch(filePath, () => {
    if (stopped) {
      return;
    }

    // Clear any pending debounce
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
    }

    // Debounce: wait for writes to settle (Decision #94)
    debounceTimer = setTimeout(() => {
      if (stopped) {
        return;
      }
      debounceTimer = null;

      // File deletion should be treated as an error, not silently reset to defaults.
      // This prevents accidental safety config loosening if safety.yaml is deleted.
      if (!fs.existsSync(filePath)) {
        onChange({
          ok: false,
          error: new ConfigError(
            `Config file was deleted: ${filePath}. Keeping previous config.`,
            filePath,
          ),
        });
        return;
      }

      const result = loadConfigSafe(filePath, schema);
      onChange(result);
    }, DEBOUNCE_MS);
  });

  return {
    stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      watcher.close();
    },
  };
}
