/**
 * Shared SQLite serialization utilities.
 *
 * better-sqlite3 only accepts: number, string, bigint, Buffer, null.
 * These helpers centralize the conversion between JS types and SQLite-bindable
 * values so every component uses the same safe patterns.
 */

// ── Types ──────────────────────────────────────────────────────────────────

/** SQLite column type with semantic boolean distinction. */
export type SqliteColumnType = "text" | "integer" | "boolean" | "real" | "json";

/** The value types better-sqlite3 actually accepts for parameter binding. */
export type SqliteBindable = string | number | bigint | Buffer | null;

// ── Write Side ─────────────────────────────────────────────────────────────

/**
 * Convert a JS value to a SQLite-bindable value based on column type.
 *
 * - `"json"` → JSON.stringify (null passthrough)
 * - `"boolean"` → 0 | 1 (stored as INTEGER)
 * - `"integer"` → number passthrough
 * - `"real"` → number passthrough
 * - `"text"` → string passthrough
 * - All types: null/undefined → null
 */
export function toSqlite(type: SqliteColumnType, value: unknown): SqliteBindable {
  if (value === null || value === undefined) {
    return null;
  }
  switch (type) {
    case "json":
      return JSON.stringify(value);
    case "boolean":
      return value ? 1 : 0;
    case "integer":
      return value as number;
    case "real":
      return value as number;
    case "text":
      return value as string;
    default: {
      // biome-ignore lint/style/useNamingConvention: exhaustive check sentinel
      const _exhaustive: never = type;
      throw new Error(`Unknown SQLite column type: ${_exhaustive}`);
    }
  }
}

/** Serialize a JS value as JSON for a SQLite TEXT column. Returns null for null/undefined. */
export function toSqliteJson(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return JSON.stringify(value);
}

/** Coerce a JS value to 0 or 1 for a SQLite INTEGER column. */
export function toSqliteBoolean(value: unknown): 0 | 1 {
  return value ? 1 : 0;
}

// ── Read Side ──────────────────────────────────────────────────────────────

/**
 * Deserialize a JSON string from SQLite back to a JS value.
 * Returns null for null input. Returns null on parse errors (safe default).
 */
export function fromSqliteJson<T = unknown>(raw: string | null | undefined): T | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** Convert a SQLite INTEGER (0/1) back to a JS boolean. */
export function fromSqliteBoolean(raw: number | null | undefined): boolean {
  return Boolean(raw);
}
