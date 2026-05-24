import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { GitHostingAdapter } from "../../adapters/git-hosting.js";
import { AdapterTypes } from "../../schemas/adapters.js";
import type { Dispatch } from "../../schemas/ephemeral.js";
import { NotificationKinds } from "../../schemas/notifications.js";
import { ObservationTypes } from "../../schemas/observer.js";
import type { PhaseOutput } from "../../schemas/orchestrator.js";
import { Phases } from "../../schemas/orchestrator.js";
import { JournalEntryTypes } from "../../schemas/session-memory.js";
import type { ExternalRef } from "../../schemas/task.js";
import { sanitizeErrorMessage, sanitizeSecrets } from "../../utils/sanitize.js";
import type { NotificationRouter } from "../daemon/notification-router.js";
import type { IWorkspaceManager } from "../interfaces/workspace-manager.interface.js";
import type { IObserver } from "../observer/index.js";
import type { OrchestratorContext } from "./types.js";

// ── PR Body Helpers ────────────────────────────────────────────────────────

/** Input shape for trigger reference formatting. */
interface TriggerRefInput {
  external_ref?: ExternalRef | null;
}

/**
 * Build a plugin-blind trigger reference line.
 *
 * Never inspects `external_ref.type` — works for any git hosting platform.
 * Returns a markdown blockquote when a reference exists, or `null` otherwise.
 */
export function formatTriggerReference(task: TriggerRefInput): string | null {
  const ref = task.external_ref;
  if (!ref) {
    return null;
  }

  const label = `${ref.repo}#${ref.id}`;
  return ref.url ? `> Triggered by [${label}](${ref.url})` : `> Triggered by ${label}`;
}

/**
 * Compose the final PR description: optional decorations + trigger header + description + branding footer.
 *
 * Deterministic — the CLI agent writes the narrative, this function wraps it
 * with structural elements that must always be present. Decoration strings are
 * plugin-provided and treated as opaque by Core.
 */
export function composePrBody(description: string, task: TriggerRefInput): string {
  const parts: string[] = [];
  const decorations = task.external_ref?.pr_decorations;

  if (decorations?.description_prefix) {
    parts.push(decorations.description_prefix);
  }

  const triggerRef = formatTriggerReference(task);
  if (triggerRef) {
    parts.push(triggerRef);
  }

  parts.push(description);

  if (decorations?.description_suffix) {
    parts.push(decorations.description_suffix);
  }

  parts.push("---\n*Crafted by The Engineer*");

  return parts.join("\n\n");
}

// ── Result Types ──────────────────────────────────────────────────────────

/** Discriminated result from commitAndPush — callers match on outcome. */
export type CommitAndPushResult =
  | { outcome: "pushed"; committed: boolean }
  | { outcome: "nothing_to_push" }
  | { outcome: "error"; step: string; reason: string };

/** Discriminated result from createPullRequest — callers match on outcome. */
export type CreatePRResult =
  | { outcome: "created"; pr_number: number; url: string }
  | { outcome: "rework_pushed" }
  | { outcome: "no_hosting_plugin" }
  | { outcome: "error"; step: string; reason: string };

// ── PrManager Interface ────────────────────────────────────────────────────

/** Split PR workflow: commit+push and PR creation are independently callable. */
export interface PrManager {
  /** Commit staged changes and push branch to remote. */
  commitAndPush(
    sessionId: string,
    taskId: string,
    dispatch: Dispatch,
  ): CommitAndPushResult | Promise<CommitAndPushResult>;

  /**
   * Create a PR (or handle rework push to existing PR).
   * Only call after a successful commitAndPush with outcome "pushed".
   */
  createPullRequest(
    sessionId: string,
    taskId: string,
    demoPrepOutput: PhaseOutput,
    dispatch: Dispatch,
  ): Promise<CreatePRResult>;
}

// ── Factory ─────────────────────────────────────────────────────────────────

