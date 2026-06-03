/**
 * OTLP/HTTP+JSON wire types — the subset of the OpenTelemetry trace protocol
 * we hand-build (no OTel SDK).
 *
 * Shapes match the OTLP/JSON encoding accepted by any OTLP/HTTP backend on
 * `<endpoint>/v1/traces` (Jaeger v2, the OTel Collector, etc.). We emit trace
 * spans only — `events` is part of the spec but unused here. `links` carries the
 * cross-trace "follows-from" edge: each task dispatch is its own bounded trace, and
 * a resumed/reworked dispatch's root links back to the previous dispatch's root so
 * the whole task lifecycle is navigable as a chain (without merging into one
 * idle-gap-dominated mega-trace).
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
  /**
   * Human-readable error description, carried only on an error status. Sourced from
   * the observation's `error_message` column and sanitized at the export boundary
   * (the same gate the attributes pass through). Omitted on an OK status.
   */
  message?: string;
}

/**
 * An OTLP span link — a reference to a span in ANOTHER trace this span follows
 * from. We use it for trace continuity: a resumed dispatch's root links to the
 * prior dispatch's root. `attributes` is part of the spec but we emit none.
 */
export interface OtlpLink {
  traceId: string;
  spanId: string;
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
  /** Cross-trace "follows-from" edges; omitted when the span has none. */
  links?: OtlpLink[];
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
