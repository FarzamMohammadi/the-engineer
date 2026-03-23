import type { TaskWorkspace } from "../../schemas/task.js";

/** Result of verifyWorkspace(). */
export interface WorkspaceVerification {
  status: "valid" | "recoverable" | "lost";
  currentCommit: string | null;
  recoveryAction: string | null;
}

/** Internal record tracking a workspace's state. */
export interface WorkspaceRecord {
  taskId: string;
  repo: string;
  branch: string;
  worktreePath: string;
  baseBranch: string;
  baseCommit: string;
}

/** Optional parameters for createWorkspace(). */
export interface CreateWorkspaceOptions {
  /** Task title for slug generation (defaults to taskId). */
  title?: string | undefined;
  /** Branch to create from (defaults to config.default_base_branch). */
  baseBranch?: string | undefined;
  /** Parent task's branch (for child tasks, takes precedence over baseBranch). */
  parentBranch?: string | undefined;
  /** Unauthenticated clone URL (required if repo not yet cloned). */
  cloneUrl?: string | undefined;
  /** Identifier for the thoughts/ directory (e.g., "issue-42"). Derived from trigger events. */
  thoughtsId?: string | undefined;
}

export interface IWorkspaceManager {
  /** Create an isolated workspace for a task. */
  createWorkspace(taskId: string, repo: string, options?: CreateWorkspaceOptions): WorkspaceRecord;

  /** Verify the integrity of an existing workspace. */
  verifyWorkspace(taskId: string): WorkspaceVerification;

  /** Clean up a workspace — remove worktree and optionally delete the branch. */
  cleanupWorkspace(taskId: string, preserveBranch?: boolean): void;

  /** Clone a repo if it doesn't exist locally. Idempotent. */
  ensureClone(repo: string, cloneUrl: string): string;

  /** Push the task's branch to remote. */
  pushBranch(taskId: string): void;

  /** Re-register a workspace from persisted task state (for daemon restart). */
  registerExistingWorkspace(taskId: string, workspace: TaskWorkspace): void;

  /** Get the worktree filesystem path for a task, or null if unknown. */
  getWorktreePath(taskId: string): string | null;

  /** Get the full workspace record for a task, or null if unknown. */
  getWorkspaceRecord(taskId: string): WorkspaceRecord | null;
}
