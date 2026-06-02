import { existsSync } from "node:fs";
import { join } from "node:path";

import BetterSqlite3 from "better-sqlite3";

import { cancelTask } from "../../core/task-engine/index.js";
import { TaskStates } from "../../schemas/task.js";
import { getOutput } from "../output.js";
import { resolveTaskId } from "../resolve-task.js";

// ── Command ──────────────────────────────────────────────────────────────────

/**
 * Cancel a task by transitioning it to the `cancelled` terminal state.
 *
 * A guarded, versioned write (shared with the dashboard via `cancelTask`) that joins the daemon's
 * optimistic-concurrency CAS, so cancelling a running task serializes against a concurrent transition —
 * exactly one wins. The daemon detects the flip on its next tick and SIGTERMs the in-flight agent; the
 * reaper then reclaims the workspace + branch. Direct DB access (no full bootstrap) keeps it fast and
 * usable even when the daemon is stopped.
 */
export function runCancel(engineerHome: string, taskId: string): number {
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
    return cancelByTaskId(db, taskId);
  } finally {
    db.close();
  }
}

function cancelByTaskId(db: BetterSqlite3.Database, taskIdInput: string): number {
  const out = getOutput();

  const taskId = resolveTaskId(db, taskIdInput);
  if (!taskId) {
    return 1;
  }

  const result = cancelTask(db, taskId, { reason: "cli_cancel", triggeredBy: "cli" });

  if (result.outcome === "not_found") {
    out.error(`Task not found: ${taskId}`);
    return 1;
  }
  if (result.outcome === "not_cancellable") {
    out.error(`Task is in state "${result.state}". Only a task that has not finished can be cancelled.`);
    return 1;
  }

  if (out.mode === "json") {
    out.data({ taskId, previousState: result.fromState, newState: TaskStates.cancelled });
  } else {
    out.success(`Task ${taskId} cancelled — moved from ${result.fromState} to ${TaskStates.cancelled}.`);
    out.log("  If it was running, the daemon stops the agent and the reaper cleans up shortly.");
  }

  return 0;
}
