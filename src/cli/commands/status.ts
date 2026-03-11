import { existsSync } from "node:fs";
import { join } from "node:path";

import BetterSqlite3 from "better-sqlite3";

import { isProcessRunning, readPidFile } from "../pid.js";

interface TaskCountRow {
  state: string;
  count: number;
}

/** Shows daemon status and task queue info. Returns exit code. */
export function runStatus(engineerHome: string): number {
  const pid = readPidFile(engineerHome);
  const isRunning = pid !== null && isProcessRunning(pid);

  if (!isRunning) {
    console.log("  The Engineer: stopped");

    // Try to show last run info from DB
    const dbPath = join(engineerHome, "data", "engineer.db");
    if (existsSync(dbPath)) {
      showTaskSummary(dbPath);
    }
    return 0;
  }

  console.log(`  The Engineer: running (PID ${pid})`);

  // Query DB for task info
  const dbPath = join(engineerHome, "data", "engineer.db");
  if (existsSync(dbPath)) {
    showTaskSummary(dbPath);
  }

  // TODO: Phase 15 — plugin health requires running daemon IPC
  // Plugin health lives in Registry's in-memory state, not in DB.
  // Showing plugin health here requires IPC or DB persistence.

  return 0;
}

function showTaskSummary(dbPath: string): void {
  try {
    const db = new BetterSqlite3(dbPath, { readonly: true });

    try {
      const rows = db
        .prepare("SELECT state, COUNT(*) as count FROM tasks GROUP BY state")
        .all() as TaskCountRow[];

      if (rows.length === 0) {
        console.log("  Tasks: none");
        return;
      }

      console.log("  Tasks:");
      for (const row of rows) {
        console.log(`    ${row.state}: ${row.count}`);
      }
    } finally {
      db.close();
    }
  } catch {
    // DB might be locked or corrupted — silently skip
  }
}
