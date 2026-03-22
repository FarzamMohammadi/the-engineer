/**
 * Generic observations query API route — exposes all 13 observation types.
 */
import { Hono } from "hono";

import type { ObservationStore } from "../../core/observer/index.js";
import type { ObservationLevel, ObservationTypeValue } from "../../schemas/observer.js";

export interface ObservationRoutesDeps {
  observationStore: ObservationStore;
}

export function observationRoutes(deps: ObservationRoutesDeps): Hono {
  const app = new Hono();

  /** Query observations with filters. Supports all 13 observation types. */
  app.get("/", (c) => {
    const type = c.req.query("type");
    const taskId = c.req.query("task_id");
    const traceId = c.req.query("trace_id");
    const phase = c.req.query("phase");
    const since = c.req.query("since");
    const level = c.req.query("level");
    const limitStr = c.req.query("limit");
    const limit = limitStr ? Number.parseInt(limitStr, 10) : 200;

    const observations = deps.observationStore.query({
      type: (type || undefined) as ObservationTypeValue | undefined,
      task_id: taskId || undefined,
      trace_id: traceId || undefined,
      phase: phase || undefined,
      since: since || undefined,
      level: (level || undefined) as ObservationLevel | undefined,
      limit,
    });

    return c.json({ observations, count: observations.length });
  });

  return app;
}
