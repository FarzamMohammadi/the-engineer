import { execFileSync } from "node:child_process";
import type { GitHostingAdapter } from "../../adapters/git-hosting.js";
import { AdapterTypes } from "../../schemas/adapters.js";
import type { Dispatch } from "../../schemas/ephemeral.js";
import type { PhaseOutput } from "../../schemas/orchestrator.js";
import { Phases } from "../../schemas/orchestrator.js";
import { JournalEntryTypes } from "../../schemas/session-memory.js";
import { sanitizeSecrets } from "../../utils/sanitize.js";
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
    commentOnSourceIssue: (d: Dispatch, m: string) => void,
    notifyMilestone: (d: Dispatch, m: string) => void,
  ): Promise<boolean>;
}

// ── Factory ─────────────────────────────────────────────────────────────────

/** Create a PrManager bound to the given OrchestratorContext. */
export function createPrManager(ctx: OrchestratorContext): PrManager {
  function logPrStepFailure(sessionId: string, taskId: string, step: string, error: unknown): void {
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
    commentOnSourceIssue: (d: Dispatch, m: string) => void,
    notifyMilestone: (d: Dispatch, m: string) => void,
  ): Promise<boolean> {
    const worktreePath = ctx.workspaceManager.getWorktreePath(taskId);
    if (!worktreePath) {
      console.warn("[pr-workflow] no workspace path — skipping");
      return false;
    }

    const record = ctx.workspaceManager.getWorkspaceRecord(taskId);
    if (!record) {
      console.warn("[pr-workflow] no workspace record — skipping");
      return false;
    }

    const isRework = dispatch.task.review?.pr_number != null;
    console.log(
      `[pr-workflow] starting: repo=${record.repo} branch=${record.branch} rework=${String(isRework)}`,
    );

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
          : `feat: ${dispatch.task.title}\n\nAutomated by The Engineer`;
        execFileSync("git", ["commit", "-m", commitMessage], {
          cwd: worktreePath,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        });
        hasNewCommit = true;
      }
    } catch (error) {
      logPrStepFailure(sessionId, taskId, "commit", error);
      console.error(
        `[pr-workflow] commit failed: ${error instanceof Error ? error.message : String(error)}`,
      );
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
          console.warn("[pr-workflow] no commits ahead of base — skipping");
          return false;
        }
        console.log(`[pr-workflow] ${aheadCount} commits ahead of base`);
      } catch (error) {
        console.warn(
          `[pr-workflow] can't determine ahead count — skipping: ${error instanceof Error ? error.message : String(error)}`,
        );
        return false;
      }
    }

    // 2. Push via WorkspaceManager (D151 — token injection)
    console.log(`[pr-workflow] pushing branch ${record.branch}...`);
    try {
      ctx.workspaceManager.pushBranch(taskId);
      console.log("[pr-workflow] push succeeded");
    } catch (error) {
      logPrStepFailure(sessionId, taskId, "push", error);
      console.error(
        `[pr-workflow] push failed: ${error instanceof Error ? error.message : String(error)}`,
      );
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
      commentOnSourceIssue(dispatch, "Pushed rework addressing review feedback.");
      return true;
    }

    // 3. Create draft PR via GitHostingAdapter
    const gitHosting = ctx.registry.getPrimaryPlugin<GitHostingAdapter>(AdapterTypes.git_hosting);
    if (!gitHosting) {
      console.warn("[pr-workflow] no git hosting plugin — skipping PR creation");
      return false;
    }

    console.log(`[pr-workflow] creating draft PR on ${record.repo}...`);
    try {
      const rawDescription =
        (demoPrepOutput.data as { pr_description?: string }).pr_description ??
        `Automated PR for: ${dispatch.task.title}`;

      // Sanitize PR description to prevent secret leakage (D154)
      const prDescription = sanitizeSecrets(rawDescription);

      const prResult = await gitHosting.createPR({
        repo: record.repo,
        branch: record.branch,
        base: record.baseBranch,
        title: dispatch.task.title,
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

      console.log(`[pr-workflow] draft PR #${String(prResult.pr_number)} created: ${prResult.url}`);

      notifyMilestone(dispatch, `Draft PR created: ${prResult.url}`);
      commentOnSourceIssue(dispatch, `Draft PR created: ${prResult.url}`);
      return true;
    } catch (error) {
      logPrStepFailure(sessionId, taskId, "pr_creation", error);
      console.error(
        `[pr-workflow] PR creation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  return { commitPushAndCreatePR };
}
