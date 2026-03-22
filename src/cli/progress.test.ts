import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createOutput, resetOutput } from "./output.js";
import { Spinner } from "./progress.js";

let stderrWrites: string[];

beforeEach(() => {
  vi.useFakeTimers();
  stderrWrites = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    stderrWrites.push(String(chunk));
    return true;
  });
  createOutput({ mode: "human" });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetOutput();
});

// ── Spinner ──────────────────────────────────────────────────────────────────

describe("Spinner", () => {
  it("writes spinner frames to stderr on start", () => {
    const spinner = new Spinner("Loading...", false);
    spinner.start();
    vi.advanceTimersByTime(160); // 2 frames
    spinner.stop();
    expect(stderrWrites.length).toBeGreaterThanOrEqual(2);
    expect(stderrWrites.some((w) => w.includes("Loading..."))).toBe(true);
  });

  it("updates the message", () => {
    const spinner = new Spinner("first", false);
    spinner.start();
    vi.advanceTimersByTime(80);
    spinner.update("second");
    vi.advanceTimersByTime(80);
    spinner.stop();
    expect(stderrWrites.some((w) => w.includes("second"))).toBe(true);
  });

  it("succeed stops and writes green checkmark", () => {
    const spinner = new Spinner("task", false);
    spinner.start();
    vi.advanceTimersByTime(80);
    spinner.succeed("done!");
    // Should contain the success message
    const lastWrites = stderrWrites.join("");
    expect(lastWrites).toContain("✓");
    expect(lastWrites).toContain("done!");
  });

  it("fail stops and writes red cross", () => {
    const spinner = new Spinner("task", false);
    spinner.start();
    vi.advanceTimersByTime(80);
    spinner.fail("broken!");
    const lastWrites = stderrWrites.join("");
    expect(lastWrites).toContain("✗");
    expect(lastWrites).toContain("broken!");
  });

  it("stop clears the line", () => {
    const spinner = new Spinner("task", false);
    spinner.start();
    vi.advanceTimersByTime(80);
    spinner.stop();
    // Last write should be the clear sequence
    const last = stderrWrites.at(-1) ?? "";
    expect(last).toContain("\x1B[2K");
  });

  it("is silent when explicitly set", () => {
    const spinner = new Spinner("Loading...", true);
    spinner.start();
    vi.advanceTimersByTime(200);
    spinner.succeed("done");
    expect(stderrWrites).toHaveLength(0);
  });

  it("is silent in json mode", () => {
    resetOutput();
    createOutput({ mode: "json" });
    const spinner = new Spinner("Loading...");
    spinner.start();
    vi.advanceTimersByTime(200);
    spinner.succeed("done");
    expect(stderrWrites).toHaveLength(0);
  });

  it("does not double-start", () => {
    const spinner = new Spinner("task", false);
    spinner.start();
    spinner.start(); // second call should be no-op
    vi.advanceTimersByTime(80);
    spinner.stop();
    // Should still work (not throw or double-write)
    expect(stderrWrites.length).toBeGreaterThan(0);
  });

  it("succeed uses spinner message if no override", () => {
    const spinner = new Spinner("original", false);
    spinner.start();
    vi.advanceTimersByTime(80);
    spinner.succeed();
    const lastWrites = stderrWrites.join("");
    expect(lastWrites).toContain("original");
  });
});
