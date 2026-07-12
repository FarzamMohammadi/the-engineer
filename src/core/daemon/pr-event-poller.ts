import type { GitHostingAdapter } from "../../adapters/git-hosting.js";
import { AdapterTypes, type PRComment } from "../../schemas/adapters.js";
import { type PrEvent, PrEventTypes } from "../../schemas/git-hosting-events.js";
import { NotificationKinds } from "../../schemas/notifications.js";
import { BlockCategories, BlockReasons, type BlockedDetails, type Task, TaskStates } from "../../schemas/task.js";
import { sanitizeErrorMessage, sanitizeSecrets } from "../../utils/sanitize.js";
import { arbitrate, dedupePrEvents, findAuthorizedApproval } from "../orchestrator/pipeline/pr-events.js";
import type { NotificationRouter } from "./notification-router.js";
import type { PrEventPollerContext } from "./types.js";

// ── PR-Event Poller ────────────────────────────────────────────────────────────
//
// The daemon's bridge between an open PR and the pipeline. Each tick it asks the git
// hosting plugin which PR events currently hold for every task parked in
// blocked(pr_review_pending), filters them through Core policy, picks one winner by
// precedence, and re-enters the task by writing the winning event's type onto it and
// re-queuing — the orchestrator reads that on dispatch and starts at entryFor(event).
//
// Two re-entry paths. Rework events re-enter the upstream pipeline (new comments →
// requirements, CI failure / merge conflict → execution). The merge events re-enter at
// delivery's auto-merge, which performs the merge. An authorized /approve is the
// single-contributor approval path: when a live re-check confirms the PR is green and the
// host will take a merge, the poller promotes it to a merge (dropping the same-poll comments,
// which would otherwise win precedence and route to requirements); a not-yet-green /approve
// keeps the task waiting.
//
// A PR the host reports as protection-`blocked` still promotes. That is the host's verdict on
// its own rules, not on whether the merge can happen: an admin token on a repo that permits a
// bypass merges it normally, and for a lone owner that bypass is the only automated route —
// the PR is authored under the owner's own account, and a host will not let an author approve
// their own pull request, so the required review is unsatisfiable by anyone. The /approve
// comment IS the owner's approval for that reason. Whether the host ultimately takes the merge
// is decided by delivery's auto-merge, which resolves a refusal into an owner hand-off and
// never a rework — so promoting costs at most one rejected attempt.

/** Polls open PRs for events and re-enters their tasks. */
export interface PrEventPoller {
  /** Detect and route external PR events for review-pending tasks. A pre-fetched list avoids a redundant query. */
  poll(reviewPendingTasks?: Task[]): Promise<void>;
}

