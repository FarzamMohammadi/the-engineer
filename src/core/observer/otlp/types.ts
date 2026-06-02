/**
 * OTLP/HTTP+JSON wire types — the subset of the OpenTelemetry trace protocol
 * we hand-build (no OTel SDK).
 *
 * Shapes match the OTLP/JSON encoding accepted by any OTLP/HTTP backend on
 * `<endpoint>/v1/traces` (Jaeger v2, the OTel Collector, etc.). We emit trace
 * spans only — `links` and `events` are part of the spec but unused here.
 *
 * Wire contract (the parts that bite if wrong):
 * - `traceId` / `spanId` / `parentSpanId` are case-insensitive hex (16 / 8 / 8
 *   bytes → 32 / 16 / 16 chars). See ./ulid.ts for the derivation.
 * - `startTimeUnixNano` / `endTimeUnixNano` are uint64 nanoseconds **as strings**
 *   (a JSON number would lose precision past 2^53).
 * - `attributes` is a list of `{ key, value: AnyValue }`, never a bare map.
 */

// ── Attribute Values ──────────────────────────────────────────────────────────

/** An OTLP `AnyValue`. We only emit the scalar variants the mapper produces. */
export type OtlpAnyValue =
  | { stringValue: string }
  | { intValue: string }
  | { boolValue: boolean }
  | { doubleValue: number };

/** A single OTLP key/value attribute. */
export interface OtlpKeyValue {
  key: string;
  value: OtlpAnyValue;
}

// ── Span ────────────────────────────────────────────────────────────────────

/** OTLP status codes. `UNSET` is the protocol default; we map ok → OK, error → ERROR. */
export const OtlpStatusCodes = {
  OK: "STATUS_CODE_OK",
  ERROR: "STATUS_CODE_ERROR",
} as const;
export type OtlpStatusCode = (typeof OtlpStatusCodes)[keyof typeof OtlpStatusCodes];

/** OTLP span status. */
export interface OtlpStatus {
  code: OtlpStatusCode;
}

/** A single OTLP span — one observation projected onto the wire. */
export interface OtlpSpan {
  traceId: string;
  spanId: string;
  /** Omitted for the root span of a trace (a present-but-empty value is invalid). */
  parentSpanId?: string;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpKeyValue[];
  status: OtlpStatus;
}

// ── Resource / Scope envelope ─────────────────────────────────────────────────

/** The `resource` carrying `service.name` so the backend groups our spans. */
export interface OtlpResource {
  attributes: OtlpKeyValue[];
}

/** The instrumentation scope (our exporter's identity). */
export interface OtlpScope {
  name: string;
  version: string;
}

export interface OtlpScopeSpans {
  scope: OtlpScope;
  spans: OtlpSpan[];
}

export interface OtlpResourceSpans {
  resource: OtlpResource;
  scopeSpans: OtlpScopeSpans[];
}

/** The full `/v1/traces` request body. */
export interface OtlpTracesPayload {
  resourceSpans: OtlpResourceSpans[];
}
