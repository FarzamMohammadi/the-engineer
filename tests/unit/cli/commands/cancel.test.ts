import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runCancel } from "../../../../src/cli/commands/cancel.js";
import { createOutput, resetOutput } from "../../../../src/cli/output.js";
import { createDatabase } from "../../../../src/db/database.js";
import { SubStates, TaskStates } from "../../../../src/schemas/task.js";

let tempDir: string;
let stdoutWrites: string[];
let stderrWrites: string[];

beforeEach(() => {
  tempDir = join(tmpdir(), `cancel-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

function insertTask(
  db: import("better-sqlite3").Database,
  id: string,
  state: string,
  subState: string | null = null,
): void {
  db.prepare(
    `INSERT INTO tasks (id, idempotency_key, state, sub_state, priority, title, created_at, last_transition_at)
     VALUES (?, ?, ?, ?, 50, 'Test task', '2026-01-15T10:30:00Z', '2026-01-15T10:30:00Z')`,
  ).run(id, `test:${id}`, state, subState);
}

describe("runCancel", () => {
  it("returns 1 when the database does not exist", () => {
    const code = runCancel(tempDir, "nonexistent-task");
    expect(code).toBe(1);
    expect(stderrWrites.join("")).toContain("No database found");
  });

  it("returns 1 when the task is not found", () => {
    const dbPath = join(tempDir, "data", "engineer.db");
    createDatabase(dbPath).close();

    const code = runCancel(tempDir, "nonexistent-task");
    expect(code).toBe(1);
    expect(stderrWrites.join("")).toContain("Task not found");
  });

  // The CLI opens the DB directly (no daemon, no bootstrap) — these all run with the daemon stopped.
  it("cancels a running task — transitions to cancelled, bumps version, writes an audit row", () => {
    const dbPath = join(tempDir, "data", "engineer.db");
    const handle = createDatabase(dbPath);
    insertTask(handle.db, "task-active", TaskStates.active, SubStates.working);

    const code = runCancel(tempDir, "task-active");
    expect(code).toBe(0);

    const row = handle.db.prepare("SELECT state, sub_state, version FROM tasks WHERE id = ?").get("task-active") as {
      state: string;
      sub_state: string | null;
      version: number;
    };
    expect(row.state).toBe(TaskStates.cancelled);
    expect(row.sub_state).toBeNull();
    expect(row.version).toBe(2);

    const transition = handle.db
      .prepare("SELECT from_state, to_state, reason, triggered_by FROM state_transitions WHERE task_id = ?")
      .get("task-active") as { from_state: string; to_state: string; reason: string; triggered_by: string };
    expect(transition.from_state).toBe(TaskStates.active);
    expect(transition.to_state).toBe(TaskStates.cancelled);
    expect(transition.reason).toBe("cli_cancel");
    expect(transition.triggered_by).toBe("cli");

    expect(stdoutWrites.join("")).toContain("moved from active to cancelled");
    handle.close();
  });

  it("cancels a blocked task", () => {
    const dbPath = join(tempDir, "data", "engineer.db");
    const handle = createDatabase(dbPath);
    insertTask(handle.db, "task-blocked", TaskStates.blocked);

    expect(runCancel(tempDir, "task-blocked")).toBe(0);
    expect(
      (handle.db.prepare("SELECT state FROM tasks WHERE id = ?").get("task-blocked") as { state: string }).state,
    ).toBe(TaskStates.cancelled);
    handle.close();
  });

  it("rejects cancelling a task that has already finished", () => {
    const dbPath = join(tempDir, "data", "engineer.db");
    const handle = createDatabase(dbPath);
    insertTask(handle.db, "task-done", TaskStates.completed);

    const code = runCancel(tempDir, "task-done");
    expect(code).toBe(1);
    expect(stderrWrites.join("")).toContain("has not finished");
    expect(
      (handle.db.prepare("SELECT state FROM tasks WHERE id = ?").get("task-done") as { state: string }).state,
    ).toBe(TaskStates.completed);
    handle.close();
  });

  it("resolves a task by ID prefix", () => {
    const dbPath = join(tempDir, "data", "engineer.db");
    const handle = createDatabase(dbPath);
    insertTask(handle.db, "01HXYZ1234567890ABCDEFGHIJ", TaskStates.queued);

    expect(runCancel(tempDir, "01HXYZ12")).toBe(0);
    expect(
      (handle.db.prepare("SELECT state FROM tasks WHERE id = ?").get("01HXYZ1234567890ABCDEFGHIJ") as { state: string })
        .state,
    ).toBe(TaskStates.cancelled);
    handle.close();
  });

  it("produces JSON output in json mode", () => {
    resetOutput();
    createOutput({ mode: "json", color: false });

    const dbPath = join(tempDir, "data", "engineer.db");
    const handle = createDatabase(dbPath);
    insertTask(handle.db, "task-json", TaskStates.queued);

    expect(runCancel(tempDir, "task-json")).toBe(0);

    const parsed = JSON.parse(stdoutWrites.join("")) as Record<string, unknown>;
    expect(parsed["previousState"]).toBe(TaskStates.queued);
    expect(parsed["newState"]).toBe(TaskStates.cancelled);
    handle.close();
  });
});
