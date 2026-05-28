import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runLogs } from "../../../../src/cli/commands/logs.js";
import { resetOutput } from "../../../../src/cli/output.js";

let tempDir: string;
let stdoutLines: string[];

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "logs-test-"));
  stdoutLines = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    stdoutLines.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  resetOutput();
});

describe("runLogs", () => {
  it("returns 0 when no log file exists", () => {
    const code = runLogs(tempDir, { raw: false, lines: 50, follow: false });
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

    const code = runLogs(tempDir, { raw: true, lines: 2, follow: false });
    expect(code).toBe(0);

    // Each raw line is written as `${line}\n` — should show last 2
    const joined = stdoutLines.join("");
    expect(joined).toContain("line2");
    expect(joined).toContain("line3");
    expect(joined).not.toContain("line1");
  });

  it("finds pino-roll numbered log files (engineer.1.log)", () => {
    const logsDir = join(tempDir, "logs");
    mkdirSync(logsDir, { recursive: true });
    const logLines = ['{"level":30,"msg":"from-numbered"}'];
    writeFileSync(join(logsDir, "engineer.1.log"), logLines.join("\n"), "utf8");

    const code = runLogs(tempDir, { raw: true, lines: 50, follow: false });
    expect(code).toBe(0);

    const joined = stdoutLines.join("");
    expect(joined).toContain("from-numbered");
  });

  it("respects --lines option", () => {
    const logsDir = join(tempDir, "logs");
    mkdirSync(logsDir, { recursive: true });
    const lines = Array.from({ length: 10 }, (_, i) => `{"level":30,"msg":"line${i}"}`);
    writeFileSync(join(logsDir, "engineer.log"), lines.join("\n"), "utf8");

    runLogs(tempDir, { raw: true, lines: 3, follow: false });

    const written = stdoutLines.filter((line) => line.includes('"msg":"line'));
    expect(written).toHaveLength(3);
  });
});
