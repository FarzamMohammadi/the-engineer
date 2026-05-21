import type Database from "better-sqlite3";

import type { StateStore } from "../../adapters/base.js";

/**
 * Create a StateStore scoped to a single plugin.
 *
 * The pluginId is baked into the closure — the plugin can never access
 * another plugin's keys. Backed by prepared statements on the
 * `plugin_state` table.
 */
export function createStateStore(db: Database.Database, pluginId: string): StateStore {
  const getStmt = db.prepare("SELECT value FROM plugin_state WHERE plugin_id = ? AND key = ?");

  const setStmt = db.prepare(
    "INSERT OR REPLACE INTO plugin_state (plugin_id, key, value, updated_at) VALUES (?, ?, ?, ?)",
  );

  const deleteStmt = db.prepare("DELETE FROM plugin_state WHERE plugin_id = ? AND key = ?");

  return {
    get(key: string): unknown {
      const row = getStmt.get(pluginId, key) as { value: string } | undefined;
      return row ? (JSON.parse(row.value) as unknown) : null;
    },

    set(key: string, value: unknown): void {
      setStmt.run(pluginId, key, JSON.stringify(value), new Date().toISOString());
    },

    delete(key: string): void {
      deleteStmt.run(pluginId, key);
    },
  };
}
