import type Database from "better-sqlite3";
import { ulid } from "ulid";

import { KEY_FREEING_STATES, RETRYABLE_STATES, TaskStates } from "../../schemas/task.js";

// ── Types ──────────────────────────────────────────────────────────────────────

/** The outcome of a guarded retry write — the caller maps it to an HTTP status or a CLI exit code. */
export type RetryTaskResult =
  | { outcome: "retried"; fromState: string }
  | { outcome: "not_found" }
  | { outcome: "not_retryable"; state: string }
  | { outcome: "already_reaped" }
  | { outcome: "key_conflict"; holderId: string };

/** What gets recorded on the `state_transitions` audit row for a retry. */
export interface RetryTaskOptions {
  readonly reason: string;
  readonly triggeredBy: string;
}

interface TaskRetryRow {
  state: string;
  sub_state: string | null;
  blocked: string | null;
  reaped_at: string | null;
  idempotency_key: string;
}

const RETRYABLE_PLACEHOLDERS = RETRYABLE_STATES.map(() => "?").join(", ");

// The key-holder gate, in lockstep with the daemon's TaskQueries.findKeyHolder and the app-level re-trigger
// dedup: only completed/cancelled free a key, so a NON-freeing holder is a live task already owning the source.
const KEY_FREEING_LIST = KEY_FREEING_STATES.map((state) => `'${state}'`).join(", ");

// ── Guarded Retry Write ──────────────────────────────────────────────────────────

/**
 * Re-queue a task with a guarded, versioned raw write — the cross-process retry/resume path shared by the
 * dashboard API and `engineer retry`. Neither has the task-engine (the CLI is a separate process; the
 * dashboard holds only DB handles), so both open the DB directly and converge here — the same shape
 * `cancel.ts` uses, kept in one place so the race-protecting `version` bump can never drift out of a copy.
 *
 * `failed`/`blocked` re-queue unconditionally (the workspace was never reaped). A `cancelled` task is a
 * RESUME and carries two extra preconditions, because cancel freed the work and the idempotency key:
 *  - `reaped_at IS NULL` — once the reaper has swept, the worktree/branch/PR are gone; there is nothing to
 *    resume into ({@link RetryTaskResult} `already_reaped`). The UPDATE re-asserts this so a concurrent reap
 *    that stamps `reaped_at` between our read and write wins (we match zero rows and report it).
 *  - the idempotency key is free — cancel released it, so the trigger may have cloned a fresh task. Resuming
 *    would put two live tasks on one source; we refuse with `key_conflict`. The partial unique index
 *    `idx_tasks_idempotency_key_active` is the backstop if a clone lands between our check and the write.
 *
 * The version bump joins the daemon's optimistic-concurrency CAS; the state change, counter/timestamp reset,
 * cleared block payload, and audit row are one transaction.
 */
export function retryTask(db: Database.Database, taskId: string, opts: RetryTaskOptions): RetryTaskResult {
  const row = db
    .prepare("SELECT state, sub_state, blocked, reaped_at, idempotency_key FROM tasks WHERE id = ?")
    .get(taskId) as TaskRetryRow | undefined;
  if (!row) {
    return { outcome: "not_found" };
  }
  if (!(RETRYABLE_STATES as readonly string[]).includes(row.state)) {
    return { outcome: "not_retryable", state: row.state };
  }

  if (row.state === TaskStates.cancelled) {
    const precondition = checkResumePreconditions(db, taskId, row);
    if (precondition) {
      return precondition;
    }
  }

  const now = new Date().toISOString();

  let retried: boolean;
  try {
    retried = writeRetry(db, taskId, row, now, opts);
  } catch (err) {
    // A concurrent trigger cloned the freed key between our check and the write: the partial unique index
    // rejects the second live holder. Surface it as a clean conflict rather than a raw constraint error.
    if (isIdempotencyKeyViolation(err)) {
      const holder = findKeyHolder(db, row.idempotency_key, taskId);
      return { outcome: "key_conflict", holderId: holder ?? "unknown" };
    }
    throw err;
  }

  if (!retried) {
    const current = db.prepare("SELECT state, reaped_at FROM tasks WHERE id = ?").get(taskId) as
      | { state: string; reaped_at: string | null }
      | undefined;
    // Lost the guarded write. For a cancelled task that means a concurrent reap stamped `reaped_at`; for any
    // other, a daemon transition moved it out of a retryable state. Report what actually happened.
    if (row.state === TaskStates.cancelled && current?.reaped_at != null) {
      return { outcome: "already_reaped" };
    }
    return { outcome: "not_retryable", state: current?.state ?? row.state };
  }

  return { outcome: "retried", fromState: row.state };
}

/** A resumed cancelled task must still have its work, and its idempotency key must be free. Null = OK. */
function checkResumePreconditions(db: Database.Database, taskId: string, row: TaskRetryRow): RetryTaskResult | null {
  if (row.reaped_at != null) {
    return { outcome: "already_reaped" };
  }
  const holder = findKeyHolder(db, row.idempotency_key, taskId);
  if (holder) {
    return { outcome: "key_conflict", holderId: holder };
  }
  return null;
}

/**
 * The guarded write itself, in one transaction. The UPDATE bumps `version` and guards
 * `WHERE state IN (<retryable>)`; for a cancelled task it additionally re-asserts `reaped_at IS NULL` so a
 * concurrent reap wins. Returns false when the guard matched zero rows (the caller resolves why).
 */
function writeRetry(
  db: Database.Database,
  taskId: string,
  row: TaskRetryRow,
  now: string,
  opts: RetryTaskOptions,
): boolean {
  return db.transaction(() => {
    const update = db
      .prepare(
        `UPDATE tasks
         SET state = ?, sub_state = NULL, not_before = NULL, completed_at = NULL,
             consecutive_crash_count = 0, consecutive_agent_unavailable_count = 0,
             version = version + 1, last_transition_at = ?
         WHERE id = ? AND state IN (${RETRYABLE_PLACEHOLDERS}) AND (state != ? OR reaped_at IS NULL)`,
      )
      .run(TaskStates.queued, now, taskId, ...RETRYABLE_STATES, TaskStates.cancelled);
    if (update.changes === 0) {
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
}

// ── Idempotency Key ──────────────────────────────────────────────────────────────

/** The id of a live (non-key-freeing) task holding this key other than `selfId`, or null if the key is free. */
function findKeyHolder(db: Database.Database, key: string, selfId: string): string | null {
  const holder = db
    .prepare(
      `SELECT id FROM tasks WHERE idempotency_key = ? AND state NOT IN (${KEY_FREEING_LIST}) AND id != ? LIMIT 1`,
    )
    .get(key, selfId) as { id: string } | undefined;
  return holder?.id ?? null;
}

/** Whether a thrown error is the partial-unique-index rejection on `idempotency_key`. */
function isIdempotencyKeyViolation(err: unknown): boolean {
  return (
    err instanceof Error &&
    "code" in err &&
    (err as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE" &&
    err.message.includes("idempotency_key")
  );
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
