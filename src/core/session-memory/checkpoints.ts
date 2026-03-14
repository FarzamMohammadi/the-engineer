import type Database from "better-sqlite3";
import { ulid } from "ulid";

import type { Checkpoint } from "../../schemas/session-memory.js";
import type { CreateCheckpointInput } from "../interfaces/session-memory.interface.js";
import { type CheckpointRow, rowToCheckpoint } from "./row-mappers.js";

/**
 * Named snapshots for crash recovery and session resume.
 * Ordered by rowid (insertion order) for latest-checkpoint queries.
 */
export class CheckpointStore {
  private readonly insertCheckpointStmt: Database.Statement;
  private readonly getLatestCheckpointByTaskStmt: Database.Statement;

  constructor(db: Database.Database) {
    this.insertCheckpointStmt = db.prepare(`
      INSERT INTO checkpoints (
        id, session_id, task_id, phase, phase_progress,
        context_summary, key_findings, open_questions, next_action,
        last_event_id, workspace_ref, reason, timestamp, journal_offset
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.getLatestCheckpointByTaskStmt = db.prepare(
      "SELECT * FROM checkpoints WHERE task_id = ? ORDER BY rowid DESC LIMIT 1",
    );
  }

  createCheckpoint(input: CreateCheckpointInput): Checkpoint {
    const id = ulid();
    const now = new Date().toISOString();

    this.insertCheckpointStmt.run(
      id,
      input.sessionId,
      input.taskId,
      input.phase,
      input.phaseProgress,
      input.contextSummary,
      JSON.stringify(input.keyFindings),
      JSON.stringify(input.openQuestions),
      input.nextAction,
      input.lastEventId,
      input.workspaceRef ? JSON.stringify(input.workspaceRef) : null,
      input.reason,
      now,
      input.journalOffset,
    );

    return {
      id,
      session_id: input.sessionId,
      task_id: input.taskId,
      phase: input.phase,
      phase_progress: input.phaseProgress,
      context_summary: input.contextSummary,
      key_findings: input.keyFindings,
      open_questions: input.openQuestions,
      next_action: input.nextAction,
      last_event_id: input.lastEventId,
      workspace_ref: input.workspaceRef,
      reason: input.reason,
      timestamp: now,
      journal_offset: input.journalOffset,
    };
  }

  getLatestCheckpoint(taskId: string): Checkpoint | null {
    const row = this.getLatestCheckpointByTaskStmt.get(taskId) as CheckpointRow | undefined;
    if (!row) {
      return null;
    }
    return rowToCheckpoint(row);
  }
}
