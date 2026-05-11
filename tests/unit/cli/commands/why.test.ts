import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runWhy } from "../../../../src/cli/commands/why.js";
import { createOutput, resetOutput } from "../../../../src/cli/output.js";
import { createDatabase } from "../../../../src/db/database.js";
import { Phases } from "../../../../src/schemas/orchestrator.js";
import { JournalEntryTypes } from "../../../../src/schemas/session-memory.js";
import { SubStates, TaskStates } from "../../../../src/schemas/task.js";

let tempDir: string;
let stdoutWrites: string[];
let stderrWrites: string[];

beforeEach(() => {
  tempDir = join(tmpdir(), `why-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

// Helper to insert a task with all required NOT NULL columns
function insertTask(db: import("better-sqlite3").Database, id: string, overrides: Record<string, unknown> = {}): void {
  const defaults = {
    state: TaskStates.requirements_gathering,
    sub_state: null as string | null,
    priority: 50,
    title: "Test task",
    description: "",
    repo: null,
    created_at: "2026-01-15T10:30:00Z",
    last_transition_at: "2026-01-15T10:30:00Z",
    llm_tokens: 0,
    llm_cost_usd: 0,
    ...overrides,
  };
  db.prepare(
    `INSERT INTO tasks (id, state, sub_state, priority, title, description, repo, created_at, last_transition_at, llm_tokens, llm_cost_usd)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    defaults.state,
    defaults.sub_state ?? null,
    defaults.priority,
    defaults.title,
    defaults.description,
    defaults.repo,
    defaults.created_at,
    defaults.last_transition_at,
    defaults.llm_tokens,
    defaults.llm_cost_usd,
  );
}

describe("runWhy", () => {
  it("returns 1 when database does not exist", () => {
    const code = runWhy(tempDir, "nonexistent-task");
    expect(code).toBe(1);
    expect(stderrWrites.join("")).toContain("No database found");
  });

  it("returns 1 when task is not found", () => {
    const dbPath = join(tempDir, "data", "engineer.db");
    const handle = createDatabase(dbPath);
    handle.close();

    const code = runWhy(tempDir, "nonexistent-task");
    expect(code).toBe(1);
    expect(stderrWrites.join("")).toContain("Task not found");
  });

  it("displays task info when task is found", () => {
    const dbPath = join(tempDir, "data", "engineer.db");
    const handle = createDatabase(dbPath);
    insertTask(handle.db, "task-001", {
      state: TaskStates.active,
      sub_state: SubStates.working,
      description: "Fix bug",
      repo: "owner/repo",
      llm_tokens: 1230,
      llm_cost_usd: 0.42,
    });
    handle.close();

    const code = runWhy(tempDir, "task-001");
    expect(code).toBe(0);

    const output = stdoutWrites.join("");
    expect(output).toContain("task-001");
    expect(output).toContain("active");
    expect(output).toContain("working");
    expect(output).toContain("owner/repo");
    expect(output).toContain("$0.42");
  });

  it("displays timeline with state transitions", () => {
    const dbPath = join(tempDir, "data", "engineer.db");
    const handle = createDatabase(dbPath);
    insertTask(handle.db, "task-002", { state: TaskStates.queued });

    handle.db
      .prepare(
        `INSERT INTO state_transitions (id, task_id, from_state, to_state, reason, triggered_by, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "tr-1",
        "task-002",
        TaskStates.requirements_gathering,
        TaskStates.queued,
        "auto-transition",
        "daemon",
        "2026-01-15T10:30:01Z",
      );

    handle.close();

    const code = runWhy(tempDir, "task-002");
    expect(code).toBe(0);

    const output = stdoutWrites.join("");
    expect(output).toContain("requirements_gathering");
    expect(output).toContain("queued");
    expect(output).toContain("auto-transition");
  });

  it("shows 'No activity recorded' when no events or transitions exist", () => {
    const dbPath = join(tempDir, "data", "engineer.db");
    const handle = createDatabase(dbPath);
    insertTask(handle.db, "task-003");
    handle.close();

    const code = runWhy(tempDir, "task-003");
    expect(code).toBe(0);

    const output = stdoutWrites.join("");
    expect(output).toContain("No activity recorded");
  });

  it("displays journal entries", () => {
    const dbPath = join(tempDir, "data", "engineer.db");
    const handle = createDatabase(dbPath);
    insertTask(handle.db, "task-004", { state: TaskStates.active });

    handle.db
      .prepare("INSERT INTO sessions (id, task_id, started_at) VALUES (?, ?, ?)")
      .run("session-001", "task-004", "2026-01-15T10:30:00Z");

    handle.db
      .prepare(
        `INSERT INTO journal_entries (id, session_id, task_id, type, summary, phase, tags, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "j-1",
        "session-001",
        "task-004",
        JournalEntryTypes.finding,
        "Found 3 related files",
        Phases.research,
        "[]",
        "2026-01-15T10:32:00Z",
      );

    handle.close();

    const code = runWhy(tempDir, "task-004");
    expect(code).toBe(0);

    const output = stdoutWrites.join("");
    expect(output).toContain("Found 3 related files");
    expect(output).toContain("research");
  });

  it("outputs JSON in json mode", () => {
    resetOutput();
    createOutput({ mode: "json" });

    const dbPath = join(tempDir, "data", "engineer.db");
    const handle = createDatabase(dbPath);
    insertTask(handle.db, "task-005", {
      state: TaskStates.completed,
      description: "Fix auth",
      llm_tokens: 500,
      llm_cost_usd: 0.25,
    });
    handle.close();

    const code = runWhy(tempDir, "task-005");
    expect(code).toBe(0);

    const output = stdoutWrites.join("");
    const parsed = JSON.parse(output);
    expect(parsed.task.id).toBe("task-005");
    expect(parsed.task.state).toBe(TaskStates.completed);
    expect(parsed.cost.usd).toBe(0.25);
  });
});
