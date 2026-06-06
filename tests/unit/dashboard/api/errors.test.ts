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
    insertEvent(handle.db, "e1", 1, "cost.limit_reached", {
      task_id: null,
      limit_type: "daily",
      limit_scope: null,
      current_spend: 52.4,
      limit_value: 50,
    });
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
      "cost.limit_reached",
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

    const errors = await listErrors();
    const byType = new Map(errors.map((e) => [e["detail"] as string, e["message"] as string]));

    expect(byType.get("health.plugin_failed")).toBe("auth expired");
    expect(byType.get("timeout.alert")).toBe("paged owner");
  });

  it("renders a USD cost.limit_reached breach with its spend and limit dollars, not the bare type", async () => {
    // A daily/monthly/per-task breach has no limit_scope; current_spend and limit_value are dollars.
    insertEvent(handle.db, "usd1", 1, "cost.limit_reached", {
      task_id: null,
      limit_type: "monthly",
      limit_scope: null,
      current_spend: 512.5,
      limit_value: 500,
    });

    const errors = await listErrors();
    const message = errors.find((e) => e["detail"] === "cost.limit_reached")?.["message"];

    expect(message).toBe("monthly cost limit reached: $512.5 of $500");
    // Not the bare token.
    expect(message).not.toBe("cost.limit_reached");
  });

  it("renders a provider cost.limit_reached breach as a request-count cap, not dollars", async () => {
    // A provider breach carries limit_scope (the provider id); current_spend and limit_value are daily
    // request counts, not USD — so the message must not prefix them with a dollar sign.
    insertEvent(handle.db, "prov1", 1, "cost.limit_reached", {
      task_id: "t-prov",
      limit_type: "daily",
      limit_scope: "claude-code-agent",
      current_spend: 200,
      limit_value: 200,
    });

    const errors = await listErrors();
    const message = errors.find((e) => e["detail"] === "cost.limit_reached")?.["message"];

    expect(message).toBe("claude-code-agent daily request cap reached: 200 of 200");
    expect(message).not.toContain("$");
  });
});
