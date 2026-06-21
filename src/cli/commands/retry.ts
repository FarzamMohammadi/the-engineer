import { existsSync } from "node:fs";
import { join } from "node:path";

import BetterSqlite3 from "better-sqlite3";

import { retryTask } from "../../core/task-engine/index.js";
import { TaskStates } from "../../schemas/task.js";
import { getOutput } from "../output.js";
import { resolveTaskId } from "../resolve-task.js";

// ── Command ──────────────────────────────────────────────────────────────────

/**
 * Retry a blocked or failed task by re-queuing it for the daemon.
 *
 * Delegates the guarded, versioned write to the shared `retryTask` core helper (the same path the dashboard
 * uses), then formats the outcome for the CLI. Direct DB access (no full bootstrap) keeps it fast and usable
 * even when the daemon is stopped.
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
    return retryResolvedTask(db, taskId);
  } finally {
    db.close();
  }
}

function retryResolvedTask(db: BetterSqlite3.Database, taskIdInput: string): number {
  const out = getOutput();

  const taskId = resolveTaskId(db, taskIdInput);
  if (!taskId) {
    return 1;
  }

  const task = db.prepare("SELECT title FROM tasks WHERE id = ?").get(taskId) as { title: string } | undefined;
  const result = retryTask(db, taskId, { reason: "cli_retry", triggeredBy: "cli" });

  if (result.outcome === "not_found") {
    out.error(`Task not found: ${taskId}`);
    return 1;
  }
  if (result.outcome === "not_retryable") {
    out.error(`Task is in state "${result.state}". Only blocked or failed tasks can be retried.`);
    return 1;
  }

  if (out.mode === "json") {
    out.data({
      taskId,
      previousState: result.fromState,
      newState: TaskStates.queued,
      retriedAt: new Date().toISOString(),
    });
  } else {
    out.success(`Task ${taskId} retried — moved from ${result.fromState} to queued.`);
    out.log(`  Title: ${task?.title ?? taskId}`);
    out.log("  The daemon will pick it up on the next scheduling cycle.");
  }

  return 0;
}
