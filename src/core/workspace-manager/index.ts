import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import type { z } from "zod";

import type { WorkspaceConfigSchema } from "../../schemas/config.js";
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
 * **Note:** PR operations (createPR, mergePR, etc.) are not implemented in this
 * phase. They require the GitHostingAdapter via Registry, which is built in
 * Phase 14b. The constructor will accept a Registry parameter when those
 * operations are added.
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
   * Fetches from remote (if configured), creates a named branch from the base,
   * and sets up a git worktree. Emits `workspace.created`.
   *
   * @param taskId - The task this workspace belongs to
   * @param repo - Repository name (e.g., "owner/repo")
   * @param title - Optional task title for slug generation (defaults to taskId)
   * @param baseBranch - Branch to create from (defaults to config.default_base_branch)
   * @param parentBranch - Parent task's branch (for child tasks, takes precedence over baseBranch)
   */
  createWorkspace(
    taskId: string,
    repo: string,
    title?: string,
    baseBranch?: string,
    parentBranch?: string,
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

    if (!existsSync(repoCloneDir)) {
      throw new Error(`WorkspaceManager: repo clone directory does not exist: ${repoCloneDir}`);
    }

    // Fetch latest from remote
    if (this.config.fetch_before_create) {
      this.gitExec(["fetch", "origin"], repoCloneDir);
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
      this.gitExec(["rev-parse", "--verify", record.branch], repoCloneDir);
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

  // ── Queries ──────────────────────────────────────────────────────────────

  /** Get the worktree filesystem path for a task, or null if unknown. */
  getWorktreePath(taskId: string): string | null {
    return this.workspaces.get(taskId)?.worktreePath ?? null;
  }

  // ── Private Helpers ────────────────────────────────────────────────────────

  private gitExec(args: string[], cwd: string): string {
    return execSync(`git ${args.join(" ")}`, {
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
