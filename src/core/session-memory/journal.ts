import type Database from "better-sqlite3";
import { ulid } from "ulid";

import { toSqliteJson } from "../../db/serialize.js";
import type { JournalEntry } from "../../schemas/session-memory.js";
import { sanitizeSecrets } from "../../utils/sanitize.js";
import type { AddJournalEntryInput } from "../interfaces/session-memory.interface.js";
import { type JournalEntryRow, rowToJournalEntry } from "./row-mappers.js";

/** Append-only journal for the Orchestrator's reasoning. */
export class JournalStore {
  private readonly insertStmt: Database.Statement;
  private readonly queryByTaskStmt: Database.Statement;
  private readonly latestTimestampStmt: Database.Statement;

  constructor(db: Database.Database) {
    this.insertStmt = db.prepare(`
      INSERT INTO journal_entries (
        id, session_id, task_id, timestamp, phase, type,
        summary, detail, error_detail, tags
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.queryByTaskStmt = db.prepare("SELECT * FROM journal_entries WHERE task_id = ? ORDER BY timestamp ASC");
    this.latestTimestampStmt = db.prepare("SELECT MAX(timestamp) as latest FROM journal_entries WHERE task_id = ?");
  }

  /** Append a journal entry. */
  addEntry(input: AddJournalEntryInput): JournalEntry {
    const id = ulid();
    const now = new Date().toISOString();
    const tags = input.tags ?? [];

    const summary = sanitizeSecrets(input.summary);
    const detail = input.detail ? sanitizeSecrets(input.detail) : null;
    const errorDetail = input.errorDetail ? sanitizeSecrets(input.errorDetail) : null;

    this.insertStmt.run(
      id,
      input.sessionId,
      input.taskId,
      now,
      input.phase,
      input.type,
      summary,
      detail,
      errorDetail,
      toSqliteJson(tags),
    );

    return {
      id,
      session_id: input.sessionId,
      task_id: input.taskId,
      timestamp: now,
      phase: input.phase,
      type: input.type,
      summary,
      detail,
      error_detail: errorDetail,
      tags,
    };
  }

  /** Query all journal entries for a task, ordered by timestamp. */
  query(taskId: string): JournalEntry[] {
    const rows = this.queryByTaskStmt.all(taskId) as JournalEntryRow[];
    return rows.map(rowToJournalEntry);
  }

  /** Get the latest journal entry timestamp for a task (single MAX query). */
  getLatestTimestamp(taskId: string): string | null {
    const row = this.latestTimestampStmt.get(taskId) as { latest: string | null } | undefined;
    return row?.latest ?? null;
  }
}
