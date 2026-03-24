import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readSessionResult, writeSessionResultTemplate } from "./session-result.js";

describe("readSessionResult", () => {
  let dir: string;

  beforeEach(() => {
    dir = path.join(
      tmpdir(),
      `session-result-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    // tmpdir cleanup is OS-managed; no explicit removal needed for test dirs
  });

  it("returns null when file does not exist", () => {
    expect(readSessionResult(dir)).toBeNull();
  });

  it("returns parsed SessionResult for valid JSON", () => {
    writeFileSync(
      path.join(dir, "session-result.json"),
      JSON.stringify({ status: "ready", next_phase: "research", summary: "done" }),
    );
    const result = readSessionResult(dir);
    expect(result).toEqual({ status: "ready", next_phase: "research", summary: "done" });
  });

  it('returns "invalid" for malformed JSON', () => {
    writeFileSync(path.join(dir, "session-result.json"), "not valid json {{{");
    expect(readSessionResult(dir)).toBe("invalid");
  });

  it('returns "invalid" for valid JSON that fails schema validation', () => {
    writeFileSync(
      path.join(dir, "session-result.json"),
      JSON.stringify({ status: "unknown_status", next_phase: "research", summary: "" }),
    );
    expect(readSessionResult(dir)).toBe("invalid");
  });

  it('returns "invalid" for template placeholders', () => {
    // writeSessionResultTemplate writes placeholder strings that don't match enums
    writeSessionResultTemplate(dir);
    expect(readSessionResult(dir)).toBe("invalid");
  });

  it("returns parsed result for need_more_info status", () => {
    writeFileSync(
      path.join(dir, "session-result.json"),
      JSON.stringify({
        status: "need_more_info",
        next_phase: "requirements_gathering",
        summary: "need clarification",
      }),
    );
    const result = readSessionResult(dir);
    expect(result).toEqual({
      status: "need_more_info",
      next_phase: "requirements_gathering",
      summary: "need clarification",
    });
  });
});
