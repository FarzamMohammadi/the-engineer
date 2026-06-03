import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ObservationStore } from "../../../../src/core/observer/index.js";
import { errorRoutes } from "../../../../src/dashboard/api/errors.js";
import { createInMemoryDatabase } from "../../../../src/db/database.js";
import type { DatabaseHandle } from "../../../../src/db/database.js";

// ── Helpers ──────────────────────────────────────────────────────────────────────

/** Insert an event row with a JSON payload. */
function insertEvent(
  db: Database.Database,
  id: string,
  sequence: number,
  type: string,
  payload: Record<string, unknown>,
  taskId: string | null = null,
): void {
  db.prepare(
    `INSERT INTO events (id, sequence, type, source, task_id, timestamp, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, sequence, type, "test", taskId, "2026-01-15T10:30:00Z", JSON.stringify(payload));
}

// collectObservationErrors goes through the store; the event-source tests want it empty so the asserted
// errors come only from the events table.
const emptyStore = { query: () => [] } as unknown as ObservationStore;

// ── Tests ────────────────────────────────────────────────────────────────────────

describe("errorRoutes — GET / error events", () => {
  let handle: DatabaseHandle;
  let app: ReturnType<typeof errorRoutes>;

  beforeEach(() => {
    handle = createInMemoryDatabase();
    app = errorRoutes({ db: handle.db, observationStore: emptyStore });
  });

  afterEach(() => {
    handle.close();
  });

  async function listErrors(): Promise<Record<string, unknown>[]> {
    const res = await app.request("/");
    const body = (await res.json()) as { errors: Record<string, unknown>[] };
    return body.errors;
  }

  it("surfaces the real error-bearing event types", async () => {
    insertEvent(handle.db, "e1", 1, "cost.quota_exhausted", { provider_id: "anthropic", window_type: "daily" });
    insertEvent(handle.db, "e2", 2, "health.plugin_failed", {
      plugin_id: "github",
      plugin_type: "trigger",
      error: "boom",
    });
    insertEvent(handle.db, "e3", 3, "health.plugin_unhealthy", {
      plugin_id: "telegram",
      plugin_type: "comm",
      error: "slow",
    });
    insertEvent(handle.db, "e4", 4, "timeout.alert", { task_id: "t1", escalation: "owner" }, "t1");

    const errors = await listErrors();
    const detailTypes = errors.map((e) => e["detail"]).sort();

    expect(detailTypes).toEqual([
      "cost.quota_exhausted",
      "health.plugin_failed",
      "health.plugin_unhealthy",
      "timeout.alert",
    ]);
  });

  it("does not query the removed (non-existent) event types", async () => {
    // The old query named task.failed and health.check_failed — neither is a real EventType. Rows of those
    // types should never surface (and in practice can never be written), so the event source is empty here.
    insertEvent(handle.db, "stale1", 1, "task.failed", { reason: "should not appear" });
    insertEvent(handle.db, "stale2", 2, "health.check_failed", { reason: "should not appear" });

    expect(await listErrors()).toEqual([]);
  });

  it("derives a human message from the payload's cause key, falling back to the event type", async () => {
    insertEvent(handle.db, "msg1", 1, "health.plugin_failed", {
      plugin_id: "github",
      plugin_type: "trigger",
      error: "auth expired",
    });
    insertEvent(handle.db, "msg2", 2, "timeout.alert", { task_id: "t1", escalation: "paged owner" }, "t1");
    insertEvent(handle.db, "msg3", 3, "cost.quota_exhausted", { provider_id: "anthropic", window_type: "daily" });

    const errors = await listErrors();
    const byType = new Map(errors.map((e) => [e["detail"] as string, e["message"] as string]));

    expect(byType.get("health.plugin_failed")).toBe("auth expired");
    expect(byType.get("timeout.alert")).toBe("paged owner");
    // No prose carrier on the payload — falls back to the event type.
    expect(byType.get("cost.quota_exhausted")).toBe("cost.quota_exhausted");
  });
});
