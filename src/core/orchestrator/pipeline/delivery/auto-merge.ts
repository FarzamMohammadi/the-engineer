import type { GitHostingAdapter } from "../../../../adapters/git-hosting.js";
import {
  AdapterTypes,
  type MergeFailureReason,
  type MergeStrategy,
  type PRStatus,
} from "../../../../schemas/adapters.js";
import { EventTypes } from "../../../../schemas/events.js";
import { NotificationKinds, correlationFromTraceScope } from "../../../../schemas/notifications.js";
import { ObservationTypes } from "../../../../schemas/observer.js";
import type { ReviewState } from "../../../../schemas/task.js";
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
//   - merged / already-merged / auto-merge-disabled / host-blocked → done (the deliverable
//     exists, or the host requires a human to perform the merge — either way we stop, never loop)
//   - CI failing / merge conflict → jump back to execution to fix it (a rework, so the
//     stale approval is dismissed and a human must re-approve before the next merge —
//     that human gate is what bounds the loop)
//   - a transient failure (a pending check, a flaky merge API) → return to the review
//     wait; the stateless poller retries the merge once the PR is ready again.

/** How `run` resolved the merge attempt. `next` reads this from `result.data` to pick the route. */
type MergeDisposition =
  | "merged"
  | "auto_merge_disabled"
  | "ci_failure"
  | "merge_conflict"
  | "needs_human_merge"
  | "retry_wait";

/** The subset of dispositions a failed merge attempt can resolve to — routed by {@link classifyMergeFailure}. */
type MergeFailureDisposition = Extract<MergeDisposition, "merge_conflict" | "needs_human_merge" | "retry_wait">;

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

  // Re-derive readiness from the live PR — state can shift between the poller's signal and here. The
  // disposition is the central decision of this terminal, irreversible step, so it is recorded with the
  // live status that drove it and the alternatives it beat — the owner can always reconstruct why a PR did
  // (or did not) merge.
  const status = await hosting.getPRStatus(repo, prNumber);
  const readiness = decideReadiness(ctx, repo, status);
  recordMergeReadiness(ctx, prNumber, status, readiness);

  switch (readiness.disposition) {
    case "merged": {
      // External-merge backfill: record so the reaper can reap the branch, but no milestone — the user
      // merged it themselves, and we do not notify someone of their own action.
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
      return performMerge(ctx, hosting, repo, prNumber, record, review);
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
    // The merge record is backfilled by the caller (so the reaper can reap an externally-merged branch).
    return { disposition: "merged", reasoning: "the PR is already merged" };
  }
  if (!ctx.safetyLayer.checkAutoMergeAllowed(repo)) {
    return { disposition: "auto_merge_disabled", reasoning: "auto-merge is disabled for this repo" };
  }
  if (status.checks_state === "failing") {
    return { disposition: "ci_failure", reasoning: "CI checks are failing" };
  }
  if (status.merge_state === "conflicting") {
    return { disposition: "merge_conflict", reasoning: "the PR no longer merges cleanly into its base" };
  }
  // `unknown` mergeability is the host still computing it (common right after a push) — wait and re-check,
  // never rework, so a not-yet-resolved merge state cannot send a clean PR back to execution.
  if (status.merge_state === "unknown") {
    return { disposition: "retry_wait", reasoning: "mergeability is not yet computed" };
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
    `PR #${String(prNumber)} is ${status.state}, checks ${status.checks_state}, merge_state=${status.merge_state}`,
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
  review: ReviewState,
): Promise<SubPhaseResult> {
  // Capture the formal-approval state *before* the cleanup push. If a strip commit lands after a formal
  // approval, the host's dismiss_stale_reviews dismisses it, so the hand-off must ask the owner to
  // re-approve. A `/approve` comment is never dismissed, so it takes the plain hand-off. Only fetched when
  // stripping is enabled — the one case a dismissal can occur.
  const wasApproved = ctx.safetyLayer.shouldExcludeThoughtsOnMerge()
    ? (await hosting.getReviewStatus(repo, prNumber)).approved
    : false;
  const stripped = removeThoughtsBeforeMerge(ctx);
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
    span.setError(new Error(result.message));
    span.end({ success: false, reason: result.reason });
    return routeMergeFailure(ctx, prNumber, result.reason, result.message, wasApproved && stripped);
  }
  span.end({ success: true, merge_sha: result.merge_sha });

  recordMerge(ctx, { repo, prNumber, strategy, mergeSha: result.merge_sha, record, review, notifyMilestone: true });
  return resolved("merged", `Merged PR #${String(prNumber)}`);
}

/**
 * Remove the branch-introduced thoughts/ files before merge, when configured. Best-effort — a failure
 * never blocks the merge. Returns whether a cleanup commit was actually pushed: a push after a formal
 * approval dismisses it (dismiss_stale_reviews), which the hand-off notification must surface.
 */
