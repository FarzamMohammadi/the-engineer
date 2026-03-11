import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isProcessRunning, pidFilePath, readPidFile } from "./pid.js";

describe("pidFilePath", () => {
  it("returns correct path", () => {
    expect(pidFilePath("/home/user/.engineer")).toBe("/home/user/.engineer/run/engineer.pid");
  });
});

describe("readPidFile", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pid-test-"));
    mkdirSync(join(tempDir, "run"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns null when PID file does not exist", () => {
    expect(readPidFile(tempDir)).toBeNull();
  });

  it("returns PID when file contains valid number", () => {
    writeFileSync(join(tempDir, "run", "engineer.pid"), "12345\n");
    expect(readPidFile(tempDir)).toBe(12345);
  });

  it("returns null for invalid content", () => {
    writeFileSync(join(tempDir, "run", "engineer.pid"), "not-a-number");
    expect(readPidFile(tempDir)).toBeNull();
  });

  it("returns null for negative PID", () => {
    writeFileSync(join(tempDir, "run", "engineer.pid"), "-1");
    expect(readPidFile(tempDir)).toBeNull();
  });

  it("returns null for zero PID", () => {
    writeFileSync(join(tempDir, "run", "engineer.pid"), "0");
    expect(readPidFile(tempDir)).toBeNull();
  });
});

describe("isProcessRunning", () => {
  it("returns true for current process", () => {
    expect(isProcessRunning(process.pid)).toBe(true);
  });

  it("returns false for non-existent PID", () => {
    expect(isProcessRunning(99999999)).toBe(false);
  });
});
