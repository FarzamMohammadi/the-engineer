import { describe, expect, it, vi } from "vitest";
import { createTestObserverFacade } from "../../../test/helpers/test-observer-facade.js";
import type { DaemonConfig } from "../../schemas/config.js";
import type { TaskFeedbackReceivedPayload } from "../../schemas/events.js";
import type { NotificationRouter } from "./notification-router.js";
import {
  type ReviewHandler,
  type ReviewHandlerCallbacks,
  createReviewHandler,
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
    state: "review_pending",
    sub_state: "demo",
    repo: "owner/repo",
    external_ref: "issue:1",
    workspace: "/tmp/ws/task-1",
    review: {
      pr_number: 42,
      pr_state: "draft",
      demo_artifacts: [],
      feedback_rounds: [],
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
        if (state === "review_pending") {
          return tasks;
        }
        return [];
      }),
      getTask: vi.fn().mockImplementation((id: string) => taskMap.get(id) ?? null),
      requestTransition: vi.fn().mockReturnValue({ success: true }),
      updateTaskField: vi.fn(),
    } as unknown as ReviewHandlerContext["taskEngine"],
    safetyLayer: {
      checkAutoMergeAllowed: vi.fn().mockReturnValue(false),
      flushCostSnapshot: vi.fn(),
    } as unknown as ReviewHandlerContext["safetyLayer"],
    workspaceManager: {
      cleanupWorkspace: vi.fn(),
    } as unknown as ReviewHandlerContext["workspaceManager"],
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
      // Demo sub_state means it transitions demo->code first, then to completed
      expect(te.requestTransition).toHaveBeenCalledWith(
        "task-1",
        "review_pending",
        "code",
        "pr_merged",
        "daemon",
      );
      expect(te.requestTransition).toHaveBeenCalledWith(
        "task-1",
        "completed",
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
        expect.objectContaining({ kind: "completion", taskId: "task-1" }),
      );
      expect(notifications.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "ticket_comment",
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
      const task = createReviewTask({ sub_state: "code" });
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
        (c: unknown[]) => (c[0] as { type: string }).type === "task.feedback_received",
      );
      expect(feedbackCall).toBeDefined();
      const payload = (feedbackCall?.[0] as { payload: TaskFeedbackReceivedPayload }).payload;
      expect(payload.feedback_type).toBe("changes_requested");
      expect(payload.reviewer).toBe("alice");
      expect(payload.pr_number).toBe(42);
    });

    it("detects approval and emits feedback event", async () => {
      const task = createReviewTask({ sub_state: "code" });
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
        (c: unknown[]) => (c[0] as { type: string }).type === "task.feedback_received",
      );
      expect(feedbackCall).toBeDefined();
      const payload = (feedbackCall?.[0] as { payload: TaskFeedbackReceivedPayload }).payload;
      expect(payload.feedback_type).toBe("approved");
      expect(payload.reviewer).toBe("bob");
    });

    it("deduplicates identical review states", async () => {
      const task = createReviewTask({ sub_state: "code" });
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
        (c: unknown[]) => (c[0] as { type: string }).type === "task.feedback_received",
      );
      // Only one feedback event despite two polls
      expect(feedbackCalls).toHaveLength(1);
    });

    it("emits new event when review state changes", async () => {
      const task = createReviewTask({ sub_state: "code" });
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
        (c: unknown[]) => (c[0] as { type: string }).type === "task.feedback_received",
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
      const task = createReviewTask({ sub_state: "code" });
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
      const task = createReviewTask({ sub_state: "code" });
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
        (c: unknown[]) => (c[0] as { type: string }).type === "task.feedback_received",
      );
      expect(feedbackCall).toBeDefined();
      const payload = (feedbackCall?.[0] as { payload: TaskFeedbackReceivedPayload }).payload;
      expect(payload.content).not.toContain("ghp_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB");
      expect(payload.content).toContain("[REDACTED:github_token]");
    });

    it("resumes polling after failure window expires", async () => {
      const task = createReviewTask({ sub_state: "code" });
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
      const task = createReviewTask({ sub_state: "code" });
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
      const task = createReviewTask({ sub_state: "code" });
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
        "queued",
        null,
        "feedback_rework:changes_requested",
        "daemon",
      );
      expect(notifications.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "ticket_comment",
          taskId: "task-1",
          message: "Reviewer feedback received (changes_requested) — reworking.",
        }),
      );
    });

    it("on approved/demo: marks PR ready and transitions demo->code", async () => {
      const task = createReviewTask({ sub_state: "demo" });
      buildContext([task]);
      hostingPlugin.updatePR.mockResolvedValue(undefined);

      handler.handleFeedbackEvent({
        task_id: "task-1",
        stage: "demo",
        feedback_type: "approved",
        reviewer: "bob",
        content: null,
        pr_number: 42,
      });

      // updatePR is async fire-and-forget, flush microtasks
      await flush();

      expect(hostingPlugin.updatePR).toHaveBeenCalledWith("owner/repo", 42, {
        title: null,
        body: null,
        draft: false,
        labels_add: null,
        labels_remove: null,
      });

      const te = ctx.taskEngine as unknown as {
        requestTransition: ReturnType<typeof vi.fn>;
        updateTaskField: ReturnType<typeof vi.fn>;
      };
      expect(te.requestTransition).toHaveBeenCalledWith(
        "task-1",
        "review_pending",
        "code",
        "demo_approved",
        "daemon",
      );
      // PR state updated to "ready"
      expect(te.updateTaskField).toHaveBeenCalledWith(
        "task-1",
        "review",
        expect.objectContaining({ pr_state: "ready" }),
      );
    });

    it("on approved/code without auto-merge: transitions to completed with cleanup", () => {
      const task = createReviewTask({ sub_state: "code" });
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

      const te = ctx.taskEngine as unknown as {
        requestTransition: ReturnType<typeof vi.fn>;
      };
      expect(te.requestTransition).toHaveBeenCalledWith(
        "task-1",
        "completed",
        null,
        "code_approved",
        "daemon",
      );
      expect(notifications.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "ticket_comment",
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
        expect.objectContaining({ kind: "completion", taskId: "task-1" }),
      );
      expect(callbacks.onTaskCompletionFinalized).toHaveBeenCalledWith("task-1");
    });

    it("on approved/code with auto-merge: merges PR and completes with cleanup", async () => {
      const task = createReviewTask({ sub_state: "code" });
      buildContext([task]);
      (
        ctx.safetyLayer as unknown as { checkAutoMergeAllowed: ReturnType<typeof vi.fn> }
      ).checkAutoMergeAllowed.mockReturnValue(true);
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
        "completed",
        null,
        "code_approved_merged",
        "daemon",
      );
      expect(te.updateTaskField).toHaveBeenCalledWith(
        "task-1",
        "review",
        expect.objectContaining({ pr_state: "merged" }),
      );
      // Completion cleanup: workspace, notification, child-done check
      const ws = ctx.workspaceManager as unknown as {
        cleanupWorkspace: ReturnType<typeof vi.fn>;
      };
      expect(ws.cleanupWorkspace).toHaveBeenCalledWith("task-1", true);
      expect(notifications.notify).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "completion", taskId: "task-1" }),
      );
      expect(callbacks.onTaskCompletionFinalized).toHaveBeenCalledWith("task-1");
    });

    it("on approved/code with auto-merge failure: completes with cleanup", async () => {
      const task = createReviewTask({ sub_state: "code" });
      buildContext([task]);
      (
        ctx.safetyLayer as unknown as { checkAutoMergeAllowed: ReturnType<typeof vi.fn> }
      ).checkAutoMergeAllowed.mockReturnValue(true);
      hostingPlugin.mergePR.mockRejectedValue(new Error("merge conflict"));

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
        "completed",
        null,
        "code_approved",
        "daemon",
      );
      expect(notifications.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "ticket_comment",
          taskId: "task-1",
          message: "Code approved — auto-merge failed, please merge manually.",
        }),
      );
      // Completion cleanup still runs even on merge failure
      const ws = ctx.workspaceManager as unknown as {
        cleanupWorkspace: ReturnType<typeof vi.fn>;
      };
      expect(ws.cleanupWorkspace).toHaveBeenCalledWith("task-1", true);
      expect(notifications.notify).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "completion", taskId: "task-1" }),
      );
      expect(callbacks.onTaskCompletionFinalized).toHaveBeenCalledWith("task-1");
    });

    it("ignores feedback for non-review_pending tasks", () => {
      const task = createReviewTask({ state: "active", sub_state: null });
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
      const task = createReviewTask({ sub_state: "code" });
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
      const task = createReviewTask({ sub_state: "code" });
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
});
