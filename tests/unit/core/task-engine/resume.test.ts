import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { retryTask } from "../../../../src/core/task-engine/resume.js";
import { createInMemoryDatabase } from "../../../../src/db/database.js";
import type { DatabaseHandle } from "../../../../src/db/database.js";
import { TaskStates } from "../../../../src/schemas/task.js";

// ── Helpers ──────────────────────────────────────────────────────────────────────

interface TaskOverrides {
  subState?: string | null;
  completedAt?: string | null;
  notBefore?: string | null;
  crashCount?: number;
  agentUnavailableCount?: number;
  blocked?: string | null;
  reapedAt?: string | null;
  idempotencyKey?: string;
}

function insertTask(db: Database.Database, id: string, state: string, overrides: TaskOverrides = {}): void {
  db.prepare(
    `INSERT INTO tasks (id, idempotency_key, state, sub_state, priority, title, created_at, last_transition_at,
       completed_at, not_before, consecutive_crash_count, consecutive_agent_unavailable_count, blocked, reaped_at)
     VALUES (?, ?, ?, ?, 50, 'Test task', '2026-01-15T10:30:00Z', '2026-01-15T10:30:00Z', ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    overrides.idempotencyKey ?? `test:${id}`,
    state,
    overrides.subState ?? null,
    overrides.completedAt ?? null,
    overrides.notBefore ?? null,
    overrides.crashCount ?? 0,
    overrides.agentUnavailableCount ?? 0,
    overrides.blocked ?? null,
    overrides.reapedAt ?? null,
  );
}

const RETRY_OPTS = { reason: "cli_retry", triggeredBy: "cli" };

function readState(db: Database.Database, id: string): string {
  return (db.prepare("SELECT state FROM tasks WHERE id = ?").get(id) as { state: string }).state;
}

// ── Tests ────────────────────────────────────────────────────────────────────────

describe("retryTask", () => {
  let handle: DatabaseHandle;

  beforeEach(() => {
    handle = createInMemoryDatabase();
  });

  afterEach(() => {
    handle.close();
  });

  it("retries a retryable task — sets queued, bumps version, resets counters and clears not_before/completed_at", () => {
    insertTask(handle.db, "t1", TaskStates.failed, {
      completedAt: "2026-01-15T11:00:00Z",
      notBefore: "2026-06-01T00:00:00Z",
      crashCount: 3,
      agentUnavailableCount: 2,
    });

    const result = retryTask(handle.db, "t1", RETRY_OPTS);

    expect(result).toEqual({ outcome: "retried", fromState: TaskStates.failed });

    const task = handle.db
      .prepare(
        `SELECT state, sub_state, completed_at, not_before, version,
           consecutive_crash_count AS crash, consecutive_agent_unavailable_count AS unavail
         FROM tasks WHERE id = ?`,
      )
      .get("t1") as {
      state: string;
      sub_state: string | null;
      completed_at: string | null;
      not_before: string | null;
      version: number;
      crash: number;
      unavail: number;
    };
    expect(task.state).toBe(TaskStates.queued);
    expect(task.sub_state).toBeNull();
    expect(task.completed_at).toBeNull();
    expect(task.not_before).toBeNull();
    expect(task.crash).toBe(0);
    expect(task.unavail).toBe(0);
    // The retry bumps `version` so it joins the daemon's optimistic-concurrency CAS — exactly one writer wins.
    expect(task.version).toBe(2);

    const transition = handle.db
      .prepare("SELECT from_state, to_state, to_sub, reason, triggered_by FROM state_transitions WHERE task_id = ?")
      .get("t1") as {
      from_state: string;
      to_state: string;
      to_sub: string | null;
      reason: string;
      triggered_by: string;
    };
    expect(transition.from_state).toBe(TaskStates.failed);
    expect(transition.to_state).toBe(TaskStates.queued);
    expect(transition.to_sub).toBeNull();
    expect(transition.reason).toBe("cli_retry");
    expect(transition.triggered_by).toBe("cli");
  });

  it("retries each retryable state (cancelled included, while unreaped) and refuses every non-retryable state", () => {
    for (const state of [TaskStates.failed, TaskStates.blocked, TaskStates.cancelled]) {
      insertTask(handle.db, `ok-${state}`, state);
      expect(retryTask(handle.db, `ok-${state}`, RETRY_OPTS).outcome).toBe("retried");
    }
    for (const state of [TaskStates.queued, TaskStates.active, TaskStates.completed]) {
      insertTask(handle.db, `no-${state}`, state);
      expect(retryTask(handle.db, `no-${state}`, RETRY_OPTS)).toEqual({ outcome: "not_retryable", state });
    }
  });

  it("returns not_found for a missing task — no audit row written", () => {
    expect(retryTask(handle.db, "ghost", RETRY_OPTS)).toEqual({ outcome: "not_found" });
    const count = handle.db.prepare("SELECT COUNT(*) AS n FROM state_transitions").get() as { n: number };
    expect(count.n).toBe(0);
  });

  it("clears the blocked payload but preserves the contacted outreach history", () => {
    insertTask(handle.db, "t1", TaskStates.blocked, {
      blocked: JSON.stringify({
        reason: "need_more_info",
        needed: "Confirm the repo",
        efforts_made: ["asked owner"],
        contacted: [{ person_id: "owner", at: "2026-01-15T10:45:00Z" }],
      }),
    });

    expect(retryTask(handle.db, "t1", RETRY_OPTS).outcome).toBe("retried");

    const blocked = JSON.parse(
      (handle.db.prepare("SELECT blocked FROM tasks WHERE id = ?").get("t1") as { blocked: string }).blocked,
    ) as Record<string, unknown>;
    expect(blocked["reason"]).toBe("");
    expect(blocked["needed"]).toBe("");
    expect(blocked["contacted"]).toEqual([{ person_id: "owner", at: "2026-01-15T10:45:00Z" }]);
  });

  it("resumes a cancelled task whose work still exists (reaped_at IS NULL)", () => {
    insertTask(handle.db, "t1", TaskStates.cancelled, { completedAt: "2026-01-15T11:00:00Z" });

    const result = retryTask(handle.db, "t1", RETRY_OPTS);

    expect(result).toEqual({ outcome: "retried", fromState: TaskStates.cancelled });
    const task = handle.db.prepare("SELECT state, completed_at FROM tasks WHERE id = ?").get("t1") as {
      state: string;
      completed_at: string | null;
    };
    expect(task.state).toBe(TaskStates.queued);
    expect(task.completed_at).toBeNull();

    const transition = handle.db
      .prepare("SELECT from_state, to_state FROM state_transitions WHERE task_id = ?")
      .get("t1") as { from_state: string; to_state: string };
    expect(transition.from_state).toBe(TaskStates.cancelled);
    expect(transition.to_state).toBe(TaskStates.queued);
  });

  it("refuses to resume a reaped cancelled task — its work is gone (already_reaped)", () => {
    insertTask(handle.db, "t1", TaskStates.cancelled, { reapedAt: "2026-01-15T12:00:00Z" });

    expect(retryTask(handle.db, "t1", RETRY_OPTS)).toEqual({ outcome: "already_reaped" });
    // Untouched: still cancelled, no audit row.
    expect(readState(handle.db, "t1")).toBe(TaskStates.cancelled);
    const count = handle.db.prepare("SELECT COUNT(*) AS n FROM state_transitions WHERE task_id = ?").get("t1") as {
      n: number;
    };
    expect(count.n).toBe(0);
  });

  it("refuses to resume when a newer task already holds the source's idempotency key (key_conflict)", () => {
    // Cancel freed the key; a fresh task was then triggered from the same source and is live.
    insertTask(handle.db, "old", TaskStates.cancelled, { idempotencyKey: "github:issue-42" });
    insertTask(handle.db, "new", TaskStates.queued, { idempotencyKey: "github:issue-42" });

    expect(retryTask(handle.db, "old", RETRY_OPTS)).toEqual({ outcome: "key_conflict", holderId: "new" });
    // The cancelled task is left untouched; the live clone stands.
    expect(readState(handle.db, "old")).toBe(TaskStates.cancelled);
  });

  it("a retry defeats a stale daemon transition via the version bump (the retry wins)", () => {
    insertTask(handle.db, "t1", TaskStates.failed); // version 1

    expect(retryTask(handle.db, "t1", RETRY_OPTS).outcome).toBe("retried"); // version 1 → 2

    // The daemon's now-stale optimistic-concurrency CAS matches zero rows — its write is dropped.
    const daemonCas = handle.db
      .prepare("UPDATE tasks SET state = 'completed', version = version + 1 WHERE id = ? AND version = ?")
      .run("t1", 1);
    expect(daemonCas.changes).toBe(0);
    expect(readState(handle.db, "t1")).toBe(TaskStates.queued);
  });
});
