import { describe, expect, it } from "vitest";
import {
  fromSqliteBoolean,
  fromSqliteJson,
  toSqlite,
  toSqliteBoolean,
  toSqliteJson,
} from "./serialize.js";

describe("SQLite serialization", () => {
  // ── toSqlite ─────────────────────────────────────────────────────────

  describe("toSqlite", () => {
    it("returns null for null input regardless of type", () => {
      expect(toSqlite("text", null)).toBeNull();
      expect(toSqlite("integer", null)).toBeNull();
      expect(toSqlite("boolean", null)).toBeNull();
      expect(toSqlite("real", null)).toBeNull();
      expect(toSqlite("json", null)).toBeNull();
    });

    it("returns null for undefined input regardless of type", () => {
      expect(toSqlite("text", undefined)).toBeNull();
      expect(toSqlite("integer", undefined)).toBeNull();
      expect(toSqlite("json", undefined)).toBeNull();
    });

    it("passes text values through as strings", () => {
      expect(toSqlite("text", "hello")).toBe("hello");
      expect(toSqlite("text", "")).toBe("");
    });

    it("passes integer values through as numbers", () => {
      expect(toSqlite("integer", 42)).toBe(42);
      expect(toSqlite("integer", 0)).toBe(0);
    });

    it("passes real values through as numbers", () => {
      expect(toSqlite("real", 3.14)).toBe(3.14);
    });

    it("coerces booleans to 0/1 for boolean type", () => {
      expect(toSqlite("boolean", true)).toBe(1);
      expect(toSqlite("boolean", false)).toBe(0);
    });

    it("JSON-stringifies objects for json type", () => {
      expect(toSqlite("json", { a: 1 })).toBe('{"a":1}');
      expect(toSqlite("json", [1, 2, 3])).toBe("[1,2,3]");
      expect(toSqlite("json", "text")).toBe('"text"');
    });
  });

  // ── toSqliteJson ─────────────────────────────────────────────────────

  describe("toSqliteJson", () => {
    it("stringifies objects", () => {
      expect(toSqliteJson({ key: "value" })).toBe('{"key":"value"}');
    });

    it("stringifies arrays", () => {
      expect(toSqliteJson(["a", "b"])).toBe('["a","b"]');
    });

    it("returns null for null", () => {
      expect(toSqliteJson(null)).toBeNull();
    });

    it("returns null for undefined", () => {
      expect(toSqliteJson(undefined)).toBeNull();
    });

    it("stringifies empty structures", () => {
      expect(toSqliteJson({})).toBe("{}");
      expect(toSqliteJson([])).toBe("[]");
    });
  });

  // ── toSqliteBoolean ──────────────────────────────────────────────────

  describe("toSqliteBoolean", () => {
    it("converts true to 1", () => {
      expect(toSqliteBoolean(true)).toBe(1);
    });

    it("converts false to 0", () => {
      expect(toSqliteBoolean(false)).toBe(0);
    });

    it("coerces truthy values to 1", () => {
      expect(toSqliteBoolean(1)).toBe(1);
      expect(toSqliteBoolean("yes")).toBe(1);
    });

    it("coerces falsy values to 0", () => {
      expect(toSqliteBoolean(0)).toBe(0);
      expect(toSqliteBoolean("")).toBe(0);
      expect(toSqliteBoolean(null)).toBe(0);
    });
  });

  // ── fromSqliteJson ───────────────────────────────────────────────────

  describe("fromSqliteJson", () => {
    it("parses JSON strings to objects", () => {
      expect(fromSqliteJson<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
    });

    it("parses JSON arrays", () => {
      expect(fromSqliteJson<string[]>('["a","b"]')).toEqual(["a", "b"]);
    });

    it("returns null for null input", () => {
      expect(fromSqliteJson(null)).toBeNull();
    });

    it("returns null for undefined input", () => {
      expect(fromSqliteJson(undefined)).toBeNull();
    });

    it("returns null on malformed JSON", () => {
      expect(fromSqliteJson("{bad json}")).toBeNull();
    });

    it("round-trips with toSqliteJson", () => {
      const original = { nested: { array: [1, 2, 3] }, flag: true };
      const serialized = toSqliteJson(original);
      const deserialized = fromSqliteJson<typeof original>(serialized);
      expect(deserialized).toEqual(original);
    });
  });

  // ── fromSqliteBoolean ────────────────────────────────────────────────

  describe("fromSqliteBoolean", () => {
    it("converts 1 to true", () => {
      expect(fromSqliteBoolean(1)).toBe(true);
    });

    it("converts 0 to false", () => {
      expect(fromSqliteBoolean(0)).toBe(false);
    });

    it("converts null to false", () => {
      expect(fromSqliteBoolean(null)).toBe(false);
    });

    it("converts undefined to false", () => {
      expect(fromSqliteBoolean(undefined)).toBe(false);
    });

    it("round-trips with toSqliteBoolean", () => {
      expect(fromSqliteBoolean(toSqliteBoolean(true))).toBe(true);
      expect(fromSqliteBoolean(toSqliteBoolean(false))).toBe(false);
    });
  });
});
