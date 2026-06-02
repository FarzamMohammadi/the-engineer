import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cancelTask } from "../../../../src/core/task-engine/cancel.js";
import { createInMemoryDatabase } from "../../../../src/db/database.js";
import type { DatabaseHandle } from "../../../../src/db/database.js";
import { SubStates, TaskStates } from "../../../../src/schemas/task.js";

// ── Helpers ──────────────────────────────────────────────────────────────────────

function insertTask(db: Database.Database, id: string, state: string, subState: string | null = null): void {
  db.prepare(
    `INSERT INTO tasks (id, idempotency_key, state, sub_state, priority, title, created_at, last_transition_at)
     VALUES (?, ?, ?, ?, 50, 'Test task', '2026-01-15T10:30:00Z', '2026-01-15T10:30:00Z')`,
  ).run(id, `test:${id}`, state, subState);
}

const CANCEL_OPTS = { reason: "cli_cancel", triggeredBy: "cli" };

function readState(db: Database.Database, id: string): string {
  return (db.prepare("SELECT state FROM tasks WHERE id = ?").get(id) as { state: string }).state;
}

// ── Tests ────────────────────────────────────────────────────────────────────────

describe("cancelTask", () => {
  let handle: DatabaseHandle;

  beforeEach(() => {
    handle = createInMemoryDatabase();
  });

  afterEach(() => {
    handle.close();
  });

  it("cancels a cancellable task — sets cancelled, bumps version, stamps completed_at, writes an audit row", () => {
    insertTask(handle.db, "t1", TaskStates.active, SubStates.working);

    const result = cancelTask(handle.db, "t1", CANCEL_OPTS);

    expect(result).toEqual({ outcome: "cancelled", fromState: TaskStates.active });

    const task = handle.db
      .prepare("SELECT state, sub_state, completed_at, version FROM tasks WHERE id = ?")
      .get("t1") as { state: string; sub_state: string | null; completed_at: string | null; version: number };
    expect(task.state).toBe(TaskStates.cancelled);
    expect(task.sub_state).toBeNull();
    expect(task.completed_at).not.toBeNull();
    expect(task.version).toBe(2);

    const transition = handle.db
      .prepare(
        "SELECT from_state, from_sub, to_state, to_sub, reason, triggered_by FROM state_transitions WHERE task_id = ?",
      )
      .get("t1") as {
      from_state: string;
      from_sub: string | null;
      to_state: string;
      to_sub: string | null;
      reason: string;
      triggered_by: string;
    };
    expect(transition.from_state).toBe(TaskStates.active);
    expect(transition.from_sub).toBe(SubStates.working);
    expect(transition.to_state).toBe(TaskStates.cancelled);
    expect(transition.to_sub).toBeNull();
    expect(transition.reason).toBe("cli_cancel");
    expect(transition.triggered_by).toBe("cli");
  });

  it("cancels each cancellable state and refuses each terminal state", () => {
    for (const state of [TaskStates.requirements_gathering, TaskStates.queued, TaskStates.blocked]) {
      insertTask(handle.db, `ok-${state}`, state);
      expect(cancelTask(handle.db, `ok-${state}`, CANCEL_OPTS).outcome).toBe("cancelled");
    }
    for (const state of [TaskStates.completed, TaskStates.failed, TaskStates.cancelled]) {
      insertTask(handle.db, `no-${state}`, state);
      expect(cancelTask(handle.db, `no-${state}`, CANCEL_OPTS)).toEqual({ outcome: "not_cancellable", state });
    }
  });

  it("returns not_found for a missing task — no audit row written", () => {
    expect(cancelTask(handle.db, "ghost", CANCEL_OPTS)).toEqual({ outcome: "not_found" });
    const count = handle.db.prepare("SELECT COUNT(*) AS n FROM state_transitions").get() as { n: number };
    expect(count.n).toBe(0);
  });

  // ── The version-CAS race (D14) ──────────────────────────────────────────────────

  it("a cancel defeats a stale daemon transition via the version bump (the cancel wins)", () => {
    insertTask(handle.db, "t1", TaskStates.active, SubStates.working); // version 1

    // The owner's cancel lands first, bumping version 1 → 2 under the cancellable guard.
    expect(cancelTask(handle.db, "t1", CANCEL_OPTS).outcome).toBe("cancelled");

    // The daemon's now-stale optimistic-concurrency CAS (the exact statement the state-machine runs on
    // `WHERE version = <the version it read>`) matches zero rows — its completion is dropped.
    const daemonCas = handle.db
      .prepare("UPDATE tasks SET state = 'completed', version = version + 1 WHERE id = ? AND version = ?")
      .run("t1", 1);
    expect(daemonCas.changes).toBe(0);
    expect(readState(handle.db, "t1")).toBe(TaskStates.cancelled);
  });

  it("a cancel loses to a daemon transition that already left a cancellable state (the completion wins)", () => {
    insertTask(handle.db, "t1", TaskStates.active, SubStates.working);

    // The daemon completed the task first (state → completed, version bumped).
    handle.db.prepare("UPDATE tasks SET state = 'completed', version = version + 1 WHERE id = ?").run("t1");

    // The cancel now finds it non-cancellable, matches zero rows, and reports the state it landed in.
    expect(cancelTask(handle.db, "t1", CANCEL_OPTS)).toEqual({
      outcome: "not_cancellable",
      state: TaskStates.completed,
    });
    expect(readState(handle.db, "t1")).toBe(TaskStates.completed);
  });
});
