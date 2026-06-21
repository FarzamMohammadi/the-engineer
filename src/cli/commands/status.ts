import { existsSync } from "node:fs";
import { join } from "node:path";

import BetterSqlite3 from "better-sqlite3";
import chalk from "chalk";

import { TERMINAL_STATES } from "../../schemas/task.js";
import { timeAgo } from "../format.js";
import { getOutput } from "../output.js";
import { isProcessRunning, readPidFile } from "../pid.js";

/** Options for the status command. */
export interface StatusOptions {
  readonly all: boolean;
}

interface TaskRow {
  readonly id: string;
  readonly state: string;
  readonly title: string;
  readonly created_at: string;
}

/** Shows daemon status and task listing. Returns exit code. */
export function runStatus(engineerHome: string, options?: StatusOptions): number {
  const showAll = options?.all ?? false;
  const out = getOutput();
  const pid = readPidFile(engineerHome);
  const isRunning = pid !== null && isProcessRunning(pid);

  const dbPath = join(engineerHome, "data", "engineer.db");
  let tasks: TaskRow[];
  try {
    tasks = existsSync(dbPath) ? getTaskList(dbPath, showAll) : [];
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    out.error(`Could not read tasks from ${dbPath}: ${detail}`);
    return 1;
  }

  if (out.mode === "json") {
    out.data({
      running: isRunning,
      pid: isRunning ? pid : null,
      tasks: tasks.map((t) => ({
        id: t.id,
        state: t.state,
        title: t.title,
        created_at: t.created_at,
      })),
    });
    return 0;
  }

  if (isRunning) {
    out.log(`  The Engineer: running (PID ${String(pid)})`);
  } else {
    out.log("  The Engineer: stopped");
  }

  if (tasks.length === 0) {
    out.log("  Tasks: none");
    return 0;
  }

  const summary = buildSummary(tasks);
  out.log(`  Tasks: ${summary}`);

  out.blank();
  const maxStateLen = Math.max(...tasks.map((t) => t.state.length));
  const color = out.color;

  for (const task of tasks) {
    const state = task.state.padEnd(maxStateLen);
    const shortId = task.id.slice(0, 8);
    const title = truncate(task.title, 40);
    const age = timeAgo(task.created_at);
    const dimAge = color ? chalk.dim(age) : age;
    out.log(`    ${state}  ${shortId}  ${title}  ${dimAge}`);
  }

  return 0;
}

/**
 * Reads the task list directly from the database. Throws on any DB failure
 * (corrupt/locked file, query error) rather than swallowing it — the caller
 * surfaces a clear message so "could not read tasks" never masquerades as
 * "no tasks".
 */
function getTaskList(dbPath: string, showAll: boolean): TaskRow[] {
  const db = new BetterSqlite3(dbPath, { readonly: true });

  try {
    const terminalList = TERMINAL_STATES.map((state) => `'${state}'`).join(", ");
    const whereClause = showAll ? "" : `WHERE state NOT IN (${terminalList})`;
    return db
      .prepare(
        `SELECT id, state, title, created_at FROM tasks
         ${whereClause}
         ORDER BY
           CASE state
             WHEN 'active' THEN 1
             WHEN 'blocked' THEN 2
             WHEN 'queued' THEN 3
             WHEN 'failed' THEN 4
             WHEN 'completed' THEN 5
             WHEN 'cancelled' THEN 6
           END,
           created_at ASC`,
      )
      .all() as TaskRow[];
  } finally {
    db.close();
  }
}

function buildSummary(tasks: TaskRow[]): string {
  const counts = new Map<string, number>();
  for (const task of tasks) {
    counts.set(task.state, (counts.get(task.state) ?? 0) + 1);
  }
  return [...counts.entries()].map(([state, count]) => `${String(count)} ${state}`).join(", ");
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) {
    return text.padEnd(maxLen);
  }
  return `${text.slice(0, maxLen - 1)}…`;
}
