import { describe, expect, it, vi } from "vitest";
import { createTestObserverFacade } from "../../../test/helpers/test-observer-facade.js";
import type { DaemonConfig } from "../../schemas/config.js";
import type { TaskStateChangedPayload } from "../../schemas/events.js";
import { createNotificationRouter } from "./notification-router.js";
import type { NotificationRouterContext } from "./types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function createMockCommPlugin(overrides?: { id?: string; capabilities?: string[] }) {
  const capabilities = overrides?.capabilities ?? ["send"];
  return {
    manifest: { id: overrides?.id ?? "comm-1" },
    hasCapability: vi.fn((cap: string) => capabilities.includes(cap)),
    formatMessage: vi.fn((content: string) => `[formatted] ${content}`),
    sendMessage: vi.fn().mockResolvedValue({ success: true }),
    commentOnIssue: vi.fn().mockResolvedValue({ success: true }),
    syncTaskState: vi.fn().mockResolvedValue(undefined),
  };
}

function makeDaemonConfig(): DaemonConfig {
  return {
    max_concurrent: 1,
    tick_interval_ms: 5_000,
    preemption_threshold: 20,
    preemption_timeout_ms: 60_000,
    stuck_threshold_ms: 1_800_000,
    max_active_duration_ms: 28_800_000,
    aging_threshold_ms: 86_400_000,
    aging_increment: 5,
    aging_interval_ms: 86_400_000,
    aging_cap: 75,
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
        events: { max_age_days: 90, max_count: null },
        observations: { max_age_days: 90, max_count: null },
        journal_entries: { max_age_days: 90, max_count: null },
        checkpoints: { max_age_days: 90, max_count: null },
      },
      vacuum_on_cleanup: true,
    },
    database: { cache_size_mb: 64 },
  };
}

function createMockContext(pluginOverrides?: ReturnType<typeof createMockCommPlugin>[]) {
  const commPlugins = pluginOverrides ?? [];
  return {
    config: makeDaemonConfig(),
    eventBus: {} as NotificationRouterContext["eventBus"],
    registry: {
      getPluginsByType: vi.fn().mockReturnValue(commPlugins),
    } as unknown as NotificationRouterContext["registry"],
    taskEngine: {
      getTask: vi.fn().mockReturnValue(null),
    } as unknown as NotificationRouterContext["taskEngine"],
    peopleDirectory: {
      getOwner: vi.fn().mockReturnValue(null),
      getReviewers: vi.fn().mockReturnValue([]),
    } as unknown as NotificationRouterContext["peopleDirectory"],
    clock: { now: () => Date.now() },
    observer: createTestObserverFacade("daemon"),
  } as unknown as NotificationRouterContext;
}

