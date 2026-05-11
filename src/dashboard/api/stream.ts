/**
 * SSE stream API route — real-time observations and events for the dashboard.
 *
 * Polls SQLite every second for new observations (by rowid) and events
 * (by sequence). Works in both co-located and standalone dashboard modes
 * since it only reads from the database (WAL concurrent readers).
 */
import type Database from "better-sqlite3";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

import { fromSqliteJson } from "../../db/serialize.js";

import { rowToObservation } from "../../schemas/observer.js";

export interface StreamRoutesDeps {
  db: Database.Database;
}

const POLL_INTERVAL_MS = 1000;
const HEARTBEAT_INTERVAL_MS = 15000;

interface ObservationRow {
  rowid: number;
  id: string;
  trace_id: string | null;
  parent_observation_id: string | null;
  type: string;
  name: string;
  task_id: string | null;
  phase: string | null;
  session_id: string | null;
  start_time: string;
  end_time: string | null;
  duration_ms: number | null;
  input: string | null;
  output: string | null;
  metadata: string | null;
  level: string;
  status: string;
  error_message: string | null;
}

interface EventRow {
  id: string;
  sequence: number;
  type: string;
  source: string;
  task_id: string | null;
  timestamp: string;
  payload: string;
}

/** Query the max rowid from the observations table. Returns 0 if empty/missing. */
function getMaxObsRowId(db: Database.Database): number {
  try {
    const row = db.prepare("SELECT MAX(rowid) as max_rowid FROM observations").get() as
      | { max_rowid: number | null }
      | undefined;
    return row?.max_rowid ?? 0;
  } catch {
    return 0;
  }
}

/** Query the max sequence from the events table. Returns 0 if empty/missing. */
function getMaxEventSeq(db: Database.Database): number {
  try {
    const row = db.prepare("SELECT MAX(sequence) as max_seq FROM events").get() as
      | { max_seq: number | null }
      | undefined;
    return row?.max_seq ?? 0;
  } catch {
    return 0;
  }
}

/** Poll for new observations and return them with the updated cursor. */
function pollObservations(db: Database.Database, lastRowId: number): { rows: ObservationRow[]; newCursor: number } {
  try {
    const rows = db
      .prepare("SELECT rowid, * FROM observations WHERE rowid > ? ORDER BY rowid ASC LIMIT 50")
      .all(lastRowId) as ObservationRow[];
    const last = rows[rows.length - 1];
    const newCursor = last !== undefined ? last.rowid : lastRowId;
    return { rows, newCursor };
  } catch {
    return { rows: [], newCursor: lastRowId };
  }
}

/** Poll for new events and return them with the updated cursor. */
function pollEvents(db: Database.Database, lastSeq: number): { rows: EventRow[]; newCursor: number } {
  try {
    const rows = db
      .prepare("SELECT * FROM events WHERE sequence > ? ORDER BY sequence ASC LIMIT 50")
      .all(lastSeq) as EventRow[];
    const last = rows[rows.length - 1];
    const newCursor = last !== undefined ? last.sequence : lastSeq;
    return { rows, newCursor };
  } catch {
    return { rows: [], newCursor: lastSeq };
  }
}

interface StreamState {
  lastObsRowId: number;
  lastEventSeq: number;
  heartbeatCounter: number;
}

function initStreamState(
  db: Database.Database,
  lastObsRowIdStr: string | undefined,
  lastEventSeqStr: string | undefined,
): StreamState {
  const lastObsRowId = lastObsRowIdStr ? Number.parseInt(lastObsRowIdStr, 10) : getMaxObsRowId(db);
  const lastEventSeq = lastEventSeqStr ? Number.parseInt(lastEventSeqStr, 10) : getMaxEventSeq(db);
  return { lastObsRowId, lastEventSeq, heartbeatCounter: 0 };
}

async function emitObservations(
  stream: { writeSSE: (msg: { event: string; data: string; id: string }) => Promise<void> },
  db: Database.Database,
  state: StreamState,
): Promise<void> {
  const obsResult = pollObservations(db, state.lastObsRowId);
  state.lastObsRowId = obsResult.newCursor;
  for (const row of obsResult.rows) {
    const obs = rowToObservation(row);
    await stream.writeSSE({
      event: "observation",
      data: JSON.stringify(obs),
      id: `obs:${String(row.rowid)}`,
    });
  }
}

async function emitEvents(
  stream: { writeSSE: (msg: { event: string; data: string; id: string }) => Promise<void> },
  db: Database.Database,
  state: StreamState,
): Promise<void> {
  const evtResult = pollEvents(db, state.lastEventSeq);
  state.lastEventSeq = evtResult.newCursor;
  for (const row of evtResult.rows) {
    await stream.writeSSE({
      event: "event",
      data: JSON.stringify({
        id: row.id,
        sequence: row.sequence,
        type: row.type,
        source: row.source,
        task_id: row.task_id,
        timestamp: row.timestamp,
        payload: fromSqliteJson(row.payload) ?? {},
      }),
      id: `evt:${String(row.sequence)}`,
    });
  }
}

async function emitHeartbeatIfDue(
  stream: { writeSSE: (msg: { event: string; data: string }) => Promise<void> },
  state: StreamState,
): Promise<void> {
  state.heartbeatCounter += POLL_INTERVAL_MS;
  if (state.heartbeatCounter >= HEARTBEAT_INTERVAL_MS) {
    state.heartbeatCounter = 0;
    await stream.writeSSE({
      event: "heartbeat",
      data: JSON.stringify({
        lastObsRowId: state.lastObsRowId,
        lastEventSeq: state.lastEventSeq,
      }),
    });
  }
}

export function streamRoutes(deps: StreamRoutesDeps): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    const lastObsRowIdStr = c.req.query("lastObsRowId");
    const lastEventSeqStr = c.req.query("lastEventSeq");

    return streamSSE(c, async (stream) => {
      const state = initStreamState(deps.db, lastObsRowIdStr, lastEventSeqStr);

      while (true) {
        await emitObservations(stream, deps.db, state);
        await emitEvents(stream, deps.db, state);
        await emitHeartbeatIfDue(stream, state);
        await stream.sleep(POLL_INTERVAL_MS);
      }
    });
  });

  return app;
}
