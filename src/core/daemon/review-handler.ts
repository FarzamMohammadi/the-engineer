import type { GitHostingAdapter } from "../../adapters/git-hosting.js";
import { AdapterTypes } from "../../schemas/adapters.js";
import { EventTypes, type TaskFeedbackReceivedPayload } from "../../schemas/events.js";
import { SubStates, type Task, TaskStates } from "../../schemas/task.js";
import type { PublishInput } from "../interfaces/event-bus.interface.js";
import { deriveAggregateReviewState } from "./index.js";
import type { NotificationRouter } from "./notification-router.js";
import type { ReviewHandlerContext } from "./types.js";

// ── ReviewHandler Interface ──────────────────────────────────────────────────

/** Handles review feedback detection, merge detection, and approval/rework flows. */
export interface ReviewHandler {
  /** Check for PR merges on review-pending tasks. Pre-fetched tasks avoid redundant DB queries. */
  checkMerges(reviewPendingTasks?: Task[]): Promise<void>;
  /** Check for PR review feedback on review-pending tasks. Pre-fetched tasks avoid redundant DB queries. */
  checkFeedback(reviewPendingTasks?: Task[]): Promise<void>;
  /** Handle a feedback event (called from EventBus subscription). */
  handleFeedbackEvent(payload: TaskFeedbackReceivedPayload): void;
}

/** Callbacks for cross-subsystem coordination. */
export interface ReviewHandlerCallbacks {
  /** Called when a task should be completed (PR merged). */
  onTaskMergeComplete(taskId: string): void;
}

// ── Constants ────────────────────────────────────────────────────────────────

/** Prefix on all daemon-posted issue/PR comments. Used to filter self-comments. */
const ENGINEER_COMMENT_MARKERS = [
  "Task completed",
  "Pull request created",
  "Task encountered an error",
  "PR merged",
  "Demo approved",
  "Code approved",
  "Code review approved",
  "Pushed rework",
  "Task picked up",
];

/** Time window for failure counting (5 minutes). */
const FAILURE_WINDOW_MS = 300_000;

/** Max recent failures in window before skipping review polling. */
const MAX_RECENT_FAILURES = 3;

// ── Factory ──────────────────────────────────────────────────────────────────

