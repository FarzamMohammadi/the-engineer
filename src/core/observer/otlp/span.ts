/**
 * Observation → OTLP span.
 *
 * One observation maps to exactly one span:
 * - ids: ULID-decoded (see ./ulid.ts), the root span omitting `parentSpanId`.
 * - times: ISO 8601 → unix-nanos **as strings**. An instant (observe /
 *   recordDecision / recordError, start == end) is a zero-duration span — the
 *   flame graph still shows it, it just has no width.
 * - attributes: `input`/`output` projected and sanitized (see ./attributes.ts).
 * - status: `ok` → OK, `error` → ERROR. An error span also carries the sanitized
 *   `error_message` (stored only in that column, not in input/output) as
 *   `status.message`, so the backend shows WHY a span failed.
 */

import { sanitizeSecrets } from "../../../utils/sanitize.js";

import type { Observation } from "../../../schemas/observer.js";
import { type AttributeContext, buildAttributes } from "./attributes.js";
import { type OtlpSpan, type OtlpStatus, OtlpStatusCodes } from "./types.js";
import { deriveSpanId, deriveTraceId } from "./ulid.js";

/** Nanoseconds per millisecond — ISO times carry millisecond precision. */
const NANOS_PER_MS = 1_000_000n;

/**
 * Convert an ISO 8601 timestamp to unix-nanos as a decimal string.
 *
 * `Date.parse` yields integer milliseconds; we widen to nanos with BigInt so
 * the value never loses precision the way a JSON number would past 2^53.
 */
function isoToUnixNano(iso: string): string {
  const millis = Date.parse(iso);
  if (Number.isNaN(millis)) {
    throw new Error(`Invalid ISO timestamp: "${iso}"`);
  }
  return (BigInt(millis) * NANOS_PER_MS).toString();
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
  const startTimeUnixNano = isoToUnixNano(obs.start_time);
  const endTimeUnixNano = isoToUnixNano(obs.end_time ?? obs.start_time);

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

  return span;
}
