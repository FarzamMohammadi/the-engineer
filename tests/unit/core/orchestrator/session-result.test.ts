import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  backupSessionResult,
  readSessionResult,
  writeSessionResultTemplate,
} from "../../../../src/core/orchestrator/session-result.js";
import { Complexities, Phases } from "../../../../src/schemas/orchestrator.js";

describe("readSessionResult", () => {
  let dir: string;

  beforeEach(() => {
    dir = path.join(tmpdir(), `session-result-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
      JSON.stringify({ status: "ready", next_phase: Phases.research, summary: "done" }),
    );
    const result = readSessionResult(dir);
    expect(result).toEqual({
      status: "ready",
      next_phase: Phases.research,
      summary: "done",
      complexity: Complexities.moderate,
    });
  });

  it('returns "invalid" for malformed JSON', () => {
    writeFileSync(path.join(dir, "session-result.json"), "not valid json {{{");
    expect(readSessionResult(dir)).toBe("invalid");
  });

  it('returns "invalid" for valid JSON that fails schema validation', () => {
    writeFileSync(
      path.join(dir, "session-result.json"),
      JSON.stringify({ status: "unknown_status", next_phase: Phases.research, summary: "" }),
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
        next_phase: Phases.requirements_gathering,
        summary: "need clarification",
      }),
    );
    const result = readSessionResult(dir);
    expect(result).toEqual({
      status: "need_more_info",
      next_phase: Phases.requirements_gathering,
      summary: "need clarification",
      complexity: Complexities.moderate,
    });
  });
});

describe("backupSessionResult", () => {
  let dir: string;

  beforeEach(() => {
    dir = path.join(tmpdir(), `session-result-backup-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
  });

  function getBakFiles(): string[] {
    return readdirSync(dir).filter((f) => f.endsWith(".json.bak"));
  }

  it("does nothing when file does not exist", () => {
    backupSessionResult(dir);
    expect(getBakFiles()).toHaveLength(0);
  });

  it("skips backup when file is an unfilled template", () => {
    writeSessionResultTemplate(dir);
    backupSessionResult(dir);
    expect(getBakFiles()).toHaveLength(0);
    // Original template still in place
    expect(existsSync(path.join(dir, "session-result.json"))).toBe(true);
  });

  it("skips backup for corrupt JSON", () => {
    writeFileSync(path.join(dir, "session-result.json"), "not valid json {{{");
    backupSessionResult(dir);
    expect(getBakFiles()).toHaveLength(0);
  });

  it("backs up valid result and writes fresh template", () => {
    const validResult = { status: "ready", next_phase: Phases.research, summary: "done" };
    writeFileSync(path.join(dir, "session-result.json"), JSON.stringify(validResult));

    backupSessionResult(dir);

    // .bak created with old content
    const bakFiles = getBakFiles();
    expect(bakFiles).toHaveLength(1);
    const bakContent = JSON.parse(readFileSync(path.join(dir, bakFiles[0]!), "utf-8"));
    expect(bakContent).toEqual(validResult);

    // session-result.json reset to template (invalid)
    expect(readSessionResult(dir)).toBe("invalid");
  });
});
