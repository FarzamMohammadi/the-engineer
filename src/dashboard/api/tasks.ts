import type Database from "better-sqlite3";
/**
 * Task listing & detail API routes.
 */
import { Hono } from "hono";

import type { ObservationStore } from "../../core/observer/index.js";
import { fromSqliteJson } from "../../db/serialize.js";

export interface TaskRoutesDeps {
  db: Database.Database;
  observationStore: ObservationStore;
}

/** Columns for the lightweight task list. Avoids needing rowToTask. */
const LIST_COLUMNS = `id, title, state, sub_state, phase, priority, repo,
  llm_cost_usd, llm_tokens, created_at, started_at, completed_at,
  last_transition_at, parent_id, children, workspace`;

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
  workspace: string | null;
}

function mapListRow(row: TaskListRow) {
  let childrenCount = 0;
  try {
    childrenCount = (fromSqliteJson<unknown[]>(row.children) ?? []).length;
  } catch {
    /* empty */
  }
  let worktreePath: string | null = null;
  if (row.workspace) {
    const ws = fromSqliteJson<Record<string, unknown>>(row.workspace);
    worktreePath = (ws?.["worktree_path"] as string) ?? null;
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
    worktree_path: worktreePath,
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
      result[key] = fromSqliteJson(value) ?? value;
    } else {
      result[key] = value;
    }
  }
  return result;
}

export function taskRoutes(deps: TaskRoutesDeps): Hono {
  const app = new Hono();

  /** List tasks, optionally filter by state. */
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: list endpoint with phase + reason enrichment
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

    // Bulk-fetch which phases actually ran for each task (from observations)
    const taskIds = tasks.map((t) => t.id);
    const phasesRanMap: Record<string, string[]> = {};
    if (taskIds.length > 0) {
      try {
        const phaseRows = deps.db
          .prepare(
            `SELECT task_id, name as phase FROM observations
             WHERE type = 'phase_transition' AND task_id IN (${taskIds.map(() => "?").join(",")})`,
          )
          .all(...taskIds) as Array<{ task_id: string; phase: string }>;
        for (const row of phaseRows) {
          const arr = phasesRanMap[row.task_id] ?? [];
          arr.push(row.phase);
          phasesRanMap[row.task_id] = arr;
        }
      } catch {
        // table may not have data yet
      }
    }

    // Fetch latest transition reason for blocked/failed tasks (single batch query)
    const reasonMap: Record<string, string> = {};
    const blockedIds = tasks
      .filter((t) => t.state === "blocked" || t.state === "failed")
      .map((t) => t.id);
    if (blockedIds.length > 0) {
      try {
        const rows = deps.db
          .prepare(
            `SELECT task_id, reason FROM state_transitions
             WHERE rowid IN (SELECT MAX(rowid) FROM state_transitions WHERE task_id IN (${blockedIds.map(() => "?").join(",")}) GROUP BY task_id)`,
          )
          .all(...blockedIds) as Array<{ task_id: string; reason: string }>;
        for (const row of rows) {
          if (row.reason) {
            reasonMap[row.task_id] = row.reason;
          }
        }
      } catch {
        // table may not exist yet
      }
    }

    const tasksWithPhases = tasks.map((t) => ({
      ...t,
      phases_ran: phasesRanMap[t.id] ?? [],
      blocked_reason: reasonMap[t.id] ?? null,
    }));

    return c.json({ tasks: tasksWithPhases, count: tasksWithPhases.length });
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

    // Fetch the latest state transition reason (explains WHY task is in current state)
    const lastTransition = deps.db
      .prepare(
        `SELECT reason, triggered_by, from_state, to_state, timestamp
         FROM state_transitions WHERE task_id = ? ORDER BY rowid DESC LIMIT 1`,
      )
      .get(taskId) as Record<string, unknown> | undefined;

    const task = mapFullTask(row);
    if (lastTransition) {
      task["last_transition_reason"] = lastTransition["reason"];
      task["last_transition_by"] = lastTransition["triggered_by"];
      task["last_transition_from"] = lastTransition["from_state"];
    }

    return c.json({ task });
  });

  /** Task timeline: state transitions + journal + action observations, chronological. */
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

    // Action observations (tool_execution type)
    const actionObs = deps.observationStore.query({
      type: "tool_execution",
      task_id: taskId,
      limit: 1000,
    });

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
          payload: fromSqliteJson(e["payload"] as string | null) ?? {},
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

    for (const a of actionObs) {
      timeline.push({
        kind: "action",
        timestamp: a.start_time,
        data: a as unknown as Record<string, unknown>,
      });
    }

    // Sort chronologically
    timeline.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    return c.json({ timeline });
  });

  /** Phase metrics for a task (from phase_transition observations). */
  app.get("/:id/phases", (c) => {
    const taskId = c.req.param("id");
    const phases = deps.observationStore.query({
      type: "phase_transition",
      task_id: taskId,
      limit: 100,
    });
    return c.json({ phases });
  });

  /** Action traces for a task, optional phase filter. */
  app.get("/:id/traces", (c) => {
    const taskId = c.req.param("id");
    const phase = c.req.query("phase");
    const traces = deps.observationStore.query({
      type: "tool_execution",
      task_id: taskId,
      phase: phase ?? undefined,
      limit: 1000,
    });
    return c.json({ traces });
  });

  /** LLM traces for a task. */
  app.get("/:id/llm-traces", (c) => {
    const taskId = c.req.param("id");
    const phase = c.req.query("phase");
    const traces = deps.observationStore.query({
      type: "llm_call",
      task_id: taskId,
      phase: phase ?? undefined,
      limit: 1000,
    });
    return c.json({ traces });
  });

  return app;
}
