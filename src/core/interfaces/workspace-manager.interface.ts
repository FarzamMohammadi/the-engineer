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
  /**
   * Trace context so the `worktree_created` observation nests under the task's
   * execution trace instead of surfacing as a standalone 1-span trace. Set by the
   * orchestrator (the only caller inside a traced dispatch); omitted elsewhere.
   */
  traceId?: string | undefined;
  parentObservationId?: string | undefined;
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

  /**
   * sha256 hex of the PR's diff against its base branch, scoped to the code that actually merges by
   * excluding the engine's own regenerated `thoughts/` deliverables. The substance signal delivery
   * uses to decide whether a re-push changed what the PR represents. Returns null when no workspace
   * is persisted or git fails — a best-effort read, never a throw.
   */
  diffDigestAgainstBase(taskId: string): string | null;
}
