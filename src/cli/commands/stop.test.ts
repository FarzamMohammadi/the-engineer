import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runStop, waitForProcessExit } from "./stop.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "stop-test-"));
  mkdirSync(join(tempDir, "run"), { recursive: true });
  // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op to suppress console in tests
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("runStop", () => {
  it("returns 0 when no PID file exists", async () => {
    const code = await runStop(tempDir, 1000);
    expect(code).toBe(0);
  });

  it("returns 0 when PID file points to dead process", async () => {
    writeFileSync(join(tempDir, "run", "engineer.pid"), "99999999\n");
    const code = await runStop(tempDir, 1000);
    expect(code).toBe(0);
  });
});

describe("waitForProcessExit", () => {
  it("returns true immediately for non-existent process", async () => {
    const exited = await waitForProcessExit(99999999, 1000);
    expect(exited).toBe(true);
  });
});
