/**
 * Observer persistence layer — prepared statements for the observations table.
 *
 * Persistence layer for the unified Observer: prepared statements compiled
 * in constructor, synchronous writes, row mappers for reads.
 */
import type Database from "better-sqlite3";
import type { Statement } from "better-sqlite3";

import type { Observation, ObservationQuery } from "../../schemas/observer.js";
import { rowToObservation } from "../../schemas/observer.js";

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_QUERY_LIMIT = 100;

// ── ObserverStore ────────────────────────────────────────────────────────────

export class ObserverStore {
  private readonly db: Database.Database;
  private readonly stmtInsert: Statement;
  private readonly stmtUpdateEnd: Statement;

  constructor(db: Database.Database) {
    this.db = db;

    this.stmtInsert = db.prepare(`
      INSERT INTO observations
        (id, trace_id, parent_observation_id, type, name, task_id, phase, session_id,
         start_time, end_time, duration_ms, input, output, metadata, level, status, error_message)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.stmtUpdateEnd = db.prepare(`
      UPDATE observations
      SET end_time = ?, duration_ms = ?, output = ?, status = ?, error_message = ?
      WHERE id = ?
    `);
  }

  /** Insert a complete observation row. */
  insertObservation(obs: Observation): void {
    this.stmtInsert.run(
      obs.id,
      obs.trace_id,
      obs.parent_observation_id,
      obs.type,
      obs.name,
      obs.task_id,
      obs.phase,
      obs.session_id,
      obs.start_time,
      obs.end_time,
      obs.duration_ms,
      obs.input !== null ? JSON.stringify(obs.input) : null,
      obs.output !== null ? JSON.stringify(obs.output) : null,
      obs.metadata !== null ? JSON.stringify(obs.metadata) : null,
      obs.level,
      obs.status,
      obs.error_message,
    );
  }

  /** Update a span's end_time, duration, output, status, and error on span.end(). */
  updateSpanEnd(
    id: string,
    endTime: string,
    durationMs: number,
    output: Record<string, unknown> | null,
    status: string,
    errorMessage: string | null,
  ): void {
    this.stmtUpdateEnd.run(
      endTime,
      durationMs,
      output !== null ? JSON.stringify(output) : null,
      status,
      errorMessage,
      id,
    );
  }

  /** Query observations with dynamic filters. */
  queryObservations(filters: ObservationQuery): Observation[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.type !== undefined) {
      conditions.push("type = ?");
      params.push(filters.type);
    }
    if (filters.task_id !== undefined) {
      conditions.push("task_id = ?");
      params.push(filters.task_id);
    }
    if (filters.trace_id !== undefined) {
      conditions.push("trace_id = ?");
      params.push(filters.trace_id);
    }
    if (filters.phase !== undefined) {
      conditions.push("phase = ?");
      params.push(filters.phase);
    }
    if (filters.since !== undefined) {
      conditions.push("start_time >= ?");
      params.push(filters.since);
    }
    if (filters.level !== undefined) {
      conditions.push("level = ?");
      params.push(filters.level);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = filters.limit ?? DEFAULT_QUERY_LIMIT;

    const sql = `SELECT * FROM observations ${where} ORDER BY start_time ASC LIMIT ?`;
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as Parameters<typeof rowToObservation>[0][];
    return rows.map((row) => rowToObservation(row));
  }
}
