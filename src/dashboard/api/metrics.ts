import type Database from "better-sqlite3";
/**
 * Cost & metrics API routes.
 */
import { Hono } from "hono";

import type { ObservationStore } from "../../core/observer/index.js";
import { fromSqliteJson } from "../../db/serialize.js";
import { ObservationTypes } from "../../schemas/observer.js";

/** Dependencies injected into metrics API route handlers. */
export interface MetricsRoutesDeps {
  db: Database.Database;
  observationStore: ObservationStore;
}

/** Registers cost aggregation, quota status, and phase execution endpoints. */
export function metricsRoutes(deps: MetricsRoutesDeps): Hono {
  const app = new Hono();

  /** Cost aggregations: per task, per day, per phase. */
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: aggregation logic is inherently branchy
  app.get("/cost", (c) => {
    // Per-task cost (top 20 by spend)
    const perTask = deps.db
      .prepare(
        `SELECT id, title, llm_cost_usd, llm_tokens
         FROM tasks WHERE llm_cost_usd > 0
         ORDER BY llm_cost_usd DESC LIMIT 20`,
      )
      .all() as Record<string, unknown>[];

    // Aggregate cost from phase_transition observations
    const phaseObs = deps.observationStore.query({
      type: ObservationTypes.phase_transition,
      limit: 10000,
    });

    // Per-day cost
    const dayMap = new Map<string, { spend_usd: number; duration_ms: number }>();
    // Per-phase cost
    const phaseMap = new Map<
      string,
      {
        spend_usd: number;
        duration_ms: number;
        llm_iterations: number;
        executions: number;
      }
    >();
    let todaySpend = 0;
    let monthSpend = 0;

    const today = new Date().toISOString().slice(0, 10);
    const month = new Date().toISOString().slice(0, 7);

    for (const obs of phaseObs) {
      const output = obs.output as Record<string, unknown> | null;
      if (!output) {
        continue;
      }
      const spend = typeof output["spend_usd"] === "number" ? output["spend_usd"] : 0;
      const durationMs = typeof output["duration_ms"] === "number" ? output["duration_ms"] : 0;
      const llmIter = typeof output["llm_iterations"] === "number" ? output["llm_iterations"] : 0;

      if (spend === 0) {
        continue;
      }

      // Per-day
      const day = obs.start_time.slice(0, 10);
      const dayEntry = dayMap.get(day) ?? { spend_usd: 0, duration_ms: 0 };
      dayEntry.spend_usd += spend;
      dayEntry.duration_ms += durationMs;
      dayMap.set(day, dayEntry);

      // Per-phase
      const phaseName = obs.name;
      const phaseEntry = phaseMap.get(phaseName) ?? {
        spend_usd: 0,
        duration_ms: 0,
        llm_iterations: 0,
        executions: 0,
      };
      phaseEntry.spend_usd += spend;
      phaseEntry.duration_ms += durationMs;
      phaseEntry.llm_iterations += llmIter;
      phaseEntry.executions += 1;
      phaseMap.set(phaseName, phaseEntry);

      // Today / month
      if (day === today) {
        todaySpend += spend;
      }
      if (obs.start_time.slice(0, 7) === month) {
        monthSpend += spend;
      }
    }

    const perDay = [...dayMap.entries()]
      .map(([day, v]) => ({ day, ...v }))
      .sort((a, b) => b.day.localeCompare(a.day))
      .slice(0, 30);

    const perPhase = [...phaseMap.entries()]
      .map(([phase, v]) => ({ phase, ...v }))
      .sort((a, b) => b.spend_usd - a.spend_usd);

    // Aggregate token totals from llm_call observations
    const llmObs = deps.observationStore.query({ type: ObservationTypes.llm_call, limit: 50000 });
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheReadTokens = 0;

    for (const obs of llmObs) {
      // observe() stores data in `input`; span.end() stores in `output`. Check both.
      const out = (obs.output ?? obs.input) as Record<string, unknown> | null;
      if (!out) {
        continue;
      }
      if (typeof out["input_tokens"] === "number") {
        totalInputTokens += out["input_tokens"];
      } else if (typeof out["tokens_in"] === "number") {
        totalInputTokens += out["tokens_in"];
      }
      if (typeof out["output_tokens"] === "number") {
        totalOutputTokens += out["output_tokens"];
      } else if (typeof out["tokens_out"] === "number") {
        totalOutputTokens += out["tokens_out"];
      }
      if (typeof out["cache_read_tokens"] === "number") {
        totalCacheReadTokens += out["cache_read_tokens"];
      }
    }

    return c.json({
      today_spend_usd: todaySpend,
      month_spend_usd: monthSpend,
      per_task: perTask,
      per_day: perDay,
      per_phase: perPhase,
      token_totals: {
        input: totalInputTokens,
        output: totalOutputTokens,
        cache_read: totalCacheReadTokens,
        total: totalInputTokens + totalOutputTokens,
      },
    });
  });

  /**
   * Quota status — pure data reader. Reads from:
   * 1. quota_status observations (written by Core after each LLM call + daemon polling)
   * 2. cost.quota_exhausted events (hard limit breaches)
   *
   * Dashboard never fetches data itself. Plugin gets it, Core stores it, dashboard reads it.
   */
  app.get("/quota", (c) => {
    try {
      // Latest quota status from observations (written by orchestrator + daemon)
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

      // Recent exhaustion events (hard limit breaches)
      let exhaustionEvents: Record<string, unknown>[] = [];
      try {
        const rows = deps.db
          .prepare(
            `SELECT payload, timestamp FROM events
             WHERE type = 'cost.quota_exhausted'
             ORDER BY sequence DESC LIMIT 10`,
          )
          .all() as { payload: string; timestamp: string }[];

        exhaustionEvents = rows.map((row) => {
          const p = fromSqliteJson<Record<string, unknown>>(row.payload) ?? {};
          return { ...p, observed_at: row.timestamp };
        });
      } catch {
        // events table may not exist yet
      }

      return c.json({
        available: liveQuota !== null || exhaustionEvents.length > 0,
        live: liveQuota,
        exhaustion_events: exhaustionEvents,
      });
    } catch {
      return c.json({ available: false, live: null, exhaustion_events: [] });
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
