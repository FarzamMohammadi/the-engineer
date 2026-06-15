import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";

import type { z } from "zod";

import type { WorkspaceConfigSchema } from "../../schemas/config.js";
import {
  EventTypes,
  WorkspaceCleanedPayloadSchema,
  WorkspaceCreatedPayloadSchema,
  WorkspaceVerifiedPayloadSchema,
} from "../../schemas/events.js";
import { ObservationTypes } from "../../schemas/observer.js";
import { PHASE_DIRECTORIES } from "../../schemas/orchestrator.js";
import type { Task } from "../../schemas/task.js";
import { sanitizeErrorMessage } from "../../utils/sanitize.js";
import type { EventDeclaration } from "../event-bus/topology.js";
import type { IEventBus, PublishInput } from "../interfaces/event-bus.interface.js";
import type { ITaskEngine } from "../interfaces/task-engine.interface.js";
import type {
  AuthUrlProvider,
  CreateWorkspaceOptions,
  IWorkspaceManager,
  WorkspaceRecord,
  WorkspaceVerification,
} from "../interfaces/workspace-manager.interface.js";
import type { IObserver } from "../observer/index.js";
import { WorkspaceCreationError, WorkspaceNotFoundError } from "./errors.js";

// ── Types ────────────────────────────────────────────────────────────────────

/** Parsed workspace config (all defaults applied). */
type WorkspaceConfig = z.output<typeof WorkspaceConfigSchema>;

// ── Event Declarations ──────────────────────────────────────────────────────

/**
 * Workspace lifecycle events. `subscribers: []` is intentional — these events
 * exist for the EventBus persistence layer (audit trail), not for any runtime
 * subscriber. Workspace lifecycle changes are driven directly by the
 * orchestrator's per-task code path.
 */
export const EVENTS: EventDeclaration[] = [
  {
    type: "workspace.created",
    description: "Emitted when a git worktree is created for a task",
    payloadSchema: WorkspaceCreatedPayloadSchema,
    publishers: ["workspace-manager"],
    subscribers: [],
  },
  {
    type: "workspace.verified",
    description: "Emitted after verifying a workspace's integrity",
    payloadSchema: WorkspaceVerifiedPayloadSchema,
    publishers: ["workspace-manager"],
    subscribers: [],
  },
  {
    type: "workspace.cleaned",
    description: "Emitted when a task's workspace is cleaned up",
    payloadSchema: WorkspaceCleanedPayloadSchema,
    publishers: ["workspace-manager"],
    subscribers: [],
  },
];

// ── Pure Functions ───────────────────────────────────────────────────────────

const NON_ALNUM = /[^a-z0-9]+/g;
const LEADING_TRAILING_HYPHENS = /^-+|-+$/g;
const TRAILING_HYPHENS = /-+$/;

/** git's stderr when deleting a remote branch that is already gone — the reaper treats this as success. */
const REMOTE_REF_ABSENT = /remote ref does not exist/i;

/** Wall-clock ceiling for the remote branch delete so a hung `git push --delete` cannot wedge the reaper's sweep. */
const REMOTE_DELETE_TIMEOUT_MS = 120_000;

/** Combine an exec error's stderr and message for classification. Never logged raw — it may carry an auth URL. */
function gitErrorText(error: unknown): string {
  if (error && typeof error === "object") {
    const e = error as { stderr?: unknown; message?: unknown };
    const stderr = typeof e.stderr === "string" ? e.stderr : "";
    const message = typeof e.message === "string" ? e.message : "";
    return `${stderr}\n${message}`;
  }
  return String(error);
}

/**
 * Sanitize a title into a branch-safe slug.
 *
 * - Lowercases
 * - Replaces non-alphanumeric runs with hyphens
 * - Trims leading/trailing hyphens
 * - Truncates to maxLength
 * - Falls back to "task" if result is empty
 */
