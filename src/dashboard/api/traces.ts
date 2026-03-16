/**
 * Trace detail API routes — action observations, LLM observations, blob content.
 */
import { Hono } from "hono";

import type { ObservationStore } from "../../core/observer/index.js";

export interface TraceRoutesDeps {
  observationStore: ObservationStore;
}

export function traceRoutes(deps: TraceRoutesDeps): Hono {
  const app = new Hono();

  /** Get action observations for a task, optional phase filter. */
  app.get("/:taskId", (c) => {
    const taskId = c.req.param("taskId");
    const phase = c.req.query("phase");
    const traces = deps.observationStore.query({
      type: "tool_execution",
      task_id: taskId,
      phase: phase ?? undefined,
      limit: 1000,
    });
    return c.json({ traces });
  });

  /** Get action + LLM observations for a specific phase of a task. */
  app.get("/:taskId/:phase", (c) => {
    const taskId = c.req.param("taskId");
    const phase = c.req.param("phase");
    const actionTraces = deps.observationStore.query({
      type: "tool_execution",
      task_id: taskId,
      phase,
      limit: 1000,
    });
    const llmTraces = deps.observationStore.query({
      type: "llm_call",
      task_id: taskId,
      phase,
      limit: 1000,
    });
    return c.json({ action_traces: actionTraces, llm_traces: llmTraces });
  });

  return app;
}

export interface BlobRoutesDeps {
  observationStore: ObservationStore;
}

export function blobRoutes(deps: BlobRoutesDeps): Hono {
  const app = new Hono();

  /** Fetch full LLM prompt or response content from blob store. */
  app.get("/:prefix/:hash", (c) => {
    const prefix = c.req.param("prefix");
    const hash = c.req.param("hash");
    const ref = `${prefix}/${hash}`;

    const content = deps.observationStore.readBlob(ref);
    if (content === null) {
      return c.json({ error: "Blob not found" }, 404);
    }

    return c.text(content);
  });

  return app;
}
