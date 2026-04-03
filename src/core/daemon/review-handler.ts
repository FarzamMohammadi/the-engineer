import type { GitHostingAdapter } from "../../adapters/git-hosting.js";
import { AdapterTypes } from "../../schemas/adapters.js";
import { EventTypes, type TaskFeedbackReceivedPayload } from "../../schemas/events.js";
import { type Task, TaskStates } from "../../schemas/task.js";
import { sanitizeErrorMessage, sanitizeSecrets } from "../../utils/sanitize.js";
import type { PublishInput } from "../interfaces/event-bus.interface.js";
import type { NotificationRouter } from "./notification-router.js";
import type { ReviewHandlerContext } from "./types.js";

// ── Pure Functions ────────────────────────────────────────────────────────────

/**
 * Derive aggregate review state from per-reviewer statuses.
 * changes_requested dominates over approved. Returns null if no actionable reviews.
 */
export function deriveAggregateReviewState(reviewStatus: {
  changes_requested: boolean;
  approved: boolean;
  reviewers: Array<{ state: string }>;
}): "changes_requested" | "approved" | "comment" | null {
  if (reviewStatus.changes_requested) {
    return "changes_requested";
  }
  if (reviewStatus.approved) {
    return "approved";
  }
  // A reviewer submitted a review with comments (not approve/reject)
  if (reviewStatus.reviewers.some((r) => r.state === "commented")) {
    return "comment";
  }
  return null;
}

/** Regex matching /approve or /approved as a standalone comment command. */
const APPROVE_COMMAND_REGEX = /^\/(approve|approved)\s*$/i;

/**
 * Detect if any PR comment contains an /approve command.
 * Comments are formatted as "@author: body" by fetchPRCommentStrings().
 * Returns the author of the first matching command, or null.
 */
export function detectCommentApproval(prComments: string[]): { author: string } | null {
  for (const comment of prComments) {
    const colonIndex = comment.indexOf(": ");
    if (colonIndex === -1) {
      continue;
    }
    const author = comment.slice(1, colonIndex); // strip leading "@"
    const body = comment.slice(colonIndex + 2).trim();
    if (APPROVE_COMMAND_REGEX.test(body)) {
      return { author };
    }
  }
  return null;
}

// ── ReviewHandler Interface ──────────────────────────────────────────────────

/** Handles review feedback detection, merge detection, and approval/rework flows. */
export interface ReviewHandler {
  /** Check for PR merges on review-pending tasks. Pre-fetched tasks avoid redundant DB queries. */
  checkMerges(reviewPendingTasks?: Task[]): Promise<void>;
  /** Check for PR review feedback on review-pending tasks. Pre-fetched tasks avoid redundant DB queries. */
  checkFeedback(reviewPendingTasks?: Task[]): Promise<void>;
  /** Check CI status for approved tasks awaiting pipeline completion, then merge or re-queue. */
  checkApprovedCI(): Promise<void>;
  /** Handle a feedback event (called from EventBus subscription). */
  handleFeedbackEvent(payload: TaskFeedbackReceivedPayload): void;
  /** Clear per-tick PR status cache. Call at start of each tick to avoid stale data. */
  clearTickCache(): void;
}

/** Callbacks for cross-subsystem coordination. */
export interface ReviewHandlerCallbacks {
  /** Called when a task reaches a terminal state (merged, approved, or completed). */
  onTaskCompletionFinalized(taskId: string): void;
}

// ── Constants ────────────────────────────────────────────────────────────────

/** Prefixes on daemon-posted comments, used to filter out self-authored comments during review polling. */
const SELF_COMMENT_PREFIXES = [
  "Task completed",
  "Pull request created",
  "Task encountered an error",
  "PR merged",
  "Code approved",
  "Code review approved",
  "Pushed rework",
  "Task picked up",
  "CI pipeline failing",
  "Auto-merge rejected",
  "Auto-merge API call failed",
];

// ── Factory ──────────────────────────────────────────────────────────────────

