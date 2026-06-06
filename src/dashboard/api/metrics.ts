import type Database from "better-sqlite3";
/**
 * Cost & metrics API routes.
 */
import { Hono } from "hono";

import type { IObserver } from "../../core/observer/facade.js";
import type { ObservationStore } from "../../core/observer/index.js";
import { ObservationTypes } from "../../schemas/observer.js";
import { sanitizeErrorMessage } from "../../utils/sanitize.js";
import { aggregateAgentCost } from "./agent-cost-aggregation.js";

/** Dependencies injected into metrics API route handlers. */
export interface MetricsRoutesDeps {
  db: Database.Database;
  observationStore: ObservationStore;
  observer: IObserver;
}

/** Registers cost aggregation, quota status, and phase execution endpoints. */
export function metricsRoutes(deps: MetricsRoutesDeps): Hono {
  const app = new Hono();

  /** Cost aggregations: per task, per day, per phase — all sourced from the agent_call span's real spend. */
  app.get("/cost", (c) => {
    // Per-task cost (top 20 by spend)
    const perTask = deps.db
      .prepare(
        `SELECT id, title, agent_cost_usd, agent_tokens
         FROM tasks WHERE agent_cost_usd > 0
         ORDER BY agent_cost_usd DESC LIMIT 20`,
      )
      .all() as Record<string, unknown>[];

    // Every cost number derives from agent_call spans (the only observation that carries real per-run spend).
    const agentObs = deps.observationStore.query({ type: ObservationTypes.agent_call, limit: 50000 });
    const cost = aggregateAgentCost(agentObs);

    return c.json({
      today_spend_usd: cost.todaySpend,
      month_spend_usd: cost.monthSpend,
      per_task: perTask,
      per_day: cost.perDay,
      per_phase: cost.perPhase,
      token_totals: cost.tokenTotals,
    });
  });

  /**
   * Quota status — pure data reader. Reads the latest `quota_status` observation (emitted by the daemon's
   * periodic agent-quota poll). Cost-limit breaches surface on the errors page (via `cost.limit_reached`),
   * not here.
   *
   * Dashboard never fetches data itself. The daemon asks the plugin, Core stores it, the dashboard reads it.
   */
  app.get("/quota", (c) => {
    try {
      // Latest quota status from observations (emitted by the daemon's quota poll)
      const latestObs = deps.observationStore.query({
        type: ObservationTypes.quota_status,
        limit: 1,
      });
      // observe() stores data in `input` field (output is for span end-data only)
      const liveQuota: Record<string, unknown> | null =
        latestObs.length > 0
          ? {
              ...(latestObs[0]?.input as Record<string, unknown> | null),
              observed_at: latestObs[0]?.start_time,
            }
          : null;

      return c.json({
        available: liveQuota !== null,
        live: liveQuota,
      });
    } catch (error) {
      // A read failure here is not "no quota yet" — surface it instead of silently returning the empty
      // shape, so the observer can tell a broken reader from an idle one (Fail Loud).
      deps.observer.warn("Quota endpoint read failed — returning empty quota", {
        endpoint: "/api/metrics/quota",
        error: sanitizeErrorMessage(error),
      });
      return c.json({ available: false, live: null });
    }
  });

  /** Phase execution details. */
  app.get("/phases", (c) => {
    const taskId = c.req.query("task_id");

    if (taskId) {
      const phases = deps.observationStore.query({
        type: ObservationTypes.phase_transition,
        task_id: taskId,
        limit: 100,
      });
      return c.json({ phases });
    }

    // Recent phase observations across all tasks
    const phases = deps.observationStore.query({
      type: ObservationTypes.phase_transition,
      limit: 50,
    });
    return c.json({ phases });
  });

  return app;
}