export function slugify(title: string, maxLength: number): string {
  let slug = title.toLowerCase().replace(NON_ALNUM, "-").replace(LEADING_TRAILING_HYPHENS, "");

  slug = slug.slice(0, maxLength).replace(TRAILING_HYPHENS, "");

  return slug || "task";
}

/**
 * Build the full branch name from prefix, task ID, and slug.
 * Example: `engineer/47-dark-mode`
 */
export function branchName(prefix: string, taskId: string, slug: string): string {
  return `${prefix}${taskId}-${slug}`;
}

/**
 * Project a Task's persisted `workspace` field into a runtime WorkspaceRecord.
 * Returns null when the task has no workspace, or when the worktree path is
 * absent (worktree never created — only the placeholder shape is on the task).
 */
function recordFromTask(task: Task): WorkspaceRecord | null {
  const ws = task.workspace;
  if (!ws?.worktree_path) {
    return null;
  }
  return {
    taskId: task.id,
    repo: ws.repo,
    branch: ws.branch,
    worktreePath: ws.worktree_path,
    baseBranch: ws.base_branch,
    thoughtsDir: ws.thoughts_dir,
  };
}

/**
 * Validate that a path is within the expected workspace root.
 * Uses realpathSync to resolve symlinks before comparison.
 * Throws if the resolved path is outside the workspace root.
 *
 * @returns The resolved (canonicalized) path.
 */
