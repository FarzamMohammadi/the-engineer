import type { GitHostingAdapter } from "../../../../adapters/git-hosting.js";
import { AdapterTypes, type MergeStrategy } from "../../../../schemas/adapters.js";
import { EventTypes } from "../../../../schemas/events.js";
import { NotificationKinds } from "../../../../schemas/notifications.js";
import { sanitizeErrorMessage } from "../../../../utils/sanitize.js";
import type { PublishInput } from "../../../interfaces/event-bus.interface.js";
import type { WorkspaceRecord } from "../../../interfaces/workspace-manager.interface.js";
import { removeThoughtsAndPush } from "../../pr-manager.js";
import {
  BlockCategories,
  type Ctx,
  Phases,
  type RoutableResult,
  type Route,
  type SubPhase,
  type SubPhaseResult,
} from "../types.js";
import { skipWhenPushOnly } from "./deliverable.js";

// ── The Sub-Phase ────────────────────────────────────────────────────────────
//
// auto-merge performs the merge. It is entry-only: the normal advance path blocks
// at await-review and never reaches it. The daemon's PR-event poller re-enters the
// task here on a `pr_ready_to_merge` (approved + CI green + mergeable) or `pr_merged`
// event, so by the time `run` executes the PR was just observed ready. `run` still
// re-checks the live PR — state can shift in the tick between the signal and here —
// then merges, removes engineering thoughts from the branch first, deletes the
// remote branch, and emits the merge audit events. Skipped in push-only mode, which
// has no PR to merge.
//
// Routing splits by cause (the local merge cleanup, the merge call, and the merge
// audit are effects; `next` is pure):
//   - merged / already-merged / auto-merge-disabled → done (the deliverable exists)
//   - CI failing / not mergeable → jump back to execution to fix it (a rework, so the
//     stale approval is dismissed and a human must re-approve before the next merge —
//     that human gate is what bounds the loop)
//   - a transient failure (a pending check, a flaky merge API) → return to the review
//     wait; the stateless poller retries the merge once the PR is ready again.

/** How `run` resolved the merge attempt. `next` reads this from `result.data` to pick the route. */
type MergeDisposition = "merged" | "auto_merge_disabled" | "ci_failure" | "merge_conflict" | "retry_wait";

/** Delivery: merge the approved PR. Entry-only — reached by an external event, not by advance. Skipped in push-only. */
export const autoMerge: SubPhase = {
  name: "auto-merge",
  skip: skipWhenPushOnly,
  run: runAutoMerge,
  next: autoMergeNext,
};

/** Route on how the merge resolved: a completed (or externally-completed) merge is done; an unmergeable PR reworks; a transient miss waits. */
export function autoMergeNext(result: RoutableResult): Route {
  if (result.outcome === "needs_human") {
    return {
      go: "block",
      category: BlockCategories.awaiting_human,
      needed: "Resolve the merge ambiguity before continuing",
    };
  }
  const disposition = (result.data as { disposition?: MergeDisposition } | undefined)?.disposition;
  switch (disposition) {
    case "ci_failure":
      return { go: "jump", to: Phases.execution, carry: { summary: CI_REWORK_SUMMARY } };
    case "merge_conflict":
      return { go: "jump", to: Phases.execution, carry: { summary: CONFLICT_REWORK_SUMMARY } };
    case "retry_wait":
      return {
        go: "block",
        category: BlockCategories.awaiting_pr_review,
        needed: "Waiting on the open PR — the merge retries once its checks are green and it is mergeable",
      };
    default:
      return { go: "done" };
  }
}

const CI_REWORK_SUMMARY =
  "The pull request could not be merged because its CI checks are failing. Reproduce the failures by running the project's own gates, fix the root cause, and let delivery re-push the branch.";
const CONFLICT_REWORK_SUMMARY =
  "The pull request could not be merged because it no longer merges cleanly into its base branch. Update the branch against the base, resolve every conflict, and let delivery re-push.";

// ── Running the Merge ──────────────────────────────────────────────────────────

