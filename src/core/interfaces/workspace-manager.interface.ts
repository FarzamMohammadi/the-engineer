import type { SecureValue } from "../../utils/secure-value.js";

/**
 * Callback that transforms a plain remote URL into an authenticated one.
 *
 * Returns a SecureValue so the token never leaks through toString/toJSON.
 * If no auth is available, returns a SecureValue wrapping the original URL.
 * Injected at bootstrap — Core never knows which plugin provides auth.
 */
export type AuthUrlProvider = (remoteUrl: string) => SecureValue;

/** Result of verifyWorkspace(). */
export interface WorkspaceVerification {
  status: "valid" | "recoverable" | "lost";
  currentCommit: string | null;
  recoveryAction: string | null;
}

/**
 * A workspace's runtime shape, projected from the task's persisted `task.workspace` field.
 *
 * WorkspaceManager constructs this view from `taskEngine.getTask(taskId)?.workspace` on
 * every read — there is no in-memory cache. The persisted `task.workspace` is the single
 * source of truth.
 */
export interface WorkspaceRecord {
  taskId: string;
  repo: string;
  branch: string;
  worktreePath: string;
  baseBranch: string;
  /** Relative path to the thoughts directory (e.g., "thoughts/2026-03-22-issue-42"), or null if none. */
  thoughtsDir: string | null;
}

/** Optional parameters for createWorkspace(). */
export interface CreateWorkspaceOptions {
  /** Task title for slug generation (defaults to taskId). */
  title?: string | undefined;
  /** Branch to create from (defaults to config.default_base_branch). */
  baseBranch?: string | undefined;
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

  /** Delete the task's branch from the remote. Best-effort — callers should catch errors. */
  deleteRemoteBranch(taskId: string): void;

  /** Get the worktree filesystem path for a task, or null if unknown. */
  getWorktreePath(taskId: string): string | null;

  /** Get the full workspace record for a task, or null if unknown. */
  getWorkspaceRecord(taskId: string): WorkspaceRecord | null;
}