export function validateWorkspacePath(targetPath: string, workspaceRoot: string): string {
  let resolvedPath: string;
  let resolvedRoot: string;

  try {
    resolvedPath = realpathSync(targetPath);
  } catch {
    throw new WorkspaceCreationError(
      `Workspace path validation failed: "${targetPath}" does not exist or cannot be resolved`,
    );
  }

  try {
    resolvedRoot = realpathSync(workspaceRoot);
  } catch {
    throw new WorkspaceCreationError(
      `Workspace root validation failed: "${workspaceRoot}" does not exist or cannot be resolved`,
    );
  }

  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}/`)) {
    throw new WorkspaceCreationError(
      `Workspace escape detected: "${targetPath}" resolves to "${resolvedPath}" which is outside workspace root "${resolvedRoot}"`,
    );
  }

  return resolvedPath;
}

// ── WorkspaceManager ─────────────────────────────────────────────────────────

/** Constructor dependencies for WorkspaceManager. */
export interface WorkspaceManagerDeps {
  eventBus: IEventBus;
  config: WorkspaceConfig;
  observer: IObserver;
  authUrlProvider: AuthUrlProvider;
  /** Source of truth for workspace state — reads project `task.workspace` into a WorkspaceRecord on every query. */
  taskEngine: ITaskEngine;
}

/**
 * Git operations service for per-task workspace isolation.
 *
 * Uses git worktrees for lightweight, isolated checkouts sharing the same .git
 * directory. Each task gets its own worktree with a named branch. The branch
 * is the persistent artifact; the worktree is ephemeral.
 *
 * Stateless: every read projects `task.workspace` (persisted in the tasks table)
 * into a `WorkspaceRecord`. The DB is the single source of truth — no in-memory
 * cache to keep in sync.
 *
 * Emits workspace events on the Event Bus at each lifecycle point.
 *
 * Authentication: delegates to an injected `AuthUrlProvider` callback that
 * transforms plain remote URLs into authenticated ones. The token never
 * appears in config files, the database, or git remote URLs on disk.
 */
export class WorkspaceManager implements IWorkspaceManager {
  private readonly eventBus: IEventBus;
  private readonly config: WorkspaceConfig;
  private readonly observer: IObserver;
  private readonly authUrlProvider: AuthUrlProvider;
  private readonly taskEngine: ITaskEngine;

  constructor(deps: WorkspaceManagerDeps) {
    this.eventBus = deps.eventBus;
    this.observer = deps.observer;
    this.authUrlProvider = deps.authUrlProvider;
    this.config = deps.config;
    this.taskEngine = deps.taskEngine;
  }

  // ── Workspace Lifecycle ──────────────────────────────────────────────────

  /**
   * Create an isolated workspace for a task.
   *
   * If the repo is not yet cloned locally, clones it first using the provided
   * cloneUrl. Always fetches latest from remote, creates a named branch
   * from the base, and sets up a git worktree. Emits `workspace.created`.
   */
  createWorkspace(taskId: string, repo: string, options?: CreateWorkspaceOptions): WorkspaceRecord {
    const { title, baseBranch, cloneUrl, thoughtsId, traceId, parentObservationId } = options ?? {};
    const resolvedBase = baseBranch ?? this.config.default_base_branch;
    const slug = slugify(title ?? taskId, this.config.slug_max_length);
    const branch = branchName(this.config.branch_prefix, taskId, slug);
    const repoCloneDir = path.join(this.config.workspace_root, repo);
    const worktreePath = path.join(this.config.workspace_root, "worktrees", repo, `${taskId}-${slug}`);
    const createStart = Date.now();

    this.observer.info("Creating workspace", {
      taskId,
      repo,
      branch,
      base: resolvedBase,
    });

    // Clone repo if not present (D147)
    if (!existsSync(repoCloneDir)) {
      if (!cloneUrl) {
        throw new WorkspaceCreationError(`Repo clone directory does not exist: "${repoCloneDir}"`);
      }
      this.ensureClone(repo, cloneUrl);
    }

    // Always fetch latest from remote before branching — stale base = silent divergence
    this.observer.debug("Fetching latest from remote", { taskId, repo });
    this.gitExecWithAuth(["fetch", "origin"], repoCloneDir);

    // Determine the ref to branch from
    const fromRef = `origin/${resolvedBase}`;

    // Create the branch
    this.observer.debug("Creating branch", { taskId, branch, fromRef });
    this.gitExec(["branch", branch, fromRef], repoCloneDir);

    // Get the base commit
    const baseCommit = this.gitExec(["rev-parse", branch], repoCloneDir);

    // Create the worktree — if this fails, roll back the branch so we don't leave orphaned refs
    this.observer.debug("Adding worktree", { taskId, worktreePath, branch });
    try {
      this.gitExec(["worktree", "add", worktreePath, branch], repoCloneDir);
    } catch (worktreeError) {
      try {
        this.gitExec(["branch", "-D", branch], repoCloneDir);
      } catch {
        // Branch rollback best-effort — the stuck detection loop will surface this
        this.observer.warn("Branch rollback after worktree failure also failed", {
          taskId,
          branch,
        });
      }
      throw worktreeError;
    }

    // Defense-in-depth: validate the created worktree resolves within workspace root
    validateWorkspacePath(worktreePath, this.config.workspace_root);

    // Create thoughts/ directory structure for pipeline file-based handoffs
    let thoughtsDirRelative: string | null = null;
    if (thoughtsId) {
      const dateStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
      thoughtsDirRelative = `thoughts/${dateStr}-${thoughtsId}`;
      const thoughtsDirAbsolute = path.join(worktreePath, thoughtsDirRelative);
      for (const phase of PHASE_DIRECTORIES) {
        mkdirSync(path.join(thoughtsDirAbsolute, phase), { recursive: true });
      }
      this.observer.debug("Created thoughts/ directory structure", {
        taskId,
        thoughtsDir: thoughtsDirRelative,
      });
    }

    // Persist before any caller can query — DB is the single source of truth.
    this.taskEngine.updateTaskField(taskId, "workspace", {
      repo,
      branch,
      base_branch: resolvedBase,
      worktree_path: worktreePath,
      thoughts_dir: thoughtsDirRelative,
    });

    const workspace: WorkspaceRecord = {
      taskId,
      repo,
      branch,
      worktreePath,
      baseBranch: resolvedBase,
      thoughtsDir: thoughtsDirRelative,
    };

    this.observer.info("Workspace created", { taskId, repo, branch, worktreePath, baseCommit });
    this.observer.observe(
      ObservationTypes.workspace_op,
      "worktree_created",
      { taskId, repo, branch, worktreePath, durationMs: Date.now() - createStart },
      // Nest under the task's execution trace when the orchestrator threaded the
      // context; undefined (any other caller) falls back to a standalone observation.
      { task_id: taskId, trace_id: traceId, parent_observation_id: parentObservationId },
    );

    this.eventBus.publish({
      type: EventTypes["workspace.created"],
      source: "workspace_manager",
      task_id: taskId,
      payload: {
        task_id: taskId,
        repo,
        branch,
        worktree_path: worktreePath,
        base_branch: resolvedBase,
        base_commit: baseCommit,
      },
    } satisfies PublishInput<"workspace.created">);

    return workspace;
  }

  /**
   * Verify the integrity of an existing workspace.
   *
   * Checks whether the worktree directory exists, the branch is intact,
   * and returns a status indicating whether the workspace is valid,
   * recoverable (worktree missing but branch exists), or lost.
   * Emits `workspace.verified`.
   */
  verifyWorkspace(taskId: string): WorkspaceVerification {
    const record = this.readRecord(taskId);

    if (!record) {
      const result: WorkspaceVerification = {
        status: "lost",
        currentCommit: null,
        recoveryAction: null,
      };
      this.observer.warn("Workspace verification: no record found (lost)", { taskId });
      this.emitVerified(taskId, result);
      return result;
    }

    const repoCloneDir = path.join(this.config.workspace_root, record.repo);
    const worktreeExists = existsSync(record.worktreePath);

    if (worktreeExists) {
      // Worktree exists — check it's on the correct branch and get current commit.
      // If rev-parse fails (e.g. corrupted .git file), treat as recoverable rather than crashing.
      try {
        const currentCommit = this.gitExec(["rev-parse", "HEAD"], record.worktreePath);
        const result: WorkspaceVerification = {
          status: "valid",
          currentCommit,
          recoveryAction: null,
        };
        this.observer.debug("Workspace verified: valid", { taskId, currentCommit });
        this.emitVerified(taskId, result);
        return result;
      } catch {
        const result: WorkspaceVerification = {
          status: "recoverable",
          currentCommit: null,
          recoveryAction: "worktree directory exists but HEAD is unreadable — recreate worktree",
        };
        this.observer.warn("Workspace verified: recoverable (HEAD unreadable)", {
          taskId,
          worktreePath: record.worktreePath,
        });
        this.emitVerified(taskId, result);
        return result;
      }
    }

    // Worktree is missing — check if branch still exists
    try {
      const currentCommit = this.gitExec(["rev-parse", record.branch], repoCloneDir);
      const result: WorkspaceVerification = {
        status: "recoverable",
        currentCommit,
        recoveryAction: "recreate worktree from existing branch",
      };
      this.observer.warn("Workspace verified: recoverable (worktree missing, branch exists)", {
        taskId,
        branch: record.branch,
        currentCommit,
      });
      this.emitVerified(taskId, result);
      return result;
    } catch {
      const result: WorkspaceVerification = {
        status: "lost",
        currentCommit: null,
        recoveryAction: null,
      };
      this.observer.warn("Workspace verified: lost (worktree and branch both missing)", {
        taskId,
        branch: record.branch,
      });
      this.emitVerified(taskId, result);
      return result;
    }
  }

  /**
   * Clean up a workspace — remove worktree and optionally delete the branch.
   *
   * Idempotent: no-op if no workspace is recorded for the task. The persisted
   * `task.workspace` row is left intact; the `workspace.cleaned` event is the
   * audit trail.
   */
  cleanupWorkspace(taskId: string, preserveBranch?: boolean): void {
    const record = this.readRecord(taskId);

    if (!record) {
      return; // Idempotent
    }

    const cleanupStart = Date.now();
    this.observer.info("Cleaning up workspace", {
      taskId,
      branch: record.branch,
      preserveBranch: preserveBranch ?? false,
    });

    const repoCloneDir = path.join(this.config.workspace_root, record.repo);

    // Remove worktree (--force handles dirty working trees). Wrapped so a failed
    // removal doesn't prevent branch deletion or event emission.
    if (existsSync(record.worktreePath)) {
      try {
        this.gitExec(["worktree", "remove", record.worktreePath, "--force"], repoCloneDir);
      } catch (err) {
        // Worktree removal failed — continue with cleanup. Stale worktree dirs are
        // harmless until the next git worktree prune cycle.
        this.observer.warn("Worktree removal failed — continuing cleanup", {
          taskId,
          worktreePath: record.worktreePath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Delete branch unless preserving — log if it fails so genuine errors
    // (permissions, repo corruption) don't hide behind the idempotency comment.
    if (!preserveBranch) {
      try {
        this.gitExec(["branch", "-D", record.branch], repoCloneDir);
      } catch (err) {
        this.observer.debug("Branch deletion skipped (already deleted or unavailable)", {
          taskId,
          branch: record.branch,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    this.recordCleanup(taskId, record.branch, preserveBranch ?? false, Date.now() - cleanupStart);
  }

  /** Record a completed cleanup at its three sinks: the debug log, the workspace_op observation, and the audit event. */
  private recordCleanup(taskId: string, branch: string, branchPreserved: boolean, durationMs: number): void {
    this.observer.debug("Workspace cleaned", { taskId, elapsedMs: durationMs });
    this.observer.observe(
      ObservationTypes.workspace_op,
      "worktree_cleaned",
      { taskId, branch, branchPreserved, durationMs },
      { task_id: taskId },
    );
    this.eventBus.publish({
      type: EventTypes["workspace.cleaned"],
      source: "workspace_manager",
      task_id: taskId,
      payload: {
        task_id: taskId,
        branch_preserved: branchPreserved,
      },
    } satisfies PublishInput<"workspace.cleaned">);
  }

  // ── Clone & Push ──────────────────────────────────────────────────────────

  /**
   * Clone a repo if it doesn't exist locally (D147). Idempotent.
   *
   * Uses the unauthenticated clone URL + token from env at operation time.
   * After clone, resets the remote to the unauthenticated URL so the token
   * is never persisted on disk.
   */
  ensureClone(repo: string, cloneUrl: string): string {
    const repoCloneDir = path.join(this.config.workspace_root, repo);

    if (existsSync(repoCloneDir)) {
      this.observer.debug("Repo already cloned — skipping clone", { repo, repoCloneDir });
      return repoCloneDir;
    }

    this.observer.info("Cloning repository", { repo });
    const cloneStart = Date.now();

    // Create parent directory
    mkdirSync(path.dirname(repoCloneDir), { recursive: true });

    // Clone with auth token (transient). Disable credential helpers so the
    // token is never cached to disk by git-credential-store or similar.
    const authUrl = this.authUrlProvider(cloneUrl);
    execFileSync("git", ["-c", "credential.helper=", "clone", authUrl.unwrap(), repoCloneDir], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Reset remote to unauthenticated URL — token must never persist on disk (D148).
    // If set-url fails, the auth token remains in .git/config, so delete the entire clone
    // to prevent credential persistence, then re-throw so the caller can retry.
    try {
      this.gitExec(["remote", "set-url", "origin", cloneUrl], repoCloneDir);
    } catch (setUrlError) {
      this.observer.warn("Failed to reset git remote after clone — removing clone to prevent token persistence", {
        repo,
      });
      try {
        rmSync(repoCloneDir, { recursive: true, force: true });
      } catch (removalError) {
        // Removal failed AFTER set-url failed — the clone with the auth token in
        // .git/config is now stranded on disk. Surface it loudly: no silent
        // token persistence (§ 15 Graceful Degradation).
        this.observer.error("Auth token persists on disk — clone removal failed after set-url failure", {
          repo,
          repoCloneDir,
          error: removalError instanceof Error ? removalError.message : String(removalError),
        });
      }
      throw new WorkspaceCreationError(
        `Failed to reset git remote after clone — removed clone to prevent token persistence: ${setUrlError instanceof Error ? setUrlError.message : String(setUrlError)}`,
        { cause: setUrlError },
      );
    }

    this.observer.info("Repository cloned", { repo, elapsedMs: Date.now() - cloneStart });
    return repoCloneDir;
  }

  /**
   * Push the task's branch to remote (D150, D151).
   *
   * Pushes to an explicit authenticated URL so the token is never written
   * to .git/config. Sets upstream tracking.
   */
  pushBranch(taskId: string): void {
    const record = this.readRecord(taskId);
    if (!record) {
      throw new WorkspaceNotFoundError(taskId);
    }

    this.observer.info("Pushing branch to remote", { taskId, branch: record.branch });
    const pushStart = Date.now();

    const repoCloneDir = path.join(this.config.workspace_root, record.repo);

    // Get the unauthenticated remote URL
    const remoteUrl = this.gitExec(["remote", "get-url", "origin"], repoCloneDir);

    // Push with transient auth — explicit URL, not remote name
    const authUrl = this.authUrlProvider(remoteUrl);
    this.gitExec(["push", "--no-verify", "-u", authUrl.unwrap(), record.branch], record.worktreePath);

    this.observer.info("Branch pushed", {
      taskId,
      branch: record.branch,
      elapsedMs: Date.now() - pushStart,
    });
  }

  /**
   * Delete the task's branch from the remote. Idempotent and bounded for the reaper: a branch that is
   * already gone (a human or the host removed it) is the desired end-state, so "remote ref does not exist"
   * is treated as success; the push is wall-clock-capped so a hung delete cannot wedge the sweep. Any other
   * failure (auth, network, branch protection, timeout) throws so the caller retries on the next sweep.
   */
  deleteRemoteBranch(taskId: string): void {
    const record = this.readRecord(taskId);
    if (!record) {
      throw new WorkspaceNotFoundError(taskId);
    }

    this.observer.info("Deleting branch from remote", { taskId, branch: record.branch });
    const deleteStart = Date.now();

    const repoCloneDir = path.join(this.config.workspace_root, record.repo);

    // Get the unauthenticated remote URL
    const remoteUrl = this.gitExec(["remote", "get-url", "origin"], repoCloneDir);

    // Delete with transient auth — explicit URL, not remote name. Bounded by a timeout; an already-gone
    // remote ref is the desired state, so it is tolerated rather than thrown.
    const authUrl = this.authUrlProvider(remoteUrl);
    try {
      this.gitExec(["push", "--no-verify", authUrl.unwrap(), "--delete", record.branch], repoCloneDir, {
        timeoutMs: REMOTE_DELETE_TIMEOUT_MS,
      });
    } catch (error) {
      if (REMOTE_REF_ABSENT.test(gitErrorText(error))) {
        this.observer.debug("Remote branch already deleted — treating as success", {
          taskId,
          branch: record.branch,
        });
        this.emitBranchDeleted(taskId, record.branch, Date.now() - deleteStart, true);
        return;
      }
      throw error;
    }

    this.observer.info("Branch deleted from remote", {
      taskId,
      branch: record.branch,
      elapsedMs: Date.now() - deleteStart,
    });
    this.emitBranchDeleted(taskId, record.branch, Date.now() - deleteStart, false);
  }

  /** Record the remote branch deletion as a workspace_op — `alreadyGone` distinguishes a real delete from the already-absent end-state. */
  private emitBranchDeleted(taskId: string, branch: string, durationMs: number, alreadyGone: boolean): void {
    this.observer.observe(
      ObservationTypes.workspace_op,
      "branch_deleted",
      { taskId, branch, alreadyGone, durationMs },
      { task_id: taskId },
    );
  }

  // ── Queries ──────────────────────────────────────────────────────────────

  /** Get the worktree filesystem path for a task, or null if no workspace is persisted. */
  getWorktreePath(taskId: string): string | null {
    return this.readRecord(taskId)?.worktreePath ?? null;
  }

  /** Get the full workspace record for a task, or null if no workspace is persisted. */
  getWorkspaceRecord(taskId: string): WorkspaceRecord | null {
    return this.readRecord(taskId);
  }

  /**
   * sha256 hex of the PR's diff against its base branch — delivery's substance signal for "did this
   * re-push change what the PR represents." The diff is scoped to the merged code by excluding the
   * engine's own regenerated `thoughts/` deliverables (`pr-title.md`, `pr-description.md`, and the
   * rest): those are rewritten every round, so including them would change the digest on every
   * re-push and re-trigger the very spurious description update the digest exists to suppress. The
   * `thoughts/` exclusion mirrors `exclude_thoughts_on_merge` / `removeThoughtsAndPush`. A three-dot
   * range (`base...HEAD`) reads the diff since the merge-base, so resolving a conflict by merging
   * base into the branch — new HEAD sha, same diff — correctly reads as no substance change.
   *
   * Returns null when no workspace is persisted or git fails; this is a best-effort gate, never a
   * throw — a null digest tells the caller "cannot verify" and it skips the update rather than blocks.
   */
  diffDigestAgainstBase(taskId: string): string | null {
    const record = this.readRecord(taskId);
    if (!record) {
      return null;
    }
    try {
      const diff = this.gitExec(
        ["diff", `origin/${record.baseBranch}...HEAD`, "--", ".", ":(exclude)thoughts/"],
        record.worktreePath,
      );
      return createHash("sha256").update(diff, "utf-8").digest("hex");
    } catch (error) {
      this.observer.warn("Failed to compute diff digest against base — treating as unavailable", {
        taskId,
        error: sanitizeErrorMessage(error),
      });
      return null;
    }
  }

  // ── Private Helpers ────────────────────────────────────────────────────────

  /**
   * Project the task's persisted `workspace` field into a WorkspaceRecord.
   *
   * The DB is the single source of truth — every read goes through this helper.
   * Returns null when the task has no workspace (never created, or pre-creation).
   * Lets `taskEngine.getTask` errors propagate to the caller (fail loud — § 15).
   */
  private readRecord(taskId: string): WorkspaceRecord | null {
    const task = this.taskEngine.getTask(taskId);
    return task ? recordFromTask(task) : null;
  }

  /** Run a git command, swapping `origin` for an authenticated remote URL. Used for fetch from the primary clone. */
  private gitExecWithAuth(args: string[], cwd: string): string {
    const remoteUrl = this.gitExec(["remote", "get-url", "origin"], cwd);
    const authUrl = this.authUrlProvider(remoteUrl);
    const authArgs = args.map((a) => (a === "origin" ? authUrl.unwrap() : a));
    return this.gitExec(authArgs, cwd);
  }

  private gitExec(args: string[], cwd: string, options?: { timeoutMs?: number }): string {
    // Disable credential helpers so auth tokens are never cached to disk.
    return execFileSync("git", ["-c", "credential.helper=", ...args], {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      ...(options?.timeoutMs ? { timeout: options.timeoutMs } : {}),
    }).trim();
  }

  private emitVerified(taskId: string, result: WorkspaceVerification): void {
    this.eventBus.publish({
      type: EventTypes["workspace.verified"],
      source: "workspace_manager",
      task_id: taskId,
      payload: {
        task_id: taskId,
        status: result.status,
        current_commit: result.currentCommit,
        recovery_action: result.recoveryAction,
      },
    } satisfies PublishInput<"workspace.verified">);
  }
}
