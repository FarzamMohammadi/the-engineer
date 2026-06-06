import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ObservationStore } from "../../../../src/core/observer/index.js";
import { systemRoutes } from "../../../../src/dashboard/api/system.js";
import { createInMemoryDatabase } from "../../../../src/db/database.js";
import type { DatabaseHandle } from "../../../../src/db/database.js";

// ── Helpers ──────────────────────────────────────────────────────────────────────

/** Overwrite the single `_meta` plugin-health snapshot row (mirrors what the registry writes each cycle). */
function seedHealthSnapshot(db: Database.Database, snapshot: Record<string, unknown>): void {
  db.prepare("INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)").run(
    "plugin_health_snapshot",
    JSON.stringify(snapshot),
  );
}

const emptyStore = { query: () => [] } as unknown as ObservationStore;

function makeRoutes(db: Database.Database): ReturnType<typeof systemRoutes> {
  return systemRoutes({
    db,
    observationStore: emptyStore,
    runDir: "/tmp/does-not-exist",
    telemetryEnabled: false,
    telemetryUiBase: "http://localhost:16686",
  });
}

interface PluginHealthBody {
  records: Array<{ plugin_id: string; state: string; consecutive_failures: number; last_error: string | null }>;
  checked_at: string | null;
}

// ── Tests ────────────────────────────────────────────────────────────────────────

describe("systemRoutes — GET /plugin-health", () => {
  let handle: DatabaseHandle;
  let app: ReturnType<typeof systemRoutes>;

  beforeEach(() => {
    handle = createInMemoryDatabase();
    app = makeRoutes(handle.db);
  });

  afterEach(() => {
    handle.close();
  });

  async function getPluginHealth(): Promise<PluginHealthBody> {
    const res = await app.request("/plugin-health");
    return (await res.json()) as PluginHealthBody;
  }

  it("returns an empty, well-formed shape when no snapshot exists yet", async () => {
    const body = await getPluginHealth();

    expect(body).toEqual({ records: [], checked_at: null });
  });

  it("returns the records and updated_at from the _meta health snapshot", async () => {
    seedHealthSnapshot(handle.db, {
      records: [
        {
          plugin_id: "any-trigger",
          state: "failed",
          consecutive_failures: 3,
          last_check_at: "2026-01-15T10:29:00Z",
          last_healthy_at: "2026-01-15T09:00:00Z",
          last_error: "boom",
        },
      ],
      updated_at: "2026-01-15T10:30:00Z",
    });

    const body = await getPluginHealth();

    expect(body.records).toHaveLength(1);
    expect(body.records[0]).toMatchObject({ plugin_id: "any-trigger", state: "failed", consecutive_failures: 3 });
    // `checked_at` is the snapshot's own `updated_at` — the health loop's last-run liveness marker.
    expect(body.checked_at).toBe("2026-01-15T10:30:00Z");
  });

  it("reflects the latest state after the snapshot row is overwritten", async () => {
    // The registry overwrites the single `_meta` row each cycle, so a recovery flip replaces the prior state.
    seedHealthSnapshot(handle.db, {
      records: [{ plugin_id: "p", state: "failed", consecutive_failures: 3, last_check_at: null, last_error: "x" }],
      updated_at: "2026-01-15T10:29:00Z",
    });
    seedHealthSnapshot(handle.db, {
      records: [{ plugin_id: "p", state: "healthy", consecutive_failures: 0, last_check_at: null, last_error: null }],
      updated_at: "2026-01-15T10:30:00Z",
    });

    const body = await getPluginHealth();

    // The recovery flip is reflected: the overwritten snapshot shows healthy, not the earlier failed.
    expect(body.records[0]).toMatchObject({ plugin_id: "p", state: "healthy", consecutive_failures: 0 });
    expect(body.checked_at).toBe("2026-01-15T10:30:00Z");
  });
});
