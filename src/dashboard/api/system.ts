/**
 * System status & health API routes.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type Database from "better-sqlite3";
import { Hono } from "hono";

import type { ObservabilityStore } from "../../core/observability/index.js";

export interface SystemRoutesDeps {
  db: Database.Database;
  observability: ObservabilityStore;
  runDir: string;
}

export function systemRoutes(deps: SystemRoutesDeps): Hono {
  const app = new Hono();

  app.get("/status", (c) => {
    const stats = deps.observability.getSystemStats();

    // Check if daemon is running via PID file
    const pidFile = join(deps.runDir, "daemon.pid");
    let daemonRunning = false;
    let daemonPid: number | null = null;

    if (existsSync(pidFile)) {
      try {
        daemonPid = Number.parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
        // Check if process exists (signal 0 doesn't kill, just checks)
        process.kill(daemonPid, 0);
        daemonRunning = true;
      } catch {
        daemonRunning = false;
        daemonPid = null;
      }
    }

    return c.json({
      daemon_running: daemonRunning,
      daemon_pid: daemonPid,
      ...stats,
    });
  });

  app.get("/health", (c) => {
    // Pull recent health events from the events table
    const rows = deps.db
      .prepare(`SELECT * FROM events WHERE type LIKE 'health.%' ORDER BY sequence DESC LIMIT 20`)
      .all() as Record<string, unknown>[];

    const events = rows.map((row) => ({
      id: row["id"],
      type: row["type"],
      source: row["source"],
      task_id: row["task_id"],
      timestamp: row["timestamp"],
      payload: JSON.parse((row["payload"] as string) || "{}"),
    }));

    return c.json({ events });
  });

  return app;
}