export function createReviewHandler(
  ctx: ReviewHandlerContext,
  notifications: NotificationRouter,
  callbacks: ReviewHandlerCallbacks,
): ReviewHandler {
  const {
    eventBus,
    registry,
    taskEngine,
    safetyLayer,
    workspaceManager,
    peopleDirectory,
    observer,
  } = ctx;

  // Circuit breaker thresholds — configurable for operators with slow/self-hosted git hosting
  const failureWindowMs = ctx.config.review_polling.failure_window_ms;
  const maxFailuresBeforePause = ctx.config.review_polling.max_failures_before_pause;

  /** Max pipeline_fix rework cycles before giving up and asking human to merge manually. */
  const MAX_PIPELINE_FIX_RETRIES = 3;

  // ── Internal State ──────────────────────────────────────────────────────
  const emittedFeedbackKeys = new Map<string, string>();

  // Per-tick cache for PR status to avoid duplicate API calls across checkMerges + checkFeedback
  const prStatusCache = new Map<string, Awaited<ReturnType<GitHostingAdapter["getPRStatus"]>>>();

  // Time-windowed failure counting for review API
  const reviewApiFailures: Array<{ timestamp: number }> = [];

  // Tasks approved but waiting for CI pipelines to pass before merge
  const approvedAwaitingCI = new Map<string, { repo: string; prNumber: number }>();

  function shouldSkipReviewPolling(now: number): boolean {
    // Clean up old failures outside the window
    const windowStart = now - failureWindowMs;
    while (reviewApiFailures.length > 0 && (reviewApiFailures[0]?.timestamp ?? 0) < windowStart) {
      reviewApiFailures.shift();
    }
    return reviewApiFailures.length >= maxFailuresBeforePause;
  }

  function recordReviewApiFailure(now: number): void {
    reviewApiFailures.push({ timestamp: now });
  }

  async function getCachedPRStatus(
    hosting: GitHostingAdapter,
    repo: string,
    prNumber: number,
  ): Promise<Awaited<ReturnType<GitHostingAdapter["getPRStatus"]>>> {
    const cacheKey = `${repo}#${String(prNumber)}`;
    const cached = prStatusCache.get(cacheKey);
    if (cached) {
      return cached;
    }
    const status = await hosting.getPRStatus(repo, prNumber);
    prStatusCache.set(cacheKey, status);
    return status;
  }

  function clearTickCache(): void {
    prStatusCache.clear();
  }

  // ── Merge Detection ─────────────────────────────────────────────────────

  function completeTaskOnMerge(task: {
    id: string;
    sub_state: string | null;
    review: { pr_number: number | null } | null;
  }): void {
    const completionTransition = taskEngine.requestTransition(
      task.id,
      TaskStates.completed,
      null,
      "pr_merged",
      "daemon",
    );
    if (!completionTransition.success) {
      observer.warn("Failed to transition task to completed after PR merge", {
        taskId: task.id,
        reason: completionTransition.reason,
      });
      // PR is merged — still clean up workspace and notify, even if transition failed
    }

    finalizeTaskCompletion(task.id, "PR merged — task completed.");
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

    let status: Awaited<ReturnType<GitHostingAdapter["getPRStatus"]>>;
    try {
      status = await getCachedPRStatus(hosting, task.repo, task.review.pr_number);
    } catch (err) {
      observer.warn("Failed to check PR status", {
        taskId: task.id,
        error: sanitizeErrorMessage(err),
      });
      return;
    }

    if (status.state === "merged") {
      try {
        completeTaskOnMerge(task);
      } catch (err) {
        observer.error("Failed to complete task after PR merge detected", {
          taskId: task.id,
          error: sanitizeErrorMessage(err),
        });
      }
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
  type ReviewPollResult = {
    changes_requested: boolean;
    approved: boolean;
    reviewers: Array<{ state: string; username?: string }>;
    comments?: string[];
  };

  /** Check if a GitHub username is authorized to approve via comment command. */
  function isAuthorizedApprover(author: string): boolean {
    const owners = peopleDirectory.getByRole("owner");
    const reviewers = peopleDirectory.getByRole("reviewer");
    const authorizedPeople = [...owners, ...reviewers];
    // If no people configured, allow anyone (solo dev without people.yaml)
    if (authorizedPeople.length === 0) {
      return true;
    }
    return authorizedPeople.some((p) =>
      p.contacts.some(
        (c) => c.channel === "github" && c.handle.toLowerCase() === author.toLowerCase(),
      ),
    );
  }

  function resolveAggregateStateWithComments(
    reviewStatus: ReviewPollResult,
    prComments: string[],
  ): AggregateState | null {
    // Formal reviews always take precedence
    const state = deriveAggregateReviewState(reviewStatus);
    if (state) {
      return state;
    }
    // Comment-based approval: /approve or /approved from authorized users
    if (safetyLayer.isCommentApprovalEnabled()) {
      const approval = detectCommentApproval(prComments);
      if (approval && isAuthorizedApprover(approval.author)) {
        observer.info("Comment-based approval detected", { author: approval.author });
        return "approved";
      }
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
          return !SELF_COMMENT_PREFIXES.some((marker) => body.startsWith(marker));
        })
        .map((c) => `@${c.author}: ${c.body.trim()}`);
    } catch (err) {
      observer.debug("Failed to fetch PR comments — proceeding with review data only", {
        repo,
        prNumber,
        error: sanitizeErrorMessage(err),
      });
      return [];
    }
  }

  function emitFeedbackIfNew(
    taskId: string,
    prNumber: number,
    aggregateState: AggregateState,
    allComments: string[],
    reviewStatus: ReviewPollResult,
  ): boolean {
    const dedupKey = `${aggregateState}:${String(allComments.length)}`;
    if (emittedFeedbackKeys.get(taskId) === dedupKey) {
      return false;
    }
    emittedFeedbackKeys.set(taskId, dedupKey);

    const stage = "code" as const;
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
        content: allComments.length > 0 ? sanitizeSecrets(allComments.join("\n")) : null,
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
      const [reviewStatus, prStatus, prComments] = await Promise.all([
        hosting.getReviewStatus(repo, prNumber),
        getCachedPRStatus(hosting, repo, prNumber),
        fetchPRCommentStrings(hosting, repo, prNumber),
      ]);
      const allComments = [...(reviewStatus.comments ?? []), ...prComments];

      const aggregateState = resolveAggregateStateWithComments(reviewStatus, prComments);

      // Count review states for observability
      const approvalCount = reviewStatus.reviewers.filter((r) => r.state === "approved").length;
      const changesCount = reviewStatus.reviewers.filter(
        (r) => r.state === "changes_requested",
      ).length;

      // Emit poll event only when review state actually changed (avoids ~60K no-op events/week)
      const dedupKey = aggregateState
        ? `${aggregateState}:${String(allComments.length)}`
        : "none:0";
      const isAlreadyProcessed = emittedFeedbackKeys.get(task.id) === dedupKey;

      if (!isAlreadyProcessed) {
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
      observer.warn("Failed to check PR review feedback", {
        taskId: task.id,
        error: sanitizeErrorMessage(err),
      });
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
      observer.warn("Skipping review feedback polling — too many recent API failures", {
        recentFailures: reviewApiFailures.length,
        windowMs: failureWindowMs,
      });
      return;
    }

    // Prune stale dedup entries for tasks no longer in review_pending
    observer.debug("Polling review feedback", {
      count: reviewTasks.length,
      taskIds: reviewTasks.map((t) => t.id),
    });

    const reviewTaskIds = new Set(reviewTasks.map((t) => t.id));
    for (const key of emittedFeedbackKeys.keys()) {
      if (!reviewTaskIds.has(key)) {
        emittedFeedbackKeys.delete(key);
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
      pr_state: "ready" as const,
      demo_artifacts: [],
      feedback_rounds: [],
    };
    const sanitizedContent = payload.content ? sanitizeSecrets(payload.content) : null;
    const comments = sanitizedContent
      ? sanitizedContent.split("\n").filter((line) => line.trim().length > 0)
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
    observer.debug("Feedback round stored", {
      taskId: payload.task_id,
      stage: payload.stage,
      feedbackType: payload.feedback_type,
      commentCount: comments.length,
    });
  }

  function handleReviewApproval(
    task: NonNullable<ReturnType<typeof taskEngine.getTask>>,
    payload: TaskFeedbackReceivedPayload,
  ): void {
    handleCodeApproval(task, payload).catch((err) => {
      observer.error("Unhandled error in handleCodeApproval", {
        error: sanitizeErrorMessage(err),
        taskId: payload.task_id,
      });
    });
  }

  /** Finalize task completion: workspace cleanup, notification, issue comment, child-done check. */
  function finalizeTaskCompletion(taskId: string, commentMessage?: string): void {
    try {
      workspaceManager.cleanupWorkspace(taskId, true);
    } catch (err) {
      observer.warn("Workspace cleanup failed during completion", {
        taskId,
        error: sanitizeErrorMessage(err),
      });
    }
    notifications.notify({ kind: "completion", taskId });
    if (commentMessage) {
      notifications.notify({ kind: "ticket_comment", taskId, message: commentMessage });
    }
    callbacks.onTaskCompletionFinalized(taskId);
  }

  /** Remove thoughts/ from the branch before merge if configured. Non-fatal. */
  function tryRemoveThoughtsBeforeMerge(
    task: NonNullable<ReturnType<typeof taskEngine.getTask>>,
  ): void {
    if (!safetyLayer.shouldExcludeThoughtsOnMerge()) {
      return;
    }
    try {
      if (!workspaceManager.getWorktreePath(task.id) && task.workspace) {
        workspaceManager.registerExistingWorkspace(task.id, task.workspace);
      }
      workspaceManager.removeThoughtsAndPush(task.id);
    } catch (err) {
      observer.warn("Failed to remove thoughts directory before merge — proceeding", {
        taskId: task.id,
        error: sanitizeErrorMessage(err),
      });
    }
  }

  /** Count how many pipeline_fix rework cycles this task has been through (DB-persisted). */
  function countPipelineFixAttempts(taskId: string): number {
    const history = taskEngine.getStateHistory(taskId);
    return history.filter((t) => t.reason === "pipeline_fix").length;
  }

  /** Re-queue a task to fix failing CI pipelines. */
  function handlePipelineFailure(taskId: string): void {
    const fixCount = countPipelineFixAttempts(taskId);
    if (fixCount >= MAX_PIPELINE_FIX_RETRIES) {
      observer.warn("Pipeline fix retry limit reached — completing with manual merge request", {
        taskId,
        attempts: fixCount,
      });
      taskEngine.requestTransition(taskId, TaskStates.completed, null, "code_approved", "daemon");
      finalizeTaskCompletion(
        taskId,
        `Code approved — CI pipeline failed after ${String(fixCount)} fix attempts. Please fix CI and merge manually.`,
      );
      return;
    }

    // Add a synthetic unapplied feedback round so the orchestrator's
    // requirements-gathering phase receives CI failure context and knows
    // exactly what to fix (reuses the existing rework prompt pipeline).
    const task = taskEngine.getTask(taskId);
    if (task?.review) {
      const ciRound = {
        stage: "code" as const,
        comments: [
          `CI pipeline is failing (attempt ${String(fixCount + 1)}/${String(MAX_PIPELINE_FIX_RETRIES)}).`,
          "The PR has been approved but cannot be merged until CI passes.",
          "Investigate the CI failure, fix the root cause, and push the fix to the existing branch.",
        ],
        applied: false,
      };
      taskEngine.updateTaskField(taskId, "review", {
        ...task.review,
        feedback_rounds: [...task.review.feedback_rounds, ciRound],
      });
    }

    const transition = taskEngine.requestTransition(
      taskId,
      TaskStates.queued,
      null,
      "pipeline_fix",
      "daemon",
    );
    if (!transition.success) {
      observer.warn("Failed to re-queue task for pipeline fix", {
        taskId,
        reason: transition.reason,
      });
      return;
    }
    // Clear stale dedup key so re-polling after fix doesn't suppress events
    emittedFeedbackKeys.delete(taskId);
    approvedAwaitingCI.delete(taskId);
    notifications.notify({
      kind: "ticket_comment",
      taskId,
      message: `CI pipeline failing — reworking to fix (attempt ${String(fixCount + 1)}/${String(MAX_PIPELINE_FIX_RETRIES)}).`,
    });
    observer.info("Task re-queued for pipeline fix", { taskId, attempt: fixCount + 1 });
  }

  /** Attempt merge and handle the result. Only call when CI has passed. */
  async function attemptMerge(
    taskId: string,
    task: NonNullable<ReturnType<typeof taskEngine.getTask>>,
    repo: string,
    prNumber: number,
    hosting: GitHostingAdapter,
  ): Promise<void> {
    tryRemoveThoughtsBeforeMerge(task);

    observer.info("Attempting auto-merge", { taskId, prNumber, repo });
    let result: Awaited<ReturnType<GitHostingAdapter["mergePR"]>>;
    try {
      result = await hosting.mergePR(repo, prNumber, "squash");
    } catch (mergeErr) {
      // Unexpected API-level exception — leave task in review_pending for retry next tick
      observer.warn("Auto-merge API call failed — will retry next tick", {
        error: sanitizeErrorMessage(mergeErr),
        taskId,
      });
      // Clear dedup key so next poll re-detects approval and retries
      emittedFeedbackKeys.delete(taskId);
      notifications.notify({
        kind: "ticket_comment",
        taskId,
        message: "Auto-merge API call failed — will retry.",
      });
      return;
    }

    if (result.success) {
      taskEngine.updateTaskField(taskId, "review", {
        ...(task.review ?? {
          pr_number: prNumber,
          pr_state: "ready" as const,
          demo_artifacts: [],
          feedback_rounds: [],
        }),
        pr_state: "merged",
      });
      taskEngine.requestTransition(
        taskId,
        TaskStates.completed,
        null,
        "code_approved_merged",
        "daemon",
      );
      finalizeTaskCompletion(taskId, `Code approved — PR #${String(prNumber)} auto-merged.`);
      observer.info("PR auto-merged successfully", { taskId, prNumber });
    } else {
      // Merge rejected by GitHub (branch protection, merge conflict, etc.)
      // Do NOT complete the task — leave in review_pending for next tick to re-evaluate
      observer.warn("Auto-merge rejected by GitHub — leaving task in review_pending", {
        taskId,
        error: result.error?.message,
        code: result.error?.code,
      });
      // Clear dedup key so next poll re-detects approval and retries
      emittedFeedbackKeys.delete(taskId);
      notifications.notify({
        kind: "ticket_comment",
        taskId,
        message: `Auto-merge rejected: ${result.error?.message ?? "unknown reason"}. Will retry.`,
      });
    }
  }

  async function handleCodeApproval(
    task: NonNullable<ReturnType<typeof taskEngine.getTask>>,
    payload: TaskFeedbackReceivedPayload,
  ): Promise<void> {
    try {
      const repo = task.repo;
      const prNumber = task.review?.pr_number;
      const autoMergeAllowed = repo ? safetyLayer.checkAutoMergeAllowed(repo) : false;

      const hosting = registry.getPrimaryPlugin<GitHostingAdapter>(AdapterTypes.git_hosting);
      if (!(autoMergeAllowed && prNumber && repo && hosting)) {
        taskEngine.requestTransition(
          payload.task_id,
          TaskStates.completed,
          null,
          "code_approved",
          "daemon",
        );
        finalizeTaskCompletion(payload.task_id, "Code review approved — ready to merge.");
        observer.info("Code approved — auto-merge not enabled", {
          taskId: payload.task_id,
          autoMergeAllowed,
        });
        return;
      }

      // Gate: check CI pipeline status before attempting merge
      const prStatus = await getCachedPRStatus(hosting, repo, prNumber);
      const { checks_state } = prStatus;

      if (checks_state === "passing" || checks_state === "none") {
        // CI passed or no CI configured — proceed with merge
        await attemptMerge(payload.task_id, task, repo, prNumber, hosting);
      } else if (checks_state === "pending") {
        // CI still running — defer merge to checkApprovedCI() on next tick
        approvedAwaitingCI.set(payload.task_id, { repo, prNumber });
        observer.info("CI checks pending — deferring merge", {
          taskId: payload.task_id,
          prNumber,
        });
        notifications.notify({
          kind: "ticket_comment",
          taskId: payload.task_id,
          message: "Code approved — waiting for CI pipeline to complete before merging.",
        });
      } else {
        // CI failed — re-queue task for pipeline fix
        observer.info("CI checks failing — triggering pipeline fix", {
          taskId: payload.task_id,
          prNumber,
        });
        handlePipelineFailure(payload.task_id);
      }
    } catch (err) {
      observer.error("Failed to handle code approval", {
        error: sanitizeErrorMessage(err),
        taskId: payload.task_id,
      });
    }
  }

  // ── CI Awaiting Check (called from daemon tick) ────────────────────────

  async function checkSingleTaskCI(
    taskId: string,
    repo: string,
    prNumber: number,
    hosting: GitHostingAdapter,
  ): Promise<void> {
    const prStatus = await hosting.getPRStatus(repo, prNumber);
    const { checks_state } = prStatus;

    if (checks_state === "passing" || checks_state === "none") {
      approvedAwaitingCI.delete(taskId);
      const task = taskEngine.getTask(taskId);
      if (task) {
        await attemptMerge(taskId, task, repo, prNumber, hosting);
      }
    } else if (checks_state === "failing") {
      approvedAwaitingCI.delete(taskId);
      observer.info("CI checks failed for approved task — triggering pipeline fix", {
        taskId,
        prNumber,
      });
      handlePipelineFailure(taskId);
    } else {
      // Still waiting — keep in map, check again next tick
      observer.debug("CI checks still pending", { taskId, prNumber });
    }
  }

  async function checkApprovedCI(): Promise<void> {
    if (approvedAwaitingCI.size === 0) {
      return;
    }

    const hosting = registry.getPrimaryPlugin<GitHostingAdapter>(AdapterTypes.git_hosting);
    if (!hosting) {
      return;
    }

    // Prune entries for tasks no longer in review_pending
    const reviewTasks = new Set(
      taskEngine.getTasksByState(TaskStates.review_pending).map((t) => t.id),
    );
    for (const taskId of approvedAwaitingCI.keys()) {
      if (!reviewTasks.has(taskId)) {
        approvedAwaitingCI.delete(taskId);
      }
    }

    for (const [taskId, { repo, prNumber }] of approvedAwaitingCI) {
      try {
        await checkSingleTaskCI(taskId, repo, prNumber, hosting);
      } catch (err) {
        observer.warn("Failed to check CI status for approved task", {
          taskId,
          error: sanitizeErrorMessage(err),
        });
      }
    }
  }

  function handleFeedbackRework(
    _task: NonNullable<ReturnType<typeof taskEngine.getTask>>,
    payload: TaskFeedbackReceivedPayload,
  ): void {
    try {
      const transition = taskEngine.requestTransition(
        payload.task_id,
        TaskStates.queued,
        null,
        `feedback_rework:${payload.feedback_type}`,
        "daemon",
      );
      if (!transition.success) {
        observer.warn(
          "Failed to re-queue task for rework — task may have been completed concurrently",
          {
            taskId: payload.task_id,
            reason: transition.reason,
            feedbackType: payload.feedback_type,
          },
        );
        return;
      }
      // Clear stale dedup key so re-polling after rework doesn't suppress events
      emittedFeedbackKeys.delete(payload.task_id);
      notifications.notify({
        kind: "ticket_comment",
        taskId: payload.task_id,
        message: `Reviewer feedback received (${payload.feedback_type}) — reworking.`,
      });
      observer.info("Task re-queued after review feedback", {
        taskId: payload.task_id,
        feedbackType: payload.feedback_type,
      });
    } catch (err) {
      observer.error("Failed to re-queue task after feedback", {
        error: sanitizeErrorMessage(err),
        taskId: payload.task_id,
      });
    }
  }

  return {
    checkMerges,
    checkFeedback,
    checkApprovedCI,
    handleFeedbackEvent,
    clearTickCache,
  };
}
