import { describe, expect, it, vi } from "vitest";
import { createTestObserverFacade } from "../../../test/helpers/test-observer-facade.js";
import type { TaskStateChangedPayload } from "../../schemas/events.js";
import { createNotificationRouter } from "./notification-router.js";
import type { NotificationRouterContext } from "./notification-router.js";

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
  } as unknown as NotificationRouterContext;
}

/** Flush microtask queue so fire-and-forget promises resolve. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("NotificationRouter", () => {
  // 1. notify({ kind: "completion" }) sends milestone notification to owner via comm plugins
  it("notify completion sends milestone notification to owner via comm plugins", async () => {
    const commPlugin = createMockCommPlugin({ channel: "telegram" });
    const ctx = createMockContext([commPlugin]);
    (ctx.peopleDirectory.getOwner as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "farzam",
      contacts: [{ channel: "telegram", handle: "@farzam" }],
    });

    (ctx.taskEngine.getTask as ReturnType<typeof vi.fn>).mockReturnValue({ title: "Fix the bug" });

    const router = createNotificationRouter(ctx);
    router.notify({ kind: "completion", taskId: "task-001" });
    await flush();

    expect(commPlugin.formatMessage).toHaveBeenCalledWith(
      'Task "Fix the bug" completed successfully.',
      "milestone",
    );
    expect(commPlugin.sendMessage).toHaveBeenCalledWith(
      { user_id: "@farzam", channel: "telegram" },
      expect.objectContaining({
        content: expect.stringContaining("completed successfully"),
        metadata: { task_id: "task-001", type: "milestone" },
      }),
    );
  });

  // 2. notify({ kind: "task_error" }) sends alert to owner with reason
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
    router.notify({ kind: "task_error", taskId: "task-002", reason: "build_failed" });
    await flush();

    expect(commPlugin.formatMessage).toHaveBeenCalledWith(
      expect.stringContaining("build_failed"),
      "alert",
    );
    expect(commPlugin.sendMessage).toHaveBeenCalledWith(
      { user_id: "@owner", channel: "telegram" },
      expect.objectContaining({
        metadata: { task_id: "task-002", type: "alert" },
      }),
    );
  });

  // 3. notify({ kind: "escalation_alert" }) sends to owner AND reviewers
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

    router.notify({ kind: "escalation_alert", taskId: "task-003" });
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

  // 4. notify({ kind: "review_reminder" }) sends to reviewers only
  it("notify review_reminder sends to reviewers only, not owner", async () => {
    const commPlugin = createMockCommPlugin({ channel: "telegram" });
    const ctx = createMockContext([commPlugin]);
    (ctx.peopleDirectory.getOwner as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "owner-1",
      contacts: [{ channel: "telegram", handle: "@owner" }],
    });
    (ctx.peopleDirectory.getReviewers as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: "reviewer-1", contacts: [{ channel: "telegram", handle: "@rev1" }] },
    ]);

    const router = createNotificationRouter(ctx);
    (ctx.taskEngine.getTask as ReturnType<typeof vi.fn>).mockReturnValue({ title: "Add tests" });

    router.notify({ kind: "review_reminder", taskId: "task-004", elapsedMs: 7_200_000 }); // 2 hours
    await flush();

    expect(commPlugin.sendMessage).toHaveBeenCalledTimes(1);
    expect(commPlugin.sendMessage).toHaveBeenCalledWith(
      { user_id: "@rev1", channel: "telegram" },
      expect.objectContaining({
        content: expect.stringContaining("2h"),
      }),
    );
    // Verify owner was not called
    const recipientHandles = commPlugin.sendMessage.mock.calls.map(
      (call: unknown[]) => (call[0] as { user_id: string }).user_id,
    );
    expect(recipientHandles).not.toContain("@owner");
  });

  // 5. Skips when no owner/reviewers configured
  it("skips notification when no owner is configured", async () => {
    const commPlugin = createMockCommPlugin({ channel: "telegram" });
    const ctx = createMockContext([commPlugin]);
    // getOwner returns null by default

    const router = createNotificationRouter(ctx);
    router.notify({ kind: "completion", taskId: "task-005" });
    await flush();

    expect(commPlugin.sendMessage).not.toHaveBeenCalled();
  });

  it("skips review reminder when no reviewers configured", async () => {
    const commPlugin = createMockCommPlugin({ channel: "telegram" });
    const ctx = createMockContext([commPlugin]);
    // getReviewers returns [] by default

    const router = createNotificationRouter(ctx);
    router.notify({ kind: "review_reminder", taskId: "task-006", elapsedMs: 3_600_000 });
    await flush();

    expect(commPlugin.sendMessage).not.toHaveBeenCalled();
  });

  // 6. notify({ kind: "ticket_comment" }) routes to plugin with ticket_management capability
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
    router.notify({ kind: "ticket_comment", taskId: "task-008", message: "PR merged!" });
    await flush();

    expect(issuePlugin.commentOnTicket).toHaveBeenCalledWith(
      { type: "test_issue", repo: "acme/widgets", id: "42" },
      "PR merged!",
    );
    expect(sendOnlyPlugin.commentOnTicket).not.toHaveBeenCalled();
  });

  // 7. notify({ kind: "ticket_comment" }) skips when no external_ref
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
    router.notify({ kind: "ticket_comment", taskId: "task-009", message: "Hello" });
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
    expect(() => router.notify({ kind: "completion", taskId: "task-011" })).not.toThrow();
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
      router.notify({ kind: "ticket_comment", taskId: "task-012", message: "Comment" }),
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

    router.notify({ kind: "cost_limit", taskId: "task-014" });
    await flush();

    expect(commPlugin.formatMessage).toHaveBeenCalledWith(
      expect.stringContaining("cost limit"),
      "alert",
    );
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
    router.notify({ kind: "ticket_comment", taskId: "nonexistent-task", message: "Hello" });
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
    const poisonedReason =
      "push failed: https://git:ghp_SECRETTOKEN1234567890abcdefgh@github.com/org/repo.git";
    (ctx.taskEngine.getTask as ReturnType<typeof vi.fn>).mockReturnValue({
      title: "Deploy service",
    });

    router.notify({ kind: "task_error", taskId: "task-sec", reason: poisonedReason });
    await flush();

    const formattedArg = (commPlugin.formatMessage as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as string;
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
    router.notify({ kind: "ticket_comment", taskId: "task-sec", message: poisonedMessage });
    await flush();

    const commentArg = (commPlugin.commentOnTicket as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[1] as string;
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
    router.notify({ kind: "completion", taskId: "task-pref" });
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
    router.notify({ kind: "completion", taskId: "task-fallback" });
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
    router.notify({ kind: "completion", taskId: "task-skip" });
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
      kind: "question",
      taskId: "task-route",
      personId: "alice",
      message: "What do you think?",
    });
    await flush();

    // Only telegram should be called (alice's only contact)
    expect(telegramPlugin.sendMessage).toHaveBeenCalledOnce();
    expect(githubPlugin.sendMessage).not.toHaveBeenCalled();
  });
});
