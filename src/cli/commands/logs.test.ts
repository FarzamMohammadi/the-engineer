import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runLogs } from "./logs.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "logs-test-"));
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("runLogs", () => {
  it("returns 0 when no log file exists", () => {
    const code = runLogs(tempDir, { json: false, lines: 50, follow: false });
    expect(code).toBe(0);
  });

  it("reads and outputs log lines in JSON mode", () => {
    const logsDir = join(tempDir, "logs");
    mkdirSync(logsDir, { recursive: true });
    const logLines = [
      '{"level":30,"time":1000,"msg":"line1"}',
      '{"level":30,"time":2000,"msg":"line2"}',
      '{"level":30,"time":3000,"msg":"line3"}',
    ];
    writeFileSync(join(logsDir, "engineer.log"), logLines.join("\n"), "utf8");

    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(String(args[0]));
    });

    const code = runLogs(tempDir, { json: true, lines: 2, follow: false });
    expect(code).toBe(0);
    // Should show last 2 lines
    expect(logged).toHaveLength(2);
    expect(logged[0]).toContain("line2");
    expect(logged[1]).toContain("line3");
  });

  it("respects --lines option", () => {
    const logsDir = join(tempDir, "logs");
    mkdirSync(logsDir, { recursive: true });
    const lines = Array.from({ length: 10 }, (_, i) => `{"level":30,"msg":"line${i}"}`);
    writeFileSync(join(logsDir, "engineer.log"), lines.join("\n"), "utf8");

    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(String(args[0]));
    });

    runLogs(tempDir, { json: true, lines: 3, follow: false });
    expect(logged).toHaveLength(3);
  });
});
