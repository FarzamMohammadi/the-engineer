import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runRetry } from "../../../../src/cli/commands/retry.js";
import { createOutput, resetOutput } from "../../../../src/cli/output.js";
import { createDatabase } from "../../../../src/db/database.js";
import { TaskStates } from "../../../../src/schemas/task.js";

let tempDir: string;
let stdoutWrites: string[];
let stderrWrites: string[];

beforeEach(() => {
  tempDir = join(tmpdir(), `retry-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

function insertTask(db: import("better-sqlite3").Database, id: string, overrides: Record<string, unknown> = {}): void {
  const defaults = {
    state: TaskStates.blocked,
    sub_state: null as string | null,
    priority: 50,
    title: "Test task",
    description: "",
    repo: null,
    created_at: "2026-01-15T10:30:00Z",
    last_transition_at: "2026-01-15T10:30:00Z",
    agent_tokens: 0,
    agent_cost_usd: 0,
    consecutive_crash_count: 3,
    consecutive_agent_unavailable_count: 2,
    not_before: "2026-06-01T00:00:00Z",
    ...overrides,
  };
  db.prepare(
    `INSERT INTO tasks (id, idempotency_key, state, sub_state, priority, title, description, repo,
       created_at, last_transition_at, agent_tokens, agent_cost_usd,
       consecutive_crash_count, consecutive_agent_unavailable_count, not_before)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    `test:${id}`,
    defaults.state,
    defaults.sub_state ?? null,
    defaults.priority,
    defaults.title,
    defaults.description,
    defaults.repo,
    defaults.created_at,
    defaults.last_transition_at,
    defaults.agent_tokens,
    defaults.agent_cost_usd,
    defaults.consecutive_crash_count,
    defaults.consecutive_agent_unavailable_count,
    defaults.not_before,
  );
}

describe("runRetry", () => {
  it("returns 1 when database does not exist", () => {
    const code = runRetry(tempDir, "nonexistent-task");
    expect(code).toBe(1);
    expect(stderrWrites.join("")).toContain("No database found");
  });

  it("returns 1 when task is not found", () => {
    const dbPath = join(tempDir, "data", "engineer.db");
    const handle = createDatabase(dbPath);
    handle.close();

    const code = runRetry(tempDir, "nonexistent-task");
    expect(code).toBe(1);
    expect(stderrWrites.join("")).toContain("Task not found");
  });

  it("retries a blocked task — transitions to queued and resets both counters", () => {
    const dbPath = join(tempDir, "data", "engineer.db");
    const handle = createDatabase(dbPath);
    insertTask(handle.db, "task-blocked");

    const code = runRetry(tempDir, "task-blocked");
    expect(code).toBe(0);

    const row = handle.db.prepare("SELECT * FROM tasks WHERE id = ?").get("task-blocked") as Record<string, unknown>;
    expect(row["state"]).toBe(TaskStates.queued);
    expect(row["sub_state"]).toBeNull();
    expect(row["not_before"]).toBeNull();
    expect(row["consecutive_crash_count"]).toBe(0);
    expect(row["consecutive_agent_unavailable_count"]).toBe(0);

    const transition = handle.db
      .prepare("SELECT * FROM state_transitions WHERE task_id = ? ORDER BY rowid DESC LIMIT 1")
      .get("task-blocked") as Record<string, unknown>;
    expect(transition["from_state"]).toBe(TaskStates.blocked);
    expect(transition["to_state"]).toBe(TaskStates.queued);
    expect(transition["reason"]).toBe("cli_retry");

    expect(stdoutWrites.join("")).toContain("moved from blocked to queued");
    handle.close();
  });

  it("retries a failed task — transitions to queued and resets both counters", () => {
    const dbPath = join(tempDir, "data", "engineer.db");
    const handle = createDatabase(dbPath);
    insertTask(handle.db, "task-failed", { state: TaskStates.failed });

    const code = runRetry(tempDir, "task-failed");
    expect(code).toBe(0);

    const row = handle.db.prepare("SELECT * FROM tasks WHERE id = ?").get("task-failed") as Record<string, unknown>;
    expect(row["state"]).toBe(TaskStates.queued);
    expect(row["not_before"]).toBeNull();
    expect(row["consecutive_crash_count"]).toBe(0);
    expect(row["consecutive_agent_unavailable_count"]).toBe(0);

    const transition = handle.db
      .prepare("SELECT * FROM state_transitions WHERE task_id = ? ORDER BY rowid DESC LIMIT 1")
      .get("task-failed") as Record<string, unknown>;
    expect(transition["from_state"]).toBe(TaskStates.failed);
    expect(transition["to_state"]).toBe(TaskStates.queued);

    expect(stdoutWrites.join("")).toContain("moved from failed to queued");
    handle.close();
  });

  it("resolves a task by ID prefix", () => {
    const dbPath = join(tempDir, "data", "engineer.db");
    const handle = createDatabase(dbPath);
    insertTask(handle.db, "01HXYZ1234567890ABCDEFGHIJ", { state: TaskStates.failed });

    const code = runRetry(tempDir, "01HXYZ12");
    expect(code).toBe(0);

    const row = handle.db.prepare("SELECT * FROM tasks WHERE id = ?").get("01HXYZ1234567890ABCDEFGHIJ") as Record<
      string,
      unknown
    >;
    expect(row["state"]).toBe(TaskStates.queued);
    expect(stdoutWrites.join("")).toContain("moved from failed to queued");
    handle.close();
  });

  it("rejects retry on a non-retryable state", () => {
    const dbPath = join(tempDir, "data", "engineer.db");
    const handle = createDatabase(dbPath);
    insertTask(handle.db, "task-active", { state: TaskStates.active });

    const code = runRetry(tempDir, "task-active");
    expect(code).toBe(1);
    expect(stderrWrites.join("")).toContain("Only blocked or failed tasks can be retried");
    handle.close();
  });

  it("produces JSON output in json mode", () => {
    resetOutput();
    createOutput({ mode: "json", color: false });

    const dbPath = join(tempDir, "data", "engineer.db");
    const handle = createDatabase(dbPath);
    insertTask(handle.db, "task-json", { state: TaskStates.failed });

    const code = runRetry(tempDir, "task-json");
    expect(code).toBe(0);

    const jsonOutput = stdoutWrites.join("");
    const parsed = JSON.parse(jsonOutput) as Record<string, unknown>;
    expect(parsed["previousState"]).toBe(TaskStates.failed);
    expect(parsed["newState"]).toBe(TaskStates.queued);
    handle.close();
  });
});
