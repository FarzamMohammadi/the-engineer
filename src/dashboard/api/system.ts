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
    // Try engineer.pid first, fall back to dashboard.pid (co-hosted = same process)
    let daemonRunning = false;
    let daemonPid: number | null = null;

    for (const name of ["engineer.pid", "dashboard.pid"]) {
      const pidFile = join(deps.runDir, name);
      if (!existsSync(pidFile)) continue;
      try {
        const pid = Number.parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
        process.kill(pid, 0);
        daemonRunning = true;
        daemonPid = pid;
        break;
      } catch {
        // stale or unreadable
      }
    }

    // Detect LLM provider from traces (most recent provider_id)
    let llmProvider: string | null = null;
    try {
      const row = deps.db
        .prepare("SELECT DISTINCT provider_id FROM llm_traces ORDER BY rowid DESC LIMIT 1")
        .get() as { provider_id: string } | undefined;
      llmProvider = row?.provider_id ?? null;
    } catch {
      // table may not exist yet
    }

    return c.json({
      daemon_running: daemonRunning,
      daemon_pid: daemonPid,
      llm_provider: llmProvider,
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
