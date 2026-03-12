/**
 * Trace detail API routes — action traces, LLM traces, blob content.
 */
import { Hono } from "hono";

import type { ObservabilityStore } from "../../core/observability/index.js";

export interface TraceRoutesDeps {
  observability: ObservabilityStore;
}

export function traceRoutes(deps: TraceRoutesDeps): Hono {
  const app = new Hono();

  /** Get action traces for a task, optional phase filter. */
  app.get("/:taskId", (c) => {
    const taskId = c.req.param("taskId");
    const phase = c.req.query("phase");
    const traces = deps.observability.getActionTraces(taskId, phase);
    return c.json({ traces });
  });

  /** Get action traces for a specific phase of a task. */
  app.get("/:taskId/:phase", (c) => {
    const taskId = c.req.param("taskId");
    const phase = c.req.param("phase");
    const actionTraces = deps.observability.getActionTraces(taskId, phase);
    const llmTraces = deps.observability.getLlmTraces(taskId, phase);
    return c.json({ action_traces: actionTraces, llm_traces: llmTraces });
  });

  return app;
}

export interface BlobRoutesDeps {
  observability: ObservabilityStore;
}

export function blobRoutes(deps: BlobRoutesDeps): Hono {
  const app = new Hono();

  /** Fetch full LLM prompt or response content from blob store. */
  app.get("/:prefix/:hash", (c) => {
    const prefix = c.req.param("prefix");
    const hash = c.req.param("hash");
    const ref = `${prefix}/${hash}`;

    const content = deps.observability.readBlob(ref);
    if (content === null) {
      return c.json({ error: "Blob not found" }, 404);
    }

    return c.text(content);
  });

  return app;
}
