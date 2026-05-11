import type Database from "better-sqlite3";

import type { ExternalRef, StateTransition, Task, TaskState } from "../../schemas/task.js";
import { type StateTransitionRow, type TaskRow, rowToStateTransition, rowToTask } from "./row-mapper.js";

/**
 * Read-only query methods for tasks.
 * All queries return typed domain objects via row mappers.
 */
export class TaskQueries {
  private readonly getTaskStmt: Database.Statement;
  private readonly getTasksByStateStmt: Database.Statement;
  private readonly getQueuedStmt: Database.Statement;
  private readonly getChildrenStmt: Database.Statement;
  private readonly getStateHistoryStmt: Database.Statement;
  private readonly findByExternalRefStmt: Database.Statement;

  constructor(db: Database.Database) {
    this.getTaskStmt = db.prepare("SELECT * FROM tasks WHERE id = ?");

    this.getTasksByStateStmt = db.prepare("SELECT * FROM tasks WHERE state = ? ORDER BY priority DESC, created_at ASC");

    this.getQueuedStmt = db.prepare(
      "SELECT * FROM tasks WHERE state = 'queued' ORDER BY priority DESC, created_at ASC",
    );

    this.getChildrenStmt = db.prepare("SELECT * FROM tasks WHERE parent_id = ? ORDER BY created_at ASC");

    this.getStateHistoryStmt = db.prepare("SELECT * FROM state_transitions WHERE task_id = ? ORDER BY timestamp ASC");

    this.findByExternalRefStmt = db.prepare(`
      SELECT 1 FROM tasks
      WHERE json_extract(external_ref, '$.type') = ?
        AND json_extract(external_ref, '$.repo') = ?
        AND json_extract(external_ref, '$.id') = ?
        AND state NOT IN ('completed', 'failed')
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

  /** Get all queued tasks, ordered by priority DESC, created_at ASC. */
  getQueuedByPriority(): Task[] {
    const rows = this.getQueuedStmt.all() as TaskRow[];
    return rows.map(rowToTask);
  }

  /** Get all children of a parent task, ordered by created_at ASC. */
  getChildren(parentId: string): Task[] {
    const rows = this.getChildrenStmt.all(parentId) as TaskRow[];
    return rows.map(rowToTask);
  }

  /** Get the full state transition history for a task, ordered by timestamp ASC. */
  getStateHistory(taskId: string): StateTransition[] {
    const rows = this.getStateHistoryStmt.all(taskId) as StateTransitionRow[];
    return rows.map(rowToStateTransition);
  }

  /**
   * Check if a non-terminal task exists with the given external ref.
   * Type-aware matching (type + repo + id) for dedup purposes.
   * Deliberately different from externalRefsMatch() which is type-agnostic for unblock.
   */
  findByExternalRef(ref: ExternalRef): boolean {
    const row = this.findByExternalRefStmt.get(ref.type, ref.repo, ref.id);
    return row !== undefined;
  }
}
