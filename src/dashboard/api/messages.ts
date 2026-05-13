import type Database from "better-sqlite3";
import { Hono } from "hono";
/**
 * Dashboard messages API — allows the owner to respond to blocked tasks.
 *
 * Writes a `comm.message_received` event directly to the events table.
 * The Daemon polls for these events and calls the UnblockResolver.
 */
import { ulid } from "ulid";
import { toSqliteJson } from "../../db/serialize.js";

/** Dependencies injected into messages API route handlers. */
export interface MessagesRoutesDeps {
  /** Writable DB connection (separate from the read-only main connection). */
  writeDb: Database.Database;
}

/** Registers the endpoint for owner responses to blocked tasks via the dashboard. */
export function messagesRoutes(deps: MessagesRoutesDeps): Hono {
  const app = new Hono();

  /**
   * POST /api/messages/:taskId/respond
   *
   * Owner responds to a blocked task through the dashboard.
   * Writes a comm.message_received event so the Daemon can process it.
   */
  app.post("/:taskId/respond", async (c) => {
    const taskId = c.req.param("taskId");
    const body = await c.req.json<{ content?: string }>().catch(() => ({ content: undefined }));
    const content = body.content;

    if (!content || typeof content !== "string" || content.trim().length === 0) {
      return c.json({ error: "content is required" }, 400);
    }

    const eventId = ulid();
    const now = new Date().toISOString();
    const payload = toSqliteJson({
      source: "dashboard",
      sender: "owner",
      content: content.trim(),
      reply_to: null,
      task_id: taskId,
      platform_metadata: {},
    });

    try {
      deps.writeDb
        .prepare(
          `INSERT INTO events (id, type, source, task_id, timestamp, payload)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(eventId, "comm.message_received", "dashboard", taskId, now, payload);

      return c.json({ success: true, eventId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, 500);
    }
  });

  return app;
}