async function runAutoMerge(ctx: Ctx): Promise<SubPhaseResult> {
  const hosting = ctx.registry.getPrimaryPlugin<GitHostingAdapter>(AdapterTypes.git_hosting);
  if (!hosting) {
    throw new Error("Cannot merge the pull request: no git hosting plugin is registered");
  }
  const record = ctx.workspaceManager.getWorkspaceRecord(ctx.task.id);
  const prNumber = ctx.task.review?.pr_number;
  const repo = record?.repo ?? ctx.task.repo;
  if (!(prNumber && repo)) {
    throw new Error("Cannot merge the pull request: the task has no PR number or repo on record");
  }

  // Re-derive readiness from the live PR — a pr_merged re-entry or a prior successful merge lands here already done.
  const status = await hosting.getPRStatus(repo, prNumber);
  if (status.state === "merged") {
    ctx.observer.info("Pull request already merged — completing", { taskId: ctx.task.id, prNumber });
    return done("merged", `PR #${String(prNumber)} is already merged`);
  }

  if (!ctx.safetyLayer.checkAutoMergeAllowed(repo)) {
    ctx.observer.info("Auto-merge not enabled for repo — completing for a manual merge", {
      taskId: ctx.task.id,
      repo,
      prNumber,
    });
    ctx.notifications.notify({
      kind: NotificationKinds.ticket_comment,
      taskId: ctx.task.id,
      message: `PR #${String(prNumber)} is approved and ready. Auto-merge is disabled for this repo — merge it when you're ready.`,
    });
    return done(
      "auto_merge_disabled",
      `PR #${String(prNumber)} approved; auto-merge disabled — leaving the merge to a human`,
    );
  }

  if (status.checks_state === "failing") {
    return done("ci_failure", `PR #${String(prNumber)} CI is failing — reworking before it can merge`);
  }
  if (!status.mergeable) {
    return done("merge_conflict", `PR #${String(prNumber)} no longer merges cleanly — reworking before it can merge`);
  }
  if (status.checks_state !== "passing") {
    ctx.observer.info("PR not yet green — returning to the review wait", {
      taskId: ctx.task.id,
      prNumber,
      checks: status.checks_state,
    });
    return done(
      "retry_wait",
      `PR #${String(prNumber)} checks are not yet green (${status.checks_state}) — waiting to retry`,
    );
  }

  removeThoughtsBeforeMerge(ctx);

  const strategy = ctx.workspaceConfig.pr.default_merge_strategy;
  ctx.observer.info("Merging pull request", { taskId: ctx.task.id, repo, prNumber, strategy });
  const result = await hosting.mergePR(repo, prNumber, strategy);
  if (!result.success) {
    if (result.error?.code === "merge_conflict") {
      return done("merge_conflict", `Merge rejected as conflicting: ${result.error.message}`);
    }
    ctx.observer.warn("Merge did not complete — returning to the review wait to retry", {
      taskId: ctx.task.id,
      prNumber,
      code: result.error?.code,
      message: result.error?.message,
    });
    return done("retry_wait", `Merge did not complete (${result.error?.code ?? "unknown"}) — waiting to retry`);
  }

  recordMerge(ctx, repo, prNumber, strategy, result.merge_sha, record);
  return done("merged", `Merged PR #${String(prNumber)}`);
}

/** Remove the branch-introduced thoughts/ files before merge, when configured. Best-effort — a failure never blocks the merge. */
function removeThoughtsBeforeMerge(ctx: Ctx): void {
  if (!ctx.safetyLayer.shouldExcludeThoughtsOnMerge()) {
    return;
  }
  try {
    removeThoughtsAndPush({ workspaceManager: ctx.workspaceManager, observer: ctx.observer }, ctx.task.id);
  } catch (error) {
    ctx.observer.warn("Failed to remove thoughts before merge — proceeding with the merge", {
      taskId: ctx.task.id,
      error: sanitizeErrorMessage(error),
    });
  }
}

/**
 * Record a completed merge: mark the PR merged on the task, publish the merge audit event, and delete the
 * remote branch (when configured) with its own audit event. The local worktree is reaped by the scheduler's
 * generic completion; only the merge-specific cleanup lives here. Branch deletion is best-effort.
 */
function recordMerge(
  ctx: Ctx,
  repo: string,
  prNumber: number,
  strategy: MergeStrategy,
  mergeSha: string,
  record: WorkspaceRecord | null,
): void {
  if (ctx.task.review) {
    ctx.taskEngine.updateTaskField(ctx.task.id, "review", { ...ctx.task.review, pr_state: "merged" });
  }
  ctx.eventBus.publish({
    type: EventTypes["git.pr_merged"],
    source: "orchestrator",
    task_id: ctx.task.id,
    payload: {
      task_id: ctx.task.id,
      repo,
      pr_number: prNumber,
      merge_strategy: strategy,
      merge_sha: mergeSha,
      into_branch: record?.baseBranch ?? "",
    },
  } satisfies PublishInput<"git.pr_merged">);
  ctx.notifications.notify({
    kind: NotificationKinds.milestone,
    taskId: ctx.task.id,
    message: `Merged PR #${String(prNumber)}`,
  });
  ctx.observer.info("Pull request merged", { taskId: ctx.task.id, prNumber, mergeSha });
  deleteRemoteBranchAfterMerge(ctx, repo, record);
}

/** Delete the merged branch from the remote when configured, emitting the audit event. Never blocks completion. */
function deleteRemoteBranchAfterMerge(ctx: Ctx, repo: string, record: WorkspaceRecord | null): void {
  if (!(ctx.workspaceConfig.pr.delete_branch_after_merge && record)) {
    return;
  }
  try {
    ctx.workspaceManager.deleteRemoteBranch(ctx.task.id);
    ctx.eventBus.publish({
      type: EventTypes["git.branch_deleted"],
      source: "orchestrator",
      task_id: ctx.task.id,
      payload: { task_id: ctx.task.id, repo, branch: record.branch },
    } satisfies PublishInput<"git.branch_deleted">);
    ctx.observer.info("Deleted remote branch after merge", { taskId: ctx.task.id, branch: record.branch });
  } catch (error) {
    ctx.observer.warn("Remote branch deletion failed after merge — proceeding", {
      taskId: ctx.task.id,
      branch: record.branch,
      error: sanitizeErrorMessage(error),
    });
  }
}

/** A merge attempt that ran cleanly: an `ok` result carrying the disposition `next` routes on. */
function done(disposition: MergeDisposition, summary: string): SubPhaseResult {
  return { outcome: "ok", summary, data: { disposition } };
}
