/**
 * OTLP/JSON projection — pure (no I/O) mapping of observations onto the
 * OpenTelemetry trace wire format.
 *
 * This module owns wire correctness so the exporter (live POSTs) and the
 * dashboard (deep-link) share one derivation and never drift:
 * - `deriveTraceId` / `deriveSpanId` — the ULID-decoded ids (imported by BOTH
 *   the exporter and the dashboard's "View trace in Jaeger" link).
 * - `mapObservationToSpan` — one observation → one OTLP span.
 * - `buildResourceSpans` — the `/v1/traces` request envelope.
 *
 * No subscriptions, no HTTP, no SQLite — feed it observations, get JSON.
 */

// ── Id derivation (shared SSOT for exporter + dashboard) ──────────────────────

export { deriveSpanId, deriveTraceId } from "./ulid.js";

// ── Projection ────────────────────────────────────────────────────────────────

export { buildAttributes } from "./attributes.js";
export type { AttributeContext } from "./attributes.js";
export { mapObservationToSpan } from "./span.js";
export { buildResourceSpans, HOST_NAME, SCOPE_NAME, SERVICE_NAME } from "./resource.js";

// ── Wire types ────────────────────────────────────────────────────────────────

export { OtlpStatusCodes } from "./types.js";
export type {
  OtlpAnyValue,
  OtlpKeyValue,
  OtlpResourceSpans,
  OtlpSpan,
  OtlpStatus,
  OtlpStatusCode,
  OtlpTracesPayload,
} from "./types.js";
