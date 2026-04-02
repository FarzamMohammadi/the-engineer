import { existsSync } from "node:fs";
import { join } from "node:path";

import BetterSqlite3 from "better-sqlite3";

import { getOutput } from "../output.js";
import { isProcessRunning, readPidFile } from "../pid.js";

interface TaskRow {
  id: string;
  state: string;
  sub_state: string | null;
  repo: string | null;
  review: string | null; // JSON blob
  created_at: number;
  updated_at: number;
}

interface MergeDetectionActivity {
  task_id: string;
  repo: string | null;
  pr_number: number | null;
  has_metadata: boolean;
  missing_fields: string[];
}

interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
  metadata: any;
}

/** Shows merge detection diagnostics and current review_pending tasks. Returns exit code. */
export function runDebugMerges(
  engineerHome: string,
  options: { taskId?: string; follow?: boolean },
): number {
  const out = getOutput();
  const pid = readPidFile(engineerHome);
  const isRunning = pid !== null && isProcessRunning(pid);

  if (!isRunning) {
    if (out.mode === "json") {
      out.data({ error: "Daemon is not running", running: false });
    } else {
      out.log("⚠️  The Engineer daemon is not running. Start it with: engineer start");
    }
    return 1;
  }

  const dbPath = join(engineerHome, "data", "engineer.db");
  if (!existsSync(dbPath)) {
    if (out.mode === "json") {
      out.data({ error: "Database not found", dbPath });
    } else {
      out.log(`⚠️  Database not found at ${dbPath}`);
    }
    return 1;
  }

  if (options.follow) {
    if (out.mode === "json") {
      out.data({ error: "Follow mode not yet implemented" });
    } else {
      out.log("🚧 Follow mode will be implemented in a future update.");
      out.log("📖 For now, use: engineer logs --follow | grep merge");
    }
    return 1;
  }

  const reviewTasks = getReviewPendingTasks(dbPath, options.taskId);
  const recentLogs = getRecentMergeDetectionLogs(engineerHome);

  if (out.mode === "json") {
    out.data({
      running: isRunning,
      pid,
      review_pending_tasks: reviewTasks,
      recent_merge_logs: recentLogs,
      timestamp: new Date().toISOString(),
    });
    return 0;
  }

  // Human-readable output
  out.log(`🔍 Merge Detection Debug Report`);
  out.log(`   Daemon: running (PID ${pid})`);
  out.log(`   Timestamp: ${new Date().toLocaleString()}`);
  out.log("");

  if (options.taskId) {
    const task = reviewTasks.find((t) => t.task_id === options.taskId);
    if (!task) {
      out.log(`❌ Task ${options.taskId} not found in review_pending state`);
      return 1;
    }
    displayTaskDetails(out, task);
  } else {
    displayReviewTasksSummary(out, reviewTasks);
  }

  displayRecentActivity(out, recentLogs);

  return 0;
}

function getReviewPendingTasks(dbPath: string, specificTaskId?: string): MergeDetectionActivity[] {
  const db = new BetterSqlite3(dbPath, { readonly: true });
  try {
    const query = specificTaskId
      ? "SELECT * FROM tasks WHERE id = ? AND state = 'review_pending'"
      : "SELECT * FROM tasks WHERE state = 'review_pending'";

    const params = specificTaskId ? [specificTaskId] : [];
    const rows = db.prepare(query).all(...params) as TaskRow[];

    return rows.map((row) => {
      let review: any = null;
      let prNumber: number | null = null;
      try {
        review = row.review ? JSON.parse(row.review) : null;
        prNumber = review?.pr_number || null;
      } catch {
        // Invalid JSON in review field
      }

      const missingFields: string[] = [];
      if (!row.repo) missingFields.push("repo");
      if (!prNumber) missingFields.push("pr_number");

      return {
        task_id: row.id,
        repo: row.repo,
        pr_number: prNumber,
        has_metadata: missingFields.length === 0,
        missing_fields: missingFields,
      };
    });
  } finally {
    db.close();
  }
}

function getRecentMergeDetectionLogs(engineerHome: string): LogEntry[] {
  const logsPath = join(engineerHome, "logs", "daemon.log");
  if (!existsSync(logsPath)) {
    return [];
  }

  // For now, return empty array - in a real implementation, we'd parse the log file
  // This would require implementing log parsing logic
  return [];
}

function displayTaskDetails(out: ReturnType<typeof getOutput>, task: MergeDetectionActivity): void {
  out.log(`📋 Task Details: ${task.task_id}`);
  out.log(`   Repository: ${task.repo || "❌ Missing"}`);
  out.log(`   PR Number: ${task.pr_number ? `#${task.pr_number}` : "❌ Missing"}`);
  out.log(`   Ready for merge detection: ${task.has_metadata ? "✅ Yes" : "❌ No"}`);

  if (task.missing_fields.length > 0) {
    out.log(`   Missing fields: ${task.missing_fields.join(", ")}`);
    out.log("");
    out.log("💡 Possible issues:");
    out.log("   - PR creation may have failed");
    out.log("   - Task metadata wasn't updated after PR creation");
    out.log("   - Task state transition issue");
  }
}

function displayReviewTasksSummary(
  out: ReturnType<typeof getOutput>,
  tasks: MergeDetectionActivity[],
): void {
  out.log(`📋 Review Pending Tasks: ${tasks.length}`);

  if (tasks.length === 0) {
    out.log("   No tasks currently in review_pending state");
    return;
  }

  const readyForDetection = tasks.filter((t) => t.has_metadata);
  const missingMetadata = tasks.filter((t) => !t.has_metadata);

  out.log(`   Ready for merge detection: ${readyForDetection.length}`);
  out.log(`   Missing metadata: ${missingMetadata.length}`);
  out.log("");

  if (readyForDetection.length > 0) {
    out.log("✅ Ready for merge detection:");
    for (const task of readyForDetection) {
      out.log(`   ${task.task_id}: ${task.repo}#${task.pr_number}`);
    }
    out.log("");
  }

  if (missingMetadata.length > 0) {
    out.log("❌ Missing metadata (will be skipped):");
    for (const task of missingMetadata) {
      const missing = task.missing_fields.join(", ");
      out.log(`   ${task.task_id}: missing ${missing}`);
    }
    out.log("");
  }
}

function displayRecentActivity(out: ReturnType<typeof getOutput>, logs: LogEntry[]): void {
  out.log("📊 Recent Merge Detection Activity:");

  if (logs.length === 0) {
    out.log("   No recent activity found in logs");
    out.log("   💡 Try: engineer logs --follow | grep -i merge");
    return;
  }

  // Display recent logs (this would be implemented when log parsing is added)
  for (const entry of logs.slice(0, 10)) {
    out.log(`   [${entry.timestamp}] ${entry.level}: ${entry.message}`);
  }
}
