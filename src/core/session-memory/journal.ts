import type Database from "better-sqlite3";
import { ulid } from "ulid";

import { toSqliteJson } from "../../db/serialize.js";
import type { JournalEntry } from "../../schemas/session-memory.js";
import { sanitizeSecrets } from "../../utils/sanitize.js";
import type { AddJournalEntryInput, JournalQueryFilters } from "../interfaces/session-memory.interface.js";
import { type JournalEntryRow, rowToJournalEntry } from "./row-mappers.js";

/**
 * Append-only journal for the Orchestrator's reasoning.
 *
 * Query uses dynamic SQL since filter permutations are exponential.
 * All parameters are bound — no injection risk. Tags use AND semantics.
 */
export class JournalStore {
  private readonly insertJournalStmt: Database.Statement;
  private readonly latestTimestampStmt: Database.Statement;

  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.latestTimestampStmt = db.prepare("SELECT MAX(timestamp) as latest FROM journal_entries WHERE task_id = ?");
    this.insertJournalStmt = db.prepare(`
      INSERT INTO journal_entries (
        id, session_id, task_id, timestamp, phase, type,
        summary, detail, action_type, finding_type, decision_key, error_detail, comm_target,
        tags
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
  }

  addJournalEntry(input: AddJournalEntryInput): JournalEntry {
    const id = ulid();
    const now = new Date().toISOString();
    const tags = input.tags ?? [];

    // Sanitize fields that may contain leaked tokens (D154)
    const summary = sanitizeSecrets(input.summary);
    const detail = input.detail ? sanitizeSecrets(input.detail) : null;
    const errorDetail = input.errorDetail ? sanitizeSecrets(input.errorDetail) : null;

    this.insertJournalStmt.run(
      id,
      input.sessionId,
      input.taskId,
      now,
      input.phase,
      input.type,
      summary,
      detail,
      input.actionType ?? null,
      input.findingType ?? null,
      input.decisionKey ?? null,
      errorDetail,
      input.commTarget ?? null,
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
      action_type: input.actionType ?? null,
      finding_type: input.findingType ?? null,
      decision_key: input.decisionKey ?? null,
      error_detail: errorDetail,
      comm_target: input.commTarget ?? null,
      tags,
    };
  }

  /**
   * Query journal entries for a task with optional filters.
   *
   * Builds SQL dynamically based on which filters are provided.
   * All parameters are bound (no injection risk). Tags use AND semantics:
   * the entry must contain ALL specified tags.
   */
  queryJournal(taskId: string, filters?: JournalQueryFilters): JournalEntry[] {
    const conditions: string[] = ["task_id = ?"];
    const params: unknown[] = [taskId];

    if (filters?.type) {
      conditions.push("type = ?");
      params.push(filters.type);
    }

    if (filters?.phase) {
      conditions.push("phase = ?");
      params.push(filters.phase);
    }

    if (filters?.since) {
      conditions.push("timestamp >= ?");
      params.push(filters.since);
    }

    if (filters?.tags && filters.tags.length > 0) {
      for (const tag of filters.tags) {
        conditions.push("EXISTS (SELECT 1 FROM json_each(tags) WHERE value = ?)");
        params.push(tag);
      }
    }

    const sql = `SELECT * FROM journal_entries WHERE ${conditions.join(" AND ")} ORDER BY timestamp ASC`;
    const rows = this.db.prepare(sql).all(...params) as JournalEntryRow[];
    return rows.map(rowToJournalEntry);
  }

  /** Get the latest journal entry timestamp for a task (single MAX query). */
  getLatestJournalTimestamp(taskId: string): string | null {
    const row = this.latestTimestampStmt.get(taskId) as { latest: string | null } | undefined;
    return row?.latest ?? null;
  }
}
