import { describe, expect, it, vi } from "vitest";
import { createTestObserverFacade } from "../../../test/helpers/test-observer-facade.js";
import { type DaemonConfig, WorkspaceConfigSchema } from "../../schemas/config.js";
import { EventTypes, type TaskFeedbackReceivedPayload } from "../../schemas/events.js";
import { NotificationKinds } from "../../schemas/notifications.js";
import { SubStates, TaskStates } from "../../schemas/task.js";
import type { NotificationRouter } from "./notification-router.js";
import {
  type ReviewHandler,
  type ReviewHandlerCallbacks,
  createReviewHandler,
  detectCommentApproval,
  evaluatePostApprovalChecks,
} from "./review-handler.js";
import type { ReviewHandlerContext } from "./types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeDaemonConfig(): DaemonConfig {
  return {
    max_concurrent: 1,
    tick_interval_ms: 5_000,
    preemption_threshold: 20,
    preemption_timeout_ms: 60_000,
    stuck_threshold_ms: 1_800_000,
    max_active_duration_ms: 28_800_000,
    shutdown_timeout_ms: 30_000,
    trigger_poll_interval_ms: 30_000,
    response_poll_interval_ms: 5000,
    seen_keys_ttl_ms: 86_400_000,
    logging: {
      level: "error" as const,
      dir: "logs",
      max_size_bytes: 524_288_000,
      max_files: 7,
      console: false,
    },
    plugins: {
      dirs: [],
      health_check_interval_ms: 60_000,
      health_check_timeout_ms: 5_000,
      consecutive_failures_threshold: 3,
    },
    subscriber_warn_threshold_ms: 50,
    data_lifecycle: {
      enabled: false,
      interval_ms: 3_600_000,
      retention: {
        events: { max_age_days: 90 },
        observations: { max_age_days: 90 },
        journal_entries: { max_age_days: 90 },
        checkpoints: { max_age_days: 90 },
      },
    },
    database: { cache_size_mb: 64 },
    notification_retry: { interval_ms: 30_000, max_attempts: 120, max_age_ms: 3_600_000 },
    review_polling: { failure_window_ms: 300_000, max_failures_before_pause: 3 },
  };
}

function createMockHostingPlugin() {
  return {
    manifest: { id: "github-hosting", type: "git_hosting" },
    hasCapability: vi.fn().mockReturnValue(false),
    getPRStatus: vi.fn().mockResolvedValue({ state: "open", draft: false }),
    getReviewStatus: vi.fn().mockResolvedValue({
      changes_requested: false,
      approved: false,
      reviewers: [],
      comments: [],
    }),
    getPRComments: vi.fn().mockResolvedValue([]),
    updatePR: vi.fn().mockResolvedValue(undefined),
    mergePR: vi.fn().mockResolvedValue({ success: true }),
  };
}

function createMockNotifications(): NotificationRouter {
  return {
    notify: vi.fn(),
    syncStateToCommPlugin: vi.fn(),
  };
}

function createMockCallbacks(): ReviewHandlerCallbacks {
  return {
    onTaskCompletionFinalized: vi.fn(),
  };
}

function createReviewTask(overrides?: Record<string, unknown>) {
  return {
    id: "task-1",
    title: "Fix the bug",
    state: TaskStates.review_pending,
    sub_state: SubStates.code,
    repo: "owner/repo",
    external_ref: "issue:1",
    workspace: "/tmp/ws/task-1",
    review: {
      pr_number: 42,
      pr_state: "ready",
      demo_artifacts: [],
      feedback_rounds: [],
      accommodated_comment_ids: [],
      accommodated_review_state: null,
    },
    ...overrides,
  };
}

let hostingPlugin: ReturnType<typeof createMockHostingPlugin>;
let notifications: NotificationRouter;
let callbacks: ReviewHandlerCallbacks;
let ctx: ReviewHandlerContext;
let handler: ReviewHandler;
let clockNow: number;

function buildContext(
  tasks: ReturnType<typeof createReviewTask>[],
  hostingPlugins?: ReturnType<typeof createMockHostingPlugin>[],
) {
  hostingPlugin = createMockHostingPlugin();
  notifications = createMockNotifications();
  callbacks = createMockCallbacks();
  clockNow = 1_000_000;

  const taskMap = new Map(tasks.map((t) => [t.id, t]));

  ctx = {
    config: makeDaemonConfig(),
    eventBus: {
      publish: vi.fn(),
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      replay: vi.fn(),
      getEventsForTask: vi.fn(),
      getEventsSince: vi.fn(),
    } as unknown as ReviewHandlerContext["eventBus"],
    registry: {
      getPluginsByType: vi.fn().mockImplementation((type: string) => {
        if (type === "git_hosting") {
          return hostingPlugins ?? [hostingPlugin];
        }
        return [];
      }),
      getPrimaryPlugin: vi.fn().mockImplementation((type: string) => {
        if (type === "git_hosting") {
          const plugins = hostingPlugins ?? [hostingPlugin];
          return plugins[0] ?? null;
        }
        return null;
      }),
    } as unknown as ReviewHandlerContext["registry"],
    taskEngine: {
      getTasksByState: vi.fn().mockImplementation((state: string) => {
        if (state === TaskStates.review_pending) {
          return tasks;
        }
        return [];
      }),
      getTask: vi.fn().mockImplementation((id: string) => taskMap.get(id) ?? null),
      requestTransition: vi.fn().mockReturnValue({ success: true }),
      updateTaskField: vi.fn(),
      getStateHistory: vi.fn().mockReturnValue([]),
    } as unknown as ReviewHandlerContext["taskEngine"],
    safetyLayer: {
      checkAutoMergeAllowed: vi.fn().mockReturnValue(false),
      isCommentApprovalEnabled: vi.fn().mockReturnValue(false),
      shouldExcludeThoughtsOnMerge: vi.fn().mockReturnValue(false),
      flushCostSnapshot: vi.fn(),
    } as unknown as ReviewHandlerContext["safetyLayer"],
    workspaceConfig: WorkspaceConfigSchema.parse({}),
    workspaceManager: {
      cleanupWorkspace: vi.fn(),
      deleteRemoteBranch: vi.fn(),
      getWorktreePath: vi.fn().mockReturnValue(null),
      registerExistingWorkspace: vi.fn(),
      removeThoughtsAndPush: vi.fn().mockReturnValue(true),
    } as unknown as ReviewHandlerContext["workspaceManager"],
    peopleDirectory: {
      getByRole: vi.fn().mockReturnValue([]),
      getOwner: vi.fn().mockReturnValue(null),
      getReviewers: vi.fn().mockReturnValue([]),
    } as unknown as ReviewHandlerContext["peopleDirectory"],
    clock: { now: () => clockNow },
    observer: createTestObserverFacade("daemon"),
  } as unknown as ReviewHandlerContext;

  handler = createReviewHandler(ctx, notifications, callbacks);
}

