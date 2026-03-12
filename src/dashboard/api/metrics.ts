import type Database from "better-sqlite3";
/**
 * Cost & metrics API routes.
 */
import { Hono } from "hono";

import type { ObservabilityStore } from "../../core/observability/index.js";

export interface MetricsRoutesDeps {
  db: Database.Database;
  observability: ObservabilityStore;
}

export function metricsRoutes(deps: MetricsRoutesDeps): Hono {
  const app = new Hono();

  /** Cost aggregations: per task, per day, per phase. */
  app.get("/cost", (c) => {
    // Per-task cost (top 20 by spend)
    const perTask = deps.db
      .prepare(
        `SELECT id, title, llm_cost_usd, llm_tokens
         FROM tasks WHERE llm_cost_usd > 0
         ORDER BY llm_cost_usd DESC LIMIT 20`,
      )
      .all() as Record<string, unknown>[];

    // Per-day cost from phase_metrics
    const perDay = deps.db
      .prepare(
        `SELECT DATE(started_at) as day,
                SUM(spend_usd) as spend_usd,
                SUM(tokens_in) as tokens_in,
                SUM(tokens_out) as tokens_out
         FROM phase_metrics
         WHERE spend_usd IS NOT NULL
         GROUP BY DATE(started_at)
         ORDER BY day DESC
         LIMIT 30`,
      )
      .all() as Record<string, unknown>[];

    // Per-phase cost aggregate (across all tasks)
    const perPhase = deps.db
      .prepare(
        `SELECT phase,
                SUM(spend_usd) as spend_usd,
                SUM(tokens_in) as tokens_in,
                SUM(tokens_out) as tokens_out,
                SUM(llm_iterations) as llm_iterations,
                COUNT(*) as executions
         FROM phase_metrics
         WHERE spend_usd IS NOT NULL
         GROUP BY phase
         ORDER BY spend_usd DESC`,
      )
      .all() as Record<string, unknown>[];

    // Today's total
    const todayRow = deps.db
      .prepare(
        `SELECT COALESCE(SUM(spend_usd), 0) as spend
         FROM phase_metrics
         WHERE DATE(started_at) = DATE('now')`,
      )
      .get() as { spend: number };

    // Monthly total
    const monthRow = deps.db
      .prepare(
        `SELECT COALESCE(SUM(spend_usd), 0) as spend
         FROM phase_metrics
         WHERE strftime('%Y-%m', started_at) = strftime('%Y-%m', 'now')`,
      )
      .get() as { spend: number };

    return c.json({
      today_spend_usd: todayRow.spend,
      month_spend_usd: monthRow.spend,
      per_task: perTask,
      per_day: perDay,
      per_phase: perPhase,
    });
  });

  /** Phase execution details. */
  app.get("/phases", (c) => {
    const taskId = c.req.query("task_id");

    if (taskId) {
      const metrics = deps.observability.getPhaseMetrics(taskId);
      return c.json({ phases: metrics });
    }

    // Recent phase metrics across all tasks
    const rows = deps.db
      .prepare("SELECT * FROM phase_metrics ORDER BY started_at DESC LIMIT 50")
      .all() as Record<string, unknown>[];

    return c.json({ phases: rows });
  });

  return app;
}
