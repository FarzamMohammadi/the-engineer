import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { GitHostingAdapter } from "../../adapters/git-hosting.js";
import { AdapterTypes } from "../../schemas/adapters.js";
import type { Dispatch } from "../../schemas/ephemeral.js";
import { ObservationType } from "../../schemas/observer.js";
import type { PhaseOutput } from "../../schemas/orchestrator.js";
import { Phases } from "../../schemas/orchestrator.js";
import { JournalEntryTypes } from "../../schemas/session-memory.js";
import { sanitizeErrorMessage, sanitizeSecrets } from "../../utils/sanitize.js";
import type { OrchestratorNotifier } from "./orchestrator-notifier.js";
import type { OrchestratorContext } from "./types.js";

// ── PrManager Interface ────────────────────────────────────────────────────

/** Commit, push, and PR creation workflow. */
export interface PrManager {
  /**
   * Commit all changes, push branch, and create a draft PR (D149, D150, D151).
   *
   * For rework dispatches (PR already exists): commits, pushes to existing
   * branch, marks feedback as applied, and returns true (no new PR).
   */
  commitPushAndCreatePR(
    sessionId: string,
    taskId: string,
    demoPrepOutput: PhaseOutput,
    dispatch: Dispatch,
  ): Promise<boolean>;
}

// ── Factory ─────────────────────────────────────────────────────────────────

