import { existsSync } from "node:fs";
import { join } from "node:path";

import BetterSqlite3 from "better-sqlite3";
import { ulid } from "ulid";

import { toSqliteJson } from "../../db/serialize.js";
import { TaskStates } from "../../schemas/task.js";
import { getOutput } from "../output.js";
import { isProcessRunning, readPidFile } from "../pid.js";
import { resolveTaskId } from "../resolve-task.js";

// ── Command ──────────────────────────────────────────────────────────────────

/**
 * Re-run a cancelled task as a fresh clone from its source — the CLI counterpart of the dashboard's Re-run.
 *
 * Unlike `retry`/`cancel` (direct state writes that work even when the daemon is stopped), re-run CREATES a
 * task, which must go through the daemon so the creation lands on the audit trail (`task.created`). So this
 * writes a `task.rerun_requested` event — the same cross-process path the dashboard uses — and the daemon's
 * response poller does the clone. It therefore requires a running daemon: the poller advances its scan cursor
 * past existing rows on startup, so an event written while the daemon is down would never be picked up.
 */
export function runRerun(engineerHome: string, taskId: string): number {
  const out = getOutput();
  const dbPath = join(engineerHome, "data", "engineer.db");

  if (!existsSync(dbPath)) {
    out.error(`No database found at ${dbPath}. Run 'engineer start' first.`);
    return 1;
  }

  const pid = readPidFile(engineerHome);
  if (pid === null || !isProcessRunning(pid)) {
    out.error(
      "The daemon is not running. Re-run creates a new task and needs the daemon — start it with 'engineer start', then re-run.",
    );
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
    return requestRerun(db, taskId);
  } finally {
    db.close();
  }
}

function requestRerun(db: BetterSqlite3.Database, taskIdInput: string): number {
  const out = getOutput();

  const taskId = resolveTaskId(db, taskIdInput);
  if (!taskId) {
    return 1;
  }

  const task = db.prepare("SELECT state, reaped_at FROM tasks WHERE id = ?").get(taskId) as
    | { state: string; reaped_at: string | null }
    | undefined;
  if (!task) {
    out.error(`Task not found: ${taskId}`);
    return 1;
  }
  if (task.state !== TaskStates.cancelled) {
    out.error(`Task is in state "${task.state}". Only a cancelled task can be re-run.`);
    return 1;
  }
  // Re-run is for a cancelled task whose work was already cleaned up. While the work still exists, the task
  // can be resumed in place — cloning would discard that progress — so point the owner at retry instead.
  if (task.reaped_at === null) {
    out.error(
      `Task ${taskId} can still be resumed — its work was not cleaned up. Use 'engineer retry ${taskId}' to resume it in place. Re-run is for cancelled tasks whose workspace was already reaped.`,
    );
    return 1;
  }

  // Hand the clone to the daemon (it owns task creation + the audit trail), mirroring the dashboard endpoint.
  db.prepare("INSERT INTO events (id, type, source, task_id, timestamp, payload) VALUES (?, ?, ?, ?, ?, ?)").run(
    ulid(),
    "task.rerun_requested",
    "cli",
    taskId,
    new Date().toISOString(),
    toSqliteJson({ task_id: taskId }),
  );

  if (out.mode === "json") {
    out.data({ taskId, requested: "rerun" });
  } else {
    out.success(`Re-run requested for ${taskId}.`);
    out.log("  The daemon will create a fresh task from the same source on its next cycle.");
  }

  return 0;
}
