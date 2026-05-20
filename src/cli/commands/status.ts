import { existsSync } from "node:fs";
import { join } from "node:path";

import BetterSqlite3 from "better-sqlite3";

import { getOutput } from "../output.js";
import { isProcessRunning, readPidFile } from "../pid.js";

interface TaskCountRow {
  readonly state: string;
  readonly count: number;
}

/** Shows daemon status and task queue info. Returns exit code. */
export function runStatus(engineerHome: string): number {
  const out = getOutput();
  const pid = readPidFile(engineerHome);
  const isRunning = pid !== null && isProcessRunning(pid);

  const dbPath = join(engineerHome, "data", "engineer.db");
  const tasks = existsSync(dbPath) ? getTaskSummary(dbPath) : [];

  if (out.mode === "json") {
    out.data({
      running: isRunning,
      pid: isRunning ? pid : null,
      tasks: Object.fromEntries(tasks.map((r) => [r.state, r.count])),
    });
    return 0;
  }

  if (isRunning) {
    out.log(`  The Engineer: running (PID ${pid})`);
  } else {
    out.log("  The Engineer: stopped");
  }

  if (tasks.length === 0) {
    out.log("  Tasks: none");
  } else {
    out.log("  Tasks:");
    for (const row of tasks) {
      out.log(`    ${row.state}: ${row.count}`);
    }
  }

  return 0;
}

function getTaskSummary(dbPath: string): TaskCountRow[] {
  try {
    const db = new BetterSqlite3(dbPath, { readonly: true });

    try {
      return db.prepare("SELECT state, COUNT(*) as count FROM tasks GROUP BY state").all() as TaskCountRow[];
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}
