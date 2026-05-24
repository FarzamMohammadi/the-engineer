import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import type { Task } from "../../schemas/task.js";
import type { WorkspaceRecord } from "../interfaces/workspace-manager.interface.js";
import type { EvaluationSnapshot } from "./types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function gitSync(args: string[], cwd: string): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return "";
  }
}

/** Recursively collect all .md files under a directory. */
function collectMdFiles(dir: string, basePath: string, result: Map<string, string>): void {
  if (!existsSync(dir)) {
    return;
  }
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      collectMdFiles(full, basePath, result);
    } else if (entry.endsWith(".md")) {
      const rel = relative(basePath, full);
      result.set(rel, readFileSync(full, "utf-8"));
    }
  }
}

// ── Snapshot Capture ────────────────────────────────────────────────────────

/** Input for {@link captureSnapshot}. */
export interface CaptureSnapshotInput {
  readonly taskId: string;
  readonly worktreePath: string;
  readonly thoughtsDir: string;
  readonly task: Task;
  readonly record: WorkspaceRecord;
  readonly engineerHome: string;
}

/**
 * Synchronously capture all data needed for evaluation from a live worktree.
 *
 * Must be called BEFORE worktree cleanup — the worktree must still exist.
 * Creates the evaluation output directory and writes snapshot.json for durability.
 */
export function captureSnapshot(input: CaptureSnapshotInput): EvaluationSnapshot {
  const { taskId, worktreePath, thoughtsDir, task, record, engineerHome } = input;
  const evaluationDir = join(engineerHome, "evaluations", taskId);
  mkdirSync(evaluationDir, { recursive: true });

  const gitDiff = gitSync(["diff", `origin/${record.baseBranch}...HEAD`], worktreePath);
  const commitLog = gitSync(["log", "--stat", `origin/${record.baseBranch}..HEAD`], worktreePath);

  const thoughtsFiles = new Map<string, string>();
  const thoughtsAbsPath = join(worktreePath, thoughtsDir);
  collectMdFiles(thoughtsAbsPath, thoughtsAbsPath, thoughtsFiles);

  // Bare clone dir = workspace_root/repo (always survives worktree cleanup)
  // Derive from worktree record — the workspace root is the parent of "worktrees/"
  const bareCloneDir = join(worktreePath, "..", "..", record.repo);

  const snapshot: EvaluationSnapshot = {
    taskId,
    taskTitle: task.title,
    taskDescription: task.description ?? null,
    repo: record.repo,
    branch: record.branch,
    baseBranch: record.baseBranch,
    gitDiff,
    commitLog,
    thoughtsFiles,
    evaluationDir,
    bareCloneDir,
    snapshotTimestamp: new Date().toISOString(),
  };

  // Write snapshot for durability/debugging (serialize Map as object)
  const serializable = {
    ...snapshot,
    thoughtsFiles: Object.fromEntries(thoughtsFiles),
  };
  writeFileSync(join(evaluationDir, "snapshot.json"), JSON.stringify(serializable, null, 2));

  return snapshot;
}
