import type Database from "better-sqlite3";
/**
 * Task listing & detail API routes.
 */
import { Hono } from "hono";

import type { ObservationStore } from "../../core/observer/index.js";
import { deriveTraceId } from "../../core/observer/otlp/index.js";
import { PipelinePhaseSchema } from "../../core/orchestrator/pipeline/types.js";
import { cancelTask } from "../../core/task-engine/index.js";
import { fromSqliteJson } from "../../db/serialize.js";
import { TaskStates } from "../../schemas/task.js";

/** The real pipeline phase names, as a set, for validating values parsed out of observation inputs. */
const REAL_PHASES = new Set<string>(PipelinePhaseSchema.options);

/** Dependencies injected into task API route handlers. */
export interface TaskRoutesDeps {
  db: Database.Database;
  writeDb: Database.Database;
  observationStore: ObservationStore;
}

/** Columns for the lightweight task list. Avoids needing rowToTask. */
const LIST_COLUMNS = `id, title, state, sub_state, phase, sub_phase, phase_iteration, total_reworks,
  priority, repo, agent_cost_usd, agent_tokens, created_at, started_at, completed_at,
  last_transition_at, workspace`;

interface TaskListRow {
  id: string;
  title: string;
  state: string;
  sub_state: string | null;
  phase: string | null;
  sub_phase: string | null;
  phase_iteration: number;
  total_reworks: number;
  priority: number;
  repo: string | null;
  agent_cost_usd: number;
  agent_tokens: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  last_transition_at: string;
  workspace: string | null;
}

interface TaskListItem {
  id: string;
  title: string;
  state: string;
  sub_state: string | null;
  phase: string | null;
  sub_phase: string | null;
  phase_iteration: number;
  total_reworks: number;
  priority: number;
  repo: string | null;
  agent_cost_usd: number;
  agent_tokens: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  last_transition_at: string;
  worktree_path: string | null;
}

function mapListRow(row: TaskListRow): TaskListItem {
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
    sub_phase: row.sub_phase,
    phase_iteration: row.phase_iteration,
    total_reworks: row.total_reworks,
    priority: row.priority,
    repo: row.repo,
    agent_cost_usd: row.agent_cost_usd,
    agent_tokens: row.agent_tokens,
    created_at: row.created_at,
    started_at: row.started_at,
    completed_at: row.completed_at,
    last_transition_at: row.last_transition_at,
    worktree_path: worktreePath,
  };
}

/**
 * Read the real pipeline phase out of a phase_transition observation's `input` JSON. The runner stores the
 * phase in `input.phase` (the `name` column holds the event name, not the phase), so this is the only honest
 * source. Returns null when the input is absent, unparseable, or carries a value that is not a real phase.
 */
function parsePhaseFromInput(input: string | null): string | null {
  if (!input) {
    return null;
  }
  const parsed = fromSqliteJson<Record<string, unknown>>(input);
  const phase = parsed?.["phase"];
  if (typeof phase === "string" && REAL_PHASES.has(phase)) {
    return phase;
  }
  return null;
}

