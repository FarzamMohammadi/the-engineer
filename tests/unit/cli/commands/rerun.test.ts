import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runRerun } from "../../../../src/cli/commands/rerun.js";
import { createOutput, resetOutput } from "../../../../src/cli/output.js";
import { createDatabase } from "../../../../src/db/database.js";
import { TaskStates } from "../../../../src/schemas/task.js";

let tempDir: string;
let stdoutWrites: string[];
let stderrWrites: string[];

beforeEach(() => {
  tempDir = join(tmpdir(), `rerun-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tempDir, "data"), { recursive: true });

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

  createOutput({ mode: "human", color: false });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  resetOutput();
});

/** Mark the daemon "running" by writing this live test process's PID to the pid file (process.kill(pid, 0) passes). */
function markDaemonRunning(): void {
  mkdirSync(join(tempDir, "run"), { recursive: true });
  writeFileSync(join(tempDir, "run", "engineer.pid"), String(process.pid));
}

function insertTask(
  db: import("better-sqlite3").Database,
  id: string,
  state: string,
  reapedAt: string | null = null,
): void {
  db.prepare(
    `INSERT INTO tasks (id, idempotency_key, state, priority, title, description, created_at, last_transition_at,
       agent_tokens, agent_cost_usd, reaped_at)
     VALUES (?, ?, ?, 50, 'Test task', '', '2026-01-15T10:30:00Z', '2026-01-15T10:30:00Z', 0, 0, ?)`,
  ).run(id, `test:${id}`, state, reapedAt);
}

/** A reaped cancelled task — the only kind `engineer rerun` accepts (its work is gone, so it cannot be resumed). */
const REAPED_AT = "2026-01-16T09:00:00Z";

describe("runRerun", () => {
  it("returns 1 when the database does not exist", () => {
    const code = runRerun(tempDir, "nonexistent-task");
    expect(code).toBe(1);
    expect(stderrWrites.join("")).toContain("No database found");
  });

  it("returns 1 when the daemon is not running", () => {
    const handle = createDatabase(join(tempDir, "data", "engineer.db"));
    insertTask(handle.db, "task-cancelled", TaskStates.cancelled);
    handle.close();

    const code = runRerun(tempDir, "task-cancelled");
    expect(code).toBe(1);
    expect(stderrWrites.join("")).toContain("daemon is not running");
  });

  it("writes a task.rerun_requested event for a reaped cancelled task when the daemon is running", () => {
    markDaemonRunning();
    const handle = createDatabase(join(tempDir, "data", "engineer.db"));
    insertTask(handle.db, "task-cancelled", TaskStates.cancelled, REAPED_AT);

    const code = runRerun(tempDir, "task-cancelled");
    expect(code).toBe(0);

    const event = handle.db
      .prepare("SELECT type, source, task_id, payload FROM events WHERE task_id = ?")
      .get("task-cancelled") as { type: string; source: string; task_id: string; payload: string };
    expect(event.type).toBe("task.rerun_requested");
    expect(event.source).toBe("cli");
    expect(JSON.parse(event.payload)).toEqual({ task_id: "task-cancelled" });
    expect(stdoutWrites.join("")).toContain("Re-run requested");
    handle.close();
  });

  it("rejects a task that is not cancelled, writing no event", () => {
    markDaemonRunning();
    const handle = createDatabase(join(tempDir, "data", "engineer.db"));
    insertTask(handle.db, "task-failed", TaskStates.failed);

    const code = runRerun(tempDir, "task-failed");
    expect(code).toBe(1);
    expect(stderrWrites.join("")).toContain("Only a cancelled task can be re-run");

    const count = handle.db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number };
    expect(count.n).toBe(0);
    handle.close();
  });

  it("rejects an unreaped cancelled task (still resumable) and points to retry, writing no event", () => {
    markDaemonRunning();
    const handle = createDatabase(join(tempDir, "data", "engineer.db"));
    insertTask(handle.db, "task-unreaped", TaskStates.cancelled, null);

    const code = runRerun(tempDir, "task-unreaped");
    expect(code).toBe(1);
    expect(stderrWrites.join("")).toContain("can still be resumed");
    expect(stderrWrites.join("")).toContain("engineer retry");

    const count = handle.db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number };
    expect(count.n).toBe(0);
    handle.close();
  });

  it("returns 1 when the task is not found", () => {
    markDaemonRunning();
    const handle = createDatabase(join(tempDir, "data", "engineer.db"));
    handle.close();

    const code = runRerun(tempDir, "ghost");
    expect(code).toBe(1);
    expect(stderrWrites.join("")).toContain("Task not found");
  });

  it("resolves a task by ID prefix", () => {
    markDaemonRunning();
    const handle = createDatabase(join(tempDir, "data", "engineer.db"));
    insertTask(handle.db, "01HXYZ1234567890ABCDEFGHIJ", TaskStates.cancelled, REAPED_AT);

    const code = runRerun(tempDir, "01HXYZ12");
    expect(code).toBe(0);
    expect(stdoutWrites.join("")).toContain("Re-run requested");
    handle.close();
  });
});
