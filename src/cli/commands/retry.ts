import { existsSync } from "node:fs";
import { join } from "node:path";

import BetterSqlite3 from "better-sqlite3";

import { TaskStates } from "../../schemas/task.js";
import { getOutput } from "../output.js";

// ── Row Types ────────────────────────────────────────────────────────────────

interface TaskRow {
  id: string;
  state: string;
  sub_state: string | null;
  title: string;
  blocked: string | null;
  not_before: string | null;
}

// ── Command ──────────────────────────────────────────────────────────────────

/**
 * Retry a blocked task by transitioning it back to queued.
 *
 * This is a thin CLI entry point for the same unblock mechanism that the
 * ResponsePoller and dashboard use. Direct DB access (no full bootstrap)
 * keeps it fast and usable even when the daemon is stopped.
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
  } catch {
    out.error(`Failed to open database at ${dbPath}.`);
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

  if (task.state !== TaskStates.blocked) {
    out.error(`Task is in state "${task.state}", not "${TaskStates.blocked}". Only blocked tasks can be retried.`);
    return 1;
  }

  // Transition blocked → queued
  const now = new Date().toISOString();

  db.transaction(() => {
    db.prepare(
      `INSERT INTO state_transitions (task_id, from_state, to_state, reason, triggered_by, timestamp)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(taskId, TaskStates.blocked, TaskStates.queued, "cli_retry", "cli", now);

    db.prepare("UPDATE tasks SET state = ?, sub_state = NULL, not_before = NULL WHERE id = ?").run(
      TaskStates.queued,
      taskId,
    );

    // Clear blocked details but preserve contact history
    const blockedRaw = task.blocked;
    if (blockedRaw) {
      try {
        const blocked = JSON.parse(blockedRaw) as Record<string, unknown>;
        const contacted = Array.isArray(blocked["contacted"]) ? blocked["contacted"] : [];
        if (contacted.length > 0) {
          db.prepare("UPDATE tasks SET blocked = ? WHERE id = ?").run(
            JSON.stringify({
              reason: "",
              efforts_made: [],
              contacted,
              needed: "",
              waiting_for: "",
            }),
            taskId,
          );
        } else {
          db.prepare("UPDATE tasks SET blocked = NULL WHERE id = ?").run(taskId);
        }
      } catch {
        db.prepare("UPDATE tasks SET blocked = NULL WHERE id = ?").run(taskId);
      }
    }

    // Reset crash counter so retry cycle starts fresh
    db.prepare("UPDATE tasks SET consecutive_crash_count = 0 WHERE id = ?").run(taskId);
  })();

  if (out.mode === "json") {
    out.data({
      taskId,
      previousState: TaskStates.blocked,
      newState: TaskStates.queued,
      retriedAt: now,
    });
  } else {
    out.success(`Task ${taskId} retried — moved from blocked to queued.`);
    out.log(`  Title: ${task.title}`);
    out.log("  The daemon will pick it up on the next scheduling cycle.");
  }

  return 0;
}