/** Flush microtask queue so fire-and-forget promises resolve. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("ReviewHandler", () => {
  // ── checkMerges ──────────────────────────────────────────────────────────

  describe("checkMerges", () => {
    it("detects merged PR and completes task", async () => {
      const task = createReviewTask();
      buildContext([task]);
      hostingPlugin.getPRStatus.mockResolvedValue({ state: "merged", draft: false });

      await handler.checkMerges();

      const te = ctx.taskEngine as unknown as {
        requestTransition: ReturnType<typeof vi.fn>;
      };
      // Task is already in code sub_state, so it transitions directly to completed
      expect(te.requestTransition).toHaveBeenCalledWith(
        "task-1",
        TaskStates.completed,
        null,
        "pr_merged",
        "daemon",
      );
    });

    it("skips when no review-pending tasks", async () => {
      buildContext([]);

      await handler.checkMerges();

      expect(ctx.registry.getPrimaryPlugin).not.toHaveBeenCalled();
    });

    it("skips when no git_hosting plugin", async () => {
      const task = createReviewTask();
      buildContext([task], []);
      // Override to return null
      (ctx.registry.getPrimaryPlugin as ReturnType<typeof vi.fn>).mockReturnValue(null);

      await handler.checkMerges();

      expect(hostingPlugin.getPRStatus).not.toHaveBeenCalled();
    });

    it("calls onTaskCompletionFinalized callback after merge", async () => {
      const task = createReviewTask();
      buildContext([task]);
      hostingPlugin.getPRStatus.mockResolvedValue({ state: "merged", draft: false });

      await handler.checkMerges();

      expect(callbacks.onTaskCompletionFinalized).toHaveBeenCalledWith("task-1");
    });

    it("sends completion notification and issue comment on merge", async () => {
      const task = createReviewTask();
      buildContext([task]);
      hostingPlugin.getPRStatus.mockResolvedValue({ state: "merged", draft: false });

      await handler.checkMerges();

      expect(notifications.notify).toHaveBeenCalledWith(
        expect.objectContaining({ kind: NotificationKinds.completion, taskId: "task-1" }),
      );
      expect(notifications.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: NotificationKinds.ticket_comment,
          taskId: "task-1",
          message: "PR merged — task completed.",
        }),
      );
    });

    it("cleans up workspace on merge", async () => {
      const task = createReviewTask();
      buildContext([task]);
      hostingPlugin.getPRStatus.mockResolvedValue({ state: "merged", draft: false });

      await handler.checkMerges();

      const ws = ctx.workspaceManager as unknown as {
        cleanupWorkspace: ReturnType<typeof vi.fn>;
      };
      expect(ws.cleanupWorkspace).toHaveBeenCalledWith("task-1", true);
    });

    it("skips task without pr_number or repo", async () => {
      const task = createReviewTask({ review: null, repo: null });
      buildContext([task]);

      await handler.checkMerges();

      expect(hostingPlugin.getPRStatus).not.toHaveBeenCalled();
    });
  });

  // ── checkFeedback ────────────────────────────────────────────────────────

  describe("checkFeedback", () => {
    it("detects changes_requested and emits feedback event", async () => {
      const task = createReviewTask({ sub_state: SubStates.code });
      buildContext([task]);
      hostingPlugin.getPRStatus.mockResolvedValue({ state: "open", draft: false });
      hostingPlugin.getReviewStatus.mockResolvedValue({
        changes_requested: true,
        approved: false,
        reviewers: [{ state: "changes_requested", username: "alice" }],
        comments: [],
      });

      await handler.checkFeedback();

      const eb = ctx.eventBus as unknown as { publish: ReturnType<typeof vi.fn> };
      // Should have 2 calls: one for review.poll_completed, one for task.feedback_received
      const feedbackCall = eb.publish.mock.calls.find(
        (c: unknown[]) => (c[0] as { type: string }).type === EventTypes["task.feedback_received"],
      );
      expect(feedbackCall).toBeDefined();
      const payload = (feedbackCall?.[0] as { payload: TaskFeedbackReceivedPayload }).payload;
      expect(payload.feedback_type).toBe("changes_requested");
      expect(payload.reviewer).toBe("alice");
      expect(payload.pr_number).toBe(42);
    });

    it("detects approval and emits feedback event", async () => {
      const task = createReviewTask({ sub_state: SubStates.code });
      buildContext([task]);
      hostingPlugin.getPRStatus.mockResolvedValue({ state: "open", draft: false });
      hostingPlugin.getReviewStatus.mockResolvedValue({
        changes_requested: false,
        approved: true,
        reviewers: [{ state: "approved", username: "bob" }],
        comments: [],
      });

      await handler.checkFeedback();

      const eb = ctx.eventBus as unknown as { publish: ReturnType<typeof vi.fn> };
      const feedbackCall = eb.publish.mock.calls.find(
        (c: unknown[]) => (c[0] as { type: string }).type === EventTypes["task.feedback_received"],
      );
      expect(feedbackCall).toBeDefined();
      const payload = (feedbackCall?.[0] as { payload: TaskFeedbackReceivedPayload }).payload;
      expect(payload.feedback_type).toBe("approved");
      expect(payload.reviewer).toBe("bob");
    });

    it("deduplicates identical review states", async () => {
      const task = createReviewTask({ sub_state: SubStates.code });
      buildContext([task]);
      hostingPlugin.getPRStatus.mockResolvedValue({ state: "open", draft: false });
      hostingPlugin.getReviewStatus.mockResolvedValue({
        changes_requested: true,
        approved: false,
        reviewers: [{ state: "changes_requested", username: "alice" }],
        comments: [],
      });

      await handler.checkFeedback();
      await handler.checkFeedback();

      const eb = ctx.eventBus as unknown as { publish: ReturnType<typeof vi.fn> };
      const feedbackCalls = eb.publish.mock.calls.filter(
        (c: unknown[]) => (c[0] as { type: string }).type === EventTypes["task.feedback_received"],
      );
      // Only one feedback event despite two polls
      expect(feedbackCalls).toHaveLength(1);
    });

    it("emits new event when review state changes", async () => {
      const task = createReviewTask({ sub_state: SubStates.code });
      buildContext([task]);
      hostingPlugin.getPRStatus.mockResolvedValue({ state: "open", draft: false });

      // First poll: changes_requested
      hostingPlugin.getReviewStatus.mockResolvedValue({
        changes_requested: true,
        approved: false,
        reviewers: [{ state: "changes_requested", username: "alice" }],
        comments: [],
      });
      await handler.checkFeedback();

      // Second poll: approved (state changed)
      hostingPlugin.getReviewStatus.mockResolvedValue({
        changes_requested: false,
        approved: true,
        reviewers: [{ state: "approved", username: "alice" }],
        comments: [],
      });
      await handler.checkFeedback();

      const eb = ctx.eventBus as unknown as { publish: ReturnType<typeof vi.fn> };
      const feedbackCalls = eb.publish.mock.calls.filter(
        (c: unknown[]) => (c[0] as { type: string }).type === EventTypes["task.feedback_received"],
      );
      expect(feedbackCalls).toHaveLength(2);
      expect(
        (feedbackCalls[0]![0] as { payload: TaskFeedbackReceivedPayload }).payload.feedback_type,
      ).toBe("changes_requested");
      expect(
        (feedbackCalls[1]![0] as { payload: TaskFeedbackReceivedPayload }).payload.feedback_type,
      ).toBe("approved");
    });

    it("skips polling after too many recent failures (time-windowed)", async () => {
      const task = createReviewTask({ sub_state: SubStates.code });
      buildContext([task]);
      hostingPlugin.getReviewStatus.mockRejectedValue(new Error("API down"));

      // Trigger 3 failures within the window
      await handler.checkFeedback();
      await handler.checkFeedback();
      await handler.checkFeedback();

      // Reset mock to track further calls
      hostingPlugin.getReviewStatus.mockClear();
      hostingPlugin.getPRStatus.mockClear();

      // 4th call should be skipped due to failure threshold
      await handler.checkFeedback();

      expect(hostingPlugin.getReviewStatus).not.toHaveBeenCalled();
    });

    // SECURITY: reviewer comments are sanitized before EventBus emission
    it("sanitizes reviewer comment content in feedback event payload", async () => {
      const task = createReviewTask({ sub_state: SubStates.code });
      buildContext([task]);
      hostingPlugin.getPRStatus.mockResolvedValue({ state: "open", draft: false });
      hostingPlugin.getReviewStatus.mockResolvedValue({
        changes_requested: true,
        approved: false,
        reviewers: [{ state: "changes_requested", username: "alice" }],
        comments: ["Found a leak: ghp_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"],
      });
      hostingPlugin.getPRComments.mockResolvedValue([]);

      await handler.checkFeedback();

      const eb = ctx.eventBus as unknown as { publish: ReturnType<typeof vi.fn> };
      const feedbackCall = eb.publish.mock.calls.find(
        (c: unknown[]) => (c[0] as { type: string }).type === EventTypes["task.feedback_received"],
      );
      expect(feedbackCall).toBeDefined();
      const payload = (feedbackCall?.[0] as { payload: TaskFeedbackReceivedPayload }).payload;
      expect(payload.content).not.toContain("ghp_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB");
      expect(payload.content).toContain("[REDACTED:token]");
    });

    it("resumes polling after failure window expires", async () => {
      const task = createReviewTask({ sub_state: SubStates.code });
      buildContext([task]);
      hostingPlugin.getReviewStatus.mockRejectedValue(new Error("API down"));

      // Trigger 3 failures
      await handler.checkFeedback();
      await handler.checkFeedback();
      await handler.checkFeedback();

      // Advance clock past the 5-minute window
      clockNow += 300_001;

      hostingPlugin.getReviewStatus.mockResolvedValue({
        changes_requested: false,
        approved: false,
        reviewers: [],
        comments: [],
      });
      hostingPlugin.getPRStatus.mockResolvedValue({ state: "open", draft: false });

      await handler.checkFeedback();

      // Should have called the API again
      expect(hostingPlugin.getReviewStatus).toHaveBeenCalled();
    });

    it("respects configurable max_failures_before_pause threshold", async () => {
      const task = createReviewTask({ sub_state: SubStates.code });
      buildContext([task]);

      // Override config to pause after just 1 failure
      (ctx.config as { review_polling: { max_failures_before_pause: number } }).review_polling = {
        ...ctx.config.review_polling,
        max_failures_before_pause: 1,
      };
      // Re-create handler with the updated config
      handler = createReviewHandler(ctx, notifications, callbacks);

      hostingPlugin.getReviewStatus.mockRejectedValue(new Error("API down"));

      // 1 failure should be enough to trigger the circuit breaker
      await handler.checkFeedback();

      hostingPlugin.getReviewStatus.mockClear();
      hostingPlugin.getPRStatus.mockClear();

      await handler.checkFeedback();
      expect(hostingPlugin.getReviewStatus).not.toHaveBeenCalled();
    });
  });

  // ── handleFeedbackEvent ──────────────────────────────────────────────────

  describe("handleFeedbackEvent", () => {
    it("transitions to queued on changes_requested", () => {
      const task = createReviewTask({ sub_state: SubStates.code });
      buildContext([task]);

      handler.handleFeedbackEvent({
        task_id: "task-1",
        stage: "code",
        feedback_type: "changes_requested",
        reviewer: "alice",
        content: "Please fix the tests",
        pr_number: 42,
      });

      const te = ctx.taskEngine as unknown as {
        requestTransition: ReturnType<typeof vi.fn>;
      };
      expect(te.requestTransition).toHaveBeenCalledWith(
        "task-1",
        TaskStates.queued,
        null,
        "feedback_rework:changes_requested",
        "daemon",
      );
      expect(notifications.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: NotificationKinds.ticket_comment,
          taskId: "task-1",
          message: "Reviewer feedback received (changes_requested) — reworking.",
        }),
      );
    });

    it("on approved/code without auto-merge: transitions to completed with cleanup", async () => {
      const task = createReviewTask({ sub_state: SubStates.code });
      buildContext([task]);
      (
        ctx.safetyLayer as unknown as { checkAutoMergeAllowed: ReturnType<typeof vi.fn> }
      ).checkAutoMergeAllowed.mockReturnValue(false);

      handler.handleFeedbackEvent({
        task_id: "task-1",
        stage: "code",
        feedback_type: "approved",
        reviewer: "bob",
        content: null,
        pr_number: 42,
      });

      await flush();

      const te = ctx.taskEngine as unknown as {
        requestTransition: ReturnType<typeof vi.fn>;
      };
      expect(te.requestTransition).toHaveBeenCalledWith(
        "task-1",
        TaskStates.completed,
        null,
        "code_approved",
        "daemon",
      );
      expect(notifications.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: NotificationKinds.ticket_comment,
          taskId: "task-1",
          message: "Code review approved — ready to merge.",
        }),
      );
      // Completion cleanup: workspace, notification, child-done check
      const ws = ctx.workspaceManager as unknown as {
        cleanupWorkspace: ReturnType<typeof vi.fn>;
      };
      expect(ws.cleanupWorkspace).toHaveBeenCalledWith("task-1", true);
      expect(notifications.notify).toHaveBeenCalledWith(
        expect.objectContaining({ kind: NotificationKinds.completion, taskId: "task-1" }),
      );
      expect(callbacks.onTaskCompletionFinalized).toHaveBeenCalledWith("task-1");
    });

    it("on approved/code with auto-merge + CI passing: merges PR and completes", async () => {
      const task = createReviewTask({ sub_state: SubStates.code });
      buildContext([task]);
      (
        ctx.safetyLayer as unknown as { checkAutoMergeAllowed: ReturnType<typeof vi.fn> }
      ).checkAutoMergeAllowed.mockReturnValue(true);
      hostingPlugin.getPRStatus.mockResolvedValue({
        state: "open",
        draft: false,
        mergeable: true,
        checks_state: "passing",
        number: 42,
        url: "https://github.com/owner/repo/pull/42",
      });
      hostingPlugin.mergePR.mockResolvedValue({ success: true });

      handler.handleFeedbackEvent({
        task_id: "task-1",
        stage: "code",
        feedback_type: "approved",
        reviewer: "bob",
        content: null,
        pr_number: 42,
      });

      await flush();

      expect(hostingPlugin.mergePR).toHaveBeenCalledWith("owner/repo", 42, "squash");

      const te = ctx.taskEngine as unknown as {
        requestTransition: ReturnType<typeof vi.fn>;
        updateTaskField: ReturnType<typeof vi.fn>;
      };
      expect(te.requestTransition).toHaveBeenCalledWith(
        "task-1",
        TaskStates.completed,
        null,
        "code_approved_merged",
        "daemon",
      );
      expect(te.updateTaskField).toHaveBeenCalledWith(
        "task-1",
        "review",
        expect.objectContaining({ pr_state: "merged" }),
      );
      expect(callbacks.onTaskCompletionFinalized).toHaveBeenCalledWith("task-1");
    });

    it("on approved/code with auto-merge + CI pending: defers merge", async () => {
      const task = createReviewTask({ sub_state: SubStates.code });
      buildContext([task]);
      (
        ctx.safetyLayer as unknown as { checkAutoMergeAllowed: ReturnType<typeof vi.fn> }
      ).checkAutoMergeAllowed.mockReturnValue(true);
      hostingPlugin.getPRStatus.mockResolvedValue({
        state: "open",
        draft: false,
        mergeable: true,
        checks_state: "pending",
        number: 42,
        url: "https://github.com/owner/repo/pull/42",
      });

      handler.handleFeedbackEvent({
        task_id: "task-1",
        stage: "code",
        feedback_type: "approved",
        reviewer: "bob",
        content: null,
        pr_number: 42,
      });

      await flush();

      // Should NOT attempt merge
      expect(hostingPlugin.mergePR).not.toHaveBeenCalled();
      // Should NOT complete the task
      const te = ctx.taskEngine as unknown as {
        requestTransition: ReturnType<typeof vi.fn>;
      };
      expect(te.requestTransition).not.toHaveBeenCalledWith(
        "task-1",
        TaskStates.completed,
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
      // Should notify about waiting
      expect(notifications.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: NotificationKinds.ticket_comment,
          message: "Code approved — waiting for CI pipeline to complete before merging.",
        }),
      );
    });

    it("on approved/code with auto-merge + CI failing: re-queues for post-approval fix", async () => {
      const task = createReviewTask({ sub_state: SubStates.code });
      buildContext([task]);
      (
        ctx.safetyLayer as unknown as { checkAutoMergeAllowed: ReturnType<typeof vi.fn> }
      ).checkAutoMergeAllowed.mockReturnValue(true);
      hostingPlugin.getPRStatus.mockResolvedValue({
        state: "open",
        draft: false,
        mergeable: true,
        checks_state: "failing",
        number: 42,
        url: "https://github.com/owner/repo/pull/42",
      });

      handler.handleFeedbackEvent({
        task_id: "task-1",
        stage: "code",
        feedback_type: "approved",
        reviewer: "bob",
        content: null,
        pr_number: 42,
      });

      await flush();

      // Should NOT attempt merge
      expect(hostingPlugin.mergePR).not.toHaveBeenCalled();
      // Should re-queue for pipeline fix
      const te = ctx.taskEngine as unknown as {
        requestTransition: ReturnType<typeof vi.fn>;
      };
      expect(te.requestTransition).toHaveBeenCalledWith(
        "task-1",
        TaskStates.queued,
        null,
        "post_approval_fix",
        "daemon",
      );
      expect(notifications.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: NotificationKinds.ticket_comment,
          message: expect.stringContaining("CI pipeline failing"),
        }),
      );
    });

    it("on approved/code with auto-merge + no CI: merges immediately", async () => {
      const task = createReviewTask({ sub_state: SubStates.code });
      buildContext([task]);
      (
        ctx.safetyLayer as unknown as { checkAutoMergeAllowed: ReturnType<typeof vi.fn> }
      ).checkAutoMergeAllowed.mockReturnValue(true);
      hostingPlugin.getPRStatus.mockResolvedValue({
        state: "open",
        draft: false,
        mergeable: true,
        checks_state: "none",
        number: 42,
        url: "https://github.com/owner/repo/pull/42",
      });
      hostingPlugin.mergePR.mockResolvedValue({ success: true });

      handler.handleFeedbackEvent({
        task_id: "task-1",
        stage: "code",
        feedback_type: "approved",
        reviewer: "bob",
        content: null,
        pr_number: 42,
      });

      await flush();

      expect(hostingPlugin.mergePR).toHaveBeenCalledWith("owner/repo", 42, "squash");
    });

    it("on merge rejected by GitHub: does NOT complete the task", async () => {
      const task = createReviewTask({ sub_state: SubStates.code });
      buildContext([task]);
      (
        ctx.safetyLayer as unknown as { checkAutoMergeAllowed: ReturnType<typeof vi.fn> }
      ).checkAutoMergeAllowed.mockReturnValue(true);
      hostingPlugin.getPRStatus.mockResolvedValue({
        state: "open",
        draft: false,
        mergeable: true,
        checks_state: "passing",
        number: 42,
        url: "https://github.com/owner/repo/pull/42",
      });
      hostingPlugin.mergePR.mockResolvedValue({
        success: false,
        merge_sha: "",
        error: { code: "pr_not_mergeable", message: "Branch protection", retryable: false },
      });

      handler.handleFeedbackEvent({
        task_id: "task-1",
        stage: "code",
        feedback_type: "approved",
        reviewer: "bob",
        content: null,
        pr_number: 42,
      });

      await flush();

      const te = ctx.taskEngine as unknown as {
        requestTransition: ReturnType<typeof vi.fn>;
      };
      // Should NOT transition to completed
      expect(te.requestTransition).not.toHaveBeenCalledWith(
        "task-1",
        TaskStates.completed,
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
      // Should notify about the failure
      expect(notifications.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: NotificationKinds.ticket_comment,
          message: expect.stringContaining("Auto-merge rejected"),
        }),
      );
    });

    it("on merge API exception: does NOT complete the task", async () => {
      const task = createReviewTask({ sub_state: SubStates.code });
      buildContext([task]);
      (
        ctx.safetyLayer as unknown as { checkAutoMergeAllowed: ReturnType<typeof vi.fn> }
      ).checkAutoMergeAllowed.mockReturnValue(true);
      hostingPlugin.getPRStatus.mockResolvedValue({
        state: "open",
        draft: false,
        mergeable: true,
        checks_state: "passing",
        number: 42,
        url: "https://github.com/owner/repo/pull/42",
      });
      hostingPlugin.mergePR.mockRejectedValue(new Error("network timeout"));

      handler.handleFeedbackEvent({
        task_id: "task-1",
        stage: "code",
        feedback_type: "approved",
        reviewer: "bob",
        content: null,
        pr_number: 42,
      });

      await flush();

      const te = ctx.taskEngine as unknown as {
        requestTransition: ReturnType<typeof vi.fn>;
      };
      // Should NOT transition to completed
      expect(te.requestTransition).not.toHaveBeenCalledWith(
        "task-1",
        TaskStates.completed,
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    });

    it("post-approval fix resets accommodated_review_state and accommodated_comment_ids", async () => {
      const task = createReviewTask({
        sub_state: SubStates.code,
        review: {
          pr_number: 42,
          pr_state: "ready",
          demo_artifacts: [],
          feedback_rounds: [],
          accommodated_comment_ids: ["c1", "c2"],
          accommodated_review_state: "approved",
        },
      });
      buildContext([task]);
      (
        ctx.safetyLayer as unknown as { checkAutoMergeAllowed: ReturnType<typeof vi.fn> }
      ).checkAutoMergeAllowed.mockReturnValue(true);
      hostingPlugin.getPRStatus.mockResolvedValue({
        state: "open",
        draft: false,
        mergeable: true,
        checks_state: "failing",
        number: 42,
        url: "https://github.com/owner/repo/pull/42",
      });

      handler.handleFeedbackEvent({
        task_id: "task-1",
        stage: "code",
        feedback_type: "approved",
        reviewer: "bob",
        content: null,
        pr_number: 42,
      });

      await flush();

      const te = ctx.taskEngine as unknown as { updateTaskField: ReturnType<typeof vi.fn> };
      // Find the updateTaskField call that includes the synthetic feedback round
      const reviewUpdate = te.updateTaskField.mock.calls.find(
        (call: unknown[]) =>
          call[1] === "review" &&
          (call[2] as { accommodated_review_state?: unknown }).accommodated_review_state === null,
      );
      expect(reviewUpdate).toBeDefined();
      expect(
        (reviewUpdate![2] as { accommodated_comment_ids: unknown[] }).accommodated_comment_ids,
      ).toEqual([]);
    });

    it("post-approval fix retry limit: completes with manual merge message", async () => {
      const task = createReviewTask({ sub_state: SubStates.code });
      buildContext([task]);
      (
        ctx.safetyLayer as unknown as { checkAutoMergeAllowed: ReturnType<typeof vi.fn> }
      ).checkAutoMergeAllowed.mockReturnValue(true);
      hostingPlugin.getPRStatus.mockResolvedValue({
        state: "open",
        draft: false,
        mergeable: true,
        checks_state: "failing",
        number: 42,
        url: "https://github.com/owner/repo/pull/42",
      });
      // Simulate 3 previous post_approval_fix attempts in state history
      (
        ctx.taskEngine as unknown as { getStateHistory: ReturnType<typeof vi.fn> }
      ).getStateHistory.mockReturnValue([
        { reason: "post_approval_fix" },
        { reason: "post_approval_fix" },
        { reason: "post_approval_fix" },
      ]);

      handler.handleFeedbackEvent({
        task_id: "task-1",
        stage: "code",
        feedback_type: "approved",
        reviewer: "bob",
        content: null,
        pr_number: 42,
      });

      await flush();

      const te = ctx.taskEngine as unknown as {
        requestTransition: ReturnType<typeof vi.fn>;
      };
      // Should complete the task (retry limit reached)
      expect(te.requestTransition).toHaveBeenCalledWith(
        "task-1",
        TaskStates.completed,
        null,
        "code_approved",
        "daemon",
      );
      expect(notifications.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: NotificationKinds.ticket_comment,
          message: expect.stringContaining("Please fix and merge manually"),
        }),
      );
    });

    it("ignores feedback for non-review_pending tasks", () => {
      const task = createReviewTask({ state: TaskStates.active, sub_state: null });
      buildContext([task]);

      handler.handleFeedbackEvent({
        task_id: "task-1",
        stage: "code",
        feedback_type: "changes_requested",
        reviewer: "alice",
        content: "Fix it",
        pr_number: 42,
      });

      const te = ctx.taskEngine as unknown as {
        requestTransition: ReturnType<typeof vi.fn>;
      };
      expect(te.requestTransition).not.toHaveBeenCalled();
    });

    it("ignores feedback for unknown task", () => {
      buildContext([]);

      handler.handleFeedbackEvent({
        task_id: "nonexistent",
        stage: "code",
        feedback_type: "changes_requested",
        reviewer: "alice",
        content: null,
        pr_number: 99,
      });

      const te = ctx.taskEngine as unknown as {
        requestTransition: ReturnType<typeof vi.fn>;
      };
      expect(te.requestTransition).not.toHaveBeenCalled();
    });

    it("stores feedback round on the task", () => {
      const task = createReviewTask({ sub_state: SubStates.code });
      buildContext([task]);

      handler.handleFeedbackEvent({
        task_id: "task-1",
        stage: "code",
        feedback_type: "changes_requested",
        reviewer: "alice",
        content: "Line 10 needs a fix\nLine 20 also",
        pr_number: 42,
      });

      const te = ctx.taskEngine as unknown as {
        updateTaskField: ReturnType<typeof vi.fn>;
      };
      // updateTaskField called for review with feedback_rounds
      const reviewCalls = te.updateTaskField.mock.calls.filter((c: unknown[]) => c[1] === "review");
      expect(reviewCalls.length).toBeGreaterThanOrEqual(1);
      const reviewArg = reviewCalls[0]![2] as {
        feedback_rounds: Array<{ stage: string; comments: string[]; applied: boolean }>;
      };
      expect(reviewArg.feedback_rounds).toHaveLength(1);
      expect(reviewArg.feedback_rounds[0]!.stage).toBe("code");
      expect(reviewArg.feedback_rounds[0]!.comments).toEqual([
        "Line 10 needs a fix",
        "Line 20 also",
      ]);
      expect(reviewArg.feedback_rounds[0]!.applied).toBe(false);
    });

    // SECURITY: feedback content is sanitized before storage
    it("sanitizes secrets in feedback content before storing in task review rounds", () => {
      const task = createReviewTask({ sub_state: SubStates.code });
      buildContext([task]);

      const tokenContent =
        "Fix the auth: https://git:ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA@github.com/org/repo";
      handler.handleFeedbackEvent({
        task_id: "task-1",
        stage: "code",
        feedback_type: "changes_requested",
        reviewer: "alice",
        content: tokenContent,
        pr_number: 42,
      });

      const te = ctx.taskEngine as unknown as {
        updateTaskField: ReturnType<typeof vi.fn>;
      };
      const reviewCalls = te.updateTaskField.mock.calls.filter((c: unknown[]) => c[1] === "review");
      const reviewArg = reviewCalls[0]![2] as {
        feedback_rounds: Array<{ comments: string[] }>;
      };
      const allComments = reviewArg.feedback_rounds[0]!.comments.join(" ");
      expect(allComments).not.toContain("ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    });
  });

  // ── checkApprovedCI ──────────────────────────────────────────────────────

  describe("checkApprovedCI", () => {
    it("merges when pending CI becomes passing", async () => {
      const task = createReviewTask({ sub_state: SubStates.code });
      buildContext([task]);
      (
        ctx.safetyLayer as unknown as { checkAutoMergeAllowed: ReturnType<typeof vi.fn> }
      ).checkAutoMergeAllowed.mockReturnValue(true);

      // First call: CI pending → defers to approvedAwaitingCI
      hostingPlugin.getPRStatus.mockResolvedValue({
        state: "open",
        draft: false,
        mergeable: true,
        checks_state: "pending",
        number: 42,
        url: "https://github.com/owner/repo/pull/42",
      });

      handler.handleFeedbackEvent({
        task_id: "task-1",
        stage: "code",
        feedback_type: "approved",
        reviewer: "bob",
        content: null,
        pr_number: 42,
      });
      await flush();

      expect(hostingPlugin.mergePR).not.toHaveBeenCalled();

      // Second call: CI now passing → checkApprovedCI should merge
      hostingPlugin.getPRStatus.mockResolvedValue({
        state: "open",
        draft: false,
        mergeable: true,
        checks_state: "passing",
        number: 42,
        url: "https://github.com/owner/repo/pull/42",
      });
      hostingPlugin.mergePR.mockResolvedValue({ success: true });

      await handler.checkApprovedCI();

      expect(hostingPlugin.mergePR).toHaveBeenCalledWith("owner/repo", 42, "squash");
    });

    it("re-queues for post-approval fix when pending CI becomes failing", async () => {
      const task = createReviewTask({ sub_state: SubStates.code });
      buildContext([task]);
      (
        ctx.safetyLayer as unknown as { checkAutoMergeAllowed: ReturnType<typeof vi.fn> }
      ).checkAutoMergeAllowed.mockReturnValue(true);

      // First: CI pending
      hostingPlugin.getPRStatus.mockResolvedValue({
        state: "open",
        draft: false,
        mergeable: true,
        checks_state: "pending",
        number: 42,
        url: "https://github.com/owner/repo/pull/42",
      });

      handler.handleFeedbackEvent({
        task_id: "task-1",
        stage: "code",
        feedback_type: "approved",
        reviewer: "bob",
        content: null,
        pr_number: 42,
      });
      await flush();

      // Second: CI failing
      hostingPlugin.getPRStatus.mockResolvedValue({
        state: "open",
        draft: false,
        mergeable: true,
        checks_state: "failing",
        number: 42,
        url: "https://github.com/owner/repo/pull/42",
      });

      await handler.checkApprovedCI();

      const te = ctx.taskEngine as unknown as {
        requestTransition: ReturnType<typeof vi.fn>;
      };
      expect(te.requestTransition).toHaveBeenCalledWith(
        "task-1",
        TaskStates.queued,
        null,
        "post_approval_fix",
        "daemon",
      );
    });

    it("does nothing when CI is still pending", async () => {
      const task = createReviewTask({ sub_state: SubStates.code });
      buildContext([task]);
      (
        ctx.safetyLayer as unknown as { checkAutoMergeAllowed: ReturnType<typeof vi.fn> }
      ).checkAutoMergeAllowed.mockReturnValue(true);

      hostingPlugin.getPRStatus.mockResolvedValue({
        state: "open",
        draft: false,
        mergeable: true,
        checks_state: "pending",
        number: 42,
        url: "https://github.com/owner/repo/pull/42",
      });

      handler.handleFeedbackEvent({
        task_id: "task-1",
        stage: "code",
        feedback_type: "approved",
        reviewer: "bob",
        content: null,
        pr_number: 42,
      });
      await flush();

      // Still pending on second check
      await handler.checkApprovedCI();

      expect(hostingPlugin.mergePR).not.toHaveBeenCalled();
      const te = ctx.taskEngine as unknown as {
        requestTransition: ReturnType<typeof vi.fn>;
      };
      expect(te.requestTransition).not.toHaveBeenCalledWith(
        "task-1",
        TaskStates.queued,
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    });

    it("does nothing when no tasks are awaiting CI", async () => {
      buildContext([]);

      await handler.checkApprovedCI();

      expect(hostingPlugin.getPRStatus).not.toHaveBeenCalled();
    });
  });

  // ── Post-Approval: Merge Conflict Detection ─────────────────────────────

  describe("post-approval merge conflict detection", () => {
    it("handleCodeApproval: CI passing + mergeable false → re-queues with merge_conflict", async () => {
      const task = createReviewTask({ sub_state: SubStates.code });
      buildContext([task]);
      (
        ctx.safetyLayer as unknown as { checkAutoMergeAllowed: ReturnType<typeof vi.fn> }
      ).checkAutoMergeAllowed.mockReturnValue(true);
      hostingPlugin.getPRStatus.mockResolvedValue({
        state: "open",
        draft: false,
        mergeable: false,
        checks_state: "passing",
        number: 42,
        url: "https://github.com/owner/repo/pull/42",
      });

      handler.handleFeedbackEvent({
        task_id: "task-1",
        stage: "code",
        feedback_type: "approved",
        reviewer: "bob",
        content: null,
        pr_number: 42,
      });
      await flush();

      expect(hostingPlugin.mergePR).not.toHaveBeenCalled();
      const te = ctx.taskEngine as unknown as {
        requestTransition: ReturnType<typeof vi.fn>;
        updateTaskField: ReturnType<typeof vi.fn>;
      };
      expect(te.requestTransition).toHaveBeenCalledWith(
        "task-1",
        TaskStates.queued,
        null,
        "post_approval_fix",
        "daemon",
      );
      // Verify feedback round mentions merge conflicts
      const reviewCalls = te.updateTaskField.mock.calls.filter((c: unknown[]) => c[1] === "review");
      const lastReviewArg = reviewCalls[reviewCalls.length - 1]![2] as {
        feedback_rounds: Array<{ comments: string[] }>;
      };
      const allComments = lastReviewArg.feedback_rounds.flatMap((r) => r.comments).join(" ");
      expect(allComments).toContain("Merge conflicts detected");
      expect(allComments).not.toContain("CI pipeline is failing");
    });

    it("handleCodeApproval: CI failing + mergeable false → grouped feedback with BOTH issues", async () => {
      const task = createReviewTask({ sub_state: SubStates.code });
      buildContext([task]);
      (
        ctx.safetyLayer as unknown as { checkAutoMergeAllowed: ReturnType<typeof vi.fn> }
      ).checkAutoMergeAllowed.mockReturnValue(true);
      hostingPlugin.getPRStatus.mockResolvedValue({
        state: "open",
        draft: false,
        mergeable: false,
        checks_state: "failing",
        number: 42,
        url: "https://github.com/owner/repo/pull/42",
      });

      handler.handleFeedbackEvent({
        task_id: "task-1",
        stage: "code",
        feedback_type: "approved",
        reviewer: "bob",
        content: null,
        pr_number: 42,
      });
      await flush();

      expect(hostingPlugin.mergePR).not.toHaveBeenCalled();
      const te = ctx.taskEngine as unknown as {
        requestTransition: ReturnType<typeof vi.fn>;
        updateTaskField: ReturnType<typeof vi.fn>;
      };
      // ONE re-queue, not two
      const queuedCalls = te.requestTransition.mock.calls.filter(
        (c: unknown[]) => c[1] === TaskStates.queued,
      );
      expect(queuedCalls).toHaveLength(1);
      expect(queuedCalls[0]).toEqual([
        "task-1",
        TaskStates.queued,
        null,
        "post_approval_fix",
        "daemon",
      ]);
      // Verify feedback round mentions BOTH issues
      const reviewCalls = te.updateTaskField.mock.calls.filter((c: unknown[]) => c[1] === "review");
      const lastReviewArg = reviewCalls[reviewCalls.length - 1]![2] as {
        feedback_rounds: Array<{ comments: string[] }>;
      };
      const allComments = lastReviewArg.feedback_rounds.flatMap((r) => r.comments).join(" ");
      expect(allComments).toContain("CI pipeline is failing");
      expect(allComments).toContain("Merge conflicts detected");
      // Verify notification mentions both
      expect(notifications.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: NotificationKinds.ticket_comment,
          message: expect.stringContaining("Post-approval issues"),
        }),
      );
    });

    it("handleCodeApproval: CI failing + mergeable true → only CI failure in feedback", async () => {
      const task = createReviewTask({ sub_state: SubStates.code });
      buildContext([task]);
      (
        ctx.safetyLayer as unknown as { checkAutoMergeAllowed: ReturnType<typeof vi.fn> }
      ).checkAutoMergeAllowed.mockReturnValue(true);
      hostingPlugin.getPRStatus.mockResolvedValue({
        state: "open",
        draft: false,
        mergeable: true,
        checks_state: "failing",
        number: 42,
        url: "https://github.com/owner/repo/pull/42",
      });

      handler.handleFeedbackEvent({
        task_id: "task-1",
        stage: "code",
        feedback_type: "approved",
        reviewer: "bob",
        content: null,
        pr_number: 42,
      });
      await flush();

      const te = ctx.taskEngine as unknown as {
        updateTaskField: ReturnType<typeof vi.fn>;
      };
      const reviewCalls = te.updateTaskField.mock.calls.filter((c: unknown[]) => c[1] === "review");
      const lastReviewArg = reviewCalls[reviewCalls.length - 1]![2] as {
        feedback_rounds: Array<{ comments: string[] }>;
      };
      const allComments = lastReviewArg.feedback_rounds.flatMap((r) => r.comments).join(" ");
      expect(allComments).toContain("CI pipeline is failing");
      expect(allComments).not.toContain("Merge conflicts detected");
    });

    it("handleCodeApproval: CI pending → defers to approvedAwaitingCI (ignores mergeable)", async () => {
      const task = createReviewTask({ sub_state: SubStates.code });
      buildContext([task]);
      (
        ctx.safetyLayer as unknown as { checkAutoMergeAllowed: ReturnType<typeof vi.fn> }
      ).checkAutoMergeAllowed.mockReturnValue(true);
      hostingPlugin.getPRStatus.mockResolvedValue({
        state: "open",
        draft: false,
        mergeable: false,
        checks_state: "pending",
        number: 42,
        url: "https://github.com/owner/repo/pull/42",
      });

      handler.handleFeedbackEvent({
        task_id: "task-1",
        stage: "code",
        feedback_type: "approved",
        reviewer: "bob",
        content: null,
        pr_number: 42,
      });
      await flush();

      // Should NOT re-queue or attempt merge — just defer
      expect(hostingPlugin.mergePR).not.toHaveBeenCalled();
      const te = ctx.taskEngine as unknown as {
        requestTransition: ReturnType<typeof vi.fn>;
      };
      expect(te.requestTransition).not.toHaveBeenCalledWith(
        "task-1",
        TaskStates.queued,
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
      expect(notifications.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Code approved — waiting for CI pipeline to complete before merging.",
        }),
      );
    });

    it("attemptMerge: merge_conflict error → re-queues for resolution (no retry)", async () => {
      const task = createReviewTask({ sub_state: SubStates.code });
      buildContext([task]);
      (
        ctx.safetyLayer as unknown as { checkAutoMergeAllowed: ReturnType<typeof vi.fn> }
      ).checkAutoMergeAllowed.mockReturnValue(true);
      hostingPlugin.getPRStatus.mockResolvedValue({
        state: "open",
        draft: false,
        mergeable: true,
        checks_state: "passing",
        number: 42,
        url: "https://github.com/owner/repo/pull/42",
      });
      hostingPlugin.mergePR.mockResolvedValue({
        success: false,
        merge_sha: "",
        error: { code: "merge_conflict", message: "Merge conflict", retryable: false },
      });

      handler.handleFeedbackEvent({
        task_id: "task-1",
        stage: "code",
        feedback_type: "approved",
        reviewer: "bob",
        content: null,
        pr_number: 42,
      });
      await flush();

      const te = ctx.taskEngine as unknown as {
        requestTransition: ReturnType<typeof vi.fn>;
      };
      // Should re-queue for post-approval fix, NOT just notify and retry
      expect(te.requestTransition).toHaveBeenCalledWith(
        "task-1",
        TaskStates.queued,
        null,
        "post_approval_fix",
        "daemon",
      );
    });

    it("attemptMerge: network_error → retries next tick (existing behavior preserved)", async () => {
      const task = createReviewTask({ sub_state: SubStates.code });
      buildContext([task]);
      (
        ctx.safetyLayer as unknown as { checkAutoMergeAllowed: ReturnType<typeof vi.fn> }
      ).checkAutoMergeAllowed.mockReturnValue(true);
      hostingPlugin.getPRStatus.mockResolvedValue({
        state: "open",
        draft: false,
        mergeable: true,
        checks_state: "passing",
        number: 42,
        url: "https://github.com/owner/repo/pull/42",
      });
      hostingPlugin.mergePR.mockResolvedValue({
        success: false,
        merge_sha: "",
        error: { code: "network_error", message: "Connection reset", retryable: true },
      });

      handler.handleFeedbackEvent({
        task_id: "task-1",
        stage: "code",
        feedback_type: "approved",
        reviewer: "bob",
        content: null,
        pr_number: 42,
      });
      await flush();

      const te = ctx.taskEngine as unknown as {
        requestTransition: ReturnType<typeof vi.fn>;
      };
      // Should NOT re-queue — just allow retry
      expect(te.requestTransition).not.toHaveBeenCalledWith(
        "task-1",
        TaskStates.queued,
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
      expect(notifications.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: NotificationKinds.ticket_comment,
          message: expect.stringContaining("Auto-merge rejected"),
        }),
      );
    });

    it("checkSingleTaskCI: CI passing + mergeable false → re-queues for merge conflict", async () => {
      const task = createReviewTask({ sub_state: SubStates.code });
      buildContext([task]);
      (
        ctx.safetyLayer as unknown as { checkAutoMergeAllowed: ReturnType<typeof vi.fn> }
      ).checkAutoMergeAllowed.mockReturnValue(true);

      // First: CI pending → defer
      hostingPlugin.getPRStatus.mockResolvedValue({
        state: "open",
        draft: false,
        mergeable: true,
        checks_state: "pending",
        number: 42,
        url: "https://github.com/owner/repo/pull/42",
      });

      handler.handleFeedbackEvent({
        task_id: "task-1",
        stage: "code",
        feedback_type: "approved",
        reviewer: "bob",
        content: null,
        pr_number: 42,
      });
      await flush();

      // Second: CI passing but mergeable false
      hostingPlugin.getPRStatus.mockResolvedValue({
        state: "open",
        draft: false,
        mergeable: false,
        checks_state: "passing",
        number: 42,
        url: "https://github.com/owner/repo/pull/42",
      });

      await handler.checkApprovedCI();

      expect(hostingPlugin.mergePR).not.toHaveBeenCalled();
      const te = ctx.taskEngine as unknown as {
        requestTransition: ReturnType<typeof vi.fn>;
      };
      expect(te.requestTransition).toHaveBeenCalledWith(
        "task-1",
        TaskStates.queued,
        null,
        "post_approval_fix",
        "daemon",
      );
    });

    it("checkSingleTaskCI: CI passing + mergeable true → calls attemptMerge (happy path)", async () => {
      const task = createReviewTask({ sub_state: SubStates.code });
      buildContext([task]);
      (
        ctx.safetyLayer as unknown as { checkAutoMergeAllowed: ReturnType<typeof vi.fn> }
      ).checkAutoMergeAllowed.mockReturnValue(true);

      // First: CI pending → defer
      hostingPlugin.getPRStatus.mockResolvedValue({
        state: "open",
        draft: false,
        mergeable: true,
        checks_state: "pending",
        number: 42,
        url: "https://github.com/owner/repo/pull/42",
      });

      handler.handleFeedbackEvent({
        task_id: "task-1",
        stage: "code",
        feedback_type: "approved",
        reviewer: "bob",
        content: null,
        pr_number: 42,
      });
      await flush();

      // Second: CI passing + mergeable
      hostingPlugin.getPRStatus.mockResolvedValue({
        state: "open",
        draft: false,
        mergeable: true,
        checks_state: "passing",
        number: 42,
        url: "https://github.com/owner/repo/pull/42",
      });
      hostingPlugin.mergePR.mockResolvedValue({ success: true });

      await handler.checkApprovedCI();

      expect(hostingPlugin.mergePR).toHaveBeenCalledWith("owner/repo", 42, "squash");
    });

    it("backward compat: pipeline_fix history entries counted by retry counter", async () => {
      const task = createReviewTask({ sub_state: SubStates.code });
      buildContext([task]);
      (
        ctx.safetyLayer as unknown as { checkAutoMergeAllowed: ReturnType<typeof vi.fn> }
      ).checkAutoMergeAllowed.mockReturnValue(true);
      hostingPlugin.getPRStatus.mockResolvedValue({
        state: "open",
        draft: false,
        mergeable: false,
        checks_state: "failing",
        number: 42,
        url: "https://github.com/owner/repo/pull/42",
      });
      // Mix of old and new reasons — all should count
      (
        ctx.taskEngine as unknown as { getStateHistory: ReturnType<typeof vi.fn> }
      ).getStateHistory.mockReturnValue([
        { reason: "pipeline_fix" },
        { reason: "post_approval_fix" },
        { reason: "pipeline_fix" },
      ]);

      handler.handleFeedbackEvent({
        task_id: "task-1",
        stage: "code",
        feedback_type: "approved",
        reviewer: "bob",
        content: null,
        pr_number: 42,
      });
      await flush();

      const te = ctx.taskEngine as unknown as {
        requestTransition: ReturnType<typeof vi.fn>;
      };
      // 3 previous attempts → next would be attempt 4 > limit of 3 → completes with manual merge
      expect(te.requestTransition).toHaveBeenCalledWith(
        "task-1",
        TaskStates.completed,
        null,
        "code_approved",
        "daemon",
      );
      expect(notifications.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: NotificationKinds.ticket_comment,
          message: expect.stringContaining("Please fix and merge manually"),
        }),
      );
    });

    it("retry limit with grouped issues → completes with message listing all issues", async () => {
      const task = createReviewTask({ sub_state: SubStates.code });
      buildContext([task]);
      (
        ctx.safetyLayer as unknown as { checkAutoMergeAllowed: ReturnType<typeof vi.fn> }
      ).checkAutoMergeAllowed.mockReturnValue(true);
      hostingPlugin.getPRStatus.mockResolvedValue({
        state: "open",
        draft: false,
        mergeable: false,
        checks_state: "failing",
        number: 42,
        url: "https://github.com/owner/repo/pull/42",
      });
      (
        ctx.taskEngine as unknown as { getStateHistory: ReturnType<typeof vi.fn> }
      ).getStateHistory.mockReturnValue([
        { reason: "post_approval_fix" },
        { reason: "post_approval_fix" },
        { reason: "post_approval_fix" },
      ]);

      handler.handleFeedbackEvent({
        task_id: "task-1",
        stage: "code",
        feedback_type: "approved",
        reviewer: "bob",
        content: null,
        pr_number: 42,
      });
      await flush();

      expect(notifications.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: NotificationKinds.ticket_comment,
          message: expect.stringContaining("CI pipeline failing, merge conflicts"),
        }),
      );
    });
  });

  // ── Comment-Based Approval ──────────────────────────────────────────────

  describe("detectCommentApproval (pure function)", () => {
    it("detects /approve command", () => {
      const result = detectCommentApproval(["@alice: /approve"]);
      expect(result).toEqual({ author: "alice" });
    });

    it("detects /approved command", () => {
      const result = detectCommentApproval(["@bob: /approved"]);
      expect(result).toEqual({ author: "bob" });
    });

    it("is case insensitive", () => {
      const result = detectCommentApproval(["@Alice: /APPROVE"]);
      expect(result).toEqual({ author: "Alice" });
    });

    it("ignores trailing whitespace", () => {
      const result = detectCommentApproval(["@alice: /approve  "]);
      expect(result).toEqual({ author: "alice" });
    });

    it("returns null for regular comments", () => {
      expect(detectCommentApproval(["@alice: looks good!"])).toBeNull();
    });

    it("returns null for /approve embedded in longer text", () => {
      expect(detectCommentApproval(["@alice: I /approve this change"])).toBeNull();
    });

    it("returns null for empty array", () => {
      expect(detectCommentApproval([])).toBeNull();
    });

    it("returns first match when multiple approvals exist", () => {
      const result = detectCommentApproval(["@alice: /approve", "@bob: /approved"]);
      expect(result).toEqual({ author: "alice" });
    });
  });

  describe("comment-based approval flow", () => {
    it("ignores /approve when enable_comment_approval is false", async () => {
      const task = createReviewTask({ sub_state: SubStates.code });
      buildContext([task]);

      hostingPlugin.getPRComments.mockResolvedValue([
        { id: "1", author: "FarzamMohammadi", body: "/approve", created_at: "2026-01-01" },
      ]);

      await handler.checkFeedback();
      await flush();

      // Should emit "comment" feedback, not "approved"
      const eb = ctx.eventBus as unknown as { publish: ReturnType<typeof vi.fn> };
      const feedbackCalls = eb.publish.mock.calls.filter(
        (c: unknown[]) => (c[0] as { type: string }).type === EventTypes["task.feedback_received"],
      );
      if (feedbackCalls.length > 0) {
        const payload = (feedbackCalls[0]![0] as { payload: TaskFeedbackReceivedPayload }).payload;
        expect(payload.feedback_type).toBe("comment");
      }
    });

    it("treats /approve as approval when enabled and author is authorized", async () => {
      const task = createReviewTask({ sub_state: SubStates.code });
      buildContext([task]);

      // Enable comment approval
      const sl = ctx.safetyLayer as unknown as {
        isCommentApprovalEnabled: ReturnType<typeof vi.fn>;
      };
      sl.isCommentApprovalEnabled.mockReturnValue(true);

      // Authorize via people directory (empty = allow anyone)
      const pd = ctx.peopleDirectory as unknown as { getByRole: ReturnType<typeof vi.fn> };
      pd.getByRole.mockReturnValue([]);

      hostingPlugin.getPRComments.mockResolvedValue([
        { id: "1", author: "FarzamMohammadi", body: "/approve", created_at: "2026-01-01" },
      ]);

      await handler.checkFeedback();
      await flush();

      const eb = ctx.eventBus as unknown as { publish: ReturnType<typeof vi.fn> };
      const feedbackCalls = eb.publish.mock.calls.filter(
        (c: unknown[]) => (c[0] as { type: string }).type === EventTypes["task.feedback_received"],
      );
      expect(feedbackCalls.length).toBeGreaterThan(0);
      const payload = (feedbackCalls[0]![0] as { payload: TaskFeedbackReceivedPayload }).payload;
      expect(payload.feedback_type).toBe("approved");
    });

    it("rejects /approve from unauthorized author when people are configured", async () => {
      const task = createReviewTask({ sub_state: SubStates.code });
      buildContext([task]);

      const sl = ctx.safetyLayer as unknown as {
        isCommentApprovalEnabled: ReturnType<typeof vi.fn>;
      };
      sl.isCommentApprovalEnabled.mockReturnValue(true);

      // Configure authorized people — the commenter is NOT in the list
      const pd = ctx.peopleDirectory as unknown as { getByRole: ReturnType<typeof vi.fn> };
      pd.getByRole.mockImplementation((role: string) => {
        if (role === "owner") {
          return [{ id: "farzam", contacts: [{ channel: "github", handle: "FarzamMohammadi" }] }];
        }
        return [];
      });

      hostingPlugin.getPRComments.mockResolvedValue([
        { id: "1", author: "random-user", body: "/approve", created_at: "2026-01-01" },
      ]);

      await handler.checkFeedback();
      await flush();

      const eb = ctx.eventBus as unknown as { publish: ReturnType<typeof vi.fn> };
      const feedbackCalls = eb.publish.mock.calls.filter(
        (c: unknown[]) => (c[0] as { type: string }).type === EventTypes["task.feedback_received"],
      );
      // Should be "comment" not "approved"
      if (feedbackCalls.length > 0) {
        const payload = (feedbackCalls[0]![0] as { payload: TaskFeedbackReceivedPayload }).payload;
        expect(payload.feedback_type).not.toBe("approved");
      }
    });

    it("formal changes_requested takes precedence over /approve comment", async () => {
      const task = createReviewTask({ sub_state: SubStates.code });
      buildContext([task]);

      const sl = ctx.safetyLayer as unknown as {
        isCommentApprovalEnabled: ReturnType<typeof vi.fn>;
      };
      sl.isCommentApprovalEnabled.mockReturnValue(true);

      hostingPlugin.getReviewStatus.mockResolvedValue({
        changes_requested: true,
        approved: false,
        reviewers: [{ username: "reviewer1", state: "changes_requested" }],
        comments: [],
      });
      hostingPlugin.getPRComments.mockResolvedValue([
        { id: "1", author: "FarzamMohammadi", body: "/approve", created_at: "2026-01-01" },
      ]);
      hostingPlugin.getPRStatus.mockResolvedValue({ state: "open", draft: false });

      await handler.checkFeedback();
      await flush();

      const eb = ctx.eventBus as unknown as { publish: ReturnType<typeof vi.fn> };
      const feedbackCalls = eb.publish.mock.calls.filter(
        (c: unknown[]) => (c[0] as { type: string }).type === EventTypes["task.feedback_received"],
      );
      expect(feedbackCalls.length).toBeGreaterThan(0);
      const payload = (feedbackCalls[0]![0] as { payload: TaskFeedbackReceivedPayload }).payload;
      expect(payload.feedback_type).toBe("changes_requested");
    });
  });

  // ── Thoughts Cleanup on Merge ─────────────────────────────────────────

  describe("thoughts cleanup on code approval", () => {
    it("calls removeThoughtsAndPush before merge when config enabled", async () => {
      const task = createReviewTask({
        sub_state: SubStates.code,
        workspace: { repo: "owner/repo", branch: "engineer/task-1", worktree_path: "/tmp/wt" },
        review: {
          pr_number: 42,
          pr_state: "ready",
          demo_artifacts: [],
          feedback_rounds: [],
          accommodated_comment_ids: [],
          accommodated_review_state: null,
        },
      });
      buildContext([task]);

      (
        ctx.safetyLayer as unknown as { checkAutoMergeAllowed: ReturnType<typeof vi.fn> }
      ).checkAutoMergeAllowed.mockReturnValue(true);
      const sl = ctx.safetyLayer as unknown as {
        shouldExcludeThoughtsOnMerge: ReturnType<typeof vi.fn>;
      };
      sl.shouldExcludeThoughtsOnMerge.mockReturnValue(true);
      hostingPlugin.getPRStatus.mockResolvedValue({
        state: "open",
        draft: false,
        mergeable: true,
        checks_state: "passing",
        number: 42,
        url: "https://github.com/owner/repo/pull/42",
      });
      hostingPlugin.mergePR.mockResolvedValue({ success: true });

      const payload: TaskFeedbackReceivedPayload = {
        task_id: "task-1",
        stage: "code",
        feedback_type: "approved",
        reviewer: "reviewer1",
        content: null,
        pr_number: 42,
      };
      handler.handleFeedbackEvent(payload);
      await flush();

      const wm = ctx.workspaceManager as unknown as {
        removeThoughtsAndPush: ReturnType<typeof vi.fn>;
      };
      expect(wm.removeThoughtsAndPush).toHaveBeenCalledWith("task-1");
    });

    it("does not call removeThoughtsAndPush when config disabled", async () => {
      const task = createReviewTask({
        sub_state: SubStates.code,
        review: {
          pr_number: 42,
          pr_state: "ready",
          demo_artifacts: [],
          feedback_rounds: [],
          accommodated_comment_ids: [],
          accommodated_review_state: null,
        },
      });
      buildContext([task]);

      (
        ctx.safetyLayer as unknown as { checkAutoMergeAllowed: ReturnType<typeof vi.fn> }
      ).checkAutoMergeAllowed.mockReturnValue(true);
      hostingPlugin.getPRStatus.mockResolvedValue({
        state: "open",
        draft: false,
        mergeable: true,
        checks_state: "passing",
        number: 42,
        url: "https://github.com/owner/repo/pull/42",
      });
      hostingPlugin.mergePR.mockResolvedValue({ success: true });

      const payload: TaskFeedbackReceivedPayload = {
        task_id: "task-1",
        stage: "code",
        feedback_type: "approved",
        reviewer: "reviewer1",
        content: null,
        pr_number: 42,
      };
      handler.handleFeedbackEvent(payload);
      await flush();

      const wm = ctx.workspaceManager as unknown as {
        removeThoughtsAndPush: ReturnType<typeof vi.fn>;
      };
      expect(wm.removeThoughtsAndPush).not.toHaveBeenCalled();
    });

    it("proceeds with merge even when removeThoughtsAndPush throws", async () => {
      const task = createReviewTask({
        sub_state: SubStates.code,
        workspace: { repo: "owner/repo", branch: "engineer/task-1", worktree_path: "/tmp/wt" },
        review: {
          pr_number: 42,
          pr_state: "ready",
          demo_artifacts: [],
          feedback_rounds: [],
          accommodated_comment_ids: [],
          accommodated_review_state: null,
        },
      });
      buildContext([task]);

      (
        ctx.safetyLayer as unknown as { checkAutoMergeAllowed: ReturnType<typeof vi.fn> }
      ).checkAutoMergeAllowed.mockReturnValue(true);
      const sl = ctx.safetyLayer as unknown as {
        shouldExcludeThoughtsOnMerge: ReturnType<typeof vi.fn>;
      };
      sl.shouldExcludeThoughtsOnMerge.mockReturnValue(true);
      hostingPlugin.getPRStatus.mockResolvedValue({
        state: "open",
        draft: false,
        mergeable: true,
        checks_state: "passing",
        number: 42,
        url: "https://github.com/owner/repo/pull/42",
      });
      hostingPlugin.mergePR.mockResolvedValue({ success: true });

      const wm = ctx.workspaceManager as unknown as {
        removeThoughtsAndPush: ReturnType<typeof vi.fn>;
      };
      wm.removeThoughtsAndPush.mockImplementation(() => {
        throw new Error("git rm failed");
      });

      const payload: TaskFeedbackReceivedPayload = {
        task_id: "task-1",
        stage: "code",
        feedback_type: "approved",
        reviewer: "reviewer1",
        content: null,
        pr_number: 42,
      };
      handler.handleFeedbackEvent(payload);
      await flush();

      // Task should still complete despite cleanup failure (merge still attempted)
      expect(hostingPlugin.mergePR).toHaveBeenCalled();
      const te = ctx.taskEngine as unknown as { requestTransition: ReturnType<typeof vi.fn> };
      expect(te.requestTransition).toHaveBeenCalledWith(
        "task-1",
        TaskStates.completed,
        null,
        "code_approved_merged",
        "daemon",
      );
    });
  });

  // ── Feedback Accommodation Tracking ──────────────────────────────────

  describe("feedback accommodation tracking", () => {
    it("suppresses re-trigger when same comments exist after rework", async () => {
      const task = createReviewTask({
        sub_state: SubStates.code,
        review: {
          pr_number: 42,
          pr_state: "ready",
          demo_artifacts: [],
          feedback_rounds: [],
          accommodated_comment_ids: ["comment-1"],
          accommodated_review_state: "comment",
        },
      });
      buildContext([task]);
      hostingPlugin.getPRStatus.mockResolvedValue({ state: "open", draft: false });
      hostingPlugin.getReviewStatus.mockResolvedValue({
        changes_requested: false,
        approved: false,
        reviewers: [],
        comments: [],
      });
      // Same comment ID that was already accommodated
      hostingPlugin.getPRComments.mockResolvedValue([
        { id: "comment-1", author: "alice", body: "Please fix this", created_at: "2026-01-01" },
      ]);

      await handler.checkFeedback();

      const eb = ctx.eventBus as unknown as { publish: ReturnType<typeof vi.fn> };
      const feedbackCalls = eb.publish.mock.calls.filter(
        (c: unknown[]) => (c[0] as { type: string }).type === EventTypes["task.feedback_received"],
      );
      // No feedback event — same comments, same state
      expect(feedbackCalls).toHaveLength(0);
    });

    it("triggers rework when new comment appears after accommodation", async () => {
      const task = createReviewTask({
        sub_state: SubStates.code,
        review: {
          pr_number: 42,
          pr_state: "ready",
          demo_artifacts: [],
          feedback_rounds: [],
          accommodated_comment_ids: ["comment-1"],
          accommodated_review_state: "comment",
        },
      });
      buildContext([task]);
      hostingPlugin.getPRStatus.mockResolvedValue({ state: "open", draft: false });
      hostingPlugin.getReviewStatus.mockResolvedValue({
        changes_requested: false,
        approved: false,
        reviewers: [],
        comments: [],
      });
      // Old comment + NEW comment
      hostingPlugin.getPRComments.mockResolvedValue([
        { id: "comment-1", author: "alice", body: "Please fix this", created_at: "2026-01-01" },
        { id: "comment-2", author: "alice", body: "Also fix that", created_at: "2026-01-02" },
      ]);

      await handler.checkFeedback();

      const eb = ctx.eventBus as unknown as { publish: ReturnType<typeof vi.fn> };
      const feedbackCalls = eb.publish.mock.calls.filter(
        (c: unknown[]) => (c[0] as { type: string }).type === EventTypes["task.feedback_received"],
      );
      // Should emit feedback — new comment ID detected
      expect(feedbackCalls).toHaveLength(1);
    });

    it("triggers rework when review state changes from accommodated state", async () => {
      const task = createReviewTask({
        sub_state: SubStates.code,
        review: {
          pr_number: 42,
          pr_state: "ready",
          demo_artifacts: [],
          feedback_rounds: [],
          accommodated_comment_ids: [],
          accommodated_review_state: "comment",
        },
      });
      buildContext([task]);
      hostingPlugin.getPRStatus.mockResolvedValue({ state: "open", draft: false });
      // State changed from "comment" to "changes_requested"
      hostingPlugin.getReviewStatus.mockResolvedValue({
        changes_requested: true,
        approved: false,
        reviewers: [{ state: "changes_requested", username: "alice" }],
        comments: [],
      });

      await handler.checkFeedback();

      const eb = ctx.eventBus as unknown as { publish: ReturnType<typeof vi.fn> };
      const feedbackCalls = eb.publish.mock.calls.filter(
        (c: unknown[]) => (c[0] as { type: string }).type === EventTypes["task.feedback_received"],
      );
      expect(feedbackCalls).toHaveLength(1);
      const payload = (feedbackCalls[0]![0] as { payload: TaskFeedbackReceivedPayload }).payload;
      expect(payload.feedback_type).toBe("changes_requested");
    });

    it("fresh task (no accommodated state) treats all feedback as new", async () => {
      const task = createReviewTask({ sub_state: SubStates.code });
      buildContext([task]);
      hostingPlugin.getPRStatus.mockResolvedValue({ state: "open", draft: false });
      hostingPlugin.getReviewStatus.mockResolvedValue({
        changes_requested: false,
        approved: false,
        reviewers: [],
        comments: [],
      });
      hostingPlugin.getPRComments.mockResolvedValue([
        { id: "comment-1", author: "alice", body: "Feedback here", created_at: "2026-01-01" },
      ]);

      await handler.checkFeedback();

      const eb = ctx.eventBus as unknown as { publish: ReturnType<typeof vi.fn> };
      const feedbackCalls = eb.publish.mock.calls.filter(
        (c: unknown[]) => (c[0] as { type: string }).type === EventTypes["task.feedback_received"],
      );
      // Fresh task — all comments are new
      expect(feedbackCalls).toHaveLength(1);
    });

    it("updates accommodated state when new feedback is detected", async () => {
      const task = createReviewTask({ sub_state: SubStates.code });
      buildContext([task]);
      hostingPlugin.getPRStatus.mockResolvedValue({ state: "open", draft: false });
      hostingPlugin.getReviewStatus.mockResolvedValue({
        changes_requested: true,
        approved: false,
        reviewers: [{ state: "changes_requested", username: "alice" }],
        comments: [],
      });
      hostingPlugin.getPRComments.mockResolvedValue([
        { id: "c-1", author: "alice", body: "Fix it", created_at: "2026-01-01" },
      ]);

      await handler.checkFeedback();

      const te = ctx.taskEngine as unknown as {
        updateTaskField: ReturnType<typeof vi.fn>;
      };
      // Should have updated accommodated state
      const reviewUpdates = te.updateTaskField.mock.calls.filter(
        (c: unknown[]) => c[1] === "review",
      );
      const lastUpdate = reviewUpdates[reviewUpdates.length - 1]![2] as {
        accommodated_comment_ids: string[];
        accommodated_review_state: string;
      };
      expect(lastUpdate.accommodated_comment_ids).toEqual(["c-1"]);
      expect(lastUpdate.accommodated_review_state).toBe("changes_requested");
    });
  });
});

// ── evaluatePostApprovalChecks (pure function) ─────────────────────────────

describe("evaluatePostApprovalChecks", () => {
  it("returns [] for passing + mergeable", () => {
    expect(evaluatePostApprovalChecks("passing", true)).toEqual([]);
  });

  it('returns ["merge_conflict"] for passing + not mergeable', () => {
    expect(evaluatePostApprovalChecks("passing", false)).toEqual(["merge_conflict"]);
  });

  it('returns ["ci_failure"] for failing + mergeable', () => {
    expect(evaluatePostApprovalChecks("failing", true)).toEqual(["ci_failure"]);
  });

  it('returns ["ci_failure", "merge_conflict"] for failing + not mergeable', () => {
    expect(evaluatePostApprovalChecks("failing", false)).toEqual(["ci_failure", "merge_conflict"]);
  });

  it("returns [] for none + mergeable", () => {
    expect(evaluatePostApprovalChecks("none", true)).toEqual([]);
  });

  it('returns ["merge_conflict"] for none + not mergeable', () => {
    expect(evaluatePostApprovalChecks("none", false)).toEqual(["merge_conflict"]);
  });

  it("returns [] for pending + mergeable", () => {
    expect(evaluatePostApprovalChecks("pending", true)).toEqual([]);
  });

  it('returns ["merge_conflict"] for pending + not mergeable', () => {
    expect(evaluatePostApprovalChecks("pending", false)).toEqual(["merge_conflict"]);
  });
});
