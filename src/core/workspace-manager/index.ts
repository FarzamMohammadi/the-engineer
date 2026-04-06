import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { z } from "zod";

import type { WorkspaceConfigSchema } from "../../schemas/config.js";
import {
  EventTypes,
  WorkspaceCleanedPayloadSchema,
  WorkspaceCreatedPayloadSchema,
  WorkspaceVerifiedPayloadSchema,
} from "../../schemas/events.js";
import { PHASE_DIRECTORIES } from "../../schemas/orchestrator.js";
import type { TaskWorkspace } from "../../schemas/task.js";
import type { EventDeclaration } from "../event-bus/topology.js";
import type { IEventBus, PublishInput } from "../interfaces/event-bus.interface.js";
import type {
  CreateWorkspaceOptions,
  IWorkspaceManager,
  WorkspaceRecord,
  WorkspaceVerification,
} from "../interfaces/workspace-manager.interface.js";
import type { IObserver } from "../observer/index.js";
import { writeSessionResultTemplate } from "../orchestrator/session-result.js";
import { WorkspaceCreationError, WorkspaceNotFoundError } from "./errors.js";

// ── Types ────────────────────────────────────────────────────────────────────

/** Parsed workspace config (all defaults applied). */
type WorkspaceConfig = z.output<typeof WorkspaceConfigSchema>;

// ── Event Declarations ──────────────────────────────────────────────────────

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
 * Inject authentication into an HTTPS git URL (D148).
 *
 * Replaces `https://` with `https://git:{token}@`. If token is empty or URL
 * is not HTTPS, returns the URL unchanged. The token is read from an
 * environment variable at call time — never persisted.
 */
