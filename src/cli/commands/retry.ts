import { existsSync } from "node:fs";
import { join } from "node:path";

import BetterSqlite3 from "better-sqlite3";

import { TaskStates } from "../../schemas/task.js";
import { getOutput } from "../output.js";

// ── Row Types ────────────────────────────────────────────────────────────────

interface TaskRow {
  readonly id: string;
  readonly state: string;
  readonly sub_state: string | null;
  readonly title: string;
  readonly blocked: string | null;
  readonly not_before: string | null;
}

// ── Command ──────────────────────────────────────────────────────────────────

/**
 * Retry a blocked or failed task by transitioning it back to queued.
 *
 * Resets both per-category retry counters (crash, LLM-unavailable) and
 * clears `not_before` so the retry cycle starts fresh. Direct DB access
 * (no full bootstrap) keeps it fast and usable even when the daemon is stopped.
 */
export function runRetry(engineerHome: string, taskId: string): number {
  const out = getOutput();
  const dbPath = join(engineerHome, "data", "engineer.db");

  if (!existsSync(dbPath)) {
    out.error(`No database found at ${dbPath}. Run 'engineer start' first.`);
    return 1;
  }

  let db: BetterSqlite3.Database;
  try {
    db = new BetterSqlite3(dbPath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    out.error(`Failed to open database at ${dbPath}: ${detail}`);
    return 1;
  }

  try {
    return retryTask(db, taskId);
  } finally {
    db.close();
  }
}

function retryTask(db: BetterSqlite3.Database, taskId: string): number {
  const out = getOutput();

  const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as TaskRow | undefined;

  if (!task) {
    out.error(`Task not found: ${taskId}`);
    return 1;
  }

  const retryableStates = new Set([TaskStates.blocked, TaskStates.failed]);
  if (!retryableStates.has(task.state as typeof TaskStates.blocked)) {
    out.error(`Task is in state "${task.state}". Only blocked or failed tasks can be retried.`);
    return 1;
  }

  const previousState = task.state;
  const now = new Date().toISOString();

  db.transaction(() => {
    db.prepare(
      `INSERT INTO state_transitions (task_id, from_state, to_state, reason, triggered_by, timestamp)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(taskId, previousState, TaskStates.queued, "cli_retry", "cli", now);

    db.prepare("UPDATE tasks SET state = ?, sub_state = NULL, not_before = NULL WHERE id = ?").run(
      TaskStates.queued,
      taskId,
    );

    if (previousState === TaskStates.blocked) {
      clearBlockedPreservingContacts(db, taskId, task.blocked);
    }

    db.prepare("UPDATE tasks SET consecutive_crash_count = 0, consecutive_llm_unavailable_count = 0 WHERE id = ?").run(
      taskId,
    );
  })();

  if (out.mode === "json") {
    out.data({
      taskId,
      previousState,
      newState: TaskStates.queued,
      retriedAt: now,
    });
  } else {
    out.success(`Task ${taskId} retried — moved from ${previousState} to queued.`);
    out.log(`  Title: ${task.title}`);
    out.log("  The daemon will pick it up on the next scheduling cycle.");
  }

  return 0;
}

/**
 * Resets the `blocked` JSON column on a retried task. The `reason`, `needed`,
 * `efforts_made`, and `waiting_for` fields are cleared, but the `contacted`
 * array is preserved as history of outreach attempts. If the column is empty
 * or the JSON is malformed, the column is set to NULL.
 */
function clearBlockedPreservingContacts(db: BetterSqlite3.Database, taskId: string, blockedRaw: string | null): void {
  if (!blockedRaw) {
    return;
  }

  const contacted = extractContactedHistory(blockedRaw);
  if (contacted.length === 0) {
    db.prepare("UPDATE tasks SET blocked = NULL WHERE id = ?").run(taskId);
    return;
  }

  db.prepare("UPDATE tasks SET blocked = ? WHERE id = ?").run(
    JSON.stringify({ reason: "", efforts_made: [], contacted, needed: "", waiting_for: "" }),
    taskId,
  );
}

function extractContactedHistory(blockedRaw: string): unknown[] {
  try {
    const parsed = JSON.parse(blockedRaw) as Record<string, unknown>;
    return Array.isArray(parsed["contacted"]) ? parsed["contacted"] : [];
  } catch {
    return [];
  }
}
