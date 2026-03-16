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

export interface IWorkspaceManager {
  /** Create an isolated workspace for a task. */
  createWorkspace(
    taskId: string,
    repo: string,
    title?: string,
    baseBranch?: string,
    parentBranch?: string,
    cloneUrl?: string,
  ): WorkspaceRecord;

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
