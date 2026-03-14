import { existsSync } from "node:fs";
import { join } from "node:path";

import BetterSqlite3 from "better-sqlite3";

import { getOutput } from "../output.js";

// ── Row Types ────────────────────────────────────────────────────────────────

interface TaskRow {
  id: string;
  state: string;
  sub_state: string | null;
  priority: number;
  title: string;
  description: string | null;
  repo: string | null;
  created_at: string;
  llm_tokens: number;
  llm_cost_usd: number;
}

interface TransitionRow {
  from_state: string;
  to_state: string;
  reason: string | null;
  triggered_by: string | null;
  timestamp: string;
}

interface EventRow {
  type: string;
  source: string | null;
  timestamp: string;
  payload: string | null;
}

interface JournalRow {
  type: string;
  summary: string;
  detail: string | null;
  phase: string;
  timestamp: string;
}

// ── Timeline Entry ───────────────────────────────────────────────────────────

interface TimelineEntry {
  timestamp: string;
  kind: "transition" | "event";
  summary: string;
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
  } catch {
    out.error(`Failed to open database at ${dbPath}.`);
    return 1;
  }

  try {
    return queryAndDisplay(db, taskId);
  } finally {
    db.close();
  }
}

function queryAndDisplay(db: BetterSqlite3.Database, taskId: string): number {
  const out = getOutput();

  // 1. Task basics
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
  const events = db
    .prepare("SELECT * FROM events WHERE task_id = ? ORDER BY sequence ASC")
    .all(taskId) as EventRow[];

  // 4. Journal entries (last 5)
  const journal = db
    .prepare("SELECT * FROM journal_entries WHERE task_id = ? ORDER BY timestamp ASC LIMIT 5")
    .all(taskId) as JournalRow[];

  // JSON mode
  if (out.mode === "json") {
    out.data({
      task: {
        id: task.id,
        state: task.state,
        sub_state: task.sub_state,
        priority: task.priority,
        description: task.description,
        repo: task.repo,
        created_at: task.created_at,
      },
      transitions,
      events: events.map((e) => ({
        type: e.type,
        source: e.source,
        timestamp: e.timestamp,
        payload: e.payload ? safeJsonParse(e.payload) : null,
      })),
      journal,
      cost: { tokens: task.llm_tokens, usd: task.llm_cost_usd },
    });
    return 0;
  }

  // Human mode
  out.blank();
  out.keyValue("Task", task.id);
  const stateDisplay = task.sub_state ? `${task.state} (${task.sub_state})` : task.state;
  out.keyValue("State", stateDisplay);
  out.keyValue("Priority", String(task.priority));
  out.keyValue("Created", `${task.created_at} (${timeAgo(task.created_at)})`);
  if (task.repo) {
    out.keyValue("Repo", task.repo);
  }
  if (task.description) {
    out.keyValue("Description", task.description);
  }

  // Timeline (merge transitions + events by timestamp)
  out.blank();
  const timeline = buildTimeline(transitions, events);

  if (timeline.length === 0) {
    out.log("  No activity recorded.");
  } else {
    out.heading("Timeline:");
    for (const entry of timeline) {
      const time = formatTime(entry.timestamp);
      out.log(`  ${time}  ${entry.summary}`);
    }
  }

  // Journal
  if (journal.length > 0) {
    out.blank();
    out.heading(`Journal (last ${String(journal.length)} entries):`);
    for (const entry of journal) {
      const time = formatTime(entry.timestamp);
      const phase = `[${entry.phase}]`;
      out.log(`  ${time}  ${phase.padEnd(16)} ${entry.summary}`);
    }
  }

  // Cost
  out.blank();
  out.keyValue(
    "Cost",
    `$${task.llm_cost_usd.toFixed(2)} total (${String(task.llm_tokens)} tokens)`,
  );

  return 0;
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

function timeAgo(iso: string): string {
  try {
    const ms = Date.now() - new Date(iso).getTime();
    const minutes = Math.floor(ms / 60000);
    if (minutes < 60) {
      return `${String(minutes)}m ago`;
    }
    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
      return `${String(hours)}h ago`;
    }
    const days = Math.floor(hours / 24);
    return `${String(days)}d ago`;
  } catch {
    return "unknown";
  }
}

function safeJsonParse(str: string): unknown {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}
