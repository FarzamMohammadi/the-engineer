import type Database from "better-sqlite3";
/**
 * Task listing & detail API routes.
 */
import { Hono } from "hono";

import type { ObservabilityStore } from "../../core/observability/index.js";

export interface TaskRoutesDeps {
  db: Database.Database;
  observability: ObservabilityStore;
}

/** Columns for the lightweight task list. Avoids needing rowToTask. */
const LIST_COLUMNS = `id, title, state, sub_state, phase, priority, repo,
  llm_cost_usd, llm_tokens, created_at, started_at, completed_at,
  last_transition_at, parent_id, children`;

interface TaskListRow {
  id: string;
  title: string;
  state: string;
  sub_state: string | null;
  phase: string | null;
  priority: number;
  repo: string | null;
  llm_cost_usd: number;
  llm_tokens: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  last_transition_at: string;
  parent_id: string | null;
  children: string;
}

function mapListRow(row: TaskListRow) {
  let childrenCount = 0;
  try {
    childrenCount = (JSON.parse(row.children) as unknown[]).length;
  } catch {
    /* empty */
  }
  return {
    id: row.id,
    title: row.title,
    state: row.state,
    sub_state: row.sub_state,
    phase: row.phase,
    priority: row.priority,
    repo: row.repo,
    llm_cost_usd: row.llm_cost_usd,
    llm_tokens: row.llm_tokens,
    created_at: row.created_at,
    started_at: row.started_at,
    completed_at: row.completed_at,
    last_transition_at: row.last_transition_at,
    parent_id: row.parent_id,
    children_count: childrenCount,
  };
}

/** Parse JSON columns for full task detail. */
function mapFullTask(row: Record<string, unknown>) {
  const jsonFields = [
    "external_ref",
    "children",
    "acceptance_criteria",
    "team",
    "related",
    "decisions",
    "child_summaries",
    "workspace",
    "review",
    "blocked",
  ];
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (jsonFields.includes(key) && typeof value === "string") {
      try {
        result[key] = JSON.parse(value);
      } catch {
        result[key] = value;
      }
    } else {
      result[key] = value;
    }
  }
  return result;
}

export function taskRoutes(deps: TaskRoutesDeps): Hono {
  const app = new Hono();

  /** List tasks, optionally filter by state. */
  app.get("/", (c) => {
    const state = c.req.query("state");
    const limitStr = c.req.query("limit");
    const limit = limitStr ? Number.parseInt(limitStr, 10) : 100;

    let rows: TaskListRow[];
    if (state) {
      rows = deps.db
        .prepare(
          `SELECT ${LIST_COLUMNS} FROM tasks WHERE state = ? ORDER BY last_transition_at DESC LIMIT ?`,
        )
        .all(state, limit) as TaskListRow[];
    } else {
      rows = deps.db
        .prepare(`SELECT ${LIST_COLUMNS} FROM tasks ORDER BY last_transition_at DESC LIMIT ?`)
        .all(limit) as TaskListRow[];
    }

    const tasks = rows.map(mapListRow);
    return c.json({ tasks, count: tasks.length });
  });

  /** Full task detail. */
  app.get("/:id", (c) => {
    const taskId = c.req.param("id");
    const row = deps.db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as
      | Record<string, unknown>
      | undefined;

    if (!row) {
      return c.json({ error: "Task not found" }, 404);
    }

    return c.json({ task: mapFullTask(row) });
  });

  /** Task timeline: state transitions + journal + action traces, chronological. */
  app.get("/:id/timeline", (c) => {
    const taskId = c.req.param("id");

    // State change events
    const stateEvents = deps.db
      .prepare(
        `SELECT id, type, source, timestamp, payload FROM events
         WHERE task_id = ? AND type IN ('task.state_changed', 'task.created')
         ORDER BY sequence ASC`,
      )
      .all(taskId) as Record<string, unknown>[];

    // Journal entries
    const journalEntries = deps.db
      .prepare(
        `SELECT id, session_id, phase, type, summary, detail, timestamp FROM journal_entries
         WHERE task_id = ? ORDER BY rowid ASC`,
      )
      .all(taskId) as Record<string, unknown>[];

    // Action traces
    const actionTraces = deps.observability.getActionTraces(taskId);

    // Merge into unified timeline
    type TimelineItem = {
      kind: "event" | "journal" | "action";
      timestamp: string;
      data: Record<string, unknown>;
    };

    const timeline: TimelineItem[] = [];

    for (const e of stateEvents) {
      timeline.push({
        kind: "event",
        timestamp: e["timestamp"] as string,
        data: {
          id: e["id"],
          type: e["type"],
          source: e["source"],
          payload: JSON.parse((e["payload"] as string) || "{}"),
        },
      });
    }

    for (const j of journalEntries) {
      timeline.push({
        kind: "journal",
        timestamp: j["timestamp"] as string,
        data: {
          id: j["id"],
          session_id: j["session_id"],
          phase: j["phase"],
          entry_type: j["type"],
          content: j["summary"],
          detail: j["detail"],
        },
      });
    }

    for (const a of actionTraces) {
      timeline.push({
        kind: "action",
        timestamp: a.timestamp,
        data: a as unknown as Record<string, unknown>,
      });
    }

    // Sort chronologically
    timeline.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    return c.json({ timeline });
  });

  /** Phase metrics for a task. */
  app.get("/:id/phases", (c) => {
    const taskId = c.req.param("id");
    const metrics = deps.observability.getPhaseMetrics(taskId);
    return c.json({ phases: metrics });
  });

  /** Action traces for a task, optional phase filter. */
  app.get("/:id/traces", (c) => {
    const taskId = c.req.param("id");
    const phase = c.req.query("phase");
    const traces = deps.observability.getActionTraces(taskId, phase);
    return c.json({ traces });
  });

  /** LLM traces for a task. */
  app.get("/:id/llm-traces", (c) => {
    const taskId = c.req.param("id");
    const phase = c.req.query("phase");
    const traces = deps.observability.getLlmTraces(taskId, phase);
    return c.json({ traces });
  });

  return app;
}
