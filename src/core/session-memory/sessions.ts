import type Database from "better-sqlite3";
import { ulid } from "ulid";

import type { Session, SessionEndReason } from "../../schemas/session-memory.js";
import { SessionNotFoundError } from "./errors.js";

/** Session lifecycle management — create and end sessions for tasks. */
export class SessionStore {
  private readonly insertSessionStmt: Database.Statement;
  private readonly endSessionStmt: Database.Statement;

  constructor(db: Database.Database) {
    this.insertSessionStmt = db.prepare(`
      INSERT INTO sessions (id, task_id, started_at, ended_at, end_reason)
      VALUES (?, ?, ?, ?, ?)
    `);

    this.endSessionStmt = db.prepare("UPDATE sessions SET ended_at = ?, end_reason = ? WHERE id = ?");
  }

  /** Create a new session for a task. */
  create(input: { taskId: string }): Session {
    const id = ulid();
    const now = new Date().toISOString();

    this.insertSessionStmt.run(id, input.taskId, now, null, null);

    return {
      id,
      task_id: input.taskId,
      started_at: now,
      ended_at: null,
      end_reason: null,
    };
  }

  /** End a session with a reason. Throws SessionNotFoundError if the session does not exist. */
  end(id: string, reason: SessionEndReason): void {
    const now = new Date().toISOString();
    const result = this.endSessionStmt.run(now, reason, id);
    if (result.changes === 0) {
      throw new SessionNotFoundError(id);
    }
  }
}
