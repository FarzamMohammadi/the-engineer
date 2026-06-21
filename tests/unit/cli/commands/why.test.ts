import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runWhy } from "../../../../src/cli/commands/why.js";
import { createOutput, resetOutput } from "../../../../src/cli/output.js";
import { Phases } from "../../../../src/core/orchestrator/pipeline/types.js";
import { createDatabase } from "../../../../src/db/database.js";
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
    state: TaskStates.queued,
    sub_state: null as string | null,
    priority: 50,
    title: "Test task",
    description: "",
    repo: null,
    created_at: "2026-01-15T10:30:00Z",
    last_transition_at: "2026-01-15T10:30:00Z",
    agent_tokens: 0,
    agent_cost_usd: 0,
    ...overrides,
  };
  db.prepare(
    `INSERT INTO tasks (id, idempotency_key, state, sub_state, priority, title, description, repo, created_at, last_transition_at, agent_tokens, agent_cost_usd)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      agent_tokens: 1230,
      agent_cost_usd: 0.42,
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
        TaskStates.queued,
        TaskStates.active,
        "auto-transition",
        "daemon",
        "2026-01-15T10:30:01Z",
      );

    handle.close();

    const code = runWhy(tempDir, "task-002");
    expect(code).toBe(0);

    const output = stdoutWrites.join("");
    expect(output).toContain("queued");
    expect(output).toContain("active");
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
        JournalEntryTypes.phase_change,
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

  it("surfaces why a task is blocked in human mode", () => {
    const dbPath = join(tempDir, "data", "engineer.db");
    const handle = createDatabase(dbPath);
    insertTask(handle.db, "task-blocked", { state: TaskStates.blocked });

    handle.db.prepare("UPDATE tasks SET blocked = ?, phase = ?, sub_phase = ? WHERE id = ?").run(
      JSON.stringify({
        reason: "need_more_info",
        category: "awaiting_human",
        sub_phase: "scoping",
        needed: "Confirm the target repo before planning.",
      }),
      "requirements",
      "scoping",
      "task-blocked",
    );

    handle.close();

    const code = runWhy(tempDir, "task-blocked");
    expect(code).toBe(0);

    const output = stdoutWrites.join("");
    expect(output).toContain("need_more_info");
    expect(output).toContain("awaiting_human");
    expect(output).toContain("Confirm the target repo before planning.");
    expect(output).toContain("requirements");
    expect(output).toContain("scoping");
  });

  it("includes parsed blocked details and a projected journal in JSON mode", () => {
    resetOutput();
    createOutput({ mode: "json" });

    const dbPath = join(tempDir, "data", "engineer.db");
    const handle = createDatabase(dbPath);
    insertTask(handle.db, "task-blocked-json", { state: TaskStates.blocked });

    handle.db.prepare("UPDATE tasks SET blocked = ?, phase = ?, sub_phase = ? WHERE id = ?").run(
      JSON.stringify({
        reason: "need_more_info",
        category: "awaiting_human",
        sub_phase: "scoping",
        needed: "Confirm the target repo.",
      }),
      "requirements",
      "scoping",
      "task-blocked-json",
    );

    handle.db
      .prepare("INSERT INTO sessions (id, task_id, started_at) VALUES (?, ?, ?)")
      .run("session-block", "task-blocked-json", "2026-01-15T10:30:00Z");
    handle.db
      .prepare(
        `INSERT INTO journal_entries (id, session_id, task_id, type, summary, detail, phase, error_detail, tags, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "j-block",
        "session-block",
        "task-blocked-json",
        JournalEntryTypes.phase_change,
        "Entered research",
        "Detail text",
        Phases.research,
        "internal error trace",
        "[]",
        "2026-01-15T10:31:00Z",
      );

    handle.close();

    const code = runWhy(tempDir, "task-blocked-json");
    expect(code).toBe(0);

    const parsed = JSON.parse(stdoutWrites.join("")) as {
      task: { phase: string; sub_phase: string; blocked: { reason: string; category: string; needed: string } };
      journal: Record<string, unknown>[];
    };
    expect(parsed.task.phase).toBe("requirements");
    expect(parsed.task.sub_phase).toBe("scoping");
    expect(parsed.task.blocked.reason).toBe("need_more_info");
    expect(parsed.task.blocked.category).toBe("awaiting_human");
    expect(parsed.task.blocked.needed).toBe("Confirm the target repo.");

    // Journal rows are projected to a clean shape — no internal columns leak.
    const entry = parsed.journal[0];
    if (!entry) {
      throw new Error("expected a projected journal entry");
    }
    expect(Object.keys(entry).sort()).toEqual(["detail", "phase", "summary", "timestamp", "type"]);
    expect(entry["error_detail"]).toBeUndefined();
    expect(entry["session_id"]).toBeUndefined();
    expect(entry["task_id"]).toBeUndefined();
  });

  it("resolves a task by ID prefix", () => {
    const dbPath = join(tempDir, "data", "engineer.db");
    const handle = createDatabase(dbPath);
    insertTask(handle.db, "01HXYZ1234567890ABCDEFGHIJ", {
      state: TaskStates.active,
      sub_state: SubStates.working,
      description: "Prefix test",
    });
    handle.close();

    const code = runWhy(tempDir, "01HXYZ12");
    expect(code).toBe(0);

    const output = stdoutWrites.join("");
    expect(output).toContain("01HXYZ1234567890ABCDEFGHIJ");
    expect(output).toContain("active");
  });

  it("outputs JSON in json mode", () => {
    resetOutput();
    createOutput({ mode: "json" });

    const dbPath = join(tempDir, "data", "engineer.db");
    const handle = createDatabase(dbPath);
    insertTask(handle.db, "task-005", {
      state: TaskStates.completed,
      description: "Fix auth",
      agent_tokens: 500,
      agent_cost_usd: 0.25,
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