/** Create a PrManager bound to the given OrchestratorContext. */
export function createPrManager(
  ctx: OrchestratorContext,
  notifier: OrchestratorNotifier,
): PrManager {
  const observer = ctx.observer;
  function recordPrWorkflowError(
    sessionId: string,
    taskId: string,
    step: string,
    error: unknown,
  ): void {
    const message = error instanceof Error ? error.message : String(error);
    ctx.sessionMemory.addJournalEntry({
      sessionId,
      taskId,
      phase: Phases.demo_prep,
      type: JournalEntryTypes.error,
      summary: `PR workflow failed at ${step}: ${message}`,
      tags: ["pr_workflow", step],
    });
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: multi-step PR workflow with rework branch — extraction would fragment the sequential logic
  async function commitPushAndCreatePR(
    sessionId: string,
    taskId: string,
    demoPrepOutput: PhaseOutput,
    dispatch: Dispatch,
  ): Promise<boolean> {
    const prStart = Date.now();
    const worktreePath = ctx.workspaceManager.getWorktreePath(taskId);
    if (!worktreePath) {
      observer.warn("No workspace path — skipping PR workflow", { taskId });
      return false;
    }

    const record = ctx.workspaceManager.getWorkspaceRecord(taskId);
    if (!record) {
      observer.warn("No workspace record — skipping PR workflow", { taskId });
      return false;
    }

    const isRework = dispatch.task.review?.pr_number != null;
    const span = observer.startSpan(
      ObservationType.PLUGIN_CALL,
      "pr_workflow",
      { taskId, repo: record.repo, branch: record.branch, isRework },
      { task_id: taskId },
    );
    observer.info("Starting PR workflow", {
      taskId,
      repo: record.repo,
      branch: record.branch,
      isRework,
    });

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
          ? "fix: address review feedback\n\nAutomated by The Engineer"
          : `feat: ${sanitizeSecrets(dispatch.task.title)}\n\nAutomated by The Engineer`;
        execFileSync("git", ["commit", "-m", commitMessage], {
          cwd: worktreePath,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        });
        hasNewCommit = true;
      }
    } catch (error) {
      recordPrWorkflowError(sessionId, taskId, "commit", error);
      observer.error("PR workflow commit failed", {
        taskId,
        error: sanitizeErrorMessage(error),
      });
      span.setError(error);
      span.end({ step: "commit", success: false, elapsedMs: Date.now() - prStart });
      return false;
    }

    // Check if branch has commits ahead of base
    if (!hasNewCommit) {
      try {
        const aheadCount = execFileSync(
          "git",
          ["rev-list", "--count", `origin/${record.baseBranch}..HEAD`],
          { cwd: worktreePath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
        ).trim();
        if (aheadCount === "0") {
          observer.warn("No commits ahead of base — skipping PR workflow", { taskId });
          span.end({ step: "ahead_check", success: false, elapsedMs: Date.now() - prStart });
          return false;
        }
        observer.debug("Commits ahead of base", { taskId, aheadCount });
      } catch (error) {
        observer.warn("Cannot determine ahead count — skipping PR workflow", {
          taskId,
          error: sanitizeErrorMessage(error),
        });
        span.end({ step: "ahead_check", success: false, elapsedMs: Date.now() - prStart });
        return false;
      }
    }

    // 2. Push via WorkspaceManager (D151 — token injection)
    observer.info("Pushing branch", { taskId, branch: record.branch });
    try {
      ctx.workspaceManager.pushBranch(taskId);
      observer.info("Push succeeded", { taskId, branch: record.branch });
    } catch (error) {
      recordPrWorkflowError(sessionId, taskId, "push", error);
      observer.error("PR workflow push failed", {
        taskId,
        error: sanitizeErrorMessage(error),
      });
      span.setError(error);
      span.end({ step: "push", success: false, elapsedMs: Date.now() - prStart });
      return false;
    }

    // Rework path: PR already exists — just push, mark feedback applied, notify
    if (isRework) {
      const task = ctx.taskEngine.getTask(taskId);
      if (task?.review) {
        const updatedRounds = task.review.feedback_rounds.map((r) => ({ ...r, applied: true }));
        ctx.taskEngine.updateTaskField(taskId, "review", {
          ...task.review,
          feedback_rounds: updatedRounds,
        });
      }
      notifier.commentOnSourceTicket(dispatch, "Pushed rework addressing review feedback.");
      observer.info("Rework pushed to existing PR", {
        taskId,
        prNumber: dispatch.task.review?.pr_number,
        elapsedMs: Date.now() - prStart,
      });
      span.end({ step: "rework_push", success: true, elapsedMs: Date.now() - prStart });
      return true;
    }

    // 3. Create draft PR via GitHostingAdapter
    const gitHosting = ctx.registry.getPrimaryPlugin<GitHostingAdapter>(AdapterTypes.git_hosting);
    if (!gitHosting) {
      observer.warn("No git hosting plugin — skipping PR creation", { taskId });
      span.end({ step: "pr_create", success: false, elapsedMs: Date.now() - prStart });
      return false;
    }

    observer.info("Creating draft PR", { taskId, repo: record.repo });
    try {
      // CLI-native: read PR description from deliverable file when not in PhaseOutput.data
      let rawDescription = (demoPrepOutput.data as { pr_description?: string }).pr_description;
      if (!rawDescription) {
        const deliverablePath = (demoPrepOutput.data as { deliverable_path?: string })
          .deliverable_path;
        if (deliverablePath) {
          const absPath = path.join(worktreePath, deliverablePath);
          if (existsSync(absPath)) {
            rawDescription = readFileSync(absPath, "utf-8").trim();
          }
        }
      }
      rawDescription = rawDescription || `Automated PR for: ${dispatch.task.title}`;

      // Sanitize PR description to prevent secret leakage (D154)
      const prDescription = sanitizeSecrets(rawDescription);

      const prResult = await gitHosting.createPR({
        repo: record.repo,
        branch: record.branch,
        base: record.baseBranch,
        title: sanitizeSecrets(dispatch.task.title),
        body: prDescription,
        draft: true,
        labels: null,
        reviewers: null,
      });

      ctx.taskEngine.updateTaskField(taskId, "review", {
        pr_number: prResult.pr_number,
        pr_state: "draft",
        demo_artifacts: [],
        feedback_rounds: [],
      });

      const elapsedMs = Date.now() - prStart;
      observer.info("Draft PR created", {
        taskId,
        prNumber: prResult.pr_number,
        url: prResult.url,
        elapsedMs,
      });

      notifier.notifyMilestone(dispatch, `Draft PR created: ${prResult.url}`);
      notifier.commentOnSourceTicket(dispatch, `Draft PR created: ${prResult.url}`);
      span.end({ step: "pr_create", success: true, prNumber: prResult.pr_number, elapsedMs });
      return true;
    } catch (error) {
      recordPrWorkflowError(sessionId, taskId, "pr_creation", error);
      observer.error("PR creation failed", {
        taskId,
        error: sanitizeErrorMessage(error),
      });
      span.setError(error);
      span.end({ step: "pr_create", success: false, elapsedMs: Date.now() - prStart });
      return false;
    }
  }

  return { commitPushAndCreatePR };
}
