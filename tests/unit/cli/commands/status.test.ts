import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runStatus } from "../../../../src/cli/commands/status.js";
import { createOutput, resetOutput } from "../../../../src/cli/output.js";
import { createDatabase } from "../../../../src/db/database.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "status-test-"));
  mkdirSync(join(tempDir, "run"), { recursive: true });
  createOutput({ mode: "quiet" });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  resetOutput();
  vi.restoreAllMocks();
});

describe("runStatus", () => {
  it("shows stopped when no PID file exists", () => {
    const code = runStatus(tempDir);
    expect(code).toBe(0);
  });

  it("shows stopped when PID file points to dead process", () => {
    writeFileSync(join(tempDir, "run", "engineer.pid"), "99999999\n");
    const code = runStatus(tempDir);
    expect(code).toBe(0);
  });

  it("shows task summary when database exists", () => {
    const dbPath = join(tempDir, "data", "engineer.db");
    const handle = createDatabase(dbPath);
    handle.close();

    const code = runStatus(tempDir);
    expect(code).toBe(0);
  });

  it("handles database with tasks", () => {
    const dbPath = join(tempDir, "data", "engineer.db");
    const handle = createDatabase(dbPath);
    // Insert a test task
    handle.db
      .prepare(`
      INSERT INTO tasks (id, title, priority, state, sub_state, created_at, last_transition_at)
      VALUES ('task_1', 'Test task', 50, 'queued', NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
    `)
      .run();
    handle.close();

    const code = runStatus(tempDir);
    expect(code).toBe(0);
  });
});
