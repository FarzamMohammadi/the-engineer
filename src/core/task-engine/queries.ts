import type Database from "better-sqlite3";

import type { BlockReason, StateTransition, Task, TaskState } from "../../schemas/task.js";
import { KEY_FREEING_STATES, TERMINAL_STATES, TaskStates } from "../../schemas/task.js";
import { type StateTransitionRow, type TaskRow, rowToStateTransition, rowToTask } from "./row-mapper.js";

// Terminal tasks the reaper reconciles. Derived from TERMINAL_STATES so a new terminal state is
// considered here too; `failed` is the one deliberate exclusion — failed tasks are preserved as
// debug evidence + retry source and are never reaped.
const REAPABLE_TERMINAL_STATES = TERMINAL_STATES.filter((state) => state !== TaskStates.failed);

/**
 * Read-only query methods for tasks.
 * All queries return typed domain objects via row mappers.
 */
export class TaskQueries {
  private readonly getTaskStmt: Database.Statement;
  private readonly getTasksByStateStmt: Database.Statement;
  private readonly getBlockedByReasonStmt: Database.Statement;
  private readonly getQueuedStmt: Database.Statement;
  private readonly getUnreapedTerminalStmt: Database.Statement;
  private readonly getStateHistoryStmt: Database.Statement;
  private readonly findByIdempotencyKeyStmt: Database.Statement;
  private readonly findKeyHolderStmt: Database.Statement;

  constructor(db: Database.Database) {
    this.getTaskStmt = db.prepare("SELECT * FROM tasks WHERE id = ?");

    this.getTasksByStateStmt = db.prepare("SELECT * FROM tasks WHERE state = ? ORDER BY priority DESC, created_at ASC");

    // Unreaped terminal tasks for the reaper's reconciliation sweep, oldest-finished first. Placeholders
    // built from REAPABLE_TERMINAL_STATES so the SQL stays in lockstep with the terminal-state SSOT.
    const reapablePlaceholders = REAPABLE_TERMINAL_STATES.map(() => "?").join(", ");
    this.getUnreapedTerminalStmt = db.prepare(
      `SELECT * FROM tasks WHERE state IN (${reapablePlaceholders}) AND reaped_at IS NULL ORDER BY completed_at ASC`,
    );

    this.getBlockedByReasonStmt = db.prepare(
      "SELECT * FROM tasks WHERE state = 'blocked' AND json_extract(blocked, '$.reason') = ? ORDER BY priority DESC, created_at ASC",
    );

    this.getQueuedStmt = db.prepare(
      "SELECT * FROM tasks WHERE state = 'queued' ORDER BY priority DESC, created_at ASC",
    );

    this.getStateHistoryStmt = db.prepare("SELECT * FROM state_transitions WHERE task_id = ? ORDER BY timestamp ASC");

    // Re-trigger dedup gate: only a completed/cancelled task frees its key. A `failed` task HOLDS its key
    // (it is recoverable via `engineer retry`), so the trigger resumes it instead of cloning a duplicate.
    // Built from KEY_FREEING_STATES — intentionally NARROWER than the DB idx_tasks_idempotency_key_active
    // index (which also excludes `failed`): the index guards in-play uniqueness, this gate guards re-spawning.
    const freeingList = KEY_FREEING_STATES.map((state) => `'${state}'`).join(", ");
    this.findByIdempotencyKeyStmt = db.prepare(`
      SELECT 1 FROM tasks
      WHERE idempotency_key = ?
        AND state NOT IN (${freeingList})
      LIMIT 1
    `);

    // Same gate as findByIdempotencyKey, but returns WHO holds the key — used only to explain a suppressed
    // re-trigger (a failed holder means "retry or cancel"), never on the hot dedup path.
    this.findKeyHolderStmt = db.prepare(`
      SELECT id, state FROM tasks
      WHERE idempotency_key = ?
        AND state NOT IN (${freeingList})
      LIMIT 1
    `);
  }

  /** Get a task by ID. Returns null if not found. */
  getTask(id: string): Task | null {
    const row = this.getTaskStmt.get(id) as TaskRow | undefined;
    return row ? rowToTask(row) : null;
  }

  /** Get all tasks in a given state, ordered by priority DESC, created_at ASC. */
  getTasksByState(state: TaskState): Task[] {
    const rows = this.getTasksByStateStmt.all(state) as TaskRow[];
    return rows.map(rowToTask);
  }

  /** Get all blocked tasks with a given block reason, ordered by priority DESC, created_at ASC. */
  getBlockedTasksByReason(reason: BlockReason): Task[] {
    const rows = this.getBlockedByReasonStmt.all(reason) as TaskRow[];
    return rows.map(rowToTask);
  }

  /** Get all queued tasks, ordered by priority DESC, created_at ASC. */
  getQueuedByPriority(): Task[] {
    const rows = this.getQueuedStmt.all() as TaskRow[];
    return rows.map(rowToTask);
  }

  /**
   * Get terminal tasks the reaper has not yet reconciled — completed/cancelled (never failed) with
   * `reaped_at` still NULL — oldest-finished first. The reaper's reconciliation worklist.
   */
  getUnreapedTerminalTasks(): Task[] {
    const rows = this.getUnreapedTerminalStmt.all(...REAPABLE_TERMINAL_STATES) as TaskRow[];
    return rows.map(rowToTask);
  }

  /** Get the full state transition history for a task, ordered by timestamp ASC. */
  getStateHistory(taskId: string): StateTransition[] {
    const rows = this.getStateHistoryStmt.all(taskId) as StateTransitionRow[];
    return rows.map(rowToStateTransition);
  }

  /**
   * Whether a task still holding the given idempotency key exists — the durable half of the re-trigger
   * dedup gate. Survives restarts (the in-memory seen-key cache does not). Scoped to KEY_FREEING_STATES:
   * only `completed`/`cancelled` free the key; a `failed` task HOLDS it, so the trigger resumes it via
   * `engineer retry` rather than cloning a duplicate.
   */
  findByIdempotencyKey(key: string): boolean {
    const row = this.findByIdempotencyKeyStmt.get(key);
    return row !== undefined;
  }

  /**
   * The task currently holding an idempotency key — its id and state — or null if the key is free.
   * Mirrors findByIdempotencyKey's gate (same KEY_FREEING_STATES) but returns who holds it, so a
   * suppressed re-trigger can be surfaced on the holder's timeline instead of swallowed.
   */
  findKeyHolder(key: string): { id: string; state: TaskState } | null {
    const row = this.findKeyHolderStmt.get(key) as { id: string; state: string } | undefined;
    return row ? { id: row.id, state: row.state as TaskState } : null;
  }
}
