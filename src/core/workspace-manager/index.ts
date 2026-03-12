import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

import type { z } from "zod";

import type { WorkspaceConfigSchema } from "../../schemas/config.js";
import type { TaskWorkspace } from "../../schemas/task.js";
import type { EventBus, PublishInput } from "../event-bus/index.js";

// ── Types ────────────────────────────────────────────────────────────────────

/** Parsed workspace config (all defaults applied). */
type WorkspaceConfig = z.output<typeof WorkspaceConfigSchema>;

/** Internal record tracking a workspace's state. */
export interface WorkspaceRecord {
  taskId: string;
  repo: string;
  branch: string;
  worktreePath: string;
  baseBranch: string;
  baseCommit: string;
}

/** Result of verifyWorkspace(). */
export interface WorkspaceVerification {
  status: "valid" | "recoverable" | "lost";
  currentCommit: string | null;
  recoveryAction: string | null;
}

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
export class WorkspaceManager {
  private readonly eventBus: EventBus;
  private readonly config: WorkspaceConfig;
  private readonly workspaces = new Map<string, WorkspaceRecord>();

  constructor(eventBus: EventBus, config: WorkspaceConfig) {
    this.eventBus = eventBus;
    this.config = config;
  }

  // ── Workspace Lifecycle ──────────────────────────────────────────────────

  /**
   * Create an isolated workspace for a task.
   *
   * If the repo is not yet cloned locally, clones it first using the provided
   * cloneUrl. Fetches from remote (if configured), creates a named branch
   * from the base, and sets up a git worktree. Emits `workspace.created`.
   *
   * @param taskId - The task this workspace belongs to
   * @param repo - Repository name (e.g., "owner/repo")
   * @param title - Optional task title for slug generation (defaults to taskId)
   * @param baseBranch - Branch to create from (defaults to config.default_base_branch)
   * @param parentBranch - Parent task's branch (for child tasks, takes precedence over baseBranch)
   * @param cloneUrl - Unauthenticated clone URL (required if repo not yet cloned)
   */
  createWorkspace(
    taskId: string,
    repo: string,
    title?: string,
    baseBranch?: string,
    parentBranch?: string,
    cloneUrl?: string,
  ): WorkspaceRecord {
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

    // Clone repo if not present (D147)
    if (!existsSync(repoCloneDir)) {
      if (!cloneUrl) {
        throw new Error(`WorkspaceManager: repo clone directory does not exist: ${repoCloneDir}`);
      }
      this.ensureClone(repo, cloneUrl);
    }

    // Fetch latest from remote
    if (this.config.fetch_before_create) {
      this.gitExecAuth(["fetch", "origin"], repoCloneDir);
    }

    // Determine the ref to branch from
    const fromRef = parentBranch ?? `origin/${resolvedBase}`;

    // Create the branch
    this.gitExec(["branch", branch, fromRef], repoCloneDir);

    // Get the base commit
    const baseCommit = this.gitExec(["rev-parse", branch], repoCloneDir);

    // Create the worktree
    this.gitExec(["worktree", "add", worktreePath, branch], repoCloneDir);

    const record: WorkspaceRecord = {
      taskId,
      repo,
      branch,
      worktreePath,
      baseBranch: resolvedBase,
      baseCommit,
    };

    this.workspaces.set(taskId, record);

    this.eventBus.publish({
      type: "workspace.created",
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

    return record;
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
      this.emitVerified(taskId, result);
      return result;
    }

    const repoCloneDir = path.join(this.config.workspace_root, record.repo);
    const worktreeExists = existsSync(record.worktreePath);

    if (worktreeExists) {
      // Worktree exists — check it's on the correct branch and get current commit
      const currentCommit = this.gitExec(["rev-parse", "HEAD"], record.worktreePath);
      const result: WorkspaceVerification = {
        status: "valid",
        currentCommit,
        recoveryAction: null,
      };
      this.emitVerified(taskId, result);
      return result;
    }

    // Worktree is missing — check if branch still exists
    try {
      const currentCommit = this.gitExec(["rev-parse", record.branch], repoCloneDir);
      const result: WorkspaceVerification = {
        status: "recoverable",
        currentCommit,
        recoveryAction: "recreate worktree from existing branch",
      };
      this.emitVerified(taskId, result);
      return result;
    } catch {
      const result: WorkspaceVerification = {
        status: "lost",
        currentCommit: null,
        recoveryAction: null,
      };
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

    const repoCloneDir = path.join(this.config.workspace_root, record.repo);

    // Remove worktree (--force handles dirty working trees)
    if (existsSync(record.worktreePath)) {
      this.gitExec(["worktree", "remove", record.worktreePath, "--force"], repoCloneDir);
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

    this.eventBus.publish({
      type: "workspace.cleaned",
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
      return repoCloneDir;
    }

    // Create parent directory
    mkdirSync(path.dirname(repoCloneDir), { recursive: true });

    // Clone with auth token (transient)
    const token = this.resolveToken();
    const authUrl = injectAuth(cloneUrl, token);
    execFileSync("git", ["clone", authUrl, repoCloneDir], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Reset remote to unauthenticated URL — token never persisted on disk
    this.gitExec(["remote", "set-url", "origin", cloneUrl], repoCloneDir);

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
      throw new Error(`WorkspaceManager: no workspace for task ${taskId}`);
    }

    const token = this.resolveToken();
    const repoCloneDir = path.join(this.config.workspace_root, record.repo);

    // Get the unauthenticated remote URL
    const remoteUrl = this.gitExec(["remote", "get-url", "origin"], repoCloneDir);

    // Push with transient auth — explicit URL, not remote name
    const authUrl = injectAuth(remoteUrl, token);
    this.gitExec(["push", "-u", authUrl, record.branch], record.worktreePath);
  }

  /**
   * Re-register a workspace from persisted task state (for daemon restart).
   *
   * Populates the in-memory workspaces map from a task's `workspace` field
   * so that `getWorktreePath()` and other methods work after restart.
   */
  registerExistingWorkspace(taskId: string, workspace: TaskWorkspace): void {
    if (!workspace.worktree_path) {
      return;
    }
    this.workspaces.set(taskId, {
      taskId,
      repo: workspace.repo,
      branch: workspace.branch,
      worktreePath: workspace.worktree_path,
      baseBranch: this.config.default_base_branch,
      baseCommit: "",
    });
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
  private gitExecAuth(args: string[], cwd: string): string {
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
    return execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  }

  private emitVerified(taskId: string, result: WorkspaceVerification): void {
    this.eventBus.publish({
      type: "workspace.verified",
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
