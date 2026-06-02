import type { GitHostingAdapter } from "../../../../adapters/git-hosting.js";
import { AdapterTypes, type MergeStrategy } from "../../../../schemas/adapters.js";
import { EventTypes } from "../../../../schemas/events.js";
import { NotificationKinds } from "../../../../schemas/notifications.js";
import type { ReviewState } from "../../../../schemas/task.js";
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
// then removes engineering thoughts from the branch and merges. It only *records* the
// merge — stamps `review.merged_at`, emits the audit event, and notifies the milestone;
// it does not delete the branch. The workspace reaper is the sole branch deleter and
// reaps merged branches per `branch_retention_days`. An already-merged PR (the user
// merged it, or a re-entry after a prior merge) takes the same record path with no
// milestone — the external-merge backfill that lets the reaper reap an externally-merged
// branch. Skipped in push-only mode, which has no PR to merge.
//
// Routing splits by cause (the thoughts removal, the merge call, and the merge record
// are effects; `next` is pure):
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
  const review = ctx.task.review;
  const prNumber = review?.pr_number;
  const repo = record?.repo ?? ctx.task.repo;
  if (!(prNumber && repo && review)) {
    throw new Error("Cannot merge the pull request: the task has no PR number or repo on record");
  }

  // Re-derive readiness from the live PR — a pr_merged re-entry or a prior successful merge lands here already done.
  const status = await hosting.getPRStatus(repo, prNumber);
  if (status.state === "merged") {
    // External-merge backfill: record so the reaper can reap the branch, but no milestone — the user
    // merged it themselves and we are not notifying someone of their own action (D10). The strategy is the
    // configured default (the real one is unknown for an external merge) and there is no merge SHA to record.
    ctx.observer.info("Pull request already merged — backfilling the merge record", {
      taskId: ctx.task.id,
      prNumber,
    });
    recordMerge(ctx, {
      repo,
      prNumber,
      strategy: ctx.workspaceConfig.pr.default_merge_strategy,
      mergeSha: "",
      record,
      review,
      notifyMilestone: false,
    });
    return resolved("merged", `PR #${String(prNumber)} is already merged`);
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
    return resolved(
      "auto_merge_disabled",
      `PR #${String(prNumber)} approved; auto-merge disabled — leaving the merge to a human`,
    );
  }

  if (status.checks_state === "failing") {
    return resolved("ci_failure", `PR #${String(prNumber)} CI is failing — reworking before it can merge`);
  }
  if (!status.mergeable) {
    return resolved(
      "merge_conflict",
      `PR #${String(prNumber)} no longer merges cleanly — reworking before it can merge`,
    );
  }
  // "passing" and "none" (a repo with no CI configured — nothing to wait on) both proceed to merge.
  // Only "pending" (checks still running) returns to the wait for the stateless poller to retry.
  if (status.checks_state === "pending") {
    ctx.observer.info("PR checks still running — returning to the review wait", {
      taskId: ctx.task.id,
      prNumber,
      checks: status.checks_state,
    });
    return resolved(
      "retry_wait",
      `PR #${String(prNumber)} checks are still running (${status.checks_state}) — waiting to retry`,
    );
  }

  removeThoughtsBeforeMerge(ctx);

  const strategy = ctx.workspaceConfig.pr.default_merge_strategy;
  ctx.observer.info("Merging pull request", { taskId: ctx.task.id, repo, prNumber, strategy });
  const result = await hosting.mergePR(repo, prNumber, strategy);
  if (!result.success) {
    if (result.error?.code === "merge_conflict") {
      return resolved("merge_conflict", `Merge rejected as conflicting: ${result.error.message}`);
    }
    ctx.observer.warn("Merge did not complete — returning to the review wait to retry", {
      taskId: ctx.task.id,
      prNumber,
      code: result.error?.code,
      message: result.error?.message,
    });
    return resolved("retry_wait", `Merge did not complete (${result.error?.code ?? "unknown"}) — waiting to retry`);
  }

  recordMerge(ctx, { repo, prNumber, strategy, mergeSha: result.merge_sha, record, review, notifyMilestone: true });
  return resolved("merged", `Merged PR #${String(prNumber)}`);
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

/** Inputs for recording a completed merge. `notifyMilestone` is true for a self-merge, false for the external-merge backfill. */
interface RecordMergeInput {
  readonly repo: string;
  readonly prNumber: number;
  readonly strategy: MergeStrategy;
  readonly mergeSha: string;
  readonly record: WorkspaceRecord | null;
  readonly review: ReviewState;
  readonly notifyMilestone: boolean;
}

/**
 * Record a completed merge: stamp `review.merged_at` (the reaper's retention clock), publish the merge audit
 * event, and — only for a self-merge — notify the milestone. It does NOT delete the branch: the workspace
 * reaper is the sole branch deleter and reaps per `branch_retention_days`. The local worktree is already
 * reaped inline by the scheduler's completion path.
 */
function recordMerge(ctx: Ctx, input: RecordMergeInput): void {
  const { repo, prNumber, strategy, mergeSha, record, review, notifyMilestone } = input;
  // Stamp the merge time with the orchestrator's wall-clock idiom — there is no clock on the orchestrator
  // context, and at day-granularity retention the detection-time vs actual-merge-time gap is immaterial (D15).
  ctx.taskEngine.updateTaskField(ctx.task.id, "review", {
    ...review,
    merged_at: new Date().toISOString(),
  });
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
  if (notifyMilestone) {
    ctx.notifications.notify({
      kind: NotificationKinds.milestone,
      taskId: ctx.task.id,
      message: `Merged PR #${String(prNumber)}`,
    });
  }
  ctx.observer.info("Pull request merge recorded — the reaper deletes the branch per branch_retention_days", {
    taskId: ctx.task.id,
    prNumber,
    selfMerged: notifyMilestone,
  });
}

/** A merge attempt that ran cleanly: an `ok` result carrying the disposition `next` routes on. */
function resolved(disposition: MergeDisposition, summary: string): SubPhaseResult {
  return { outcome: "ok", summary, data: { disposition } };
}