export function createPrEventPoller(ctx: PrEventPollerContext, notifications: NotificationRouter): PrEventPoller {
  const { registry, taskEngine, peopleDirectory, safetyLayer, observer, clock } = ctx;

  const failureWindowMs = ctx.config.review_polling.failure_window_ms;
  const maxFailuresBeforePause = ctx.config.review_polling.max_failures_before_pause;
  const maxBlockerReentries = ctx.config.review_polling.max_blocker_reentries;

  // Sliding window of recent detect failures — when the host is failing, pause polling rather than
  // hammer it every tick. Self-pruning: entries older than the window are dropped on each check.
  const recentFailures: number[] = [];
  // Whether polling is currently paused, so the pause warns once on entry and the resume logs once on recovery.
  let pollingPaused = false;

  function shouldPausePolling(now: number): boolean {
    const windowStart = now - failureWindowMs;
    while (recentFailures.length > 0 && (recentFailures[0] ?? 0) < windowStart) {
      recentFailures.shift();
    }
    return recentFailures.length >= maxFailuresBeforePause;
  }

  async function poll(prefetched?: Task[]): Promise<void> {
    const tasks = prefetched ?? taskEngine.getBlockedTasksByReason(BlockReasons.pr_review_pending);
    if (tasks.length === 0) {
      return;
    }
    const now = clock.now();
    if (isPausedThisTick(now)) {
      return;
    }
    const hosting = registry.getPrimaryPlugin<GitHostingAdapter>(AdapterTypes.git_hosting);
    if (!hosting) {
      return;
    }
    const settled = await Promise.allSettled(tasks.map((task) => pollSingleTask(task, hosting, now)));
    logPollRejections(settled, tasks);
  }

  /** Whether to skip this tick because the host is failing — warns once on entry, logs once on recovery. */
  function isPausedThisTick(now: number): boolean {
    if (shouldPausePolling(now)) {
      if (!pollingPaused) {
        pollingPaused = true;
        observer.warn("Pausing PR-event polling — too many recent detect failures", {
          recentFailures: recentFailures.length,
          windowMs: failureWindowMs,
        });
      }
      return true;
    }
    if (pollingPaused) {
      pollingPaused = false;
      observer.info("Resumed PR-event polling — recent detect failures have cleared", { windowMs: failureWindowMs });
    }
    return false;
  }

  /** Surface any task whose poll rejected — isolated per task by allSettled, but never silently dropped. */
  function logPollRejections(settled: PromiseSettledResult<void>[], tasks: readonly Task[]): void {
    for (const [index, outcome] of settled.entries()) {
      if (outcome.status === "rejected") {
        observer.warn("PR-event poll for a task failed unexpectedly", {
          taskId: tasks[index]?.id,
          error: sanitizeErrorMessage(outcome.reason),
        });
      }
    }
  }

  async function pollSingleTask(task: Task, hosting: GitHostingAdapter, now: number): Promise<void> {
    const prNumber = task.review?.pr_number;
    if (!(prNumber && task.repo)) {
      return;
    }

    let events: PrEvent[];
    try {
      events = await hosting.detectPrEvents(task.repo, prNumber);
    } catch (error) {
      recentFailures.push(now);
      observer.warn("Failed to detect PR events", { taskId: task.id, prNumber, error: sanitizeErrorMessage(error) });
      return;
    }

    const candidates = await actionableEvents(task, hosting, events);
    const winner = arbitrate(candidates);
    if (!winner) {
      // Nothing actionable this poll — any automated blocker has cleared (or the PR is merely waiting),
      // so the consecutive-blocker streak ends. Resetting here is what lets a transient conflict that the
      // rework genuinely fixed not count against a later, unrelated one.
      resetBlockerStreak(task);
      return;
    }
    // Only a genuine contest (more than one candidate) is a decision worth recording; a single
    // candidate is no choice. When several competed, the loser field must not vanish silently.
    if (candidates.length > 1) {
      recordArbitration(task, candidates, winner);
    }
    routeEvent(task, winner);
  }

  /**
   * Narrow the plugin's events to what is genuinely actionable now. An authorized /approve on a PR a live
   * re-check confirms is green and merge-worthy is promoted to pr_ready_to_merge — the merge path — and the
   * same-poll comments are dropped (an approval is not rework, and precedence would otherwise route the
   * comments to requirements). Otherwise: drop feedback already accommodated, drop a comments event with
   * nothing to act on (a bare changes-requested), and drop a comments event carrying an authorized /approve
   * (the task keeps waiting until the merge preconditions hold).
   */
  async function actionableEvents(
    task: Task,
    hosting: GitHostingAdapter,
    events: readonly PrEvent[],
  ): Promise<PrEvent[]> {
    const deduped = dedupePrEvents(events, task.review?.accommodated_comment_ids ?? []);
    const disposition = await resolveApproveDisposition(task, hosting, deduped);
    if (disposition === "promote") {
      recordApprovePromotion(task, deduped);
      return [{ type: PrEventTypes.pr_ready_to_merge }];
    }
    return deduped.filter(isActionableRework);
  }

  /**
   * Channels owned by the registered git-hosting plugins — the identity namespaces a PR `/approve`
   * author may match. Derived from the registry by adapter type, so adding or removing a hosting
   * plugin updates the authorization set with no change here; a hosting plugin opts in by declaring
   * `channel` in its `adapter_meta`.
   */
  function gitHostingChannels(): ReadonlySet<string> {
    const channels = new Set<string>();
    for (const plugin of registry.getPluginsByType<GitHostingAdapter>(AdapterTypes.git_hosting)) {
      const channel = plugin.manifest.adapter_meta["channel"];
      if (typeof channel === "string") {
        channels.add(channel);
      }
    }
    return channels;
  }

  /** A comments event is actionable rework only when it carries comments to address that are not an authorized /approve (an approval, not feedback). */
  function isActionableRework(event: PrEvent): boolean {
    if (event.type !== PrEventTypes.pr_comments) {
      return true;
    }
    if (event.comments.length === 0) {
      return false;
    }
    return findAuthorizedApproval(event.comments, peopleDirectory, gitHostingChannels()) === null;
  }

  /**
   * How an authorized /approve in this poll should be handled, from a single live re-check. /approve is the
   * single-contributor approval path, gated by the enable_comment_approval safety flag:
   *   - `promote` — the PR is open, green, and the host will either merge it (`mergeable`) or merge it under
   *     a bypass (`blocked`): turn the /approve into a merge.
   *   - `wait` — comment-approval disabled, no authorized /approve, the re-check threw, or the PR is not yet
   *     green / not yet resolved: the task keeps waiting.
   *
   * `blocked` promotes alongside `mergeable`, which is the non-obvious part. `blocked` means the host's own
   * protection gates the merge (a required review is missing) — it does not mean the merge cannot happen.
   * A token with admin rights on a repo that permits bypass merges a `blocked` PR normally. And for a lone
   * owner that bypass is the only automated route at all: the PR is authored under the owner's own account,
   * a host will not let an author approve their own pull request, and so the required review can never be
   * satisfied by anyone. The /approve comment IS the owner's approval for that reason; refusing to promote
   * on `blocked` would make it a dead end and leave every PR to be merged by hand.
   *
   * Promoting a merge the host ultimately refuses is safe: delivery's merge step resolves the refusal to a
   * hand-off that blocks for the owner and never reworks, so a rejected merge costs one attempt, not a loop.
   * Both branches are gated on `checks_state === "passing"`, so a red-CI PR still falls through to `wait`
   * and the normal CI path.
   */
  async function resolveApproveDisposition(
    task: Task,
    hosting: GitHostingAdapter,
    events: readonly PrEvent[],
  ): Promise<ApproveDisposition> {
    if (!safetyLayer.isCommentApprovalEnabled()) {
      return "wait";
    }
    const prNumber = task.review?.pr_number;
    if (!(prNumber && task.repo && hasAuthorizedApproval(events))) {
      return "wait";
    }
    try {
      const status = await hosting.getPRStatus(task.repo, prNumber);
      if (status.state !== "open" || status.checks_state !== "passing") {
        return "wait";
      }
      if (status.merge_state === "mergeable" || status.merge_state === "blocked") {
        return "promote";
      }
      return "wait";
    } catch (error) {
      observer.warn("Failed to re-check PR status for an /approve promotion — leaving the task waiting", {
        taskId: task.id,
        prNumber,
        error: sanitizeErrorMessage(error),
      });
      return "wait";
    }
  }

  /** Whether any comments event in the poll carries an authorized /approve. */
  function hasAuthorizedApproval(events: readonly PrEvent[]): boolean {
    return events.some(
      (event) =>
        event.type === PrEventTypes.pr_comments &&
        event.comments.length > 0 &&
        findAuthorizedApproval(event.comments, peopleDirectory, gitHostingChannels()) !== null,
    );
  }

  /** Record the arbitration decision when several actionable events competed in one poll — the winner and the field it beat. */
  function recordArbitration(task: Task, candidates: readonly PrEvent[], winner: PrEvent): void {
    const types = [...new Set(candidates.map((event) => event.type))];
    observer.recordDecision(
      "pr_event_arbitration",
      `${String(candidates.length)} actionable PR events competed for PR #${String(task.review?.pr_number)}: ${types.join(", ")}`,
      types.map((type) => ({ id: type, description: PR_EVENT_LABELS[type] })),
      winner.type,
      "Highest precedence wins — a merge is terminal, and reviewer feedback and the blockers (conflict, CI) are addressed before a ready-to-merge",
      1,
      { task_id: task.id },
    );
  }

  /** Record the /approve promotion — a reviewer comment, authorized and confirmed mergeable, is being turned into a merge. */
  function recordApprovePromotion(task: Task, events: readonly PrEvent[]): void {
    const approver = approverOf(events);
    observer.recordDecision(
      "approve_comment_promotion",
      `PR #${String(task.review?.pr_number)} carries an authorized /approve, and a live re-check confirms it is open, green, and mergeable`,
      [
        { id: "promote_to_merge", description: "Treat the /approve as approval and re-enter the task to merge now" },
        { id: "keep_waiting", description: "Leave the task waiting for a formal host approval" },
      ],
      "promote_to_merge",
      approver
        ? `Authorized /approve by "${approver}" — the single-contributor approval path, gated by enable_comment_approval and confirmed mergeable`
        : "Authorized /approve confirmed open, green, and mergeable",
      1,
      { task_id: task.id },
    );
  }

  /** The first authorized /approve author among the events, for the promotion audit trail. */
  function approverOf(events: readonly PrEvent[]): string | null {
    for (const event of events) {
      if (event.type === PrEventTypes.pr_comments && event.comments.length > 0) {
        const found = findAuthorizedApproval(event.comments, peopleDirectory, gitHostingChannels());
        if (found) {
          return found.author;
        }
      }
    }
    return null;
  }

  function routeEvent(task: Task, winner: PrEvent): void {
    // An automated blocker (conflict / CI) is system-detected and must converge or escalate — bound it.
    // Reviewer feedback and the merge events are human- or terminal-driven and re-enter as before.
    if (isAutomatedBlocker(winner.type)) {
      routeBlockerEvent(task, winner.type);
      return;
    }
    if (winner.type === PrEventTypes.pr_comments) {
      accommodateFeedback(task, winner.comments);
    }
    reenter(task, winner.type, eventNotice(winner.type));
    logReentry(task, winner.type);
  }

  /**
   * Re-enter on an automated blocker, bounded across dispatches. Each consecutive conflict/CI re-entry
   * increments the review counter; once it would exceed the cap, the task is escalated to the owner
   * instead of reworked again — the runner's per-dispatch caps cannot see this loop because every
   * PR-event re-entry resets them.
   */
  function routeBlockerEvent(task: Task, type: BlockerEventType): void {
    const count = (task.review?.consecutive_blocker_reentries ?? 0) + 1;
    if (count > maxBlockerReentries) {
      escalateBlockerCap(task, type, count);
      return;
    }
    persistBlockerStreak(task, count);
    reenter(task, type, eventNotice(type));
    logReentry(task, type);
  }

  /**
   * The automated rework loop did not converge: re-block the task under `pr_rework_cap_hit` (a
   * `pipeline_failed` reason, so it leaves the PR-review poll set and the blocked-escalation ladder
   * owns it), record the escalation, and alert the owner. No state transition — the task is already
   * `blocked`; only its block payload changes from the expected wait to a failure needing attention.
   */
  function escalateBlockerCap(task: Task, type: BlockerEventType, count: number): void {
    if (task.review) {
      taskEngine.updateTaskField(task.id, "review", { ...task.review, consecutive_blocker_reentries: count });
    }
    // Defensive: a pending event would re-dispatch this task straight back into the loop we are escaping.
    taskEngine.updateTaskField(task.id, "pending_pr_event", null);
    const label = blockerLabel(type);
    taskEngine.updateTaskField(task.id, "blocked", {
      reason: BlockReasons.pipeline_failed,
      category: BlockCategories.pr_rework_cap_hit,
      sub_phase: "await-review",
      needed: `The pull request's ${label} did not resolve after ${String(maxBlockerReentries)} automated rework passes — resolve it on the PR, then run "engineer retry" to resume.`,
    } satisfies BlockedDetails);
    recordBlockerCapEscalation(task, type, count);
    observer.warn("PR blocker re-entry cap hit — escalating to the owner", {
      taskId: task.id,
      prNumber: task.review?.pr_number,
      type,
      count,
      cap: maxBlockerReentries,
    });
    notifications.notify({
      kind: NotificationKinds.alert,
      taskId: task.id,
      message: `PR #${String(task.review?.pr_number)}: ${label} persisted after ${String(maxBlockerReentries)} automated rework passes. The task is blocked for you — resolve the PR and run "engineer retry" to resume.`,
    });
    notifications.notify({
      kind: NotificationKinds.ticket_comment,
      taskId: task.id,
      message: `Automated rework could not clear the ${label} after ${String(maxBlockerReentries)} attempts. Pausing for your input.`,
    });
  }

  /** Persist the running blocker streak so the next dispatch (and the next poll) sees the accumulated count. */
  function persistBlockerStreak(task: Task, count: number): void {
    if (!task.review) {
      return;
    }
    taskEngine.updateTaskField(task.id, "review", { ...task.review, consecutive_blocker_reentries: count });
  }

  /** Clear the blocker streak when a poll finds no actionable blocker — the loop, if any, has ended. */
  function resetBlockerStreak(task: Task): void {
    if (task.review && task.review.consecutive_blocker_reentries > 0) {
      taskEngine.updateTaskField(task.id, "review", { ...task.review, consecutive_blocker_reentries: 0 });
    }
  }

  /** Record the cap escalation as a decision — the rework-again path was available and deliberately not taken. */
  function recordBlockerCapEscalation(task: Task, type: BlockerEventType, count: number): void {
    observer.recordDecision(
      "pr_blocker_cap_escalation",
      `PR #${String(task.review?.pr_number)} ${blockerLabel(type)} re-entered ${String(count)} times (cap ${String(maxBlockerReentries)}) without resolving`,
      [
        { id: "rework_again", description: "Re-enter the pipeline to attempt the blocker again" },
        { id: "escalate", description: "Stop the automated loop and block for the owner" },
      ],
      "escalate",
      `Automated rework did not clear the ${blockerLabel(type)} within ${String(maxBlockerReentries)} passes — looping further only burns dispatches`,
      1,
      { task_id: task.id },
    );
  }

  /** One info log per re-entry, shared by the bounded and unbounded paths. */
  function logReentry(task: Task, type: PrEvent["type"]): void {
    observer.info("Re-queued task for PR event", {
      taskId: task.id,
      prNumber: task.review?.pr_number,
      type,
    });
  }

  /**
   * Record the feedback the task is about to rework on: append it as an unapplied round (the re-entered
   * requirements phase reads it through the carry) and mark its comment ids accommodated so the same
   * feedback does not re-rework on the next poll. Reviewer engagement is progress, so it also resets the
   * automated-blocker streak.
   */
  function accommodateFeedback(task: Task, comments: readonly PRComment[]): void {
    if (!task.review) {
      return;
    }
    const lines = comments.map((comment) => `@${comment.author}: ${sanitizeSecrets(comment.body.trim())}`);
    taskEngine.updateTaskField(task.id, "review", {
      ...task.review,
      feedback_rounds: [...task.review.feedback_rounds, { applied: false, comments: lines }],
      accommodated_comment_ids: comments.map((comment) => comment.id),
      consecutive_blocker_reentries: 0,
    });
  }

  /** Write the winning event onto the task and re-queue it. The event is set before the transition so the task is never dispatchable without it. */
  function reenter(task: Task, type: PrEvent["type"], notice: string): void {
    taskEngine.updateTaskField(task.id, "pending_pr_event", type);
    const transition = taskEngine.requestTransition(task.id, TaskStates.queued, null, `pr_event:${type}`, "daemon");
    if (!transition.success) {
      observer.warn("Failed to re-queue task for PR event — will retry next poll", {
        taskId: task.id,
        type,
        reason: transition.reason,
      });
      return;
    }
    notifications.notify({ kind: NotificationKinds.ticket_comment, taskId: task.id, message: notice });
  }

  return { poll };
}

