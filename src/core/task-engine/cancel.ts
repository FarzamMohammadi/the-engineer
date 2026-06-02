import type Database from "better-sqlite3";
import { ulid } from "ulid";

import { CANCELLABLE_STATES, TaskStates } from "../../schemas/task.js";

// ── Types ──────────────────────────────────────────────────────────────────────

/** The outcome of a guarded cancel write — the caller maps it to an HTTP status or a CLI exit code. */
export type CancelTaskResult =
  | { outcome: "cancelled"; fromState: string }
  | { outcome: "not_found" }
  | { outcome: "not_cancellable"; state: string };

/** What gets recorded on the `state_transitions` audit row for a cancel. */
export interface CancelTaskOptions {
  readonly reason: string;
  readonly triggeredBy: string;
}

const CANCELLABLE_PLACEHOLDERS = CANCELLABLE_STATES.map(() => "?").join(", ");

// ── Guarded Cancel Write ─────────────────────────────────────────────────────────

/**
 * Cancel a task with a guarded, versioned raw write — the cross-process cancel path shared by the dashboard
 * API and `engineer cancel`. Neither has the task-engine (the CLI is a separate process; the dashboard holds
 * only DB handles), so both open the DB directly and converge here — the same shape `retry.ts` uses for its
 * own guarded write, kept in one place so the race-protecting `version` bump can never drift out of a copy.
 *
 * The UPDATE bumps `version` and guards `WHERE state IN (<cancellable>)`, so it joins the daemon's
 * optimistic-concurrency CAS (the state-machine's `version = version + 1 WHERE version = ?`): a cancel and a
 * concurrent daemon transition genuinely serialize — exactly one wins, the loser matches zero rows. The state
 * change and its audit row are one transaction.
 */
export function cancelTask(db: Database.Database, taskId: string, opts: CancelTaskOptions): CancelTaskResult {
  const row = db.prepare("SELECT state, sub_state FROM tasks WHERE id = ?").get(taskId) as
    | { state: string; sub_state: string | null }
    | undefined;
  if (!row) {
    return { outcome: "not_found" };
  }
  if (!(CANCELLABLE_STATES as readonly string[]).includes(row.state)) {
    return { outcome: "not_cancellable", state: row.state };
  }

  const now = new Date().toISOString();

  const cancelled = db.transaction(() => {
    const update = db
      .prepare(
        `UPDATE tasks SET state = ?, sub_state = NULL, version = version + 1, completed_at = ?, last_transition_at = ?
         WHERE id = ? AND state IN (${CANCELLABLE_PLACEHOLDERS})`,
      )
      .run(TaskStates.cancelled, now, now, taskId, ...CANCELLABLE_STATES);
    if (update.changes === 0) {
      // Lost the race — a concurrent daemon transition won the version CAS and moved the task out of a
      // cancellable state between our SELECT and this UPDATE. Leave it untouched; the winner stands.
      return false;
    }
    db.prepare(
      `INSERT INTO state_transitions (id, task_id, from_state, to_state, from_sub, to_sub, reason, timestamp, triggered_by)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
    ).run(ulid(), taskId, row.state, TaskStates.cancelled, row.sub_state, opts.reason, now, opts.triggeredBy);
    return true;
  })();

  if (!cancelled) {
    const current = db.prepare("SELECT state FROM tasks WHERE id = ?").get(taskId) as { state: string } | undefined;
    return { outcome: "not_cancellable", state: current?.state ?? row.state };
  }

  return { outcome: "cancelled", fromState: row.state };
}
