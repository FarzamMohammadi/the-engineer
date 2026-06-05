import { afterEach, describe, expect, it, vi } from "vitest";
import { createNotificationRouter } from "../../../../src/core/daemon/notification-router.js";
import type { NotificationRouterContext } from "../../../../src/core/daemon/notification-router.js";
import { Observer, createSilentLogger } from "../../../../src/core/observer/index.js";
import { EventTypes, type TaskStateChangedPayload } from "../../../../src/schemas/events.js";
import { NotificationKinds } from "../../../../src/schemas/notifications.js";
import { SubStates, TaskStates } from "../../../../src/schemas/task.js";
import { FakeClock } from "../../../helpers/fake-clock.js";
import { createTestObserverFacade } from "../../../helpers/test-observer-facade.js";
import { type TestObserverHandle, createTestObserver } from "../../../helpers/test-observer.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function createMockCommPlugin(overrides?: {
  id?: string;
  capabilities?: string[];
  channel?: string;
}) {
  const capabilities = overrides?.capabilities ?? ["send"];
  const channel = overrides?.channel ?? "telegram";
  return {
    manifest: {
      id: overrides?.id ?? "comm-1",
      adapter_meta: { channel },
    },
    hasCapability: vi.fn((cap: string) => capabilities.includes(cap)),
    formatMessage: vi.fn((content: string) => `[formatted] ${content}`),
    sendMessage: vi.fn().mockResolvedValue({ success: true }),
    commentOnTicket: vi.fn().mockResolvedValue({ success: true }),
    syncTaskState: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockContext(pluginOverrides?: ReturnType<typeof createMockCommPlugin>[]) {
  const commPlugins = pluginOverrides ?? [];
  return {
    registry: {
      getPluginsByType: vi.fn().mockReturnValue(commPlugins),
    } as unknown as NotificationRouterContext["registry"],
    taskEngine: {
      getTask: vi.fn().mockReturnValue(null),
    } as unknown as NotificationRouterContext["taskEngine"],
    peopleDirectory: {
      getOwner: vi.fn().mockReturnValue(null),
      getReviewers: vi.fn().mockReturnValue([]),
      getPerson: vi.fn().mockReturnValue(null),
    } as unknown as NotificationRouterContext["peopleDirectory"],
    eventBus: {
      publish: vi.fn(),
    } as unknown as NotificationRouterContext["eventBus"],
    observer: createTestObserverFacade("daemon"),
    config: {
      notification_retry: { interval_ms: 100, max_attempts: 3, max_age_ms: 10_000 },
      notification_suppress_window_ms: 300_000,
    },
    clock: { now: vi.fn().mockReturnValue(1_000_000) },
  } as unknown as NotificationRouterContext;
}

/** Flush microtask queue so fire-and-forget promises resolve. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("NotificationRouter", () => {
  // 1. notify({ kind: NotificationKinds.completion }) sends milestone notification to owner via comm plugins
  it("notify completion sends milestone notification to owner via comm plugins", async () => {
    const commPlugin = createMockCommPlugin({ channel: "telegram" });
    const ctx = createMockContext([commPlugin]);
    (ctx.peopleDirectory.getOwner as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "farzam",
      contacts: [{ channel: "telegram", handle: "@farzam" }],
    });

    (ctx.taskEngine.getTask as ReturnType<typeof vi.fn>).mockReturnValue({ title: "Fix the bug" });

    const router = createNotificationRouter(ctx);
    router.notify({ kind: NotificationKinds.completion, taskId: "task-001" });
    await flush();

    expect(commPlugin.formatMessage).toHaveBeenCalledWith('Task "Fix the bug" completed successfully.', "milestone");
    expect(commPlugin.sendMessage).toHaveBeenCalledWith(
      { user_id: "@farzam", channel: "telegram" },
      expect.objectContaining({
        content: expect.stringContaining("completed successfully"),
        metadata: { task_id: "task-001", type: "milestone" },
      }),
    );
  });

  // 2. notify({ kind: NotificationKinds.task_error }) sends alert to owner with reason
  it("notify task_error sends alert notification to owner with reason", async () => {
    const commPlugin = createMockCommPlugin({ channel: "telegram" });
    const ctx = createMockContext([commPlugin]);
    (ctx.peopleDirectory.getOwner as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "owner-1",
      contacts: [{ channel: "telegram", handle: "@owner" }],
    });

    (ctx.taskEngine.getTask as ReturnType<typeof vi.fn>).mockReturnValue({
      title: "Deploy service",
    });

    const router = createNotificationRouter(ctx);
    router.notify({
      kind: NotificationKinds.task_error,
      taskId: "task-002",
      reason: "build_failed",
    });
    await flush();

    expect(commPlugin.formatMessage).toHaveBeenCalledWith(expect.stringContaining("build_failed"), "alert");
    expect(commPlugin.sendMessage).toHaveBeenCalledWith(
      { user_id: "@owner", channel: "telegram" },
      expect.objectContaining({
        metadata: { task_id: "task-002", type: "alert" },
      }),
    );
  });

  // 3. notify({ kind: NotificationKinds.escalation_alert }) sends to owner AND reviewers
  it("notify escalation_alert sends to both owner and reviewers", async () => {
    const commPlugin = createMockCommPlugin({ channel: "telegram" });
    const ctx = createMockContext([commPlugin]);
    (ctx.peopleDirectory.getOwner as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "owner-1",
      contacts: [{ channel: "telegram", handle: "@owner" }],
    });
    (ctx.peopleDirectory.getReviewers as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: "reviewer-1", contacts: [{ channel: "telegram", handle: "@rev1" }] },
      { id: "reviewer-2", contacts: [{ channel: "telegram", handle: "@rev2" }] },
    ]);

    const router = createNotificationRouter(ctx);
    (ctx.taskEngine.getTask as ReturnType<typeof vi.fn>).mockReturnValue({ title: "Critical fix" });

    router.notify({ kind: NotificationKinds.escalation_alert, taskId: "task-003" });
    await flush();

    // Should send to owner + 2 reviewers = 3 sends
    expect(commPlugin.sendMessage).toHaveBeenCalledTimes(3);

    const recipientHandles = commPlugin.sendMessage.mock.calls.map(
      (call: unknown[]) => (call[0] as { user_id: string }).user_id,
    );
    expect(recipientHandles).toContain("@owner");
    expect(recipientHandles).toContain("@rev1");
    expect(recipientHandles).toContain("@rev2");
  });

  // 4. notify({ kind: NotificationKinds.review_reminder }) resolves to the owner (single-user)
  it("notify review_reminder resolves to the owner", async () => {
    const commPlugin = createMockCommPlugin({ channel: "telegram" });
    const ctx = createMockContext([commPlugin]);
    (ctx.peopleDirectory.getOwner as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "owner-1",
      contacts: [{ channel: "telegram", handle: "@owner" }],
    });

    const router = createNotificationRouter(ctx);
    (ctx.taskEngine.getTask as ReturnType<typeof vi.fn>).mockReturnValue({ title: "Add tests" });

    router.notify({
      kind: NotificationKinds.review_reminder,
      taskId: "task-004",
      elapsedMs: 7_200_000,
    }); // 2 hours
    await flush();

    expect(commPlugin.sendMessage).toHaveBeenCalledTimes(1);
    expect(commPlugin.sendMessage).toHaveBeenCalledWith(
      { user_id: "@owner", channel: "telegram" },
      expect.objectContaining({
        content: expect.stringContaining("2h"),
      }),
    );
    // The reviewers list is never consulted for a review reminder in single-user.
    expect(ctx.peopleDirectory.getReviewers).not.toHaveBeenCalled();
  });

  // 5. Skips when no owner/reviewers configured
  it("skips notification when no owner is configured", async () => {
    const commPlugin = createMockCommPlugin({ channel: "telegram" });
    const ctx = createMockContext([commPlugin]);
    // getOwner returns null by default

    const router = createNotificationRouter(ctx);
    router.notify({ kind: NotificationKinds.completion, taskId: "task-005" });
    await flush();

    expect(commPlugin.sendMessage).not.toHaveBeenCalled();
  });

  it("skips review reminder when no owner configured", async () => {
    const commPlugin = createMockCommPlugin({ channel: "telegram" });
    const ctx = createMockContext([commPlugin]);
    // getOwner returns null by default — no one to remind

    const router = createNotificationRouter(ctx);
    router.notify({
      kind: NotificationKinds.review_reminder,
      taskId: "task-006",
      elapsedMs: 3_600_000,
    });
    await flush();

    expect(commPlugin.sendMessage).not.toHaveBeenCalled();
  });

  // 6. notify({ kind: NotificationKinds.ticket_comment }) routes to plugin with ticket_management capability
  it("notify ticket_comment routes to plugin with ticket_management capability", async () => {
    const sendOnlyPlugin = createMockCommPlugin({
      id: "telegram",
      capabilities: ["send"],
      channel: "telegram",
    });
    const issuePlugin = createMockCommPlugin({
      id: "github",
      capabilities: ["send", "ticket_management"],
      channel: "github",
    });
    const ctx = createMockContext([sendOnlyPlugin, issuePlugin]);
    (ctx.taskEngine.getTask as ReturnType<typeof vi.fn>).mockReturnValue({
      external_ref: { type: "test_issue", repo: "acme/widgets", id: "42" },
    });

    const router = createNotificationRouter(ctx);
    router.notify({
      kind: NotificationKinds.ticket_comment,
      taskId: "task-008",
      message: "PR merged!",
    });
    await flush();

    expect(issuePlugin.commentOnTicket).toHaveBeenCalledWith(
      { type: "test_issue", repo: "acme/widgets", id: "42" },
      "PR merged!",
    );
    expect(sendOnlyPlugin.commentOnTicket).not.toHaveBeenCalled();
  });

  // 7. notify({ kind: NotificationKinds.ticket_comment }) skips when no external_ref
  it("notify ticket_comment skips when task has no external_ref", async () => {
    const commPlugin = createMockCommPlugin({
      capabilities: ["send", "ticket_management"],
      channel: "github",
    });
    const ctx = createMockContext([commPlugin]);
    (ctx.taskEngine.getTask as ReturnType<typeof vi.fn>).mockReturnValue({
      external_ref: null,
    });

    const router = createNotificationRouter(ctx);
    router.notify({ kind: NotificationKinds.ticket_comment, taskId: "task-009", message: "Hello" });
    await flush();

    expect(commPlugin.commentOnTicket).not.toHaveBeenCalled();
  });

  // 8. syncStateToCommPlugin routes to plugins with sync capability
  it("syncStateToCommPlugin routes to plugins with sync capability", async () => {
    const syncPlugin = createMockCommPlugin({
      id: "sync-comm",
      capabilities: ["sync"],
      channel: "github",
    });
    const noSyncPlugin = createMockCommPlugin({
      id: "no-sync",
      capabilities: ["send"],
      channel: "telegram",
    });
    const ctx = createMockContext([syncPlugin, noSyncPlugin]);
    (ctx.taskEngine.getTask as ReturnType<typeof vi.fn>).mockReturnValue({
      title: "My task",
      external_ref: { type: "test_issue", repo: "owner/repo", id: "10" },
    });

    const payload: TaskStateChangedPayload = {
      task_id: "task-010",
      from_state: TaskStates.active,
      from_sub: SubStates.working,
      to_state: TaskStates.completed,
      to_sub: null,
      reason: "All done",
      triggered_by: "orchestrator",
    };

    const router = createNotificationRouter(ctx);
    router.syncStateToCommPlugin(payload);
    await flush();

    expect(syncPlugin.syncTaskState).toHaveBeenCalledWith(
      "task-010",
      TaskStates.active,
      TaskStates.completed,
      expect.objectContaining({
        task_title: "My task",
        external_ref: { type: "test_issue", repo: "owner/repo", id: "10" },
        sub_state: null,
        reason: "All done",
      }),
    );
    expect(noSyncPlugin.syncTaskState).not.toHaveBeenCalled();
  });

  // 9. Fire-and-forget failures don't throw
  it("sendMessage failure does not throw from notify", async () => {
    const commPlugin = createMockCommPlugin({ channel: "telegram" });
    commPlugin.sendMessage.mockRejectedValue(new Error("Network error"));
    const ctx = createMockContext([commPlugin]);
    (ctx.peopleDirectory.getOwner as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "owner-1",
      contacts: [{ channel: "telegram", handle: "@owner" }],
    });

    const router = createNotificationRouter(ctx);

    // Should not throw
    expect(() => router.notify({ kind: NotificationKinds.completion, taskId: "task-011" })).not.toThrow();
    await flush();
  });

  it("commentOnTicket failure does not throw from notify ticket_comment", async () => {
    const commPlugin = createMockCommPlugin({
      capabilities: ["send", "ticket_management"],
      channel: "github",
    });
    commPlugin.commentOnTicket.mockRejectedValue(new Error("GitHub API down"));
    const ctx = createMockContext([commPlugin]);
    (ctx.taskEngine.getTask as ReturnType<typeof vi.fn>).mockReturnValue({
      external_ref: { type: "test_issue", repo: "owner/repo", id: "1" },
    });

    const router = createNotificationRouter(ctx);

    expect(() =>
      router.notify({
        kind: NotificationKinds.ticket_comment,
        taskId: "task-012",
        message: "Comment",
      }),
    ).not.toThrow();
    await flush();
  });

  it("syncTaskState failure does not throw from syncStateToCommPlugin", async () => {
    const commPlugin = createMockCommPlugin({
      capabilities: ["sync"],
      channel: "github",
    });
    commPlugin.syncTaskState.mockRejectedValue(new Error("Sync failed"));
    const ctx = createMockContext([commPlugin]);
    (ctx.taskEngine.getTask as ReturnType<typeof vi.fn>).mockReturnValue({
      title: "T",
      external_ref: null,
    });

    const payload: TaskStateChangedPayload = {
      task_id: "task-013",
      from_state: TaskStates.queued,
      from_sub: null,
      to_state: TaskStates.active,
      to_sub: SubStates.working,
      reason: "dispatched",
      triggered_by: "daemon",
    };

    const router = createNotificationRouter(ctx);

    expect(() => router.syncStateToCommPlugin(payload)).not.toThrow();
    await flush();
  });

  // Additional coverage: cost_limit notification
  it("notify cost_limit sends alert with cost limit message", async () => {
    const commPlugin = createMockCommPlugin({ channel: "telegram" });
    const ctx = createMockContext([commPlugin]);
    (ctx.peopleDirectory.getOwner as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "owner-1",
      contacts: [{ channel: "telegram", handle: "@owner" }],
    });

    const router = createNotificationRouter(ctx);
    (ctx.taskEngine.getTask as ReturnType<typeof vi.fn>).mockReturnValue({
      title: "Expensive task",
    });

    router.notify({ kind: NotificationKinds.cost_limit, taskId: "task-014" });
    await flush();

    expect(commPlugin.formatMessage).toHaveBeenCalledWith(expect.stringContaining("cost limit"), "alert");
    expect(commPlugin.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("notify ticket_comment skips when task is not found", async () => {
    const commPlugin = createMockCommPlugin({
      capabilities: ["send", "ticket_management"],
      channel: "github",
    });
    const ctx = createMockContext([commPlugin]);
    // getTask returns null by default

    const router = createNotificationRouter(ctx);
    router.notify({
      kind: NotificationKinds.ticket_comment,
      taskId: "nonexistent-task",
      message: "Hello",
    });
    await flush();

    expect(commPlugin.commentOnTicket).not.toHaveBeenCalled();
  });

  // SECURITY: notify task_error strips auth tokens from reason before external delivery
  it("notify task_error sanitizes token-bearing reason before sending", async () => {
    const commPlugin = createMockCommPlugin({ channel: "telegram" });
    const ctx = createMockContext([commPlugin]);
    (ctx.peopleDirectory.getOwner as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "owner-1",
      contacts: [{ channel: "telegram", handle: "@owner" }],
    });

    const router = createNotificationRouter(ctx);
    const poisonedReason = "push failed: https://git:ghp_SECRETTOKEN1234567890abcdefgh@github.com/org/repo.git";
    (ctx.taskEngine.getTask as ReturnType<typeof vi.fn>).mockReturnValue({
      title: "Deploy service",
    });

    router.notify({
      kind: NotificationKinds.task_error,
      taskId: "task-sec",
      reason: poisonedReason,
    });
    await flush();

    const formattedArg = (commPlugin.formatMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(formattedArg).not.toContain("ghp_SECRETTOKEN1234567890abcdefgh");
    expect(formattedArg).not.toContain("https://git:ghp_");
  });

  // SECURITY: syncStateToCommPlugin sanitizes task title before sending to comm plugins
  it("syncStateToCommPlugin sanitizes task title containing secrets", async () => {
    const syncPlugin = createMockCommPlugin({
      id: "sync-comm",
      capabilities: ["sync"],
      channel: "github",
    });
    const ctx = createMockContext([syncPlugin]);
    (ctx.taskEngine.getTask as ReturnType<typeof vi.fn>).mockReturnValue({
      title: "Fix ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA leak in auth",
      external_ref: null,
    });

    const payload: TaskStateChangedPayload = {
      task_id: "task-sec",
      from_state: TaskStates.active,
      from_sub: SubStates.working,
      to_state: TaskStates.completed,
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
    expect(syncArgs.task_title).toContain("[REDACTED:token]");
  });

  // SECURITY: notify ticket_comment strips auth tokens from message before posting to GitHub
  it("notify ticket_comment sanitizes token-bearing message before posting", async () => {
    const commPlugin = createMockCommPlugin({
      capabilities: ["send", "ticket_management"],
      channel: "github",
    });
    const ctx = createMockContext([commPlugin]);
    (ctx.taskEngine.getTask as ReturnType<typeof vi.fn>).mockReturnValue({
      external_ref: { type: "test_issue", repo: "org/repo", id: "42" },
    });

    const router = createNotificationRouter(ctx);
    const poisonedMessage =
      "Error: clone failed at https://git:ghp_SECRETTOKEN1234567890abcdefgh@github.com/org/repo.git";
    router.notify({
      kind: NotificationKinds.ticket_comment,
      taskId: "task-sec",
      message: poisonedMessage,
    });
    await flush();

    const commentArg = (commPlugin.commentOnTicket as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
    expect(commentArg).not.toContain("ghp_SECRETTOKEN1234567890abcdefgh");
    expect(commentArg).not.toContain("https://git:ghp_");
  });

  // ── Preferred contact with fallback ──────────────────────────────────────

  it("sends to preferred (first) contact only when it succeeds", async () => {
    const telegramPlugin = createMockCommPlugin({
      id: "telegram-comm",
      channel: "telegram",
      capabilities: ["send"],
    });
    const githubPlugin = createMockCommPlugin({
      id: "github-comm",
      channel: "github",
      capabilities: ["send", "ticket_management"],
    });
    const ctx = createMockContext([telegramPlugin, githubPlugin]);
    (ctx.peopleDirectory.getOwner as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "farzam",
      contacts: [
        { channel: "telegram", handle: "FarzamMohammadi" },
        { channel: "github", handle: "FarzamMohammadi" },
      ],
    });
    (ctx.taskEngine.getTask as ReturnType<typeof vi.fn>).mockReturnValue({
      title: "Test task",
    });

    const router = createNotificationRouter(ctx);
    router.notify({ kind: NotificationKinds.completion, taskId: "task-pref" });
    await flush();

    // Telegram (preferred) should receive the message
    expect(telegramPlugin.sendMessage).toHaveBeenCalledOnce();
    // GitHub (fallback) should NOT — telegram succeeded
    expect(githubPlugin.sendMessage).not.toHaveBeenCalled();
  });

  it("falls back to second contact when first fails", async () => {
    const telegramPlugin = createMockCommPlugin({
      id: "telegram-comm",
      channel: "telegram",
      capabilities: ["send"],
    });
    // Telegram fails
    (telegramPlugin.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false,
      message_id: null,
      error: { message: "bot token invalid" },
    });

    const githubPlugin = createMockCommPlugin({
      id: "github-comm",
      channel: "github",
      capabilities: ["send", "ticket_management"],
    });

    const ctx = createMockContext([telegramPlugin, githubPlugin]);
    (ctx.peopleDirectory.getOwner as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "farzam",
      contacts: [
        { channel: "telegram", handle: "FarzamMohammadi" },
        { channel: "github", handle: "owner/repo#1" },
      ],
    });
    (ctx.taskEngine.getTask as ReturnType<typeof vi.fn>).mockReturnValue({
      title: "Test task",
    });

    const router = createNotificationRouter(ctx);
    router.notify({ kind: NotificationKinds.completion, taskId: "task-fallback" });
    await flush();

    // Both should have been tried — telegram first, then github as fallback
    expect(telegramPlugin.sendMessage).toHaveBeenCalledOnce();
    expect(githubPlugin.sendMessage).toHaveBeenCalledOnce();
  });

  it("skips contacts with no matching plugin and tries next", async () => {
    // Only telegram plugin loaded — no slack plugin
    const telegramPlugin = createMockCommPlugin({
      id: "telegram-comm",
      channel: "telegram",
      capabilities: ["send"],
    });

    const ctx = createMockContext([telegramPlugin]);
    (ctx.peopleDirectory.getOwner as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "farzam",
      contacts: [
        { channel: "slack", handle: "@farzam" }, // No plugin for slack
        { channel: "telegram", handle: "FarzamMohammadi" }, // Falls through to this
      ],
    });
    (ctx.taskEngine.getTask as ReturnType<typeof vi.fn>).mockReturnValue({
      title: "Test task",
    });

    const router = createNotificationRouter(ctx);
    router.notify({ kind: NotificationKinds.completion, taskId: "task-skip" });
    await flush();

    // Telegram should receive (slack skipped, no plugin)
    expect(telegramPlugin.sendMessage).toHaveBeenCalledOnce();
  });

  it("routes channel-specific notifications to correct plugin", async () => {
    const telegramPlugin = createMockCommPlugin({
      id: "telegram-comm",
      channel: "telegram",
      capabilities: ["send"],
    });
    const githubPlugin = createMockCommPlugin({
      id: "github-comm",
      channel: "github",
      capabilities: ["send", "ticket_management"],
    });
    const ctx = createMockContext([telegramPlugin, githubPlugin]);

    // Person with only telegram
    (ctx.peopleDirectory.getPerson as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "alice",
      contacts: [{ channel: "telegram", handle: "alice_tg" }],
    });

    const router = createNotificationRouter(ctx);
    router.notify({
      kind: NotificationKinds.question,
      taskId: "task-route",
      personId: "alice",
      message: "What do you think?",
    });
    await flush();

    // Only telegram should be called (alice's only contact)
    expect(telegramPlugin.sendMessage).toHaveBeenCalledOnce();
    expect(githubPlugin.sendMessage).not.toHaveBeenCalled();
  });

  // ── Ticket Comment Truncation ──────────────────────────────────────────

  it("ticket_comment truncates messages exceeding 65,000 chars", async () => {
    const commPlugin = createMockCommPlugin({
      capabilities: ["send", "ticket_management"],
      channel: "github",
    });
    const ctx = createMockContext([commPlugin]);
    (ctx.taskEngine.getTask as ReturnType<typeof vi.fn>).mockReturnValue({
      external_ref: { type: "test_issue", repo: "acme/widgets", id: "99" },
    });

    const router = createNotificationRouter(ctx);
    const hugeMessage = "x".repeat(100_000);
    router.notify({
      kind: NotificationKinds.ticket_comment,
      taskId: "task-trunc",
      message: hugeMessage,
    });
    await flush();

    const commentArg = (commPlugin.commentOnTicket as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
    expect(commentArg.length).toBeLessThanOrEqual(65_000);
    expect(commentArg).toContain("truncated to fit platform comment limits");
  });

  it("ticket_comment preserves short messages unchanged", async () => {
    const commPlugin = createMockCommPlugin({
      capabilities: ["send", "ticket_management"],
      channel: "github",
    });
    const ctx = createMockContext([commPlugin]);
    (ctx.taskEngine.getTask as ReturnType<typeof vi.fn>).mockReturnValue({
      external_ref: { type: "test_issue", repo: "acme/widgets", id: "99" },
    });

    const router = createNotificationRouter(ctx);
    router.notify({
      kind: NotificationKinds.ticket_comment,
      taskId: "task-short",
      message: "Short message",
    });
    await flush();

    const commentArg = (commPlugin.commentOnTicket as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
    expect(commentArg).toBe("Short message");
  });

  // ── Retry Queue Tests ──────────────────────────────────────────────────

  describe("retry queue", () => {
    it("enqueues retryable failure and emits comm.send_failed with retryable: true", async () => {
      const commPlugin = createMockCommPlugin({ channel: "telegram" });
      (commPlugin.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: false,
        message_id: null,
        error: {
          code: "not_found",
          message: "No chat_id",
          retryable: true,
          retry_after_ms: null,
          severity: "error",
        },
      });
      const ctx = createMockContext([commPlugin]);
      (ctx.peopleDirectory.getOwner as ReturnType<typeof vi.fn>).mockReturnValue({
        id: "owner-1",
        contacts: [{ channel: "telegram", handle: "@owner" }],
      });
      (ctx.taskEngine.getTask as ReturnType<typeof vi.fn>).mockReturnValue({ title: "Fix bug" });

      const router = createNotificationRouter(ctx);
      router.notify({ kind: NotificationKinds.completion, taskId: "task-retry-1" });
      await flush();

      // Should emit comm.send_failed with retryable: true
      const publishCalls = (ctx.eventBus.publish as ReturnType<typeof vi.fn>).mock.calls;
      const sendFailed = publishCalls.find(
        (c: unknown[]) => (c[0] as { type: string }).type === EventTypes["comm.send_failed"],
      );
      expect(sendFailed).toBeDefined();
      expect((sendFailed![0] as { payload: { retryable: boolean } }).payload.retryable).toBe(true);
    });

    it("non-retryable failure emits comm.send_failed with retryable: false and does not enqueue", async () => {
      const commPlugin = createMockCommPlugin({ channel: "telegram" });
      (commPlugin.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: false,
        message_id: null,
        error: {
          code: "auth_failed",
          message: "Unauthorized",
          retryable: false,
          retry_after_ms: null,
          severity: "error",
        },
      });
      const ctx = createMockContext([commPlugin]);
      (ctx.peopleDirectory.getOwner as ReturnType<typeof vi.fn>).mockReturnValue({
        id: "owner-1",
        contacts: [{ channel: "telegram", handle: "@owner" }],
      });
      (ctx.taskEngine.getTask as ReturnType<typeof vi.fn>).mockReturnValue({
        title: "Fix bug",
        state: TaskStates.active,
      });

      const router = createNotificationRouter(ctx);
      router.notify({ kind: NotificationKinds.completion, taskId: "task-no-retry" });
      await flush();

      const publishCalls = (ctx.eventBus.publish as ReturnType<typeof vi.fn>).mock.calls;
      const sendFailed = publishCalls.find(
        (c: unknown[]) => (c[0] as { type: string }).type === EventTypes["comm.send_failed"],
      );
      expect(sendFailed).toBeDefined();
      expect((sendFailed![0] as { payload: { retryable: boolean } }).payload.retryable).toBe(false);

      // processRetries should have nothing to do
      router.processRetries!(2_000_000);
      await flush();

      // No retry events should be emitted
      const retryEvents = publishCalls.filter(
        (c: unknown[]) =>
          (c[0] as { type: string }).type === EventTypes["comm.retry_succeeded"] ||
          (c[0] as { type: string }).type === EventTypes["comm.retry_exhausted"],
      );
      expect(retryEvents).toHaveLength(0);
    });

    it("processRetries delivers on retry and emits comm.retry_succeeded", async () => {
      const commPlugin = createMockCommPlugin({ channel: "telegram" });
      let callCount = 0;
      (commPlugin.sendMessage as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            success: false,
            message_id: null,
            error: {
              code: "not_found",
              message: "No chat_id",
              retryable: true,
              retry_after_ms: null,
              severity: "error",
            },
          });
        }
        return Promise.resolve({ success: true, message_id: "msg-42", error: null });
      });
      const ctx = createMockContext([commPlugin]);
      (ctx.peopleDirectory.getOwner as ReturnType<typeof vi.fn>).mockReturnValue({
        id: "owner-1",
        contacts: [{ channel: "telegram", handle: "@owner" }],
      });
      (ctx.taskEngine.getTask as ReturnType<typeof vi.fn>).mockReturnValue({
        title: "Fix bug",
        state: TaskStates.active,
      });

      const router = createNotificationRouter(ctx);
      router.notify({ kind: NotificationKinds.completion, taskId: "task-retry-success" });
      await flush();

      // First send failed, now trigger retry after interval
      router.processRetries!(1_000_000 + 200); // past interval_ms (100)
      await flush();

      // Should have been called twice (initial + retry)
      expect(commPlugin.sendMessage).toHaveBeenCalledTimes(2);

      const publishCalls = (ctx.eventBus.publish as ReturnType<typeof vi.fn>).mock.calls;
      const retrySucceeded = publishCalls.find(
        (c: unknown[]) => (c[0] as { type: string }).type === EventTypes["comm.retry_succeeded"],
      );
      expect(retrySucceeded).toBeDefined();
      expect((retrySucceeded![0] as { payload: { attempt: number } }).payload.attempt).toBe(1);
    });

    it("processRetries skips if interval not elapsed", async () => {
      const commPlugin = createMockCommPlugin({ channel: "telegram" });
      (commPlugin.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: false,
        message_id: null,
        error: {
          code: "not_found",
          message: "No chat_id",
          retryable: true,
          retry_after_ms: null,
          severity: "error",
        },
      });
      const ctx = createMockContext([commPlugin]);
      (ctx.peopleDirectory.getOwner as ReturnType<typeof vi.fn>).mockReturnValue({
        id: "owner-1",
        contacts: [{ channel: "telegram", handle: "@owner" }],
      });
      (ctx.taskEngine.getTask as ReturnType<typeof vi.fn>).mockReturnValue({
        title: "Fix bug",
        state: TaskStates.active,
      });

      const router = createNotificationRouter(ctx);
      router.notify({ kind: NotificationKinds.completion, taskId: "task-interval" });
      await flush();

      expect(commPlugin.sendMessage).toHaveBeenCalledTimes(1);

      // Call processRetries with time that's within the interval
      router.processRetries!(1_000_000 + 50); // interval_ms is 100, so too early
      await flush();

      // Should NOT have retried
      expect(commPlugin.sendMessage).toHaveBeenCalledTimes(1);
    });

    it("processRetries stops on terminal task state (completed)", async () => {
      const commPlugin = createMockCommPlugin({ channel: "telegram" });
      (commPlugin.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: false,
        message_id: null,
        error: {
          code: "not_found",
          message: "No chat_id",
          retryable: true,
          retry_after_ms: null,
          severity: "error",
        },
      });
      const ctx = createMockContext([commPlugin]);
      (ctx.peopleDirectory.getOwner as ReturnType<typeof vi.fn>).mockReturnValue({
        id: "owner-1",
        contacts: [{ channel: "telegram", handle: "@owner" }],
      });
      // Initially active, then completed
      (ctx.taskEngine.getTask as ReturnType<typeof vi.fn>).mockReturnValue({
        title: "Fix bug",
        state: TaskStates.active,
      });

      const router = createNotificationRouter(ctx);
      router.notify({ kind: NotificationKinds.completion, taskId: "task-terminal" });
      await flush();

      // Now task is completed
      (ctx.taskEngine.getTask as ReturnType<typeof vi.fn>).mockReturnValue({
        title: "Fix bug",
        state: TaskStates.completed,
      });
      router.processRetries!(1_000_000 + 200);
      await flush();

      const publishCalls = (ctx.eventBus.publish as ReturnType<typeof vi.fn>).mock.calls;
      const exhausted = publishCalls.find(
        (c: unknown[]) => (c[0] as { type: string }).type === EventTypes["comm.retry_exhausted"],
      );
      expect(exhausted).toBeDefined();
      expect((exhausted![0] as { payload: { reason: string } }).payload.reason).toBe("task_terminal");

      // Should NOT retry
      expect(commPlugin.sendMessage).toHaveBeenCalledTimes(1);
    });

    it("processRetries stops on max attempts", async () => {
      const commPlugin = createMockCommPlugin({ channel: "telegram" });
      (commPlugin.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: false,
        message_id: null,
        error: {
          code: "not_found",
          message: "No chat_id",
          retryable: true,
          retry_after_ms: null,
          severity: "error",
        },
      });
      const ctx = createMockContext([commPlugin]);
      // max_attempts is 3 in test config
      (ctx.peopleDirectory.getOwner as ReturnType<typeof vi.fn>).mockReturnValue({
        id: "owner-1",
        contacts: [{ channel: "telegram", handle: "@owner" }],
      });
      (ctx.taskEngine.getTask as ReturnType<typeof vi.fn>).mockReturnValue({
        title: "Fix bug",
        state: TaskStates.active,
      });

      const router = createNotificationRouter(ctx);
      router.notify({ kind: NotificationKinds.completion, taskId: "task-max" });
      await flush();

      // Retry 3 times (max_attempts = 3)
      for (let attempt = 1; attempt <= 3; attempt++) {
        router.processRetries!(1_000_000 + attempt * 200);
        await flush();
      }

      // 4th processRetries should emit exhausted
      router.processRetries!(1_000_000 + 4 * 200);
      await flush();

      const publishCalls = (ctx.eventBus.publish as ReturnType<typeof vi.fn>).mock.calls;
      const exhausted = publishCalls.filter(
        (c: unknown[]) => (c[0] as { type: string }).type === EventTypes["comm.retry_exhausted"],
      );
      expect(exhausted.length).toBeGreaterThanOrEqual(1);
      const lastExhausted = exhausted[exhausted.length - 1]!;
      expect((lastExhausted[0] as { payload: { reason: string } }).payload.reason).toBe("max_attempts");
    });

    it("processRetries stops on max age", async () => {
      const commPlugin = createMockCommPlugin({ channel: "telegram" });
      (commPlugin.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: false,
        message_id: null,
        error: {
          code: "not_found",
          message: "No chat_id",
          retryable: true,
          retry_after_ms: null,
          severity: "error",
        },
      });
      const ctx = createMockContext([commPlugin]);
      (ctx.peopleDirectory.getOwner as ReturnType<typeof vi.fn>).mockReturnValue({
        id: "owner-1",
        contacts: [{ channel: "telegram", handle: "@owner" }],
      });
      (ctx.taskEngine.getTask as ReturnType<typeof vi.fn>).mockReturnValue({
        title: "Fix bug",
        state: TaskStates.active,
      });

      const router = createNotificationRouter(ctx);
      router.notify({ kind: NotificationKinds.completion, taskId: "task-age" });
      await flush();

      // max_age_ms is 10_000 in test config — advance time past that
      router.processRetries!(1_000_000 + 20_000);
      await flush();

      const publishCalls = (ctx.eventBus.publish as ReturnType<typeof vi.fn>).mock.calls;
      const exhausted = publishCalls.find(
        (c: unknown[]) => (c[0] as { type: string }).type === EventTypes["comm.retry_exhausted"],
      );
      expect(exhausted).toBeDefined();
      expect((exhausted![0] as { payload: { reason: string } }).payload.reason).toBe("max_age");
    });

    it("retry re-runs full contact chain and succeeds on first contact", async () => {
      const telegramPlugin = createMockCommPlugin({ id: "telegram-comm", channel: "telegram" });
      const githubPlugin = createMockCommPlugin({ id: "github-comm", channel: "github" });
      let telegramCallCount = 0;
      (telegramPlugin.sendMessage as ReturnType<typeof vi.fn>).mockImplementation(() => {
        telegramCallCount++;
        if (telegramCallCount === 1) {
          return Promise.resolve({
            success: false,
            message_id: null,
            error: {
              code: "not_found",
              message: "No chat_id",
              retryable: true,
              retry_after_ms: null,
              severity: "error",
            },
          });
        }
        return Promise.resolve({ success: true, message_id: "msg-tg", error: null });
      });
      (githubPlugin.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: false,
        message_id: null,
        error: {
          code: "not_found",
          message: "No thread",
          retryable: true,
          retry_after_ms: null,
          severity: "error",
        },
      });

      const ctx = createMockContext([telegramPlugin, githubPlugin]);
      (ctx.peopleDirectory.getOwner as ReturnType<typeof vi.fn>).mockReturnValue({
        id: "owner-1",
        contacts: [
          { channel: "telegram", handle: "@owner" },
          { channel: "github", handle: "owner" },
        ],
      });
      (ctx.taskEngine.getTask as ReturnType<typeof vi.fn>).mockReturnValue({
        title: "Fix bug",
        state: TaskStates.active,
      });

      const router = createNotificationRouter(ctx);
      router.notify({ kind: NotificationKinds.completion, taskId: "task-chain" });
      await flush();

      // First attempt: telegram fails, github fails → both tried
      expect(telegramPlugin.sendMessage).toHaveBeenCalledTimes(1);
      expect(githubPlugin.sendMessage).toHaveBeenCalledTimes(1);

      // Retry: telegram succeeds → github not tried
      router.processRetries!(1_000_000 + 200);
      await flush();

      expect(telegramPlugin.sendMessage).toHaveBeenCalledTimes(2);
      // Github should not be called again since telegram succeeded
      expect(githubPlugin.sendMessage).toHaveBeenCalledTimes(1);

      const publishCalls = (ctx.eventBus.publish as ReturnType<typeof vi.fn>).mock.calls;
      const retrySucceeded = publishCalls.find(
        (c: unknown[]) => (c[0] as { type: string }).type === EventTypes["comm.retry_succeeded"],
      );
      expect(retrySucceeded).toBeDefined();
      expect((retrySucceeded![0] as { payload: { channel: string } }).payload.channel).toBe("telegram");
    });
  });

  // ── Suppression (duplicate dedup) ────────────────────────────────────────

  describe("suppression", () => {
    /** Build a context whose clock is the given FakeClock so the suppress window is testable. */
    function createSuppressContext(clock: FakeClock): NotificationRouterContext {
      const commPlugin = createMockCommPlugin({ channel: "telegram" });
      const ctx = createMockContext([commPlugin]);
      (ctx.peopleDirectory.getOwner as ReturnType<typeof vi.fn>).mockReturnValue({
        id: "owner-1",
        contacts: [{ channel: "telegram", handle: "@owner" }],
      });
      (ctx.taskEngine.getTask as ReturnType<typeof vi.fn>).mockReturnValue({ title: "Task" });
      ctx.clock = clock;
      return ctx;
    }

    it("suppresses an identical notification within the window — one delivered", async () => {
      const clock = new FakeClock();
      const ctx = createSuppressContext(clock);
      const commPlugin = (ctx.registry.getPluginsByType as ReturnType<typeof vi.fn>)()[0];

      const router = createNotificationRouter(ctx);
      router.notify({ kind: NotificationKinds.completion, taskId: "dup-task" });
      router.notify({ kind: NotificationKinds.completion, taskId: "dup-task" });
      await flush();

      expect(commPlugin.sendMessage).toHaveBeenCalledTimes(1);
    });

    it("delivers both once the suppress window elapses", async () => {
      const clock = new FakeClock();
      const ctx = createSuppressContext(clock);
      const commPlugin = (ctx.registry.getPluginsByType as ReturnType<typeof vi.fn>)()[0];

      const router = createNotificationRouter(ctx);
      router.notify({ kind: NotificationKinds.completion, taskId: "dup-task" });
      await flush();
      // Advance just past the 5-minute default window.
      clock.advance(300_001);
      router.notify({ kind: NotificationKinds.completion, taskId: "dup-task" });
      await flush();

      expect(commPlugin.sendMessage).toHaveBeenCalledTimes(2);
    });

    it("does not dedup distinct scopes (different task ids)", async () => {
      const clock = new FakeClock();
      const ctx = createSuppressContext(clock);
      const commPlugin = (ctx.registry.getPluginsByType as ReturnType<typeof vi.fn>)()[0];

      const router = createNotificationRouter(ctx);
      router.notify({ kind: NotificationKinds.completion, taskId: "task-a" });
      router.notify({ kind: NotificationKinds.completion, taskId: "task-b" });
      await flush();

      expect(commPlugin.sendMessage).toHaveBeenCalledTimes(2);
    });

    it("dedups null-task alerts per source, not across sources", async () => {
      const clock = new FakeClock();
      const ctx = createSuppressContext(clock);
      const commPlugin = (ctx.registry.getPluginsByType as ReturnType<typeof vi.fn>)()[0];

      const router = createNotificationRouter(ctx);
      // Same source twice → second suppressed.
      router.notify({ kind: NotificationKinds.alert, taskId: null, source: "trigger:gh", message: "boom" });
      router.notify({ kind: NotificationKinds.alert, taskId: null, source: "trigger:gh", message: "boom" });
      // A different source → delivered.
      router.notify({ kind: NotificationKinds.alert, taskId: null, source: "plugin:tg", message: "boom" });
      await flush();

      expect(commPlugin.sendMessage).toHaveBeenCalledTimes(2);
    });

    it("dedups alerts too — alerts do not bypass the suppress window", async () => {
      const clock = new FakeClock();
      const ctx = createSuppressContext(clock);
      const commPlugin = (ctx.registry.getPluginsByType as ReturnType<typeof vi.fn>)()[0];

      const router = createNotificationRouter(ctx);
      router.notify({ kind: NotificationKinds.alert, taskId: "alert-task", message: "boom" });
      router.notify({ kind: NotificationKinds.alert, taskId: "alert-task", message: "boom" });
      await flush();

      expect(commPlugin.sendMessage).toHaveBeenCalledTimes(1);
    });

    it("records a decision_point when it suppresses a duplicate", () => {
      const obs: TestObserverHandle = createTestObserver();
      try {
        const facade = new Observer({ rootPino: createSilentLogger().logger, store: null }, "notifications");
        facade.upgrade(obs.observer);
        const clock = new FakeClock();
        const ctx = createSuppressContext(clock);
        ctx.observer = facade;

        const router = createNotificationRouter(ctx);
        router.notify({ kind: NotificationKinds.completion, taskId: "dup-task" });
        router.notify({ kind: NotificationKinds.completion, taskId: "dup-task" });

        const decisions = obs.observer.query({ type: "decision_point" });
        const suppress = decisions.find((d) => d.name === "notification_suppressed");
        expect(suppress).toBeDefined();
      } finally {
        obs.cleanup();
      }
    });
  });

  // ── Outbound observability ───────────────────────────────────────────────

  describe("outbound observability", () => {
    let obs: TestObserverHandle;

    afterEach(() => {
      obs?.cleanup();
    });

    /** A context whose observer writes to a queryable observation store. */
    function createObservableContext(plugins: ReturnType<typeof createMockCommPlugin>[]): NotificationRouterContext {
      obs = createTestObserver();
      const facade = new Observer({ rootPino: createSilentLogger().logger, store: null }, "notifications");
      facade.upgrade(obs.observer);
      const ctx = createMockContext(plugins);
      ctx.observer = facade;
      return ctx;
    }

    it("emits a tool_execution observation on delivery", async () => {
      const commPlugin = createMockCommPlugin({ channel: "telegram" });
      const ctx = createObservableContext([commPlugin]);
      (ctx.peopleDirectory.getOwner as ReturnType<typeof vi.fn>).mockReturnValue({
        id: "owner-1",
        contacts: [{ channel: "telegram", handle: "@owner" }],
      });
      (ctx.taskEngine.getTask as ReturnType<typeof vi.fn>).mockReturnValue({ title: "Task" });

      const router = createNotificationRouter(ctx);
      router.notify({ kind: NotificationKinds.completion, taskId: "obs-deliver" });
      await flush();

      const tools = obs.observer.query({ type: "tool_execution" });
      expect(tools.find((o) => o.name === "notification_delivered")).toBeDefined();
    });

    it("emits a tool_execution observation when no channel is reachable", async () => {
      const commPlugin = createMockCommPlugin({ channel: "telegram" });
      (commPlugin.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: false,
        message_id: null,
        error: { code: "auth_failed", message: "no", retryable: false, retry_after_ms: null, severity: "error" },
      });
      const ctx = createObservableContext([commPlugin]);
      (ctx.peopleDirectory.getOwner as ReturnType<typeof vi.fn>).mockReturnValue({
        id: "owner-1",
        contacts: [{ channel: "telegram", handle: "@owner" }],
      });
      (ctx.taskEngine.getTask as ReturnType<typeof vi.fn>).mockReturnValue({ title: "Task" });

      const router = createNotificationRouter(ctx);
      router.notify({ kind: NotificationKinds.completion, taskId: "obs-fail" });
      await flush();

      const tools = obs.observer.query({ type: "tool_execution" });
      expect(tools.find((o) => o.name === "notification_send_failed")).toBeDefined();
    });

    it("emits a tool_execution observation when a retry succeeds", async () => {
      const commPlugin = createMockCommPlugin({ channel: "telegram" });
      let callCount = 0;
      (commPlugin.sendMessage as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            success: false,
            message_id: null,
            error: { code: "not_found", message: "no", retryable: true, retry_after_ms: null, severity: "error" },
          });
        }
        return Promise.resolve({ success: true, message_id: "m", error: null });
      });
      const ctx = createObservableContext([commPlugin]);
      (ctx.peopleDirectory.getOwner as ReturnType<typeof vi.fn>).mockReturnValue({
        id: "owner-1",
        contacts: [{ channel: "telegram", handle: "@owner" }],
      });
      (ctx.taskEngine.getTask as ReturnType<typeof vi.fn>).mockReturnValue({ title: "Task", state: TaskStates.active });

      const router = createNotificationRouter(ctx);
      router.notify({ kind: NotificationKinds.completion, taskId: "obs-retry" });
      await flush();
      router.processRetries!(1_000_000 + 200);
      await flush();

      const tools = obs.observer.query({ type: "tool_execution" });
      expect(tools.find((o) => o.name === "notification_retry_succeeded")).toBeDefined();
    });

    it("emits a tool_execution observation when retries are exhausted", async () => {
      const commPlugin = createMockCommPlugin({ channel: "telegram" });
      (commPlugin.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: false,
        message_id: null,
        error: { code: "not_found", message: "no", retryable: true, retry_after_ms: null, severity: "error" },
      });
      const ctx = createObservableContext([commPlugin]);
      (ctx.peopleDirectory.getOwner as ReturnType<typeof vi.fn>).mockReturnValue({
        id: "owner-1",
        contacts: [{ channel: "telegram", handle: "@owner" }],
      });
      (ctx.taskEngine.getTask as ReturnType<typeof vi.fn>).mockReturnValue({ title: "Task", state: TaskStates.active });

      const router = createNotificationRouter(ctx);
      router.notify({ kind: NotificationKinds.completion, taskId: "obs-exhaust" });
      await flush();
      // Past max_age_ms (10_000 in the test config) → exhausted.
      router.processRetries!(1_000_000 + 20_000);
      await flush();

      const tools = obs.observer.query({ type: "tool_execution" });
      expect(tools.find((o) => o.name === "notification_retry_exhausted")).toBeDefined();
    });
  });
});
