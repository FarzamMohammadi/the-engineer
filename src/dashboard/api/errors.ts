/** Consolidated error API — combines failed tasks, error observations, and error events. */
import type Database from "better-sqlite3";
import { Hono } from "hono";

import type { ObservationStore } from "../../core/observer/index.js";
import { fromSqliteJson } from "../../db/serialize.js";

/** Dependencies injected into error API route handlers. */
export interface ErrorRoutesDeps {
  db: Database.Database;
  observationStore: ObservationStore;
}

interface ErrorEntry {
  kind: "task_failure" | "observation" | "event";
  id: string;
  task_id: string | null;
  task_title: string | null;
  message: string;
  detail: string | null;
  timestamp: string;
  level: "error" | "warn";
}

function collectFailedTasks(db: Database.Database, limit: number): ErrorEntry[] {
  const failedTasks = db
    .prepare(
      `SELECT id, title, completed_at FROM tasks
       WHERE state = 'failed' ORDER BY completed_at DESC LIMIT ?`,
    )
    .all(limit) as Array<{ id: string; title: string; completed_at: string | null }>;

  const failedIds = failedTasks.map((t) => t.id);
  const reasonMap = fetchFailureReasons(db, failedIds);

  return failedTasks.map((task) => ({
    kind: "task_failure" as const,
    id: `task-${task.id}`,
    task_id: task.id,
    task_title: task.title,
    message: reasonMap[task.id] ?? "Task failed",
    detail: null,
    timestamp: task.completed_at ?? new Date().toISOString(),
    level: "error" as const,
  }));
}

function fetchFailureReasons(db: Database.Database, taskIds: string[]): Record<string, string> {
  const reasonMap: Record<string, string> = {};
  if (taskIds.length === 0) {
    return reasonMap;
  }

  try {
    const rows = db
      .prepare(
        `SELECT task_id, reason FROM state_transitions
         WHERE to_state = 'failed'
           AND task_id IN (${taskIds.map(() => "?").join(",")})
         ORDER BY rowid DESC`,
      )
      .all(...taskIds) as Array<{ task_id: string; reason: string }>;
    for (const row of rows) {
      if (row.reason && !reasonMap[row.task_id]) {
        reasonMap[row.task_id] = row.reason;
      }
    }
  } catch {
    // table may not exist yet
  }
  return reasonMap;
}

function collectObservationErrors(store: ObservationStore, level: string | undefined, limit: number): ErrorEntry[] {
  const levels = level === "warn" ? ["warn"] : level === "error" ? ["error"] : ["error", "warn"];
  const results: ErrorEntry[] = [];

  for (const observationLevel of levels) {
    const observations = store.query({ level: observationLevel as "error" | "warn", limit });
    for (const observation of observations) {
      results.push({
        kind: "observation",
        id: observation.id,
        task_id: observation.task_id,
        task_title: null,
        message: observation.error_message ?? observation.name,
        detail: observation.error_message ? observation.name : null,
        timestamp: observation.start_time,
        level: observation.level as "error" | "warn",
      });
    }
  }
  return results;
}

function collectErrorEvents(db: Database.Database, limit: number): ErrorEntry[] {
  try {
    const rows = db
      .prepare(
        `SELECT id, type, task_id, timestamp, payload FROM events
         WHERE type IN ('cost.quota_exhausted', 'health.check_failed', 'task.failed')
         ORDER BY sequence DESC LIMIT ?`,
      )
      .all(limit) as Array<{
      id: string;
      type: string;
      task_id: string | null;
      timestamp: string;
      payload: string;
    }>;

    return rows.map((event) => {
      const payload = fromSqliteJson<Record<string, unknown>>(event.payload) ?? {};
      const message =
        typeof payload["reason"] === "string"
          ? payload["reason"]
          : typeof payload["message"] === "string"
            ? payload["message"]
            : event.type;
      return {
        kind: "event" as const,
        id: event.id,
        task_id: event.task_id,
        task_title: null,
        message,
        detail: event.type,
        timestamp: event.timestamp,
        level: "error" as const,
      };
    });
  } catch {
    return [];
  }
}

/** Registers the consolidated error listing endpoint across tasks, observations, and events. */
export function errorRoutes(deps: ErrorRoutesDeps): Hono {
  const app = new Hono();

  /** GET / — consolidated error view across all sources. */
  app.get("/", (c) => {
    const level = c.req.query("level");
    const limitStr = c.req.query("limit");
    const limit = limitStr ? Number.parseInt(limitStr, 10) : 100;

    const errors: ErrorEntry[] = [
      ...collectFailedTasks(deps.db, limit),
      ...collectObservationErrors(deps.observationStore, level, limit),
      ...collectErrorEvents(deps.db, limit),
    ];

    errors.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    const limited = errors.slice(0, limit);

    return c.json({ errors: limited, count: limited.length });
  });

  return app;
}
