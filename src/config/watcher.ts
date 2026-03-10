import fs from "node:fs";

import type { z } from "zod";

import type { ConfigReloadResult } from "./loader.js";
import { loadConfigSafe } from "./loader.js";

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

    // Debounce: wait 500ms for writes to settle
    debounceTimer = setTimeout(() => {
      if (stopped) {
        return;
      }
      debounceTimer = null;
      const result = loadConfigSafe(filePath, schema);
      onChange(result);
    }, 500);
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
