/**
 * Observation → OTLP span.
 *
 * One observation maps to exactly one span:
 * - ids: ULID-decoded (see ./ulid.ts), the root span omitting `parentSpanId`.
 * - times: ISO 8601 → unix-nanos **as strings**. An instant (observe /
 *   recordDecision / recordError, start == end) — and any span that opens and
 *   closes within the same millisecond — has a zero-width duration. We floor the
 *   end to start + 1µs so the flame graph still shows it AND the backend never
 *   flags a "negative duration" (Jaeger sanitizes ≤0-width spans, one warning per
 *   span otherwise). The floor is 1µs, not 1ns: Jaeger measures duration in
 *   microseconds, so a 1ns width truncates back to 0µs. 1µs is imperceptible, so
 *   an instant still reads as instant.
 * - attributes: `input`/`output` projected and sanitized (see ./attributes.ts).
 * - status: `ok` → OK, `error` → ERROR. An error span also carries the sanitized
 *   `error_message` (stored only in that column, not in input/output) as
 *   `status.message`, so the backend shows WHY a span failed.
 */

import { sanitizeSecrets } from "../../../utils/sanitize.js";

import type { Observation } from "../../../schemas/observer.js";
import { type AttributeContext, buildAttributes } from "./attributes.js";
import { type OtlpLink, type OtlpSpan, type OtlpStatus, OtlpStatusCodes } from "./types.js";
import { deriveSpanId, deriveTraceId } from "./ulid.js";

/** Nanoseconds per millisecond — ISO times carry millisecond precision. */
const NANOS_PER_MS = 1_000_000n;

/**
 * Convert an ISO 8601 timestamp to unix-nanos.
 *
 * `Date.parse` yields integer milliseconds; we widen to nanos with BigInt so
 * the value never loses precision the way a JSON number would past 2^53.
 */
function isoToNanos(iso: string): bigint {
  const millis = Date.parse(iso);
  if (Number.isNaN(millis)) {
    throw new Error(`Invalid ISO timestamp: "${iso}"`);
  }
  return BigInt(millis) * NANOS_PER_MS;
}

/**
 * Map an observation to an OTLP span.
 *
 * `end_time` may be null for a still-open span; we fall back to `start_time`
 * (a closed or instant observation always has it set). The root span of a
 * trace has no `parent_observation_id`, so `parentSpanId` is omitted entirely
 * (an empty parent id is invalid OTLP).
 *
 * An UNTRACED observation (`trace_id` null) becomes its own single-span trace
 * (traceId derived from its own id). It must be a clean ROOT: we omit
 * `parentSpanId` even if it carries a `parent_observation_id`, because that
 * parent lives in a DIFFERENT trace — pointing at it would dangle the link at a
 * span id absent from this trace.
 */
export function mapObservationToSpan(obs: Observation, ctx: AttributeContext): OtlpSpan {
  const startNanos = isoToNanos(obs.start_time);
  // Floor the end to at least 1µs after the start. An instant (start == end), and any span that opens
  // and closes within the same millisecond, is zero-width — which OTLP backends flag as a "negative
  // duration" and silently sanitize, one warning per span. The floor must be 1µs, NOT 1ns: Jaeger's
  // duration unit is microseconds (it divides the OTLP nanos by 1000), so a 1ns width truncates back to
  // 0µs and the warning returns. 1µs is the smallest width that survives that conversion as non-zero,
  // and is imperceptible — an instant still reads as instant.
  const MIN_SPAN_NANOS = 1_000n; // 1µs — see above; smaller floors truncate to 0µs in the backend.
  const rawEndNanos = isoToNanos(obs.end_time ?? obs.start_time);
  const endNanos = rawEndNanos - startNanos >= MIN_SPAN_NANOS ? rawEndNanos : startNanos + MIN_SPAN_NANOS;
  const startTimeUnixNano = startNanos.toString();
  const endTimeUnixNano = endNanos.toString();

  // `error_message` lives only in its own column (never input/output), so without
  // this it would never reach the wire — an error span with no reason. Sanitize via
  // the same path the attributes use, since a message can echo a secret.
  const status: OtlpStatus =
    obs.status === "error"
      ? {
          code: OtlpStatusCodes.ERROR,
          ...(obs.error_message != null ? { message: sanitizeSecrets(obs.error_message) } : {}),
        }
      : { code: OtlpStatusCodes.OK };

  const span: OtlpSpan = {
    traceId: deriveTraceId(obs.trace_id ?? obs.id),
    spanId: deriveSpanId(obs.id),
    name: obs.name,
    startTimeUnixNano,
    endTimeUnixNano,
    attributes: buildAttributes(obs.input, obs.output, ctx),
    status,
  };

  // Only link to a parent when this span shares a trace with it. An untraced
  // observation (trace_id null) is its own root, so its parent — which lives in a
  // different trace — must NOT become a dangling parentSpanId.
  if (obs.parent_observation_id !== null && obs.trace_id !== null) {
    span.parentSpanId = deriveSpanId(obs.parent_observation_id);
  }

  // Cross-trace "follows-from" edges (trace continuity across dispatches). Each link
  // targets a span in ANOTHER trace, so the ids derive from the link's own
  // trace_id/observation_id — independent of this span's trace.
  if (obs.links !== null && obs.links.length > 0) {
    span.links = obs.links.map(
      (link): OtlpLink => ({ traceId: deriveTraceId(link.trace_id), spanId: deriveSpanId(link.observation_id) }),
    );
  }

  return span;
}
