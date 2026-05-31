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
// blocked(pr_review_pending), filters them through Core policy (dedup already-handled
// feedback, drop an /approve which is an approval and not rework), picks one winner by
// precedence, and re-enters the task by writing the winning event's type onto it and
// re-queuing — the orchestrator reads that on dispatch and starts at entryFor(event).
//
// This drives the rework events (new comments → requirements, CI failure / merge
// conflict → execution). The merge events (ready-to-merge, already-merged) and the
// /approve-to-merge promotion are handled when auto-merge lands; here they are
// recognized and left for that path so a poll never spuriously reworks on an approval.

/** Polls open PRs for events and re-enters their tasks. */
export interface PrEventPoller {
  /** Detect and route external PR events for review-pending tasks. A pre-fetched list avoids a redundant query. */
  poll(reviewPendingTasks?: Task[]): Promise<void>;
}

export function createPrEventPoller(ctx: PrEventPollerContext, notifications: NotificationRouter): PrEventPoller {
  const { registry, taskEngine, peopleDirectory, observer, clock } = ctx;

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

    const winner = arbitrate(actionableEvents(task, events));
    if (winner) {
      routeEvent(task, winner);
    }
  }

  /**
   * Narrow the plugin's events to what is genuinely actionable now: drop feedback already accommodated,
   * drop a comments event with nothing to act on (a bare changes-requested with no comment text — the
   * task waits for the reviewer to say what), and drop a comments event carrying an authorized /approve
   * (that is an approval, not rework; promotion to a merge is the merge path's concern).
   */
  function actionableEvents(task: Task, events: readonly PrEvent[]): PrEvent[] {
    const deduped = dedupePrEvents(events, task.review?.accommodated_comment_ids ?? []);
    return deduped.filter((event) => {
      if (event.type !== PrEventTypes.pr_comments) {
        return true;
      }
      if (event.comments.length === 0) {
        return false;
      }
      return findAuthorizedApproval(event.comments, peopleDirectory) === null;
    });
  }

  function routeEvent(task: Task, winner: PrEvent): void {
    const prNumber = task.review?.pr_number;
    if (winner.type === PrEventTypes.pr_ready_to_merge || winner.type === PrEventTypes.pr_merged) {
      observer.debug("PR reached a merge state — auto-merge wiring handles it", { taskId: task.id, type: winner.type });
      return;
    }
    if (winner.type === PrEventTypes.pr_comments) {
      accommodateFeedback(task, winner.comments);
    }
    reenter(task, winner.type, reworkNotice(winner.type));
    observer.info("Re-queued task for PR event", { taskId: task.id, prNumber, type: winner.type });
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
      feedback_rounds: [...task.review.feedback_rounds, { stage: "code", applied: false, comments: lines }],
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
function reworkNotice(type: PrEvent["type"]): string {
  switch (type) {
    case PrEventTypes.pr_comments:
      return "Reviewer feedback received — reworking to address it.";
    case PrEventTypes.pr_ci_failure:
      return "CI is failing on the pull request — reworking to fix it.";
    case PrEventTypes.pr_merge_conflict:
      return "The pull request has merge conflicts — reworking to resolve them.";
    default:
      return "Reworking the pull request.";
  }
}
