/**
 * Observation → OTLP span.
 *
 * One observation maps to exactly one span:
 * - ids: ULID-decoded (see ./ulid.ts), the root span omitting `parentSpanId`.
 * - times: ISO 8601 → unix-nanos **as strings**. An instant (observe /
 *   recordDecision / recordError, start == end) is a zero-duration span — the
 *   flame graph still shows it, it just has no width.
 * - attributes: `input`/`output` projected and sanitized (see ./attributes.ts).
 * - status: `ok` → OK, `error` → ERROR.
 */

import type { Observation } from "../../../schemas/observer.js";
import { type AttributeContext, buildAttributes } from "./attributes.js";
import { type OtlpSpan, OtlpStatusCodes } from "./types.js";
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
 */
export function mapObservationToSpan(obs: Observation, ctx: AttributeContext): OtlpSpan {
  const startTimeUnixNano = isoToUnixNano(obs.start_time);
  const endTimeUnixNano = isoToUnixNano(obs.end_time ?? obs.start_time);

  const span: OtlpSpan = {
    traceId: deriveTraceId(obs.trace_id ?? obs.id),
    spanId: deriveSpanId(obs.id),
    name: obs.name,
    startTimeUnixNano,
    endTimeUnixNano,
    attributes: buildAttributes(obs.input, obs.output, ctx),
    status: { code: obs.status === "error" ? OtlpStatusCodes.ERROR : OtlpStatusCodes.OK },
  };

  if (obs.parent_observation_id !== null) {
    span.parentSpanId = deriveSpanId(obs.parent_observation_id);
  }

  return span;
}
