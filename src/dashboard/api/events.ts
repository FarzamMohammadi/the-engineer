import type Database from "better-sqlite3";
/**
 * Event stream API routes.
 */
import { Hono } from "hono";

export interface EventRoutesDeps {
  db: Database.Database;
}

export function eventRoutes(deps: EventRoutesDeps): Hono {
  const app = new Hono();

  /** Filterable event stream. Supports incremental polling via ?since=. */
  app.get("/", (c) => {
    const type = c.req.query("type");
    const taskId = c.req.query("task_id");
    const sinceStr = c.req.query("since");
    const limitStr = c.req.query("limit");
    const since = sinceStr ? Number.parseInt(sinceStr, 10) : 0;
    const limit = limitStr ? Number.parseInt(limitStr, 10) : 50;

    let query = "SELECT * FROM events WHERE sequence > ?";
    const params: Array<string | number> = [since];

    if (type) {
      query += " AND type = ?";
      params.push(type);
    }
    if (taskId) {
      query += " AND task_id = ?";
      params.push(taskId);
    }

    query += " ORDER BY sequence DESC LIMIT ?";
    params.push(limit);

    const rows = deps.db.prepare(query).all(...params) as Record<string, unknown>[];

    const events = rows.map((row) => ({
      id: row["id"],
      sequence: row["sequence"],
      type: row["type"],
      source: row["source"],
      task_id: row["task_id"],
      timestamp: row["timestamp"],
      payload: JSON.parse((row["payload"] as string) || "{}"),
    }));

    return c.json({ events, count: events.length });
  });

  return app;
}