/** Parse JSON columns for full task detail. */
function mapFullTask(row: Record<string, unknown>): Record<string, unknown> {
  const jsonFields = [
    "external_ref",
    "acceptance_criteria",
    "team",
    "related",
    "decisions",
    "workspace",
    "review",
    "blocked",
    "last_trace_link",
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

/**
 * Resolve the OTLP trace id of a task's most recent dispatch, or null.
 *
 * The newest observation that carries a `trace_id` belongs to the latest dispatch (a re-dispatch mints a new
 * trace ULID); its decode is the trace the user most likely wants to open. Decoding goes through the shared
 * `deriveTraceId` so the deep-link matches the exported span byte-for-byte. A non-ULID stored id throws in the
 * decoder — we treat that as "no link" rather than failing the whole detail response.
 */
function latestTraceOtlpId(db: Database.Database, taskId: string): string | null {
  const row = db
    .prepare(
      `SELECT trace_id FROM observations
       WHERE task_id = ? AND trace_id IS NOT NULL
       ORDER BY rowid DESC LIMIT 1`,
    )
    .get(taskId) as { trace_id: string } | undefined;
  if (!row) {
    return null;
  }
  try {
    return deriveTraceId(row.trace_id);
  } catch {
    return null;
  }
}

/** Registers task listing, detail, timeline, phase, trace, and cancel endpoints. */
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
        .prepare(`SELECT ${LIST_COLUMNS} FROM tasks WHERE state = ? ORDER BY last_transition_at DESC LIMIT ?`)
        .all(state, limit) as TaskListRow[];
    } else {
      rows = deps.db
        .prepare(`SELECT ${LIST_COLUMNS} FROM tasks ORDER BY last_transition_at DESC LIMIT ?`)
        .all(limit) as TaskListRow[];
    }

    const tasks = rows.map(mapListRow);

    // Bulk-fetch the DISTINCT real phases each task actually ran. The phase name lives in the observation's
    // `input.phase` (the `name` column holds the event name — phase_entered/sub_phase_started/sub_phase_result),
    // so we parse the input JSON, read `phase`, keep only genuine pipeline phases, and de-dup preserving the
    // first-seen order. Rows are read ascending by rowid so the order reflects the real pipeline progression.
    const taskIds = tasks.map((t) => t.id);
    const phasesRanMap: Record<string, string[]> = {};
    if (taskIds.length > 0) {
      try {
        const phaseRows = deps.db
          .prepare(
            `SELECT task_id, input FROM observations
             WHERE type = 'phase_transition' AND task_id IN (${taskIds.map(() => "?").join(",")})
             ORDER BY rowid ASC`,
          )
          .all(...taskIds) as Array<{ task_id: string; input: string | null }>;
        for (const row of phaseRows) {
          const phase = parsePhaseFromInput(row.input);
          if (phase === null) {
            continue;
          }
          const arr = phasesRanMap[row.task_id] ?? [];
          if (!arr.includes(phase)) {
            arr.push(phase);
          }
          phasesRanMap[row.task_id] = arr;
        }
      } catch {
        // table may not have data yet
      }
    }

    // Fetch latest transition reason for blocked/failed tasks (single batch query)
    const reasonMap: Record<string, string> = {};
    const blockedIds = tasks
      .filter((t) => t.state === TaskStates.blocked || t.state === TaskStates.failed)
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
    const row = deps.db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as Record<string, unknown> | undefined;

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

    // The OTLP trace id for the "View trace in Jaeger" deep-link. A task carries no trace_id of its own
    // (each dispatch mints a fresh trace ULID into its observations), so we take the most-recent dispatch's
    // trace_id and decode it through the SAME deriveTraceId the exporter used — never a reimplementation, so
    // the link can never drift from the exported span. Null when the task has never been dispatched, or if a
    // stored id ever fails the strict ULID decode (we swallow rather than 500 a detail page over a link).
    task["trace_otlp_id"] = latestTraceOtlpId(deps.db, taskId);

    return c.json({ task });
  });

  /** Task timeline: state-change events + journal + rich observations (decisions, agent runs, verdicts, actions), chronological. */
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

    // Rich observations — the decisions, agent runs, verdicts, actions, and state changes that tell the
    // story, each carrying its input/output (and blob refs) for drill-down. Phase transitions are left to
    // the Phases tab and the journal narrative, so the timeline stays the meaningful beats, not every step.
    const narrativeTypes = new Set([
      "task_execution",
      "decision_point",
      "agent_call",
      "safety_verdict",
      "tool_execution",
      "state_transition",
    ]);
    const observations = deps.observationStore
      .query({ task_id: taskId, limit: 2000 })
      .filter((obs) => narrativeTypes.has(obs.type));

    // Merge into unified timeline
    type TimelineItem = {
      kind: "event" | "journal" | "observation";
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

    for (const obs of observations) {
      timeline.push({
        kind: "observation",
        timestamp: obs.start_time,
        data: obs as unknown as Record<string, unknown>,
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

  /** Agent traces for a task. */
  app.get("/:id/agent-traces", (c) => {
    const taskId = c.req.param("id");
    const phase = c.req.query("phase");
    const traces = deps.observationStore.query({
      type: "agent_call",
      task_id: taskId,
      phase: phase ?? undefined,
      limit: 1000,
    });
    return c.json({ traces });
  });

  /** Cancel a task — a guarded, versioned write to the `cancelled` terminal state (shared with `engineer cancel`). */
  app.post("/:id/cancel", (c) => {
    const taskId = c.req.param("id");
    try {
      const result = cancelTask(deps.writeDb, taskId, { reason: "dashboard_cancel", triggeredBy: "dashboard" });
      if (result.outcome === "not_found") {
        return c.json({ error: "Task not found" }, 404);
      }
      if (result.outcome === "not_cancellable") {
        return c.json({ error: `Cannot cancel task in "${result.state}" state` }, 400);
      }
      return c.json({ success: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, 500);
    }
  });

  return app;
}
