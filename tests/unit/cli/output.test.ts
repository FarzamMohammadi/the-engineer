import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Output, createOutput, getOutput, resetOutput } from "../../../src/cli/output.js";

// Capture stdout/stderr writes
let stdoutWrites: string[];
let stderrWrites: string[];

beforeEach(() => {
  stdoutWrites = [];
  stderrWrites = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    stdoutWrites.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    stderrWrites.push(String(chunk));
    return true;
  });
  resetOutput();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetOutput();
  // Clean env vars
  for (const key of ["NO_COLOR", "FORCE_COLOR"]) {
    delete process.env[key];
  }
});

// ── Mode Detection ───────────────────────────────────────────────────────────

describe("mode detection", () => {
  it("defaults to human mode", () => {
    const out = new Output();
    expect(out.mode).toBe("human");
  });

  it("respects explicit json mode", () => {
    const out = new Output({ mode: "json" });
    expect(out.mode).toBe("json");
  });

  it("respects explicit quiet mode", () => {
    const out = new Output({ mode: "quiet" });
    expect(out.mode).toBe("quiet");
  });
});

// ── Color Detection ──────────────────────────────────────────────────────────

describe("color detection", () => {
  it("disables color when NO_COLOR is set", () => {
    process.env["NO_COLOR"] = "1";
    const out = new Output();
    expect(out.color).toBe(false);
  });

  it("disables color when NO_COLOR is empty string", () => {
    process.env["NO_COLOR"] = "";
    const out = new Output();
    expect(out.color).toBe(false);
  });

  it("enables color when FORCE_COLOR is set", () => {
    process.env["FORCE_COLOR"] = "1";
    const out = new Output();
    expect(out.color).toBe(true);
  });

  it("FORCE_COLOR is overridden by NO_COLOR", () => {
    process.env["NO_COLOR"] = "1";
    process.env["FORCE_COLOR"] = "1";
    const out = new Output();
    expect(out.color).toBe(false);
  });

  it("respects explicit color override", () => {
    process.env["NO_COLOR"] = "1";
    const out = new Output({ color: true });
    expect(out.color).toBe(true);
  });
});

// ── Human Mode Output ────────────────────────────────────────────────────────

describe("human mode", () => {
  it("log writes to stdout", () => {
    const out = new Output({ mode: "human", color: false });
    out.log("hello world");
    expect(stdoutWrites.join("")).toContain("hello world");
  });

  it("success writes green checkmark to stdout", () => {
    const out = new Output({ mode: "human", color: false });
    out.success("done");
    const output = stdoutWrites.join("");
    expect(output).toContain("✓");
    expect(output).toContain("done");
  });

  it("warn writes yellow warning to stdout", () => {
    const out = new Output({ mode: "human", color: false });
    out.warn("caution");
    const output = stdoutWrites.join("");
    expect(output).toContain("⚠");
    expect(output).toContain("caution");
  });

  it("error writes red cross to stderr", () => {
    const out = new Output({ mode: "human", color: false });
    out.error("failed");
    const output = stderrWrites.join("");
    expect(output).toContain("✗");
    expect(output).toContain("failed");
    expect(stdoutWrites).toHaveLength(0);
  });

  it("heading writes bold text to stdout", () => {
    const out = new Output({ mode: "human", color: false });
    out.heading("Title");
    expect(stdoutWrites.join("")).toContain("Title");
  });

  it("keyValue writes aligned pair to stdout", () => {
    const out = new Output({ mode: "human", color: false });
    out.keyValue("Status", "running");
    const output = stdoutWrites.join("");
    expect(output).toContain("Status:");
    expect(output).toContain("running");
  });

  it("blank writes empty line to stdout", () => {
    const out = new Output({ mode: "human", color: false });
    out.blank();
    expect(stdoutWrites).toEqual(["\n"]);
  });

  it("data writes formatted JSON to stdout", () => {
    const out = new Output({ mode: "human", color: false });
    out.data({ key: "value" });
    const output = stdoutWrites.join("");
    expect(JSON.parse(output)).toEqual({ key: "value" });
  });
});

// ── JSON Mode Output ─────────────────────────────────────────────────────────

