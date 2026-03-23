import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createInMemoryDatabase } from "../../db/database.js";
import type { DatabaseHandle } from "../../db/database.js";
import { messagesRoutes } from "./messages.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

let dbHandle: DatabaseHandle;

function createApp() {
  const routes = messagesRoutes({ writeDb: dbHandle.db });
  return routes;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("messagesRoutes", () => {
  beforeEach(() => {
    dbHandle = createInMemoryDatabase();
  });

  afterEach(() => {
    dbHandle.close();
  });

  it("POST /:taskId/respond creates a comm.message_received event", async () => {
    const app = createApp();
    const res = await app.request("/task-1/respond", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "The answer is 42" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.eventId).toBeTruthy();

    // Verify event in DB
    const row = dbHandle.db
      .prepare("SELECT * FROM events WHERE type = ?")
      .get("comm.message_received") as {
      id: string;
      type: string;
      source: string;
      task_id: string;
      payload: string;
    };
    expect(row).toBeTruthy();
    expect(row.source).toBe("dashboard");
    expect(row.task_id).toBe("task-1");

    const payload = JSON.parse(row.payload);
    expect(payload.content).toBe("The answer is 42");
    expect(payload.source).toBe("dashboard");
    expect(payload.sender).toBe("owner");
  });

  it("rejects empty content", async () => {
    const app = createApp();
    const res = await app.request("/task-1/respond", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "" }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("content is required");
  });

  it("rejects missing content", async () => {
    const app = createApp();
    const res = await app.request("/task-1/respond", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
  });
});