/**
 * How the poller handles an authorized /approve this poll, from one live re-check: promote it to a merge,
 * escalate to the owner because the host blocks the merge, or keep waiting.
 */
type ApproveDisposition = "promote" | "wait";

/** The system-detected PR events that must converge or be escalated — distinct from human feedback and the terminal merge events. */
type BlockerEventType = typeof PrEventTypes.pr_merge_conflict | typeof PrEventTypes.pr_ci_failure;

/** Whether a PR event is an automated blocker (merge conflict / CI failure) the daemon re-enters on its own. */
function isAutomatedBlocker(type: PrEvent["type"]): type is BlockerEventType {
  return type === PrEventTypes.pr_merge_conflict || type === PrEventTypes.pr_ci_failure;
}

/** The owner-facing name of an automated blocker, for the escalation message and audit trail. */
function blockerLabel(type: BlockerEventType): string {
  return type === PrEventTypes.pr_merge_conflict ? "merge conflict" : "CI failure";
}

/** Short labels for the PR event types — the alternatives shown in the arbitration decision record. */
const PR_EVENT_LABELS: Record<PrEvent["type"], string> = {
  [PrEventTypes.pr_merged]: "PR merged — terminal",
  [PrEventTypes.pr_comments]: "Reviewer feedback to address",
  [PrEventTypes.pr_merge_conflict]: "Merge conflict to resolve",
  [PrEventTypes.pr_ci_failure]: "CI failure to fix",
  [PrEventTypes.pr_ready_to_merge]: "Approved, green, mergeable",
};

/** The ticket comment posted when a PR event re-queues a task, by event type. */
function eventNotice(type: PrEvent["type"]): string {
  switch (type) {
    case PrEventTypes.pr_comments:
      return "Reviewer feedback received — reworking to address it.";
    case PrEventTypes.pr_ci_failure:
      return "CI is failing on the pull request — reworking to fix it.";
    case PrEventTypes.pr_merge_conflict:
      return "The pull request has merge conflicts — reworking to resolve them.";
    case PrEventTypes.pr_ready_to_merge:
      return "Pull request approved with CI green — merging.";
    case PrEventTypes.pr_merged:
      return "Pull request merged — finalizing.";
    default: {
      const exhaustive: never = type;
      throw new Error(`Unhandled PR event type "${JSON.stringify(exhaustive)}"`);
    }
  }
}
