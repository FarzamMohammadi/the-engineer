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
import { aggregateAgentCost } from "./agent-cost-aggregation.js";

export interface SystemRoutesDeps {
  db: Database.Database;
  observationStore: ObservationStore;
  runDir: string;
  /** Whether trace export is on — gates the "View trace in Jaeger" link in the dashboard. */
  telemetryEnabled: boolean;
  /** Jaeger v2 web-UI base the link points at (distinct from the OTLP ingest endpoint). */
  telemetryUiBase: string;
}

export function systemRoutes(deps: SystemRoutesDeps): Hono {
  const app = new Hono();

  app.get("/status", (c) => {
    // Aggregate stats from observations table
    const tasksByState = deps.db.prepare("SELECT state, COUNT(*) as count FROM tasks GROUP BY state").all() as Array<{
      state: string;
      count: number;
    }>;

    const stateMap: Record<string, number> = {};
    let totalTasks = 0;
    for (const row of tasksByState) {
      stateMap[row.state] = row.count;
      totalTasks += row.count;
    }

    const actionCount = deps.db
      .prepare("SELECT COUNT(*) as count FROM observations WHERE type = 'tool_execution'")
      .get() as { count: number } | undefined;

    const agentCallCount = deps.db
      .prepare("SELECT COUNT(*) as count FROM observations WHERE type = 'agent_call'")
      .get() as { count: number } | undefined;

    // Total spend derives from agent_call spans via the shared aggregator (the same source the cost page uses, so
    // the two never disagree). It is null — not 0 — when no agent_call reported a numeric cost, so the UI shows
    // "no data" rather than a confidently-wrong $0.
    const agentObs = deps.observationStore.query({ type: ObservationTypes.agent_call, limit: 50000 });
    const totalSpend: number | null = aggregateAgentCost(agentObs).totalSpend;

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

    // Detect agent provider from observations
    let agentProvider: string | null = null;
    const recentAgent = deps.observationStore.query({ type: ObservationTypes.agent_call, limit: 1 });
    if (recentAgent.length > 0) {
      const input = recentAgent[0]?.input as Record<string, unknown> | null;
      agentProvider = (input?.["provider_id"] as string) ?? null;
    }

    return c.json({
      daemon_running: daemonRunning,
      daemon_pid: daemonPid,
      agent_provider: agentProvider,
      total_tasks: totalTasks,
      tasks_by_state: stateMap,
      total_action_traces: actionCount?.count ?? 0,
      total_agent_traces: agentCallCount?.count ?? 0,
      total_spend_usd: totalSpend,
      // Telemetry surface for the dashboard's "View trace in Jaeger" deep-link: whether export is on, and the
      // Jaeger web-UI base to point at. Static per process (config is startup-only), but carried here so the
      // client learns it from the API it already polls rather than from a second source.
      telemetry_enabled: deps.telemetryEnabled,
      telemetry_ui_base: deps.telemetryUiBase,
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

  // Current per-plugin health STATE (display-only / advisory). The registry's live `getAllHealthRecords()`
  // is in the daemon process and unreachable from this read-only dashboard process, so the registry caches a
  // full snapshot every health-check cycle in the `_meta` table (key `plugin_health_snapshot`, overwritten
  // each cycle, mirroring the cost tracker's `safety_snapshot`) — we read it back here. Distinct from `/health`
  // above, which returns the last-20 health *events* (the trail of changes); this returns the always-current
  // *state*. These records are ADVISORY: plugin selection never reads health (see the invariant test in
  // tests/unit/core/registry/index.test.ts), so this surface is purely informational.
  app.get("/plugin-health", (c) => {
    const row = deps.db.prepare(`SELECT value FROM _meta WHERE key = 'plugin_health_snapshot'`).get() as
      | { value: string }
      | undefined;

    if (!row) {
      // No snapshot yet — the daemon hasn't run a health-check cycle (or there are no plugins). Return an
      // empty, well-formed shape so the client renders "no data" rather than erroring.
      return c.json({ records: [], checked_at: null });
    }

    const snapshot = (fromSqliteJson(row.value) ?? {}) as { records?: unknown; updated_at?: unknown };

    return c.json({
      records: Array.isArray(snapshot.records) ? snapshot.records : [],
      // The snapshot's own `updated_at` doubles as the health loop's last-run liveness marker.
      checked_at: typeof snapshot.updated_at === "string" ? snapshot.updated_at : null,
    });
  });

  return app;
}