export function createReviewHandler(
  ctx: ReviewHandlerContext,
  notifications: NotificationRouter,
  callbacks: ReviewHandlerCallbacks,
): ReviewHandler {
  const { eventBus, registry, taskEngine, safetyLayer, workspaceManager, observer } = ctx;

  // ── Internal State ──────────────────────────────────────────────────────
  const processedReviewStates = new Map<string, string>();

  // Time-windowed failure counting for review API
  const reviewApiFailures: Array<{ timestamp: number }> = [];

  function shouldSkipReviewPolling(now: number): boolean {
    // Clean up old failures outside the window
    const windowStart = now - FAILURE_WINDOW_MS;
    while (reviewApiFailures.length > 0 && (reviewApiFailures[0]?.timestamp ?? 0) < windowStart) {
      reviewApiFailures.shift();
    }
    return reviewApiFailures.length >= MAX_RECENT_FAILURES;
  }

  function recordReviewApiFailure(now: number): void {
    reviewApiFailures.push({ timestamp: now });
  }

  // ── Merge Detection ─────────────────────────────────────────────────────

  function completeTaskOnMerge(task: {
    id: string;
    title: string;
    sub_state: string | null;
    review: { pr_number: number | null } | null;
  }): void {
    if (task.sub_state === SubStates.demo) {
      taskEngine.requestTransition(
        task.id,
        TaskStates.review_pending,
        SubStates.code,
        "pr_merged",
        "daemon",
      );
    }
    taskEngine.requestTransition(task.id, TaskStates.completed, null, "pr_merged", "daemon");
    try {
      workspaceManager.cleanupWorkspace(task.id, true);
    } catch {
      observer.warn("Workspace cleanup failed after PR merge", { taskId: task.id });
    }
    notifications.sendCompletion(task.id, task.title);
    notifications.commentOnTaskIssue(task.id, "PR merged — task completed.");
    callbacks.onTaskMergeComplete(task.id);
    observer.info("PR merged — task completed", {
      taskId: task.id,
      prNumber: task.review?.pr_number,
    });
  }

  async function checkSingleTaskMerge(
    task: ReturnType<typeof taskEngine.getTasksByState>[number],
    hosting: GitHostingAdapter,
  ): Promise<void> {
    if (!(task.review?.pr_number && task.repo)) {
      return;
    }
    try {
      const status = await hosting.getPRStatus(task.repo, task.review.pr_number);
      if (status.state === "merged") {
        completeTaskOnMerge(task);
      }
    } catch (err) {
      observer.warn("Failed to check PR status", { taskId: task.id, err });
    }
  }

  async function checkMerges(reviewPendingTasks?: Task[]): Promise<void> {
    const reviewTasks = reviewPendingTasks ?? taskEngine.getTasksByState(TaskStates.review_pending);
    if (reviewTasks.length === 0) {
      return;
    }

    const hosting = registry.getPrimaryPlugin<GitHostingAdapter>(AdapterTypes.git_hosting);
    if (!hosting) {
      return;
    }

    await Promise.allSettled(reviewTasks.map((task) => checkSingleTaskMerge(task, hosting)));
  }

  // ── Feedback Detection ──────────────────────────────────────────────────

  type AggregateState = "changes_requested" | "approved" | "comment";
  type ReviewStatusLike = {
    changes_requested: boolean;
    approved: boolean;
    reviewers: Array<{ state: string; username?: string }>;
    comments?: string[];
  };

  function resolveAggregateState(
    reviewStatus: ReviewStatusLike,
    prComments: string[],
  ): AggregateState | null {
    const state = deriveAggregateReviewState(reviewStatus);
    if (state) {
      return state;
    }
    return prComments.length > 0 ? "comment" : null;
  }

  async function fetchPRCommentStrings(
    hosting: GitHostingAdapter,
    repo: string,
    prNumber: number,
  ): Promise<string[]> {
    try {
      const comments = await hosting.getPRComments(repo, prNumber);
      return comments
        .filter((c) => {
          const body = c.body.trim();
          if (body.length === 0) {
            return false;
          }
          return !ENGINEER_COMMENT_MARKERS.some((marker) => body.startsWith(marker));
        })
        .map((c) => `@${c.author}: ${c.body.trim()}`);
    } catch {
      return []; // Non-critical — proceed with review data only
    }
  }

  function emitFeedbackIfNew(
    taskId: string,
    prNumber: number,
    aggregateState: AggregateState,
    allComments: string[],
    reviewStatus: ReviewStatusLike,
    isDraft: boolean,
  ): boolean {
    const dedupKey = `${aggregateState}:${String(allComments.length)}`;
    if (processedReviewStates.get(taskId) === dedupKey) {
      return false;
    }
    processedReviewStates.set(taskId, dedupKey);

    const stage = isDraft ? "demo" : "code";
    const primaryReviewer =
      reviewStatus.reviewers.find((r) => r.state === aggregateState) ?? reviewStatus.reviewers[0];

    eventBus.publish({
      type: EventTypes["task.feedback_received"],
      source: "daemon",
      task_id: taskId,
      payload: {
        task_id: taskId,
        stage,
        feedback_type: (aggregateState === "approved" ? "approved" : aggregateState) as
          | "approved"
          | "changes_requested"
          | "comment",
        reviewer: primaryReviewer?.username ?? "unknown",
        content: allComments.length > 0 ? allComments.join("\n") : null,
        pr_number: prNumber,
      },
    } satisfies PublishInput<"task.feedback_received">);
    return true;
  }

  async function checkSingleTaskReviewFeedback(
    task: ReturnType<typeof taskEngine.getTasksByState>[number],
    hosting: GitHostingAdapter,
    now: number,
  ): Promise<void> {
    if (!(task.review?.pr_number && task.repo)) {
      return;
    }

    const prNumber = task.review.pr_number;
    const repo = task.repo;

    try {
      const reviewStatus = await hosting.getReviewStatus(repo, prNumber);
      const prStatus = await hosting.getPRStatus(repo, prNumber);
      const prComments = await fetchPRCommentStrings(hosting, repo, prNumber);
      const allComments = [...(reviewStatus.comments ?? []), ...prComments];

      const aggregateState = resolveAggregateState(reviewStatus, prComments);

      // Count review states for observability
      const approvalCount = reviewStatus.reviewers.filter((r) => r.state === "approved").length;
      const changesCount = reviewStatus.reviewers.filter(
        (r) => r.state === "changes_requested",
      ).length;

      // Emit poll event only when review state actually changed (avoids ~60K no-op events/week)
      const dedupKey = aggregateState
        ? `${aggregateState}:${String(allComments.length)}`
        : "none:0";
      const dedupSkipped = processedReviewStates.get(task.id) === dedupKey;

      if (!dedupSkipped) {
        eventBus.publish({
          type: EventTypes["review.poll_completed"],
          source: "daemon",
          task_id: task.id,
          payload: {
            task_id: task.id,
            pr_number: prNumber,
            repo,
            aggregate_state: aggregateState ?? "none",
            approvals: approvalCount,
            changes_requested_count: changesCount,
            comment_count: allComments.length,
            reviewer_count: reviewStatus.reviewers.length,
            pr_draft: prStatus.draft,
            dedup_skipped: false,
          },
        } satisfies PublishInput<"review.poll_completed">);
      }

      if (!aggregateState) {
        observer.debug("No actionable review activity", {
          taskId: task.id,
          prNumber,
          reviewerCount: reviewStatus.reviewers.length,
        });
        return;
      }

      const emitted = emitFeedbackIfNew(
        task.id,
        prNumber,
        aggregateState,
        allComments,
        reviewStatus,
        prStatus.draft,
      );
      if (emitted) {
        observer.info("Review feedback detected", {
          taskId: task.id,
          aggregateState,
          prNumber,
          approvals: approvalCount,
        });
      } else {
        observer.debug("Review poll: no new feedback (dedup)", {
          taskId: task.id,
          aggregateState,
          prNumber,
        });
      }
    } catch (err) {
      recordReviewApiFailure(now);
      observer.warn("Failed to check PR review feedback", { taskId: task.id, err });
    }
  }

  async function checkFeedback(reviewPendingTasks?: Task[]): Promise<void> {
    const reviewTasks = reviewPendingTasks ?? taskEngine.getTasksByState(TaskStates.review_pending);
    if (reviewTasks.length === 0) {
      return;
    }

    const now = ctx.clock.now();

    // Time-windowed failure check
    if (shouldSkipReviewPolling(now)) {
      observer.debug("Skipping review feedback polling — too many recent API failures");
      return;
    }

    // Prune stale dedup entries for tasks no longer in review_pending
    observer.debug("Polling review feedback", {
      count: reviewTasks.length,
      taskIds: reviewTasks.map((t) => t.id),
    });

    const reviewTaskIds = new Set(reviewTasks.map((t) => t.id));
    for (const key of processedReviewStates.keys()) {
      if (!reviewTaskIds.has(key)) {
        processedReviewStates.delete(key);
      }
    }

    const hosting = registry.getPrimaryPlugin<GitHostingAdapter>(AdapterTypes.git_hosting);
    if (!hosting) {
      return;
    }

    await Promise.allSettled(
      reviewTasks.map((task) => checkSingleTaskReviewFeedback(task, hosting, now)),
    );
  }

  // ── Feedback Event Handler ──────────────────────────────────────────────

  function handleFeedbackEvent(payload: TaskFeedbackReceivedPayload): void {
    const task = taskEngine.getTask(payload.task_id);
    if (!task) {
      return;
    }

    // Guard: only handle feedback for tasks in review_pending state
    if (task.state !== TaskStates.review_pending) {
      observer.debug("Ignoring feedback for non-review_pending task", {
        taskId: payload.task_id,
        state: task.state,
      });
      return;
    }

    // Store feedback round on the task
    storeFeedbackRound(payload);

    if (payload.feedback_type === "approved") {
      handleReviewApproval(task, payload);
    } else {
      handleFeedbackRework(task, payload);
    }
  }

  function storeFeedbackRound(payload: TaskFeedbackReceivedPayload): void {
    const task = taskEngine.getTask(payload.task_id);
    if (!task) {
      return;
    }
    const currentReview = task.review ?? {
      pr_number: payload.pr_number,
      pr_state: payload.stage === "demo" ? "draft" : "ready",
      demo_artifacts: [],
      feedback_rounds: [],
    };
    const comments = payload.content
      ? payload.content.split("\n").filter((line) => line.trim().length > 0)
      : [];
    const newRound = {
      stage: payload.stage,
      comments,
      applied: payload.feedback_type === "approved",
    };
    taskEngine.updateTaskField(payload.task_id, "review", {
      ...currentReview,
      feedback_rounds: [...currentReview.feedback_rounds, newRound],
    });
  }

  function handleReviewApproval(
    task: NonNullable<ReturnType<typeof taskEngine.getTask>>,
    payload: TaskFeedbackReceivedPayload,
  ): void {
    if (payload.stage === "demo") {
      handleDemoApproval(task, payload);
    } else {
      handleCodeApproval(task, payload);
    }
  }

  function handleDemoApproval(
    task: NonNullable<ReturnType<typeof taskEngine.getTask>>,
    payload: TaskFeedbackReceivedPayload,
  ): void {
    const hosting = registry.getPrimaryPlugin<GitHostingAdapter>(AdapterTypes.git_hosting);
    if (hosting && task.repo && task.review?.pr_number) {
      hosting
        .updatePR(task.repo, task.review.pr_number, {
          title: null,
          body: null,
          draft: false,
          labels_add: null,
          labels_remove: null,
        })
        .then(() => {
          const currentReview = task.review ?? {
            pr_number: payload.pr_number,
            pr_state: "draft" as const,
            demo_artifacts: [],
            feedback_rounds: [],
          };
          taskEngine.updateTaskField(payload.task_id, "review", {
            ...currentReview,
            pr_state: "ready",
          });
          taskEngine.requestTransition(
            payload.task_id,
            TaskStates.review_pending,
            SubStates.code,
            "demo_approved",
            "daemon",
          );
          notifications.commentOnTaskIssue(
            payload.task_id,
            "Demo approved — PR marked ready for code review.",
          );
          observer.info("Demo approved — PR marked ready for code review", {
            taskId: payload.task_id,
          });
        })
        .catch((err) => {
          observer.error("Failed to mark PR ready after demo approval", {
            err,
            taskId: payload.task_id,
          });
        });
    }
  }

  /** Run post-completion cleanup: workspace, notification, child-done check. */
  function completeTaskCleanup(taskId: string, taskTitle: string): void {
    try {
      workspaceManager.cleanupWorkspace(taskId, true);
    } catch {
      observer.warn("Workspace cleanup failed after code approval", { taskId });
    }
    notifications.sendCompletion(taskId, taskTitle);
    callbacks.onTaskMergeComplete(taskId);
  }

  function handleCodeApproval(
    task: NonNullable<ReturnType<typeof taskEngine.getTask>>,
    payload: TaskFeedbackReceivedPayload,
  ): void {
    try {
      const repo = task.repo;
      const prNumber = task.review?.pr_number;
      const autoMergeAllowed = repo ? safetyLayer.checkAutoMergeAllowed(repo) : false;

      const hosting = registry.getPrimaryPlugin<GitHostingAdapter>(AdapterTypes.git_hosting);
      if (autoMergeAllowed && prNumber && repo && hosting) {
        hosting
          .mergePR(repo, prNumber, "squash")
          .then((result) => {
            if (result.success) {
              taskEngine.updateTaskField(payload.task_id, "review", {
                ...(task.review ?? {
                  pr_number: prNumber,
                  pr_state: "ready" as const,
                  demo_artifacts: [],
                  feedback_rounds: [],
                }),
                pr_state: "merged",
              });
              notifications.commentOnTaskIssue(
                payload.task_id,
                `Code approved — PR #${String(prNumber)} auto-merged.`,
              );
            }
            taskEngine.requestTransition(
              payload.task_id,
              TaskStates.completed,
              null,
              "code_approved_merged",
              "daemon",
            );
            completeTaskCleanup(payload.task_id, task.title);
          })
          .catch(() => {
            taskEngine.requestTransition(
              payload.task_id,
              TaskStates.completed,
              null,
              "code_approved",
              "daemon",
            );
            notifications.commentOnTaskIssue(
              payload.task_id,
              "Code approved — auto-merge failed, please merge manually.",
            );
            completeTaskCleanup(payload.task_id, task.title);
          });
      } else {
        taskEngine.requestTransition(
          payload.task_id,
          TaskStates.completed,
          null,
          "code_approved",
          "daemon",
        );
        notifications.commentOnTaskIssue(payload.task_id, "Code review approved — ready to merge.");
        completeTaskCleanup(payload.task_id, task.title);
      }
      observer.info("Code approved — task completing", {
        taskId: payload.task_id,
        autoMergeAllowed,
      });
    } catch (err) {
      observer.error("Failed to handle code approval", { err, taskId: payload.task_id });
    }
  }

  function handleFeedbackRework(
    _task: NonNullable<ReturnType<typeof taskEngine.getTask>>,
    payload: TaskFeedbackReceivedPayload,
  ): void {
    try {
      taskEngine.requestTransition(
        payload.task_id,
        TaskStates.queued,
        null,
        `feedback_rework:${payload.feedback_type}`,
        "daemon",
      );
      notifications.commentOnTaskIssue(
        payload.task_id,
        `Reviewer feedback received (${payload.feedback_type}) — reworking.`,
      );
      observer.info("Task re-queued after review feedback", {
        taskId: payload.task_id,
        feedbackType: payload.feedback_type,
      });
    } catch (err) {
      observer.error("Failed to re-queue task after feedback", {
        err,
        taskId: payload.task_id,
      });
    }
  }

  return {
    checkMerges,
    checkFeedback,
    handleFeedbackEvent,
  };
}
