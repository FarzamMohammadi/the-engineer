import type Database from "better-sqlite3";
import { ulid } from "ulid";

import type { Session, SessionEndReason } from "../../schemas/session-memory.js";
import type { CreateSessionInput } from "../interfaces/session-memory.interface.js";
import { SessionNotFoundError } from "./errors.js";
import { type SessionRow, rowToSession } from "./row-mappers.js";

/**
 * Session lifecycle management.
 * Sessions are linked chains for crash recovery — each session knows its predecessor.
 */
export class SessionStore {
  private readonly insertSessionStmt: Database.Statement;
  private readonly endSessionStmt: Database.Statement;
  private readonly getSessionsByTaskStmt: Database.Statement;

  constructor(db: Database.Database) {
    this.insertSessionStmt = db.prepare(`
      INSERT INTO sessions (id, task_id, started_at, ended_at, end_reason, previous_session_id, resumed_from_checkpoint)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    this.endSessionStmt = db.prepare("UPDATE sessions SET ended_at = ?, end_reason = ? WHERE id = ?");

    this.getSessionsByTaskStmt = db.prepare("SELECT * FROM sessions WHERE task_id = ? ORDER BY started_at ASC");
  }

  createSession(input: CreateSessionInput): Session {
    const id = ulid();
    const now = new Date().toISOString();
    const previousSessionId = input.previousSessionId ?? null;
    const resumedFromCheckpoint = input.resumedFromCheckpoint ?? null;

    this.insertSessionStmt.run(id, input.taskId, now, null, null, previousSessionId, resumedFromCheckpoint);

    return {
      id,
      task_id: input.taskId,
      started_at: now,
      ended_at: null,
      end_reason: null,
      previous_session_id: previousSessionId,
      resumed_from_checkpoint: resumedFromCheckpoint,
    };
  }

  endSession(id: string, reason: SessionEndReason): void {
    const now = new Date().toISOString();
    const result = this.endSessionStmt.run(now, reason, id);
    if (result.changes === 0) {
      throw new SessionNotFoundError(id);
    }
  }

  getSessionChain(taskId: string): Session[] {
    const rows = this.getSessionsByTaskStmt.all(taskId) as SessionRow[];
    return rows.map(rowToSession);
  }
}