export function injectAuth(url: string, token: string): string {
  if (!(token && url.startsWith("https://"))) {
    return url;
  }
  return url.replace("https://", `https://git:${token}@`);
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

/**
 * Git operations service for per-task workspace isolation.
 *
 * Uses git worktrees for lightweight, isolated checkouts sharing the same .git
 * directory. Each task gets its own worktree with a named branch. The branch
 * is the persistent artifact; the worktree is ephemeral.
 *
 * Emits workspace events on the Event Bus at each lifecycle point.
 *
 * Authentication: reads the git token from process.env at operation time
 * via the `git_token_env` config field. The token never appears in config
 * files, the database, or git remote URLs on disk.
 */
export class WorkspaceManager implements IWorkspaceManager {
  private readonly eventBus: IEventBus;
  private readonly config: WorkspaceConfig;
  private readonly observer: IObserver;
  private readonly workspaces = new Map<string, WorkspaceRecord>();

  constructor(eventBus: IEventBus, config: WorkspaceConfig, observer: IObserver) {
    this.eventBus = eventBus;
    this.observer = observer;
    // Expand ~ to actual home directory — Node APIs don't handle tilde
    this.config = {
      ...config,
      workspace_root: config.workspace_root.startsWith("~/")
        ? path.join(os.homedir(), config.workspace_root.slice(2))
        : config.workspace_root,
    };
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
    const { title, baseBranch, parentBranch, cloneUrl, thoughtsId } = options ?? {};
    const resolvedBase = parentBranch ?? baseBranch ?? this.config.default_base_branch;
    const slug = slugify(title ?? taskId, this.config.slug_max_length);
    const branch = branchName(this.config.branch_prefix, taskId, slug);
    const repoCloneDir = path.join(this.config.workspace_root, repo);
    const worktreePath = path.join(
      this.config.workspace_root,
      "worktrees",
      repo,
      `${taskId}-${slug}`,
    );

    this.observer.info("Creating workspace", {
      taskId,
      repo,
      branch,
      base: resolvedBase,
      isChild: !!parentBranch,
    });

    // Clone repo if not present (D147)
    if (!existsSync(repoCloneDir)) {
      if (!cloneUrl) {
        throw new WorkspaceCreationError(
          `WorkspaceManager: repo clone directory does not exist: ${repoCloneDir}`,
        );
      }
      this.ensureClone(repo, cloneUrl);
    }

    // Always fetch latest from remote before branching — stale base = silent divergence
    this.observer.debug("Fetching latest from remote", { taskId, repo });
    this.gitExecWithAuth(["fetch", "origin"], repoCloneDir);

    // Determine the ref to branch from
    const fromRef = parentBranch ?? `origin/${resolvedBase}`;

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

    // Create thoughts/ directory structure for RRPIR file-based handoffs
    let thoughtsDirRelative: string | null = null;
    if (thoughtsId) {
      const dateStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
      thoughtsDirRelative = `thoughts/${dateStr}-${thoughtsId}`;
      const thoughtsDirAbsolute = path.join(worktreePath, thoughtsDirRelative);
      for (const phase of PHASE_DIRECTORIES) {
        const phaseDir = path.join(thoughtsDirAbsolute, phase);
        mkdirSync(phaseDir, { recursive: true });
        writeSessionResultTemplate(phaseDir);
      }
      this.observer.debug("Created thoughts/ directory structure", {
        taskId,
        thoughtsDir: thoughtsDirRelative,
      });
    }

    const workspace: WorkspaceRecord = {
      taskId,
      repo,
      branch,
      worktreePath,
      baseBranch: resolvedBase,
      baseCommit,
      thoughtsDir: thoughtsDirRelative,
    };

    this.workspaces.set(taskId, workspace);
    this.observer.info("Workspace created", { taskId, repo, branch, worktreePath, baseCommit });

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
    const record = this.workspaces.get(taskId);

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
   * Idempotent: no-op if the taskId is not known. Emits `workspace.cleaned`.
   */
  cleanupWorkspace(taskId: string, preserveBranch?: boolean): void {
    const record = this.workspaces.get(taskId);

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

    // Remove worktree (--force handles dirty working trees).
    // Wrapped in try/catch so a failed removal doesn't prevent branch cleanup and map removal.
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

    // Delete branch unless preserving
    if (!preserveBranch) {
      try {
        this.gitExec(["branch", "-D", record.branch], repoCloneDir);
      } catch {
        // Branch may already be deleted — not an error
      }
    }

    this.workspaces.delete(taskId);
    this.observer.debug("Workspace cleaned up", {
      taskId,
      elapsedMs: Date.now() - cleanupStart,
    });

    this.eventBus.publish({
      type: EventTypes["workspace.cleaned"],
      source: "workspace_manager",
      task_id: taskId,
      payload: {
        task_id: taskId,
        branch_preserved: preserveBranch ?? false,
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
    const token = this.resolveToken();
    const authUrl = injectAuth(cloneUrl, token);
    execFileSync("git", ["-c", "credential.helper=", "clone", authUrl, repoCloneDir], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Reset remote to unauthenticated URL — token must never persist on disk (D148).
    // If set-url fails, the auth token remains in .git/config, so delete the entire clone
    // to prevent credential persistence, then re-throw so the caller can retry.
    try {
      this.gitExec(["remote", "set-url", "origin", cloneUrl], repoCloneDir);
    } catch (setUrlError) {
      this.observer.warn(
        "Failed to reset git remote after clone — removing clone to prevent token persistence",
        { repo },
      );
      try {
        rmSync(repoCloneDir, { recursive: true, force: true });
      } catch {
        // Removal best-effort — deletion failure is logged by the outer error
      }
      throw new WorkspaceCreationError(
        `Failed to reset git remote after clone — removed clone to prevent token persistence: ${setUrlError instanceof Error ? setUrlError.message : String(setUrlError)}`,
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
    const record = this.workspaces.get(taskId);
    if (!record) {
      throw new WorkspaceNotFoundError(taskId);
    }

    this.observer.info("Pushing branch to remote", { taskId, branch: record.branch });
    const pushStart = Date.now();

    const token = this.resolveToken();
    const repoCloneDir = path.join(this.config.workspace_root, record.repo);

    // Get the unauthenticated remote URL
    const remoteUrl = this.gitExec(["remote", "get-url", "origin"], repoCloneDir);

    // Push with transient auth — explicit URL, not remote name
    const authUrl = injectAuth(remoteUrl, token);
    this.gitExec(["push", "-u", authUrl, record.branch], record.worktreePath);

    this.observer.info("Branch pushed", {
      taskId,
      branch: record.branch,
      elapsedMs: Date.now() - pushStart,
    });
  }

  deleteRemoteBranch(taskId: string): void {
    const record = this.workspaces.get(taskId);
    if (!record) {
      throw new WorkspaceNotFoundError(taskId);
    }

    this.observer.info("Deleting branch from remote", { taskId, branch: record.branch });
    const deleteStart = Date.now();

    const token = this.resolveToken();
    const repoCloneDir = path.join(this.config.workspace_root, record.repo);

    // Get the unauthenticated remote URL
    const remoteUrl = this.gitExec(["remote", "get-url", "origin"], repoCloneDir);

    // Delete with transient auth — explicit URL, not remote name
    const authUrl = injectAuth(remoteUrl, token);
    this.gitExec(["push", authUrl, "--delete", record.branch], repoCloneDir);

    this.observer.info("Branch deleted from remote", {
      taskId,
      branch: record.branch,
      elapsedMs: Date.now() - deleteStart,
    });
  }

  /**
   * Re-register a workspace from persisted task state (for daemon restart).
   *
   * Populates the in-memory workspaces map from a task's `workspace` field
   * so that `getWorktreePath()` and other methods work after restart.
   */
  registerExistingWorkspace(taskId: string, workspace: TaskWorkspace): void {
    if (!workspace.worktree_path) {
      this.observer.debug("registerExistingWorkspace: no worktree_path — skipping", { taskId });
      return;
    }
    this.workspaces.set(taskId, {
      taskId,
      repo: workspace.repo,
      branch: workspace.branch,
      worktreePath: workspace.worktree_path,
      baseBranch: this.config.default_base_branch,
      baseCommit: "",
      thoughtsDir: workspace.thoughts_dir ?? null,
    });
    this.observer.debug("Registered existing workspace", {
      taskId,
      repo: workspace.repo,
      branch: workspace.branch,
      worktreePath: workspace.worktree_path,
    });
  }

  // ── Thoughts Cleanup ────────────────────────────────────────────────────

  /**
   * Remove thoughts files **introduced by this branch** from the worktree, commit, and push.
   * Only removes files added relative to the base branch — pre-existing thoughts/ content
   * in the repo is never touched. Called before merge to keep engineering artifacts out of
   * the target branch while preserving them in PR history for reviewer context.
   * Returns true if a cleanup commit was made, false if nothing to remove.
   */
  removeThoughtsAndPush(taskId: string): boolean {
    const record = this.workspaces.get(taskId);
    if (!record) {
      throw new WorkspaceNotFoundError(taskId);
    }

    // Find thoughts files added by this branch (not present on base branch)
    const baseRef = `origin/${record.baseBranch}`;
    const addedFiles = this.gitExec(
      ["diff", "--name-only", "--diff-filter=A", baseRef, "--", "thoughts/"],
      record.worktreePath,
    );

    if (!addedFiles.trim()) {
      this.observer.debug("No branch-introduced thoughts files to remove", { taskId });
      return false;
    }

    const files = addedFiles.trim().split("\n");
    this.observer.info("Removing branch-introduced thoughts files before merge", {
      taskId,
      fileCount: files.length,
    });

    this.gitExec(["rm", "-f", ...files], record.worktreePath);
    this.gitExec(
      ["commit", "-m", "chore: remove engineering thoughts before merge"],
      record.worktreePath,
    );
    this.pushBranch(taskId);

    this.observer.info("Thoughts files removed and pushed", { taskId, fileCount: files.length });
    return true;
  }

  // ── Queries ──────────────────────────────────────────────────────────────

  /** Get the worktree filesystem path for a task, or null if unknown. */
  getWorktreePath(taskId: string): string | null {
    return this.workspaces.get(taskId)?.worktreePath ?? null;
  }

  /** Get the full workspace record for a task, or null if unknown. */
  getWorkspaceRecord(taskId: string): WorkspaceRecord | null {
    return this.workspaces.get(taskId) ?? null;
  }

  // ── Private Helpers ────────────────────────────────────────────────────────

  /** Resolve the git token from the environment variable. */
  private resolveToken(): string {
    return process.env[this.config.git_token_env] ?? "";
  }

  /** Run a git command with auth injected into the remote URL for fetch/push. */
  private gitExecWithAuth(args: string[], cwd: string): string {
    const token = this.resolveToken();
    if (token && (args[0] === "fetch" || args[0] === "push")) {
      // Get remote URL and inject auth for this operation only
      const remoteUrl = this.gitExec(["remote", "get-url", "origin"], cwd);
      const authUrl = injectAuth(remoteUrl, token);
      // Replace "origin" with the auth URL in the args
      const authArgs = args.map((a) => (a === "origin" ? authUrl : a));
      return this.gitExec(authArgs, cwd);
    }
    return this.gitExec(args, cwd);
  }

  private gitExec(args: string[], cwd: string): string {
    // Disable credential helpers so auth tokens are never cached to disk.
    return execFileSync("git", ["-c", "credential.helper=", ...args], {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
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