function removeThoughtsBeforeMerge(ctx: Ctx): boolean {
  if (!ctx.safetyLayer.shouldExcludeThoughtsOnMerge()) {
    return false;
  }
  try {
    return removeThoughtsAndPush({ workspaceManager: ctx.workspaceManager, observer: ctx.observer }, ctx.task.id);
  } catch (error) {
    ctx.observer.warn("Failed to remove thoughts before merge — proceeding with the merge", {
      taskId: ctx.task.id,
      error: sanitizeErrorMessage(error),
    });
    return false;
  }
}

// ── Merge-Failure Routing ───────────────────────────────────────────────────────

/**
 * Route a failed merge attempt by its typed failure reason. A conflict reworks. A host block — a rule the
 * Engineer cannot satisfy with its token (a required review, or no merge permission) — is handed off to
 * the owner to merge: terminal, so the task leaves the review-poll set and cannot re-trigger. Anything
 * else is treated as transient and retried. The route is recorded (Coding Standards § 14 — merge failure
 * by cause), so the owner can always see why a PR did not merge itself.
 */
function routeMergeFailure(
  ctx: Ctx,
  prNumber: number,
  reason: MergeFailureReason,
  message: string,
  approvalDismissed: boolean,
): SubPhaseResult {
  const failure = classifyMergeFailure(reason);
  recordMergeOutcome(ctx, prNumber, reason, failure);
  switch (failure.disposition) {
    case "merge_conflict":
      return resolved("merge_conflict", `Merge rejected as conflicting: ${message}`);
    case "needs_human_merge": {
      notifyHostBlockedMerge(ctx, prNumber, approvalDismissed);
      return resolved("needs_human_merge", `PR #${String(prNumber)} handed off — the host blocks the Engineer's merge`);
    }
    default: {
      ctx.observer.warn("Merge did not complete — returning to the review wait to retry", {
        taskId: ctx.task.id,
        prNumber,
        reason,
        message,
      });
      return resolved("retry_wait", `Merge did not complete (${reason}) — waiting to retry`);
    }
  }
}

/** The route a failed merge attempt resolves to, with the reasoning recorded for the owner. */
interface MergeFailureRoute {
  readonly disposition: MergeFailureDisposition;
  readonly reasoning: string;
}

/** Map the plugin's typed failure reason to a route. Pure and exhaustive — a new reason breaks the build here. */
function classifyMergeFailure(reason: MergeFailureReason): MergeFailureRoute {
  switch (reason) {
    case "conflict":
      return { disposition: "merge_conflict", reasoning: "the base moved and the branch no longer merges cleanly" };
    case "not_mergeable":
      return {
        disposition: "needs_human_merge",
        reasoning:
          "the host's rules block the Engineer's own merge (a required review it cannot satisfy, or no merge permission) — a human must complete it",
      };
    case "transient":
      return {
        disposition: "retry_wait",
        reasoning: "a transient merge failure — wait and retry once the PR is ready again",
      };
    default: {
      const exhaustive: never = reason;
      throw new Error(`Unhandled merge failure reason "${JSON.stringify(exhaustive)}"`);
    }
  }
}

const MERGE_OUTCOME_OPTIONS = [
  { id: "merge_conflict", description: "Conflict — hand back to execution to resolve it" },
  { id: "needs_human_merge", description: "Host blocks the merge — hand off to the owner to complete it" },
  { id: "retry_wait", description: "Transient failure — return to the review wait and retry" },
] as const;

/** Record why a failed merge attempt routed where it did — the merge-failure-by-cause decision the owner can inspect. */
function recordMergeOutcome(ctx: Ctx, prNumber: number, reason: MergeFailureReason, failure: MergeFailureRoute): void {
  ctx.observer.recordDecision(
    "merge_outcome",
    `PR #${String(prNumber)} merge attempt failed (reason ${reason})`,
    MERGE_OUTCOME_OPTIONS,
    failure.disposition,
    failure.reasoning,
    1,
    traceScope(ctx),
  );
}

/**
 * Notify the owner that the PR is ready but the host will not let the Engineer merge it, so they complete
 * the merge. When the pre-merge thoughts-cleanup push dismissed a formal approval, the message says so and
 * asks for a fresh approval; otherwise it is the plain "merge it" hand-off.
 */
function notifyHostBlockedMerge(ctx: Ctx, prNumber: number, approvalDismissed: boolean): void {
  ctx.observer.info("Host blocked the merge — completing for the owner to merge", {
    taskId: ctx.task.id,
    prNumber,
    approvalDismissed,
  });
  const message = approvalDismissed
    ? `PR #${String(prNumber)} is ready, but my thoughts-cleanup commit dismissed your earlier approval. Re-approve it and merge when you're ready.`
    : `PR #${String(prNumber)} is approved and ready, but the host won't let me complete the merge (its rules need a human). Merge it when you're ready.`;
  ctx.notifications.notify({ kind: NotificationKinds.ticket_comment, taskId: ctx.task.id, message });
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
      correlation: correlationFromTraceScope(traceScope(ctx)),
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
