/**
 * The `/v1/traces` envelope: wrap spans in the OTLP resource/scope structure.
 *
 * `service.name` is the resource attribute every OTLP backend groups by — we
 * stamp `the-engineer` so all our spans land under one service in the UI. The
 * instrumentation scope identifies our hand-rolled exporter.
 */

import type { OtlpSpan, OtlpTracesPayload } from "./types.js";

/** The service all our spans belong to (the OTLP `service.name` resource attribute). */
export const SERVICE_NAME = "the-engineer";

/** The instrumentation scope name for our hand-rolled exporter. */
export const SCOPE_NAME = "the-engineer/observer";

/**
 * Wrap a batch of spans in the OTLP `resourceSpans` envelope.
 *
 * Returns an empty-but-valid payload for an empty batch (the caller decides
 * whether to POST; an empty POST is harmless). A single resource + single scope
 * is correct: every span shares the one service and the one exporter.
 */
export function buildResourceSpans(spans: readonly OtlpSpan[]): OtlpTracesPayload {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [{ key: "service.name", value: { stringValue: SERVICE_NAME } }],
        },
        scopeSpans: [
          {
            scope: { name: SCOPE_NAME, version: "1" },
            spans: [...spans],
          },
        ],
      },
    ],
  };
}
