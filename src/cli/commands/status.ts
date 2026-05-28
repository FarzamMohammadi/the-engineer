import { existsSync } from "node:fs";
import { join } from "node:path";

import BetterSqlite3 from "better-sqlite3";
import chalk from "chalk";

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
  const tasks = existsSync(dbPath) ? getTaskList(dbPath, showAll) : [];

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

function getTaskList(dbPath: string, showAll: boolean): TaskRow[] {
  try {
    const db = new BetterSqlite3(dbPath, { readonly: true });

    try {
      const whereClause = showAll ? "" : "WHERE state NOT IN ('completed', 'failed')";
      return db
        .prepare(
          `SELECT id, state, title, created_at FROM tasks
           ${whereClause}
           ORDER BY
             CASE state
               WHEN 'active' THEN 1
               WHEN 'blocked' THEN 2
               WHEN 'review_pending' THEN 3
               WHEN 'requirements_gathering' THEN 4
               WHEN 'queued' THEN 5
               WHEN 'failed' THEN 6
               WHEN 'completed' THEN 7
             END,
             created_at ASC`,
        )
        .all() as TaskRow[];
    } finally {
      db.close();
    }
  } catch {
    return [];
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
