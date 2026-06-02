/**
 * ULID → OTLP id derivation (the single source of truth for both the exporter
 * and the dashboard's "View trace in Jaeger" deep-link).
 *
 * A ULID is exactly 128 bits encoded as 26 Crockford base32 characters. We
 * decode it losslessly to its 16 bytes — never hash, never truncate the text
 * (a SHA-truncation throws away entropy and collides; a string `[:8]` is a
 * 32-bit collision bug). Decoding is exact and deterministic:
 *
 * - trace id  = the full 128 bits  → 16 bytes → 32 hex chars (OTLP `traceId`).
 * - span  id  = the low 64 bits    →  8 bytes → 16 hex chars (OTLP `spanId`).
 *
 * The `ulid` dependency exposes no byte decoder (only `decodeTime`), so we
 * decode the Crockford alphabet here. Both ids derive from the same decode so
 * the dashboard link and the exported span agree by construction.
 */

/** Crockford base32 alphabet, matching the `ulid` package's encoder. */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A ULID is always 26 Crockford base32 characters (128 bits). */
const ULID_LENGTH = 26;

/** Reverse lookup: Crockford char → 5-bit value. Built once. */
const CHAR_TO_VALUE: ReadonlyMap<string, number> = new Map([...CROCKFORD].map((char, index) => [char, index]));

// ── Internal decode ───────────────────────────────────────────────────────────

/**
 * Decode a ULID to its 128-bit value as a BigInt.
 *
 * Accumulates 5 bits per character (26 × 5 = 130 bits of space holding a
 * 128-bit value — the leading character contributes only 3 significant bits).
 * Case-insensitive, matching Crockford. Throws on a non-ULID input so a
 * malformed id surfaces loudly rather than producing a silently-wrong span.
 */
function decodeUlid(id: string): bigint {
  if (id.length !== ULID_LENGTH) {
    throw new Error(`Invalid ULID: expected ${ULID_LENGTH} characters, got ${id.length} ("${id}")`);
  }

  let value = 0n;
  for (const char of id.toUpperCase()) {
    const digit = CHAR_TO_VALUE.get(char);
    if (digit === undefined) {
      throw new Error(`Invalid ULID: character "${char}" is not in the Crockford base32 alphabet ("${id}")`);
    }
    value = value * 32n + BigInt(digit);
  }
  return value;
}

/** Format a BigInt as zero-padded lowercase hex of an exact byte width. */
function toHex(value: bigint, bytes: number): string {
  return value.toString(16).padStart(bytes * 2, "0");
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Derive the 32-char OTLP trace id (16 bytes hex) from a `trace_id` ULID.
 *
 * Lossless decode of the full 128 bits. Deterministic — the same ULID always
 * yields the same hex, so the dashboard deep-link and the exported span match.
 */
export function deriveTraceId(traceId: string): string {
  return toHex(decodeUlid(traceId), 16);
}

/**
 * Derive the 16-char OTLP span id (8 bytes hex) from an observation `id` ULID.
 *
 * Takes the low 64 bits of the ULID (a mask, not a text truncation), preserving
 * the random component so sibling spans within a trace stay distinct.
 */
export function deriveSpanId(obsId: string): string {
  const low64 = decodeUlid(obsId) & 0xffff_ffff_ffff_ffffn;
  return toHex(low64, 8);
}