/** Flush microtask queue so fire-and-forget promises resolve. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("NotificationRouter", () => {
  // 1. sendCompletion sends milestone to owner via comm plugins
  it("sendCompletion sends milestone notification to owner via comm plugins", async () => {
    const commPlugin = createMockCommPlugin();
    const ctx = createMockContext([commPlugin]);
    (ctx.peopleDirectory.getOwner as ReturnType<typeof vi.fn>).mockReturnValue({ id: "farzam" });

    (ctx.taskEngine.getTask as ReturnType<typeof vi.fn>).mockReturnValue({ title: "Fix the bug" });

    const router = createNotificationRouter(ctx);
    router.sendCompletion("task-001");
    await flush();

    expect(commPlugin.formatMessage).toHaveBeenCalledWith(
      'Task "Fix the bug" completed successfully.',
      "milestone",
    );
    expect(commPlugin.sendMessage).toHaveBeenCalledWith(
      { user_id: "farzam", channel: null },
      expect.objectContaining({
        content: expect.stringContaining("completed successfully"),
        metadata: { task_id: "task-001", type: "milestone" },
      }),
    );
  });

  // 2. sendTaskError sends alert to owner
  it("sendTaskError sends alert notification to owner with reason", async () => {
    const commPlugin = createMockCommPlugin();
    const ctx = createMockContext([commPlugin]);
    (ctx.peopleDirectory.getOwner as ReturnType<typeof vi.fn>).mockReturnValue({ id: "owner-1" });

    (ctx.taskEngine.getTask as ReturnType<typeof vi.fn>).mockReturnValue({
      title: "Deploy service",
    });

    const router = createNotificationRouter(ctx);
    router.sendTaskError("task-002", "build_failed");
    await flush();

    expect(commPlugin.formatMessage).toHaveBeenCalledWith(
      expect.stringContaining("build_failed"),
      "alert",
    );
    expect(commPlugin.sendMessage).toHaveBeenCalledWith(
      { user_id: "owner-1", channel: null },
      expect.objectContaining({
        metadata: { task_id: "task-002", type: "alert" },
      }),
    );
  });

  // 3. sendEscalationAlert sends to owner AND reviewers
  it("sendEscalationAlert sends to both owner and reviewers", async () => {
    const commPlugin = createMockCommPlugin();
    const ctx = createMockContext([commPlugin]);
    (ctx.peopleDirectory.getOwner as ReturnType<typeof vi.fn>).mockReturnValue({ id: "owner-1" });
    (ctx.peopleDirectory.getReviewers as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: "reviewer-1" },
      { id: "reviewer-2" },
    ]);

    const router = createNotificationRouter(ctx);
    (ctx.taskEngine.getTask as ReturnType<typeof vi.fn>).mockReturnValue({ title: "Critical fix" });

    router.sendEscalationAlert("task-003");
    await flush();

    // Should send to owner + 2 reviewers = 3 sends
    expect(commPlugin.sendMessage).toHaveBeenCalledTimes(3);

    const recipientIds = commPlugin.sendMessage.mock.calls.map(
      (call: unknown[]) => (call[0] as { user_id: string }).user_id,
    );
    expect(recipientIds).toContain("owner-1");
    expect(recipientIds).toContain("reviewer-1");
    expect(recipientIds).toContain("reviewer-2");
  });

  // 4. sendReviewReminder sends to reviewers only
  it("sendReviewReminder sends to reviewers only, not owner", async () => {
    const commPlugin = createMockCommPlugin();
    const ctx = createMockContext([commPlugin]);
    (ctx.peopleDirectory.getOwner as ReturnType<typeof vi.fn>).mockReturnValue({ id: "owner-1" });
    (ctx.peopleDirectory.getReviewers as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: "reviewer-1" },
    ]);

    const router = createNotificationRouter(ctx);
    (ctx.taskEngine.getTask as ReturnType<typeof vi.fn>).mockReturnValue({ title: "Add tests" });

    router.sendReviewReminder("task-004", 7_200_000); // 2 hours
    await flush();

    expect(commPlugin.sendMessage).toHaveBeenCalledTimes(1);
    expect(commPlugin.sendMessage).toHaveBeenCalledWith(
      { user_id: "reviewer-1", channel: null },
      expect.objectContaining({
        content: expect.stringContaining("2h"),
      }),
    );
    // Verify owner was not called
    const recipientIds = commPlugin.sendMessage.mock.calls.map(
      (call: unknown[]) => (call[0] as { user_id: string }).user_id,
    );
    expect(recipientIds).not.toContain("owner-1");
  });

  // 5. Skips when no owner/reviewers configured
  it("skips notification when no owner is configured", async () => {
    const commPlugin = createMockCommPlugin();
    const ctx = createMockContext([commPlugin]);
    // getOwner returns null by default

    const router = createNotificationRouter(ctx);
    router.sendCompletion("task-005");
    await flush();

    expect(commPlugin.sendMessage).not.toHaveBeenCalled();
  });

  it("skips review reminder when no reviewers configured", async () => {
    const commPlugin = createMockCommPlugin();
    const ctx = createMockContext([commPlugin]);
    // getReviewers returns [] by default

    const router = createNotificationRouter(ctx);
    router.sendReviewReminder("task-006", 3_600_000);
    await flush();

    expect(commPlugin.sendMessage).not.toHaveBeenCalled();
  });

  // 6. Skips plugins without "send" capability
  it("skips comm plugins that lack send capability", async () => {
    const noSendPlugin = createMockCommPlugin({ id: "no-send", capabilities: ["sync"] });
    const sendPlugin = createMockCommPlugin({ id: "with-send", capabilities: ["send"] });
    const ctx = createMockContext([noSendPlugin, sendPlugin]);
    (ctx.peopleDirectory.getOwner as ReturnType<typeof vi.fn>).mockReturnValue({ id: "owner-1" });

    const router = createNotificationRouter(ctx);
    (ctx.taskEngine.getTask as ReturnType<typeof vi.fn>).mockReturnValue({ title: "A task" });

    router.sendCompletion("task-007");
    await flush();

    expect(noSendPlugin.sendMessage).not.toHaveBeenCalled();
    expect(sendPlugin.sendMessage).toHaveBeenCalledTimes(1);
  });

  // 7. commentOnTaskIssue routes to plugin with issue_management capability
  it("commentOnTaskIssue routes to plugin with issue_management capability", async () => {
    const sendOnlyPlugin = createMockCommPlugin({ id: "telegram", capabilities: ["send"] });
    const issuePlugin = createMockCommPlugin({
      id: "github",
      capabilities: ["send", "issue_management"],
    });
    const ctx = createMockContext([sendOnlyPlugin, issuePlugin]);
    (ctx.taskEngine.getTask as ReturnType<typeof vi.fn>).mockReturnValue({
      external_ref: { type: "github_issue", repo: "acme/widgets", number: 42 },
    });

    const router = createNotificationRouter(ctx);
    router.commentOnTaskIssue("task-008", "PR merged!");
    await flush();

    expect(issuePlugin.commentOnIssue).toHaveBeenCalledWith("acme/widgets", 42, "PR merged!");
    expect(sendOnlyPlugin.commentOnIssue).not.toHaveBeenCalled();
  });

  // 8. commentOnTaskIssue skips when no external_ref
  it("commentOnTaskIssue skips when task has no external_ref", async () => {
    const commPlugin = createMockCommPlugin({ capabilities: ["send", "issue_management"] });
    const ctx = createMockContext([commPlugin]);
    (ctx.taskEngine.getTask as ReturnType<typeof vi.fn>).mockReturnValue({
      external_ref: null,
    });

    const router = createNotificationRouter(ctx);
    router.commentOnTaskIssue("task-009", "Hello");
    await flush();

    expect(commPlugin.commentOnIssue).not.toHaveBeenCalled();
  });

  // 9. syncStateToCommPlugin routes to plugins with sync capability
  it("syncStateToCommPlugin routes to plugins with sync capability", async () => {
    const syncPlugin = createMockCommPlugin({ id: "sync-comm", capabilities: ["sync"] });
    const noSyncPlugin = createMockCommPlugin({ id: "no-sync", capabilities: ["send"] });
    const ctx = createMockContext([syncPlugin, noSyncPlugin]);
    (ctx.taskEngine.getTask as ReturnType<typeof vi.fn>).mockReturnValue({
      title: "My task",
      external_ref: { type: "github_issue", repo: "owner/repo", number: 10 },
    });

    const payload: TaskStateChangedPayload = {
      task_id: "task-010",
      from_state: "active",
      from_sub: "working",
      to_state: "completed",
      to_sub: null,
      reason: "All done",
      triggered_by: "orchestrator",
    };

    const router = createNotificationRouter(ctx);
    router.syncStateToCommPlugin(payload);
    await flush();

    expect(syncPlugin.syncTaskState).toHaveBeenCalledWith(
      "task-010",
      "active",
      "completed",
      expect.objectContaining({
        task_title: "My task",
        external_ref: "https://github.com/owner/repo/issues/10",
        sub_state: null,
        reason: "All done",
      }),
    );
    expect(noSyncPlugin.syncTaskState).not.toHaveBeenCalled();
  });

  // 10. Fire-and-forget failures don't throw
  it("sendMessage failure does not throw from sendCompletion", async () => {
    const commPlugin = createMockCommPlugin();
    commPlugin.sendMessage.mockRejectedValue(new Error("Network error"));
    const ctx = createMockContext([commPlugin]);
    (ctx.peopleDirectory.getOwner as ReturnType<typeof vi.fn>).mockReturnValue({ id: "owner-1" });

    const router = createNotificationRouter(ctx);

    // Should not throw
    expect(() => router.sendCompletion("task-011")).not.toThrow();
    await flush();
  });

  it("commentOnIssue failure does not throw from commentOnTaskIssue", async () => {
    const commPlugin = createMockCommPlugin({ capabilities: ["send", "issue_management"] });
    commPlugin.commentOnIssue.mockRejectedValue(new Error("GitHub API down"));
    const ctx = createMockContext([commPlugin]);
    (ctx.taskEngine.getTask as ReturnType<typeof vi.fn>).mockReturnValue({
      external_ref: { type: "github_issue", repo: "owner/repo", number: 1 },
    });

    const router = createNotificationRouter(ctx);

    expect(() => router.commentOnTaskIssue("task-012", "Comment")).not.toThrow();
    await flush();
  });

  it("syncTaskState failure does not throw from syncStateToCommPlugin", async () => {
    const commPlugin = createMockCommPlugin({ capabilities: ["sync"] });
    commPlugin.syncTaskState.mockRejectedValue(new Error("Sync failed"));
    const ctx = createMockContext([commPlugin]);
    (ctx.taskEngine.getTask as ReturnType<typeof vi.fn>).mockReturnValue({
      title: "T",
      external_ref: null,
    });

    const payload: TaskStateChangedPayload = {
      task_id: "task-013",
      from_state: "queued",
      from_sub: null,
      to_state: "active",
      to_sub: "working",
      reason: "dispatched",
      triggered_by: "daemon",
    };

    const router = createNotificationRouter(ctx);

    expect(() => router.syncStateToCommPlugin(payload)).not.toThrow();
    await flush();
  });

  // Additional coverage: sendCostLimit and sendBlockedReminder
  it("sendCostLimit sends alert with cost limit message", async () => {
    const commPlugin = createMockCommPlugin();
    const ctx = createMockContext([commPlugin]);
    (ctx.peopleDirectory.getOwner as ReturnType<typeof vi.fn>).mockReturnValue({ id: "owner-1" });

    const router = createNotificationRouter(ctx);
    (ctx.taskEngine.getTask as ReturnType<typeof vi.fn>).mockReturnValue({
      title: "Expensive task",
    });

    router.sendCostLimit("task-014");
    await flush();

    expect(commPlugin.formatMessage).toHaveBeenCalledWith(
      expect.stringContaining("cost limit"),
      "alert",
    );
    expect(commPlugin.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("commentOnTaskIssue skips when task is not found", async () => {
    const commPlugin = createMockCommPlugin({ capabilities: ["send", "issue_management"] });
    const ctx = createMockContext([commPlugin]);
    // getTask returns null by default

    const router = createNotificationRouter(ctx);
    router.commentOnTaskIssue("nonexistent-task", "Hello");
    await flush();

    expect(commPlugin.commentOnIssue).not.toHaveBeenCalled();
  });

  // SECURITY: sendTaskError strips auth tokens from reason before external delivery
  it("sendTaskError sanitizes token-bearing reason before sending to Telegram/GitHub", async () => {
    const commPlugin = createMockCommPlugin();
    const ctx = createMockContext([commPlugin]);
    (ctx.peopleDirectory.getOwner as ReturnType<typeof vi.fn>).mockReturnValue({ id: "owner-1" });

    const router = createNotificationRouter(ctx);
    const poisonedReason =
      "push failed: https://git:ghp_SECRETTOKEN1234567890abcdefgh@github.com/org/repo.git";
    (ctx.taskEngine.getTask as ReturnType<typeof vi.fn>).mockReturnValue({
      title: "Deploy service",
    });

    router.sendTaskError("task-sec", poisonedReason);
    await flush();

    const formattedArg = (commPlugin.formatMessage as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as string;
    expect(formattedArg).not.toContain("ghp_SECRETTOKEN1234567890abcdefgh");
    expect(formattedArg).not.toContain("https://git:ghp_");
  });

  // SECURITY: syncStateToCommPlugin sanitizes task title before sending to comm plugins
  it("syncStateToCommPlugin sanitizes task title containing secrets", async () => {
    const syncPlugin = createMockCommPlugin({ id: "sync-comm", capabilities: ["sync"] });
    const ctx = createMockContext([syncPlugin]);
    (ctx.taskEngine.getTask as ReturnType<typeof vi.fn>).mockReturnValue({
      title: "Fix ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA leak in auth",
      external_ref: null,
    });

    const payload: TaskStateChangedPayload = {
      task_id: "task-sec",
      from_state: "active",
      from_sub: "working",
      to_state: "completed",
      to_sub: null,
      reason: "done",
      triggered_by: "daemon",
    };

    const router = createNotificationRouter(ctx);
    router.syncStateToCommPlugin(payload);
    await flush();

    const syncArgs = (syncPlugin.syncTaskState as ReturnType<typeof vi.fn>).mock.calls[0]?.[3] as {
      task_title: string;
    };
    expect(syncArgs.task_title).not.toContain("ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    expect(syncArgs.task_title).toContain("[REDACTED:github_token]");
  });

  // SECURITY: commentOnTaskIssue strips auth tokens from message before posting to GitHub
  it("commentOnTaskIssue sanitizes token-bearing message before posting to GitHub", async () => {
    const commPlugin = createMockCommPlugin({ capabilities: ["send", "issue_management"] });
    const ctx = createMockContext([commPlugin]);
    (ctx.taskEngine.getTask as ReturnType<typeof vi.fn>).mockReturnValue({
      external_ref: { type: "github_issue", repo: "org/repo", number: 42 },
    });

    const router = createNotificationRouter(ctx);
    const poisonedMessage =
      "Error: clone failed at https://git:ghp_SECRETTOKEN1234567890abcdefgh@github.com/org/repo.git";
    router.commentOnTaskIssue("task-sec", poisonedMessage);
    await flush();

    const commentArg = (commPlugin.commentOnIssue as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[2] as string;
    expect(commentArg).not.toContain("ghp_SECRETTOKEN1234567890abcdefgh");
    expect(commentArg).not.toContain("https://git:ghp_");
  });
});
