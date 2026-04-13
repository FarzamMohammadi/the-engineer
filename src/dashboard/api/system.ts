/**
 * System status & health API routes.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type Database from "better-sqlite3";
import { Hono } from "hono";

import type { ObservationStore } from "../../core/observer/index.js";
import { fromSqliteJson } from "../../db/serialize.js";
import { ObservationTypes } from "../../schemas/observer.js";

export interface SystemRoutesDeps {
  db: Database.Database;
  observationStore: ObservationStore;
  runDir: string;
}

export function systemRoutes(deps: SystemRoutesDeps): Hono {
  const app = new Hono();

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: aggregation + PID check logic
  app.get("/status", (c) => {
    // Aggregate stats from observations table
    const tasksByState = deps.db
      .prepare("SELECT state, COUNT(*) as count FROM tasks GROUP BY state")
      .all() as Array<{ state: string; count: number }>;

    const stateMap: Record<string, number> = {};
    let totalTasks = 0;
    for (const row of tasksByState) {
      stateMap[row.state] = row.count;
      totalTasks += row.count;
    }

    const actionCount = deps.db
      .prepare("SELECT COUNT(*) as count FROM observations WHERE type = 'tool_execution'")
      .get() as { count: number } | undefined;

    const llmCount = deps.db
      .prepare("SELECT COUNT(*) as count FROM observations WHERE type = 'llm_call'")
      .get() as { count: number } | undefined;

    // Sum spend from phase_transition observations (stored in output JSON)
    const phaseObs = deps.observationStore.query({
      type: ObservationTypes.phase_transition,
      limit: 10000,
    });
    let totalSpend: number | null = null;
    for (const obs of phaseObs) {
      const output = obs.output as Record<string, unknown> | null;
      if (output && typeof output["spend_usd"] === "number") {
        totalSpend = (totalSpend ?? 0) + output["spend_usd"];
      }
    }

    // Check if daemon is running via PID file
    let daemonRunning = false;
    let daemonPid: number | null = null;

    for (const name of ["engineer.pid", "dashboard.pid"]) {
      const pidFile = join(deps.runDir, name);
      if (!existsSync(pidFile)) {
        continue;
      }
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

    // Detect LLM provider from observations
    let llmProvider: string | null = null;
    const recentLlm = deps.observationStore.query({ type: ObservationTypes.llm_call, limit: 1 });
    if (recentLlm.length > 0) {
      const input = recentLlm[0]?.input as Record<string, unknown> | null;
      llmProvider = (input?.["provider_id"] as string) ?? null;
    }

    return c.json({
      daemon_running: daemonRunning,
      daemon_pid: daemonPid,
      llm_provider: llmProvider,
      total_tasks: totalTasks,
      tasks_by_state: stateMap,
      total_action_traces: actionCount?.count ?? 0,
      total_llm_traces: llmCount?.count ?? 0,
      total_spend_usd: totalSpend,
    });
  });

  app.get("/health", (c) => {
    const rows = deps.db
      .prepare(`SELECT * FROM events WHERE type LIKE 'health.%' ORDER BY sequence DESC LIMIT 20`)
      .all() as Record<string, unknown>[];

    const events = rows.map((row) => ({
      id: row["id"],
      type: row["type"],
      source: row["source"],
      task_id: row["task_id"],
      timestamp: row["timestamp"],
      payload: fromSqliteJson(row["payload"] as string | null) ?? {},
    }));

    return c.json({ events });
  });

  return app;
}
