import type { GitHostingAdapter } from "../../../../adapters/git-hosting.js";
import { AdapterTypes, type MergeStrategy, type PRStatus } from "../../../../schemas/adapters.js";
import { EventTypes } from "../../../../schemas/events.js";
import { NotificationKinds } from "../../../../schemas/notifications.js";
import { ObservationTypes } from "../../../../schemas/observer.js";
import { sanitizeErrorMessage } from "../../../../utils/sanitize.js";
import type { PublishInput } from "../../../interfaces/event-bus.interface.js";
import type { WorkspaceRecord } from "../../../interfaces/workspace-manager.interface.js";
import { removeThoughtsAndPush } from "../../pr-manager.js";
import { traceScope } from "../observability.js";
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

  // Re-derive readiness from the live PR — state can shift between the poller's signal and here. The
  // disposition is the central decision of this terminal, irreversible step, so it is recorded with the
  // live status that drove it and the alternatives it beat — the owner can always reconstruct why a PR did
  // (or did not) merge.
  const status = await hosting.getPRStatus(repo, prNumber);
  const readiness = decideReadiness(ctx, repo, status);
  recordMergeReadiness(ctx, prNumber, status, readiness);

  switch (readiness.disposition) {
    case "merged": {
      ctx.observer.info("Pull request already merged — completing", { taskId: ctx.task.id, prNumber });
      return resolved("merged", `PR #${String(prNumber)} is already merged`);
    }
    case "auto_merge_disabled": {
      notifyAutoMergeDisabled(ctx, prNumber);
      return resolved(
        "auto_merge_disabled",
        `PR #${String(prNumber)} approved; auto-merge disabled — leaving the merge to a human`,
      );
    }
    case "ci_failure": {
      ctx.observer.info("PR CI is failing — reworking before it can merge", { taskId: ctx.task.id, prNumber });
      return resolved("ci_failure", `PR #${String(prNumber)} CI is failing — reworking before it can merge`);
    }
    case "merge_conflict": {
      ctx.observer.info("PR no longer merges cleanly — reworking before it can merge", {
        taskId: ctx.task.id,
        prNumber,
      });
      return resolved(
        "merge_conflict",
        `PR #${String(prNumber)} no longer merges cleanly — reworking before it can merge`,
      );
    }
    case "retry_wait": {
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
    default:
      return performMerge(ctx, hosting, repo, prNumber, record);
  }
}

/** What to do with the PR, derived purely from its live status and the repo's auto-merge policy. */
interface MergeReadiness {
  readonly disposition: MergeDisposition | "merge";
  readonly reasoning: string;
}

/** Decide the disposition from the live PR status — the merge-readiness policy, in one pure place. */
function decideReadiness(ctx: Ctx, repo: string, status: PRStatus): MergeReadiness {
  if (status.state === "merged") {
    return { disposition: "merged", reasoning: "the PR is already merged" };
  }
  if (!ctx.safetyLayer.checkAutoMergeAllowed(repo)) {
    return { disposition: "auto_merge_disabled", reasoning: "auto-merge is disabled for this repo" };
  }
  if (status.checks_state === "failing") {
    return { disposition: "ci_failure", reasoning: "CI checks are failing" };
  }
  if (!status.mergeable) {
    return { disposition: "merge_conflict", reasoning: "the PR no longer merges cleanly into its base" };
  }
  // "passing" and "none" (a repo with no CI — nothing to wait on) proceed; only "pending" returns to the wait.
  if (status.checks_state === "pending") {
    return { disposition: "retry_wait", reasoning: "CI checks are still running" };
  }
  return { disposition: "merge", reasoning: `checks ${status.checks_state} and mergeable — proceeding to merge` };
}

const MERGE_DISPOSITION_OPTIONS = [
  { id: "merge", description: "Merge now — approved, checks green, mergeable" },
  { id: "merged", description: "Already merged — complete the task" },
  { id: "auto_merge_disabled", description: "Auto-merge disabled — leave the merge to a human" },
  { id: "ci_failure", description: "CI failing — hand back to execution to fix it" },
  { id: "merge_conflict", description: "No longer mergeable — hand back to execution to resolve it" },
  { id: "retry_wait", description: "Checks still running — return to the review wait and retry" },
] as const;

/** Record the merge-readiness decision: the live PR status that drove it, the disposition chosen, and why. */
function recordMergeReadiness(ctx: Ctx, prNumber: number, status: PRStatus, readiness: MergeReadiness): void {
  ctx.observer.recordDecision(
    "merge_readiness",
    `PR #${String(prNumber)} is ${status.state}, checks ${status.checks_state}, mergeable=${String(status.mergeable)}`,
    MERGE_DISPOSITION_OPTIONS,
    readiness.disposition,
    readiness.reasoning,
    1,
    traceScope(ctx),
  );
}

/** Notify the owner that an approved PR is ready but auto-merge is off, so they can merge it themselves. */
function notifyAutoMergeDisabled(ctx: Ctx, prNumber: number): void {
  ctx.observer.info("Auto-merge not enabled for repo — completing for a manual merge", {
    taskId: ctx.task.id,
    prNumber,
  });
  ctx.notifications.notify({
    kind: NotificationKinds.ticket_comment,
    taskId: ctx.task.id,
    message: `PR #${String(prNumber)} is approved and ready. Auto-merge is disabled for this repo — merge it when you're ready.`,
  });
}

/** Perform the merge inside a tool_execution span, then record the audit on success or route the failure by cause. */
async function performMerge(
  ctx: Ctx,
  hosting: GitHostingAdapter,
  repo: string,
  prNumber: number,
  record: WorkspaceRecord | null,
): Promise<SubPhaseResult> {
  removeThoughtsBeforeMerge(ctx);
  const strategy = ctx.workspaceConfig.pr.default_merge_strategy;
  ctx.observer.info("Merging pull request", { taskId: ctx.task.id, repo, prNumber, strategy });

  const span = ctx.observer.startSpan(
    ObservationTypes.tool_execution,
    "merge_pr",
    { repo, prNumber, strategy },
    traceScope(ctx),
  );
  const result = await hosting.mergePR(repo, prNumber, strategy);
  if (!result.success) {
    span.setError(new Error(result.error?.message ?? "merge did not complete"));
    span.end({ success: false, code: result.error?.code ?? null });
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
  span.end({ success: true, merge_sha: result.merge_sha });

  recordMerge(ctx, repo, prNumber, strategy, result.merge_sha, record);
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
function resolved(disposition: MergeDisposition, summary: string): SubPhaseResult {
  return { outcome: "ok", summary, data: { disposition } };
}