describe("json mode", () => {
  it("log is no-op", () => {
    const out = new Output({ mode: "json" });
    out.log("hello");
    expect(stdoutWrites).toHaveLength(0);
  });

  it("success is no-op", () => {
    const out = new Output({ mode: "json" });
    out.success("done");
    expect(stdoutWrites).toHaveLength(0);
  });

  it("warn is no-op", () => {
    const out = new Output({ mode: "json" });
    out.warn("caution");
    expect(stdoutWrites).toHaveLength(0);
  });

  it("error writes structured JSON to stderr", () => {
    const out = new Output({ mode: "json" });
    out.error("something failed");
    const output = stderrWrites.join("");
    const parsed = JSON.parse(output);
    expect(parsed).toEqual({ error: "something failed" });
  });

  it("heading is no-op", () => {
    const out = new Output({ mode: "json" });
    out.heading("Title");
    expect(stdoutWrites).toHaveLength(0);
  });

  it("keyValue is no-op", () => {
    const out = new Output({ mode: "json" });
    out.keyValue("k", "v");
    expect(stdoutWrites).toHaveLength(0);
  });

  it("blank is no-op", () => {
    const out = new Output({ mode: "json" });
    out.blank();
    expect(stdoutWrites).toHaveLength(0);
  });

  it("data writes valid JSON to stdout", () => {
    const out = new Output({ mode: "json" });
    out.data({ running: true, pid: 1234 });
    const output = stdoutWrites.join("");
    const parsed = JSON.parse(output);
    expect(parsed).toEqual({ running: true, pid: 1234 });
  });

  it("table is no-op", () => {
    const out = new Output({ mode: "json" });
    out.table([{ a: "1", b: "2" }]);
    expect(stdoutWrites).toHaveLength(0);
  });
});

// ── Quiet Mode Output ────────────────────────────────────────────────────────

describe("quiet mode", () => {
  it("log is no-op", () => {
    const out = new Output({ mode: "quiet" });
    out.log("hello");
    expect(stdoutWrites).toHaveLength(0);
  });

  it("success is no-op", () => {
    const out = new Output({ mode: "quiet" });
    out.success("done");
    expect(stdoutWrites).toHaveLength(0);
  });

  it("warn is no-op", () => {
    const out = new Output({ mode: "quiet" });
    out.warn("caution");
    expect(stdoutWrites).toHaveLength(0);
  });

  it("error writes to stderr", () => {
    const out = new Output({ mode: "quiet", color: false });
    out.error("failed");
    const output = stderrWrites.join("");
    expect(output).toContain("failed");
  });

  it("data is no-op", () => {
    const out = new Output({ mode: "quiet" });
    out.data({ key: "value" });
    expect(stdoutWrites).toHaveLength(0);
  });

  it("blank is no-op", () => {
    const out = new Output({ mode: "quiet" });
    out.blank();
    expect(stdoutWrites).toHaveLength(0);
  });
});

// ── Table Formatting ─────────────────────────────────────────────────────────

describe("table", () => {
  it("formats aligned columns", () => {
    const out = new Output({ mode: "human", color: false });
    out.table([
      { name: "alice", score: 100 },
      { name: "bob", score: 42 },
    ]);
    const output = stdoutWrites.join("");
    expect(output).toContain("name");
    expect(output).toContain("score");
    expect(output).toContain("alice");
    expect(output).toContain("bob");
    expect(output).toContain("100");
    expect(output).toContain("42");
  });

  it("handles empty rows", () => {
    const out = new Output({ mode: "human", color: false });
    out.table([]);
    expect(stdoutWrites).toHaveLength(0);
  });
});

// ── Singleton ────────────────────────────────────────────────────────────────

describe("singleton", () => {
  it("createOutput sets the singleton", () => {
    const out = createOutput({ mode: "json" });
    expect(getOutput()).toBe(out);
    expect(getOutput().mode).toBe("json");
  });

  it("getOutput creates default if not initialized", () => {
    const out = getOutput();
    expect(out.mode).toBe("human");
  });

  it("resetOutput clears the singleton", () => {
    const first = createOutput({ mode: "json" });
    resetOutput();
    const second = getOutput();
    expect(second).not.toBe(first);
    expect(second.mode).toBe("human");
  });
});