/** Create a PrManager bound to the given OrchestratorContext. */
export function createPrManager(ctx: OrchestratorContext, notifications: NotificationRouter): PrManager {
  const observer = ctx.observer;

  function recordPrWorkflowError(sessionId: string, taskId: string, step: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    ctx.sessionMemory.journal.addEntry({
      sessionId,
      taskId,
      phase: Phases.demo_prep,
      type: JournalEntryTypes.error,
      summary: `PR workflow failed at ${step}: ${message}`,
      tags: ["pr_workflow", step],
    });
  }

  // ── commitAndPush ─────────────────────────────────────────────────────

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: multi-step git workflow — sequential by nature
  function commitAndPush(sessionId: string, taskId: string, dispatch: Dispatch): CommitAndPushResult {
    const worktreePath = ctx.workspaceManager.getWorktreePath(taskId);
    if (!worktreePath) {
      observer.warn("No workspace path — skipping PR workflow", { taskId });
      return { outcome: "nothing_to_push" };
    }

    const record = ctx.workspaceManager.getWorkspaceRecord(taskId);
    if (!record) {
      observer.warn("No workspace record — skipping PR workflow", { taskId });
      return { outcome: "nothing_to_push" };
    }

    const isRework = dispatch.task.review?.pr_number != null;
    const span = observer.startSpan(
      ObservationTypes.plugin_call,
      "commit_and_push",
      { taskId, repo: record.repo, branch: record.branch, isRework },
      { task_id: taskId },
    );

    // TODO: Reconsider moving commit responsibility back to the execution phase entirely.
    // The CLI agent should commit all changes during its session; pr-manager should only push.
    // This safety-net commit exists because the agent may leave uncommitted changes.
    // 1. Deterministic commit: git add -A && git commit
    let hasNewCommit = false;
    try {
      execFileSync("git", ["add", "-A"], {
        cwd: worktreePath,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });

      let hasStagedChanges = false;
      try {
        execFileSync("git", ["diff", "--cached", "--quiet"], {
          cwd: worktreePath,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch {
        hasStagedChanges = true;
      }

      if (hasStagedChanges) {
        const commitMessage = isRework
          ? "fix: address review feedback\n\nCrafted by The Engineer"
          : `feat: ${sanitizeSecrets(dispatch.task.title)}\n\nCrafted by The Engineer`;
        execFileSync("git", ["commit", "--no-verify", "-m", commitMessage], {
          cwd: worktreePath,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        });
        hasNewCommit = true;
      }
    } catch (error) {
      recordPrWorkflowError(sessionId, taskId, "commit", error);
      observer.error("Commit failed", { taskId, error: sanitizeErrorMessage(error) });
      span.setError(error);
      span.end({ step: "commit", success: false });
      return { outcome: "error", step: "commit", reason: sanitizeErrorMessage(error) };
    }

    // Check if branch has commits ahead of base
    if (!hasNewCommit) {
      try {
        const aheadCount = execFileSync("git", ["rev-list", "--count", `origin/${record.baseBranch}..HEAD`], {
          cwd: worktreePath,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        }).trim();
        if (aheadCount === "0") {
          observer.warn("No commits ahead of base — nothing to push", { taskId });
          span.end({ step: "ahead_check", success: true });
          return { outcome: "nothing_to_push" };
        }
        observer.debug("Commits ahead of base", { taskId, aheadCount });
      } catch (error) {
        observer.warn("Cannot determine ahead count — nothing to push", {
          taskId,
          error: sanitizeErrorMessage(error),
        });
        span.end({ step: "ahead_check", success: true });
        return { outcome: "nothing_to_push" };
      }
    }

    // 2. Push via WorkspaceManager (D151 — token injection)
    observer.info("Pushing branch", { taskId, branch: record.branch });
    try {
      ctx.workspaceManager.pushBranch(taskId);
      observer.info("Push succeeded", { taskId, branch: record.branch });
    } catch (error) {
      recordPrWorkflowError(sessionId, taskId, "push", error);
      observer.error("Push failed", { taskId, error: sanitizeErrorMessage(error) });
      span.setError(error);
      span.end({ step: "push", success: false });
      return { outcome: "error", step: "push", reason: sanitizeErrorMessage(error) };
    }

    span.end({ step: "push", success: true });
    return { outcome: "pushed", committed: hasNewCommit };
  }

  // ── createPullRequest ─────────────────────────────────────────────────

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: PR creation with rework path and file resolution
  async function createPullRequest(
    sessionId: string,
    taskId: string,
    demoPrepOutput: PhaseOutput,
    dispatch: Dispatch,
  ): Promise<CreatePRResult> {
    const worktreePath = ctx.workspaceManager.getWorktreePath(taskId);
    const record = ctx.workspaceManager.getWorkspaceRecord(taskId);
    const isRework = dispatch.task.review?.pr_number != null;
    const prStart = Date.now();

    const span = observer.startSpan(
      ObservationTypes.plugin_call,
      "pr_workflow",
      { taskId, repo: record?.repo, branch: record?.branch, isRework },
      { task_id: taskId },
    );

    // Rework path: PR already exists — mark feedback applied, notify
    if (isRework) {
      const gitHosting = ctx.registry.getPrimaryPlugin<GitHostingAdapter>(AdapterTypes.git_hosting);
      if (gitHosting && dispatch.task.review?.pr_number) {
        try {
          await gitHosting.dismissApprovals(
            record?.repo ?? "",
            dispatch.task.review.pr_number,
            "New commits pushed — previous approval is for outdated code. Re-review required.",
          );
          observer.info("Stale approvals dismissed after rework push", {
            taskId,
            prNumber: dispatch.task.review.pr_number,
          });
        } catch (error) {
          observer.warn("Failed to dismiss stale approvals — proceeding", {
            taskId,
            error: sanitizeErrorMessage(error),
          });
        }
      }

      const task = ctx.taskEngine.getTask(taskId);
      if (task?.review) {
        const updatedRounds = task.review.feedback_rounds.map((r) => ({ ...r, applied: true }));
        ctx.taskEngine.updateTaskField(taskId, "review", {
          ...task.review,
          feedback_rounds: updatedRounds,
        });
      }
      notifications.notify({
        kind: NotificationKinds.ticket_comment,
        taskId: dispatch.task.id,
        message: "Pushed rework addressing review feedback.",
      });
      observer.info("Rework pushed to existing PR", {
        taskId,
        prNumber: dispatch.task.review?.pr_number,
        elapsedMs: Date.now() - prStart,
      });
      span.end({ step: "rework_push", success: true, elapsedMs: Date.now() - prStart });
      return { outcome: "rework_pushed" };
    }

    // New PR path
    const gitHosting = ctx.registry.getPrimaryPlugin<GitHostingAdapter>(AdapterTypes.git_hosting);
    if (!gitHosting) {
      observer.warn("No git hosting plugin — skipping PR creation", { taskId });
      span.end({ step: "pr_create", success: false, elapsedMs: Date.now() - prStart });
      return { outcome: "no_hosting_plugin" };
    }

    // biome-ignore lint/complexity/useSimplifiedLogicExpression: TypeScript narrowing guard — both must be non-null for PR creation
    if (!record || !worktreePath) {
      span.end({ step: "pr_create", success: false, elapsedMs: Date.now() - prStart });
      return { outcome: "error", step: "pr_create", reason: "No workspace record for PR creation" };
    }

    observer.info("Creating PR", { taskId, repo: record.repo });
    try {
      // CLI-native: read PR description from deliverable file when not in PhaseOutput.data
      let rawDescription = (demoPrepOutput.data as { pr_description?: string }).pr_description;
      if (!rawDescription) {
        const deliverablePath = (demoPrepOutput.data as { deliverable_path?: string }).deliverable_path;
        if (deliverablePath) {
          let absPath = path.join(worktreePath, deliverablePath);
          // deliverable_path may point to the phase directory — resolve to the actual file
          if (existsSync(absPath) && statSync(absPath).isDirectory()) {
            absPath = path.join(absPath, "pr-description.md");
          }
          if (existsSync(absPath) && !statSync(absPath).isDirectory()) {
            rawDescription = readFileSync(absPath, "utf-8").trim();
          }
        }
      }
      rawDescription = rawDescription || `PR for: ${dispatch.task.title}`;

      // Sanitize PR description to prevent secret leakage (D154)
      const prDescription = sanitizeSecrets(rawDescription);

      // Wrap with trigger reference header and branding footer
      const prBody = composePrBody(prDescription, dispatch.task);

      // Apply PR title decorations when available (plugin-blind: Core treats all values as opaque)
      const rawTitle = sanitizeSecrets(dispatch.task.title);
      const decorations = dispatch.task.external_ref?.pr_decorations;
      const titleParts: string[] = [];
      if (decorations?.title_prefix) {
        titleParts.push(decorations.title_prefix);
      }
      titleParts.push(rawTitle);
      if (decorations?.title_suffix) {
        titleParts.push(decorations.title_suffix);
      }
      const prTitle = titleParts.join(" ");

      const prResult = await gitHosting.createPR({
        repo: record.repo,
        branch: record.branch,
        base: record.baseBranch,
        title: prTitle,
        body: prBody,
        draft: false,
        labels: null,
        reviewers: null,
      });

      ctx.taskEngine.updateTaskField(taskId, "review", {
        pr_number: prResult.pr_number,
        pr_state: "ready",
        demo_artifacts: [],
        feedback_rounds: [],
      });

      const elapsedMs = Date.now() - prStart;
      observer.info("PR created", {
        taskId,
        prNumber: prResult.pr_number,
        url: prResult.url,
        elapsedMs,
      });

      notifications.notify({
        kind: NotificationKinds.milestone,
        taskId: dispatch.task.id,
        message: `PR created: ${prResult.url}`,
      });
      notifications.notify({
        kind: NotificationKinds.ticket_comment,
        taskId: dispatch.task.id,
        message: `PR created: ${prResult.url}`,
      });
      span.end({ step: "pr_create", success: true, prNumber: prResult.pr_number, elapsedMs });
      return { outcome: "created", pr_number: prResult.pr_number, url: prResult.url };
    } catch (error) {
      recordPrWorkflowError(sessionId, taskId, "pr_creation", error);
      observer.error("PR creation failed", {
        taskId,
        error: sanitizeErrorMessage(error),
      });
      span.setError(error);
      span.end({ step: "pr_create", success: false, elapsedMs: Date.now() - prStart });
      return { outcome: "error", step: "pr_creation", reason: sanitizeErrorMessage(error) };
    }
  }

  return { commitAndPush, createPullRequest };
}

// ── removeThoughtsAndPush ─────────────────────────────────────────────────────

/** Narrow dependency shape for `removeThoughtsAndPush`. */
export interface RemoveThoughtsDeps {
  workspaceManager: IWorkspaceManager;
  observer: IObserver;
}

/**
 * Remove thoughts files **introduced by this branch** from the worktree, commit, and push.
 *
 * PR-prep work called immediately before merge. Only removes files added relative to the
 * base branch — pre-existing `thoughts/` content in the repo is never touched. The files
 * remain in PR history for reviewer context but stay out of the target branch on merge.
 * Returns true if a cleanup commit was made, false if there was nothing to remove.
 */
export function removeThoughtsAndPush(deps: RemoveThoughtsDeps, taskId: string): boolean {
  const { workspaceManager, observer } = deps;
  const record = workspaceManager.getWorkspaceRecord(taskId);
  if (!record) {
    throw new Error(`Workspace not found for task "${taskId}"`);
  }

  const span = observer.startSpan(
    ObservationTypes.plugin_call,
    "remove_thoughts_and_push",
    { taskId, branch: record.branch, base: record.baseBranch },
    { task_id: taskId },
  );

  try {
    const baseRef = `origin/${record.baseBranch}`;
    const addedFilesRaw = execFileSync(
      "git",
      ["-c", "credential.helper=", "diff", "--name-only", "--diff-filter=A", baseRef, "--", "thoughts/"],
      { cwd: record.worktreePath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    ).trim();

    if (!addedFilesRaw) {
      observer.recordDecision(
        "remove_thoughts_and_push",
        `No branch-introduced thoughts files for task "${taskId}"`,
        [
          { id: "skip", description: "No files to remove — skip commit + push" },
          { id: "proceed", description: "Files present — rm, commit, push" },
        ],
        "skip",
        "Diff against base branch returned no added thoughts/ files.",
        1,
        { task_id: taskId },
      );
      span.end({ skipped: true, fileCount: 0 });
      return false;
    }

    const files = addedFilesRaw.split("\n");
    observer.info("Removing branch-introduced thoughts files before merge", { taskId, fileCount: files.length });

    execFileSync("git", ["-c", "credential.helper=", "rm", "-f", ...files], {
      cwd: record.worktreePath,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    execFileSync(
      "git",
      ["-c", "credential.helper=", "commit", "-m", "chore: remove engineering thoughts before merge"],
      { cwd: record.worktreePath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    workspaceManager.pushBranch(taskId);

    observer.info("Thoughts files removed and pushed", { taskId, fileCount: files.length });
    span.end({ skipped: false, fileCount: files.length });
    return true;
  } catch (error) {
    span.setError(error);
    span.end({ skipped: false });
    throw error;
  }
}
