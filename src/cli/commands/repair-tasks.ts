import { existsSync } from "node:fs";
import { join } from "node:path";

import BetterSqlite3 from "better-sqlite3";

import { loadConfigBundle } from "../../config/loader.js";
import { createPrManager } from "../../core/orchestrator/pr-manager.js";
import { createRegistry } from "../../core/registry/factory.js";
import { createTaskEngine } from "../../core/task-engine/index.js";
import { createWorkspaceManager } from "../../core/workspace-manager/index.js";
import { resolveDirectories } from "../home.js";
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

interface RepairableTask {
  task_id: string;
  issues: string[];
  can_auto_repair: boolean;
  repair_actions: string[];
}

interface RepairResult {
  total_tasks: number;
  repairable_tasks: number;
  repaired_tasks: number;
  failed_repairs: number;
  details: Array<{
    task_id: string;
    success: boolean;
    actions_taken: string[];
    error?: string;
  }>;
}

/** Repair tasks with incomplete PR metadata. Returns exit code. */
export async function runRepairTasks(
  engineerHome: string,
  options: { dryRun?: boolean },
): Promise<number> {
  const out = getOutput();
  const pid = readPidFile(engineerHome);
  const isRunning = pid !== null && isProcessRunning(pid);

  if (isRunning) {
    if (out.mode === "json") {
      out.data({ error: "Cannot repair tasks while daemon is running", running: true });
    } else {
      out.log("⚠️  Cannot repair tasks while The Engineer daemon is running.");
      out.log("   Stop the daemon with: engineer stop");
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

  try {
    const result = await performTaskRepairs(engineerHome, !!options.dryRun);

    if (out.mode === "json") {
      out.data({
        dry_run: !!options.dryRun,
        ...result,
      });
    } else {
      displayRepairResults(out, result, !!options.dryRun);
    }

    // Return non-zero if there were failed repairs (unless dry run)
    return options.dryRun ? 0 : result.failed_repairs > 0 ? 1 : 0;
  } catch (error) {
    if (out.mode === "json") {
      out.data({ error: error instanceof Error ? error.message : String(error) });
    } else {
      out.log(`❌ Repair failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return 1;
  }
}

async function performTaskRepairs(engineerHome: string, dryRun: boolean): Promise<RepairResult> {
  const dirs = resolveDirectories(engineerHome);
  const dbPath = join(engineerHome, "data", "engineer.db");

  // Analyze tasks to find repair opportunities
  const repairableTasks = analyzeRepairableTasks(dbPath);

  if (dryRun || repairableTasks.length === 0) {
    return {
      total_tasks: getTotalReviewPendingTasks(dbPath),
      repairable_tasks: repairableTasks.length,
      repaired_tasks: 0,
      failed_repairs: 0,
      details: repairableTasks.map((task) => ({
        task_id: task.task_id,
        success: false,
        actions_taken: dryRun ? task.repair_actions : ["dry-run-only"],
      })),
    };
  }

  // Load configuration and create necessary components
  const { bundle } = loadConfigBundle(dirs.config);
  const registry = await createRegistry(bundle.config, dirs.plugins);
  const db = new BetterSqlite3(dbPath);

  const taskEngine = createTaskEngine(db, registry.eventBus);
  const workspaceManager = createWorkspaceManager({
    dirs,
    registry,
    observer: console, // Simple logging for CLI context
    taskEngine,
    eventBus: registry.eventBus,
    config: bundle.config,
  });

  const prManager = createPrManager(
    {
      registry,
      observer: console,
      taskEngine,
      workspaceManager,
      sessionMemory: {} as any, // Not needed for repair operations
      config: bundle.config,
      clock: Date,
    },
    {} as any,
  ); // No notifications needed

  const repairResults: RepairResult = {
    total_tasks: getTotalReviewPendingTasks(dbPath),
    repairable_tasks: repairableTasks.length,
    repaired_tasks: 0,
    failed_repairs: 0,
    details: [],
  };

  // Attempt repairs
  for (const task of repairableTasks) {
    if (!task.can_auto_repair) {
      repairResults.details.push({
        task_id: task.task_id,
        success: false,
        actions_taken: [],
        error: "Task requires manual intervention",
      });
      repairResults.failed_repairs++;
      continue;
    }

    try {
      const recovery = await prManager.recoverTaskPRMetadata(task.task_id);

      repairResults.details.push({
        task_id: task.task_id,
        success: recovery.recovered,
        actions_taken: recovery.recovered ? ["recovered-repository-metadata"] : [],
        error: recovery.recovered ? undefined : recovery.details,
      });

      if (recovery.recovered) {
        repairResults.repaired_tasks++;
      } else {
        repairResults.failed_repairs++;
      }
    } catch (error) {
      repairResults.details.push({
        task_id: task.task_id,
        success: false,
        actions_taken: [],
        error: error instanceof Error ? error.message : String(error),
      });
      repairResults.failed_repairs++;
    }
  }

  db.close();
  return repairResults;
}

function analyzeRepairableTasks(dbPath: string): RepairableTask[] {
  const db = new BetterSqlite3(dbPath, { readonly: true });
  try {
    const rows = db
      .prepare("SELECT * FROM tasks WHERE state = 'review_pending'")
      .all() as TaskRow[];

    return rows
      .map((row) => {
        const issues: string[] = [];
        const repairActions: string[] = [];

        if (!row.repo) {
          issues.push("missing-repo");
          repairActions.push("recover-repo-from-workspace");
        }

        let prNumber: number | null = null;
        try {
          const review = row.review ? JSON.parse(row.review) : null;
          prNumber = review?.pr_number || null;
        } catch {
          issues.push("invalid-review-json");
        }

        if (!prNumber) {
          issues.push("missing-pr-number");
          repairActions.push("search-for-pr-by-branch");
        }

        if (issues.length === 0) {
          return null;
        }

        return {
          task_id: row.id,
          issues,
          can_auto_repair: !issues.includes("invalid-review-json"),
          repair_actions: repairActions,
        };
      })
      .filter((task): task is RepairableTask => task !== null);
  } finally {
    db.close();
  }
}

function getTotalReviewPendingTasks(dbPath: string): number {
  const db = new BetterSqlite3(dbPath, { readonly: true });
  try {
    const result = db
      .prepare("SELECT COUNT(*) as count FROM tasks WHERE state = 'review_pending'")
      .get() as { count: number };
    return result.count;
  } finally {
    db.close();
  }
}

function displayRepairResults(
  out: ReturnType<typeof getOutput>,
  result: RepairResult,
  dryRun: boolean,
): void {
  if (dryRun) {
    out.log("🔧 Task Repair Analysis (Dry Run)");
  } else {
    out.log("🔧 Task Repair Results");
  }

  out.log(`   Total review_pending tasks: ${result.total_tasks}`);
  out.log(`   Tasks needing repair: ${result.repairable_tasks}`);

  if (!dryRun) {
    out.log(`   Successfully repaired: ${result.repaired_tasks}`);
    out.log(`   Failed repairs: ${result.failed_repairs}`);
  }

  if (result.repairable_tasks === 0) {
    out.log("\n✅ No tasks need repair.");
    return;
  }

  out.log("\n📋 Task Details:");
  for (const detail of result.details) {
    const status = dryRun ? "🔍" : detail.success ? "✅" : "❌";
    out.log(`   ${status} ${detail.task_id}`);

    if (detail.actions_taken.length > 0) {
      out.log(`      Actions: ${detail.actions_taken.join(", ")}`);
    }

    if (detail.error) {
      out.log(`      Error: ${detail.error}`);
    }
  }

  if (dryRun && result.repairable_tasks > 0) {
    out.log("\n💡 To perform actual repairs, run: engineer repair-tasks");
  }
}
