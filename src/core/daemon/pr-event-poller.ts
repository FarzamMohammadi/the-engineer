import type { GitHostingAdapter } from "../../adapters/git-hosting.js";
import { AdapterTypes, type PRComment } from "../../schemas/adapters.js";
import { type PrEvent, PrEventTypes } from "../../schemas/git-hosting-events.js";
import { NotificationKinds } from "../../schemas/notifications.js";
import { BlockReasons, type Task, TaskStates } from "../../schemas/task.js";
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
// single-contributor approval path: when a live re-check confirms the PR is green and
// mergeable, the poller promotes it to a merge (dropping the same-poll comments, which
// would otherwise win precedence and route to requirements); a not-yet-green /approve
// keeps the task waiting rather than attempting a doomed merge.

/** Polls open PRs for events and re-enters their tasks. */
export interface PrEventPoller {
  /** Detect and route external PR events for review-pending tasks. A pre-fetched list avoids a redundant query. */
  poll(reviewPendingTasks?: Task[]): Promise<void>;
}

export function createPrEventPoller(ctx: PrEventPollerContext, notifications: NotificationRouter): PrEventPoller {
  const { registry, taskEngine, peopleDirectory, safetyLayer, observer, clock } = ctx;

  const failureWindowMs = ctx.config.review_polling.failure_window_ms;
  const maxFailuresBeforePause = ctx.config.review_polling.max_failures_before_pause;

  // Sliding window of recent detect failures — when the host is failing, pause polling rather than
  // hammer it every tick. Self-pruning: entries older than the window are dropped on each check.
  const recentFailures: number[] = [];

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
    if (shouldPausePolling(now)) {
      observer.warn("Pausing PR-event polling — too many recent detect failures", {
        recentFailures: recentFailures.length,
        windowMs: failureWindowMs,
      });
      return;
    }

    const hosting = registry.getPrimaryPlugin<GitHostingAdapter>(AdapterTypes.git_hosting);
    if (!hosting) {
      return;
    }

    await Promise.allSettled(tasks.map((task) => pollSingleTask(task, hosting, now)));
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

    const winner = arbitrate(await actionableEvents(task, hosting, events));
    if (winner) {
      routeEvent(task, winner);
    }
  }

  /**
   * Narrow the plugin's events to what is genuinely actionable now. An authorized /approve on a PR a live
   * re-check confirms is green and mergeable is promoted to pr_ready_to_merge — the merge path — and the
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
    if (await shouldPromoteApproval(task, hosting, deduped)) {
      return [{ type: PrEventTypes.pr_ready_to_merge }];
    }
    return deduped.filter(isActionableRework);
  }

  /** A comments event is actionable rework only when it carries comments to address that are not an authorized /approve (an approval, not feedback). */
  function isActionableRework(event: PrEvent): boolean {
    if (event.type !== PrEventTypes.pr_comments) {
      return true;
    }
    if (event.comments.length === 0) {
      return false;
    }
    return findAuthorizedApproval(event.comments, peopleDirectory) === null;
  }

  /**
   * Whether an authorized /approve in this poll should promote to a merge. /approve is the single-contributor
   * approval path, gated by the enable_comment_approval safety flag; it triggers a merge only when a live
   * re-check confirms the PR is open, green, and mergeable — the same preconditions the plugin computes for a
   * formal approval's pr_ready_to_merge. A not-yet-green /approve does not promote, so the task keeps waiting
   * rather than attempting a doomed merge.
   */
  async function shouldPromoteApproval(
    task: Task,
    hosting: GitHostingAdapter,
    events: readonly PrEvent[],
  ): Promise<boolean> {
    if (!safetyLayer.isCommentApprovalEnabled()) {
      return false;
    }
    const prNumber = task.review?.pr_number;
    if (!(prNumber && task.repo && hasAuthorizedApproval(events))) {
      return false;
    }
    try {
      const status = await hosting.getPRStatus(task.repo, prNumber);
      return status.state === "open" && status.checks_state === "passing" && status.mergeable;
    } catch (error) {
      observer.warn("Failed to re-check PR status for an /approve promotion — leaving the task waiting", {
        taskId: task.id,
        prNumber,
        error: sanitizeErrorMessage(error),
      });
      return false;
    }
  }

  /** Whether any comments event in the poll carries an authorized /approve. */
  function hasAuthorizedApproval(events: readonly PrEvent[]): boolean {
    return events.some(
      (event) =>
        event.type === PrEventTypes.pr_comments &&
        event.comments.length > 0 &&
        findAuthorizedApproval(event.comments, peopleDirectory) !== null,
    );
  }

  function routeEvent(task: Task, winner: PrEvent): void {
    if (winner.type === PrEventTypes.pr_comments) {
      accommodateFeedback(task, winner.comments);
    }
    reenter(task, winner.type, eventNotice(winner.type));
    observer.info("Re-queued task for PR event", {
      taskId: task.id,
      prNumber: task.review?.pr_number,
      type: winner.type,
    });
  }

  /**
   * Record the feedback the task is about to rework on: append it as an unapplied round (the re-entered
   * requirements phase reads it through the carry) and mark its comment ids accommodated so the same
   * feedback does not re-rework on the next poll.
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
