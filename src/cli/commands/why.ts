import { existsSync } from "node:fs";
import { join } from "node:path";

import BetterSqlite3 from "better-sqlite3";

import { timeAgo } from "../format.js";
import { type Output, getOutput } from "../output.js";
import { resolveTaskId } from "../resolve-task.js";

// ── Row Types ────────────────────────────────────────────────────────────────

interface TaskRow {
  readonly id: string;
  readonly state: string;
  readonly sub_state: string | null;
  readonly phase: string | null;
  readonly sub_phase: string | null;
  readonly priority: number;
  readonly title: string;
  readonly description: string | null;
  readonly repo: string | null;
  readonly blocked: string | null;
  readonly created_at: string;
  readonly agent_tokens: number;
  readonly agent_cost_usd: number;
}

interface TransitionRow {
  readonly from_state: string;
  readonly to_state: string;
  readonly reason: string | null;
  readonly triggered_by: string | null;
  readonly timestamp: string;
}

interface EventRow {
  readonly type: string;
  readonly source: string | null;
  readonly timestamp: string;
  readonly payload: string | null;
}

interface JournalRow {
  readonly type: string;
  readonly summary: string;
  readonly detail: string | null;
  readonly phase: string;
  readonly timestamp: string;
}

// ── Timeline Entry ───────────────────────────────────────────────────────────

interface TimelineEntry {
  readonly timestamp: string;
  readonly kind: "transition" | "event";
  readonly summary: string;
}

// ── Command ──────────────────────────────────────────────────────────────────

/** Displays a timeline of significant events for a task. Returns exit code. */
export function runWhy(engineerHome: string, taskId: string): number {
  const out = getOutput();
  const dbPath = join(engineerHome, "data", "engineer.db");

  if (!existsSync(dbPath)) {
    out.error(`No database found at ${dbPath}. Run 'engineer start' first.`);
    return 1;
  }

  let db: BetterSqlite3.Database;
  try {
    db = new BetterSqlite3(dbPath, { readonly: true });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    out.error(`Failed to open database at ${dbPath}: ${detail}`);
    return 1;
  }

  try {
    return queryAndDisplay(db, taskId);
  } finally {
    db.close();
  }
}

function queryAndDisplay(db: BetterSqlite3.Database, taskIdInput: string): number {
  const out = getOutput();

  // 1. Resolve prefix to full ID
  const taskId = resolveTaskId(db, taskIdInput);
  if (!taskId) {
    return 1;
  }

  const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as TaskRow | undefined;

  if (!task) {
    out.error(`Task not found: ${taskId}`);
    return 1;
  }

  // 2. State transitions
  const transitions = db
    .prepare("SELECT * FROM state_transitions WHERE task_id = ? ORDER BY timestamp ASC")
    .all(taskId) as TransitionRow[];

  // 3. Events
  const events = db.prepare("SELECT * FROM events WHERE task_id = ? ORDER BY sequence ASC").all(taskId) as EventRow[];

  // 4. Journal entries (last 5)
  const journal = db
    .prepare("SELECT * FROM journal_entries WHERE task_id = ? ORDER BY timestamp ASC LIMIT 5")
    .all(taskId) as JournalRow[];

  if (out.mode === "json") {
    renderJson(out, task, transitions, events, journal);
  } else {
    renderHuman(out, task, transitions, events, journal);
  }
  return 0;
}

/** Emit the task's full activity as one JSON object — projected to clean shapes, no internal columns leaked. */
function renderJson(
  out: Output,
  task: TaskRow,
  transitions: TransitionRow[],
  events: EventRow[],
  journal: JournalRow[],
): void {
  out.data({
    task: {
      id: task.id,
      state: task.state,
      sub_state: task.sub_state,
      phase: task.phase,
      sub_phase: task.sub_phase,
      priority: task.priority,
      description: task.description,
      repo: task.repo,
      blocked: task.blocked ? safeJsonParse(task.blocked) : null,
      created_at: task.created_at,
    },
    transitions,
    events: events.map((e) => ({
      type: e.type,
      source: e.source,
      timestamp: e.timestamp,
      payload: e.payload ? safeJsonParse(e.payload) : null,
    })),
    journal: journal.map((j) => ({
      type: j.type,
      summary: j.summary,
      detail: j.detail,
      phase: j.phase,
      timestamp: j.timestamp,
    })),
    cost: { tokens: task.agent_tokens, usd: task.agent_cost_usd },
  });
}

