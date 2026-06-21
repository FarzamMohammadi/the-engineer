import type Database from "better-sqlite3";
import { ulid } from "ulid";

import { RETRYABLE_STATES, TaskStates } from "../../schemas/task.js";

// ── Types ──────────────────────────────────────────────────────────────────────

/** The outcome of a guarded retry write — the caller maps it to an HTTP status or a CLI exit code. */
export type RetryTaskResult =
  | { outcome: "retried"; fromState: string }
  | { outcome: "not_found" }
  | { outcome: "not_retryable"; state: string };

/** What gets recorded on the `state_transitions` audit row for a retry. */
export interface RetryTaskOptions {
  readonly reason: string;
  readonly triggeredBy: string;
}

const RETRYABLE_PLACEHOLDERS = RETRYABLE_STATES.map(() => "?").join(", ");

// ── Guarded Retry Write ──────────────────────────────────────────────────────────

/**
 * Re-queue a blocked or failed task with a guarded, versioned raw write — the cross-process retry path
 * shared by the dashboard API and `engineer retry`. Neither has the task-engine (the CLI is a separate
 * process; the dashboard holds only DB handles), so both open the DB directly and converge here — the same
 * shape `cancel.ts` uses, kept in one place so the race-protecting `version` bump can never drift out of a copy.
 *
 * The UPDATE bumps `version` and guards `WHERE state IN (<retryable>)`, so it joins the daemon's
 * optimistic-concurrency CAS: a retry and a concurrent daemon transition genuinely serialize — exactly one
 * wins, the loser matches zero rows. Re-queuing resets the per-category retry counters and clears
 * `not_before` so the retry cycle starts fresh, and clears `completed_at` (a queued task is not finished).
 * The state change, the counter/timestamp reset, the cleared block payload, and the audit row are one
 * transaction.
 */
export function retryTask(db: Database.Database, taskId: string, opts: RetryTaskOptions): RetryTaskResult {
  const row = db.prepare("SELECT state, sub_state, blocked FROM tasks WHERE id = ?").get(taskId) as
    | { state: string; sub_state: string | null; blocked: string | null }
    | undefined;
  if (!row) {
    return { outcome: "not_found" };
  }
  if (!(RETRYABLE_STATES as readonly string[]).includes(row.state)) {
    return { outcome: "not_retryable", state: row.state };
  }

  const now = new Date().toISOString();

  const retried = db.transaction(() => {
    const update = db
      .prepare(
        `UPDATE tasks
         SET state = ?, sub_state = NULL, not_before = NULL, completed_at = NULL,
             consecutive_crash_count = 0, consecutive_agent_unavailable_count = 0,
             version = version + 1, last_transition_at = ?
         WHERE id = ? AND state IN (${RETRYABLE_PLACEHOLDERS})`,
      )
      .run(TaskStates.queued, now, taskId, ...RETRYABLE_STATES);
    if (update.changes === 0) {
      // Lost the race — a concurrent daemon transition won the version CAS and moved the task out of a
      // retryable state between our SELECT and this UPDATE. Leave it untouched; the winner stands.
      return false;
    }
    // A re-queued task is no longer blocked: clear the payload but keep the `contacted` outreach history.
    clearBlockedPreservingContacts(db, taskId, row.blocked);
    db.prepare(
      `INSERT INTO state_transitions (id, task_id, from_state, to_state, from_sub, to_sub, reason, timestamp, triggered_by)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
    ).run(ulid(), taskId, row.state, TaskStates.queued, row.sub_state, opts.reason, now, opts.triggeredBy);
    return true;
  })();

  if (!retried) {
    const current = db.prepare("SELECT state FROM tasks WHERE id = ?").get(taskId) as { state: string } | undefined;
    return { outcome: "not_retryable", state: current?.state ?? row.state };
  }

  return { outcome: "retried", fromState: row.state };
}

// ── Block Payload ────────────────────────────────────────────────────────────────

/**
 * Reset the `blocked` JSON column on a re-queued task. The `reason`, `needed`, `efforts_made`, and
 * `waiting_for` fields are cleared, but the `contacted` array is preserved as history of outreach attempts.
 * If the column is empty or the JSON is malformed, the column is set to NULL.
 */
function clearBlockedPreservingContacts(db: Database.Database, taskId: string, blockedRaw: string | null): void {
  if (!blockedRaw) {
    return;
  }

  const contacted = extractContactedHistory(blockedRaw);
  if (contacted.length === 0) {
    db.prepare("UPDATE tasks SET blocked = NULL WHERE id = ?").run(taskId);
    return;
  }

  db.prepare("UPDATE tasks SET blocked = ? WHERE id = ?").run(
    JSON.stringify({ reason: "", efforts_made: [], contacted, needed: "", waiting_for: "" }),
    taskId,
  );
}

function extractContactedHistory(blockedRaw: string): unknown[] {
  try {
    const parsed = JSON.parse(blockedRaw) as Record<string, unknown>;
    return Array.isArray(parsed["contacted"]) ? parsed["contacted"] : [];
  } catch {
    return [];
  }
}
