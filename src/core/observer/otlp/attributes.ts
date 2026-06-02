/**
 * Observation `input`/`output` → typed OTLP attributes.
 *
 * The export boundary, where two invariants live:
 *
 * 1. SANITIZE every stringified value. The observer facade does NOT sanitize
 *    `input`/`output`, so a secret could otherwise ride into an attribute and,
 *    against a remote endpoint, off-box. We scrub here, the last gate before
 *    the wire.
 * 2. Blob refs are NEVER inlined. Large agent prompts/responses live as a blob
 *    reference (`prompt_ref` / `response_ref`, value `aa/<sha256>`) inside the
 *    payload; we emit an attribute carrying the dashboard blob URL instead, so
 *    a span stays small (OTLP rejects oversized payloads) and the drill-down
 *    points back at the system of record.
 *
 * The always-null `metadata` column is dropped entirely (dead on the wire).
 */

import { sanitizeSecrets } from "../../../utils/sanitize.js";
import type { OtlpKeyValue } from "./types.js";

/** Keys whose values are blob references, replaced by a dashboard URL attribute. */
const BLOB_REF_KEYS = ["prompt_ref", "response_ref"] as const;

/** A blob ref is `<2-hex-prefix>/<64-hex-sha256>` (see blob-store.ts). */
const BLOB_REF_PATTERN = /^[a-f0-9]{2}\/[a-f0-9]{64}$/;

/** Context the attribute mapper needs but cannot derive purely. */
export interface AttributeContext {
  /** Dashboard base URL (e.g. `http://127.0.0.1:3847`), no trailing slash. */
  dashboardBaseUrl: string;
}

// ── Scalar projection ───────────────────────────────────────────────────────

/**
 * Project one JS value onto a typed OTLP `AnyValue`, sanitizing every string.
 *
 * Integers and finite non-integers map to `intValue`/`doubleValue`; booleans to
 * `boolValue`; everything else (objects, arrays, null/undefined nested values)
 * is JSON-stringified, then sanitized, into a `stringValue`.
 */
function toAttributeValue(value: unknown): OtlpKeyValue["value"] {
  if (typeof value === "string") {
    return { stringValue: sanitizeSecrets(value) };
  }
  if (typeof value === "boolean") {
    return { boolValue: value };
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    // OTLP `intValue` is a stringified int64; doubles stay JSON numbers.
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  }
  // Objects, arrays, null, NaN/Infinity: stringify then sanitize.
  return { stringValue: sanitizeSecrets(JSON.stringify(value)) };
}

/** Build a `<dashboardBaseUrl>/api/blob/<ref>` URL for a blob reference. */
function blobUrl(baseUrl: string, ref: string): string {
  return `${baseUrl}/api/blob/${ref}`;
}

/** A blob-ref key carrying a well-formed ref value. */
function isBlobRef(rawKey: string, value: unknown): value is string {
  return (
    (BLOB_REF_KEYS as readonly string[]).includes(rawKey) && typeof value === "string" && BLOB_REF_PATTERN.test(value)
  );
}

/**
 * Map one namespaced key/value entry to an OTLP attribute, with the blob-ref
 * special case.
 *
 * `rawKey` is the un-namespaced source key (e.g. `prompt_ref`) used only for
 * blob-ref detection; `key` is the namespaced attribute key (e.g.
 * `input.prompt_ref`) that lands on the wire. A blob ref becomes a URL
 * attribute (`<key>.url`) instead of the inlined ref string.
 */
function entryToAttribute(rawKey: string, key: string, value: unknown, ctx: AttributeContext): OtlpKeyValue {
  if (isBlobRef(rawKey, value)) {
    return { key: `${key}.url`, value: { stringValue: blobUrl(ctx.dashboardBaseUrl, value) } };
  }
  return { key, value: toAttributeValue(value) };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Project an observation's `input` and `output` records into OTLP attributes.
 *
 * `input.*` and `output.*` are namespaced so they never collide. Null records
 * (and the always-null `metadata`) contribute nothing. Every stringified value
 * is sanitized; blob refs become dashboard URLs, never inlined content.
 */
export function buildAttributes(
  input: Record<string, unknown> | null,
  output: Record<string, unknown> | null,
  ctx: AttributeContext,
): OtlpKeyValue[] {
  const attributes: OtlpKeyValue[] = [];

  for (const [key, value] of Object.entries(input ?? {})) {
    attributes.push(entryToAttribute(key, `input.${key}`, value, ctx));
  }
  for (const [key, value] of Object.entries(output ?? {})) {
    attributes.push(entryToAttribute(key, `output.${key}`, value, ctx));
  }

  return attributes;
}