/** Render the task's header, block reason, timeline, journal, and cost for a human reader. */
function renderHuman(
  out: Output,
  task: TaskRow,
  transitions: TransitionRow[],
  events: EventRow[],
  journal: JournalRow[],
): void {
  out.blank();
  out.keyValue("Task", task.id);
  const stateDisplay = task.sub_state ? `${task.state} (${task.sub_state})` : task.state;
  out.keyValue("State", stateDisplay);
  if (task.phase) {
    const phaseDisplay = task.sub_phase ? `${task.phase} (${task.sub_phase})` : task.phase;
    out.keyValue("Phase", phaseDisplay);
  }
  out.keyValue("Priority", String(task.priority));
  out.keyValue("Created", `${task.created_at} (${timeAgo(task.created_at)})`);
  if (task.repo) {
    out.keyValue("Repo", task.repo);
  }
  if (task.description) {
    out.keyValue("Description", task.description);
  }
  renderBlocked(out, task.blocked);

  out.blank();
  const timeline = buildTimeline(transitions, events);
  if (timeline.length === 0) {
    out.log("  No activity recorded.");
  } else {
    out.heading("Timeline:");
    for (const entry of timeline) {
      out.log(`  ${formatTime(entry.timestamp)}  ${entry.summary}`);
    }
  }

  if (journal.length > 0) {
    out.blank();
    out.heading(`Journal (last ${String(journal.length)} entries):`);
    for (const entry of journal) {
      out.log(`  ${formatTime(entry.timestamp)}  ${`[${entry.phase}]`.padEnd(16)} ${entry.summary}`);
    }
  }

  out.blank();
  out.keyValue("Cost", `$${task.agent_cost_usd.toFixed(2)} total (${String(task.agent_tokens)} tokens)`);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildTimeline(transitions: TransitionRow[], events: EventRow[]): TimelineEntry[] {
  const timeline: TimelineEntry[] = [];

  for (const t of transitions) {
    const reason = t.reason ? ` (${t.reason})` : "";
    timeline.push({
      timestamp: t.timestamp,
      kind: "transition",
      summary: `${t.from_state} → ${t.to_state}${reason}`,
    });
  }

  for (const e of events) {
    let summary = e.type;
    if (e.type === "cost.incurred" && e.payload) {
      const parsed = safeJsonParse(e.payload);
      if (parsed && typeof parsed === "object" && "amount_usd" in parsed) {
        summary = `cost.incurred $${Number(parsed.amount_usd).toFixed(2)}`;
      }
    }
    timeline.push({
      timestamp: e.timestamp,
      kind: "event",
      summary,
    });
  }

  timeline.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return timeline;
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toISOString().slice(11, 19);
  } catch {
    return iso.slice(0, 8);
  }
}

function safeJsonParse(str: string): unknown {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

/**
 * Surfaces the typed block payload for a blocked task: why it stopped (reason),
 * the precise cause (category), and what it needs to proceed (needed). A malformed
 * or empty payload prints nothing rather than failing — `why` must stay readable.
 */
function renderBlocked(out: Output, blockedRaw: string | null): void {
  if (!blockedRaw) {
    return;
  }
  const parsed = safeJsonParse(blockedRaw);
  if (!parsed || typeof parsed !== "object") {
    return;
  }
  const blocked = parsed as Record<string, unknown>;
  const reason = typeof blocked["reason"] === "string" ? blocked["reason"] : null;
  const category = typeof blocked["category"] === "string" ? blocked["category"] : null;
  const needed = typeof blocked["needed"] === "string" ? blocked["needed"] : null;

  if (reason) {
    out.keyValue("Blocked", category ? `${reason} (${category})` : reason);
  } else if (category) {
    out.keyValue("Blocked", category);
  }
  if (needed) {
    out.keyValue("Needs", needed);
  }
}
