import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildChannel, createResponsePoller, linkMessageToTask } from "../../../../src/core/daemon/response-poller.js";
import type { ResponsePollerContext } from "../../../../src/core/daemon/types.js";
import { BlockReasons } from "../../../../src/schemas/task.js";
import { createTestObserverFacade } from "../../../helpers/test-observer-facade.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function createMockContext(): ResponsePollerContext {
  return {
    config: {
      trigger_poll_interval_ms: 30_000,
      response_poll_interval_ms: 5_000,
    },
    eventBus: {
      publish: vi.fn(),
      getEventsSince: vi.fn().mockReturnValue([]),
    },
    registry: { getPluginsByType: vi.fn().mockReturnValue([]) },
    taskEngine: {
      getTasksByState: vi.fn().mockReturnValue([]),
    },
    workspaceManager: {
      getWorktreePath: vi.fn().mockReturnValue(null),
    },
    peopleDirectory: {},
    observer: createTestObserverFacade("daemon"),
  } as unknown as ResponsePollerContext;
}

function createMockResolver() {
  return {
    tryUnblock: vi.fn().mockReturnValue({ unblocked: false, taskId: null, reason: "no_match" }),
  };
}

function makeBlockedTask(id: string, repo: string, externalId: string) {
  return {
    id,
    state: "blocked",
    external_ref: { type: "test_issue", repo, id: externalId },
  };
}

function makeCommPlugin(id: string, messages: unknown[] = []) {
  return {
    manifest: { id, type: "communication" },
    hasCapability: vi.fn((cap: string) => cap === "receive"),
    pollMessages: vi.fn().mockResolvedValue({ messages, cursor: "2026-01-01T00:00:00Z" }),
  };
}

// ── Pure Function Tests ──────────────────────────────────────────────────────

describe("buildChannel", () => {
  it("formats external_ref as owner/repo#number", () => {
    expect(buildChannel({ type: "test_issue", repo: "owner/repo", id: "42" })).toBe("owner/repo#42");
  });
});

describe("linkMessageToTask", () => {
  it("links by task_id from platform_metadata", () => {
    const result = linkMessageToTask({
      source: "dashboard",
      sender: "owner",
      content: "The answer",
      timestamp: "2026-01-01T00:00:00Z",
      reply_to: null,
      platform_metadata: { task_id: "task-1" },
    });
    expect(result).toEqual({
      by: "task_id",
      taskId: "task-1",
      source: "dashboard",
      content: "The answer",
    });
  });

  it("links by external_ref from platform_metadata", () => {
    const result = linkMessageToTask({
      source: "github",
      sender: "farzam",
      content: "Here's the info",
      timestamp: "2026-01-01T00:00:00Z",
      reply_to: null,
      platform_metadata: {
        external_ref: { type: "test_issue", repo: "owner/repo", id: "42" },
        comment_id: 123,
      },
    });
    expect(result).toEqual({
      by: "external_ref",
      ref: { type: "test_issue", repo: "owner/repo", id: "42" },
      source: "github",
      content: "Here's the info",
    });
  });

  it("returns null when no linkable metadata", () => {
    const result = linkMessageToTask({
      source: "unknown",
      sender: "someone",
      content: "Random message",
      timestamp: "2026-01-01T00:00:00Z",
      reply_to: null,
      platform_metadata: {},
    });
    expect(result).toBeNull();
  });
});

// ── ResponsePoller Integration Tests ─────────────────────────────────────────

describe("ResponsePoller", () => {
  let ctx: ResponsePollerContext;
  let resolver: ReturnType<typeof createMockResolver>;

  beforeEach(() => {
    ctx = createMockContext();
    resolver = createMockResolver();
  });

  it("polls even when no blocked tasks exist (captures /start handshakes)", async () => {
    const plugin = makeCommPlugin("github-comm");
    (ctx.registry.getPluginsByType as ReturnType<typeof vi.fn>).mockReturnValue([plugin]);

    const poller = createResponsePoller(ctx, resolver);
    await poller.poll(100_000);

    expect(plugin.pollMessages).toHaveBeenCalled();
    // No unblock attempts since no blocked tasks
    expect(resolver.tryUnblock).not.toHaveBeenCalled();
  });

  it("polls receive-capable plugins with channels from blocked tasks", async () => {
    const task = makeBlockedTask("task-1", "owner/repo", "42");
    (ctx.taskEngine.getTasksByState as ReturnType<typeof vi.fn>).mockReturnValue([task]);

    const plugin = makeCommPlugin("github-comm");
    (ctx.registry.getPluginsByType as ReturnType<typeof vi.fn>).mockReturnValue([plugin]);

    const poller = createResponsePoller(ctx, resolver);
    await poller.poll(100_000);

    // Cursor defaults to ISO timestamp of "now" (100_000ms) on first poll — skips historical comments
    expect(plugin.pollMessages).toHaveBeenCalledWith(["owner/repo#42"], expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/));
  });

  it("does not poll plugins without receive capability", async () => {
    const task = makeBlockedTask("task-1", "owner/repo", "42");
    (ctx.taskEngine.getTasksByState as ReturnType<typeof vi.fn>).mockReturnValue([task]);

    const sendOnly = makeCommPlugin("telegram");
    sendOnly.hasCapability.mockReturnValue(false);
    (ctx.registry.getPluginsByType as ReturnType<typeof vi.fn>).mockReturnValue([sendOnly]);

    const poller = createResponsePoller(ctx, resolver);
    await poller.poll(100_000);

    expect(sendOnly.pollMessages).not.toHaveBeenCalled();
  });

  it("calls UnblockResolver when message links to task via external_ref", async () => {
    const task = makeBlockedTask("task-1", "owner/repo", "42");
    (ctx.taskEngine.getTasksByState as ReturnType<typeof vi.fn>).mockReturnValue([task]);

    const message = {
      source: "github",
      sender: "farzam",
      content: "Here's your answer",
      timestamp: "2026-01-01T00:00:00Z",
      reply_to: null,
      platform_metadata: {
        external_ref: { type: "test_issue", repo: "owner/repo", id: "42" },
        comment_id: 999,
      },
    };
    const plugin = makeCommPlugin("github-comm", [message]);
    (ctx.registry.getPluginsByType as ReturnType<typeof vi.fn>).mockReturnValue([plugin]);

    const poller = createResponsePoller(ctx, resolver);
    await poller.poll(100_000);

    expect(resolver.tryUnblock).toHaveBeenCalledWith({
      by: "external_ref",
      ref: { type: "test_issue", repo: "owner/repo", id: "42" },
      source: "github",
      content: "Here's your answer",
    });
  });

  it("emits comm.message_received event for audit trail", async () => {
    const task = makeBlockedTask("task-1", "owner/repo", "42");
    (ctx.taskEngine.getTasksByState as ReturnType<typeof vi.fn>).mockReturnValue([task]);

    const message = {
      source: "github",
      sender: "farzam",
      content: "Response",
      timestamp: "2026-01-01T00:00:00Z",
      reply_to: null,
      platform_metadata: {
        external_ref: { type: "test_issue", repo: "owner/repo", id: "42" },
        comment_id: 1,
      },
    };
    const plugin = makeCommPlugin("github-comm", [message]);
    (ctx.registry.getPluginsByType as ReturnType<typeof vi.fn>).mockReturnValue([plugin]);

    const poller = createResponsePoller(ctx, resolver);
    await poller.poll(100_000);

    const publishCalls = (ctx.eventBus.publish as ReturnType<typeof vi.fn>).mock.calls;
    const commEvents = publishCalls.filter(
      (call: unknown[]) => (call[0] as { type: string }).type === "comm.message_received",
    );
    expect(commEvents.length).toBe(1);
  });

  it("discards messages that cannot be linked when multiple tasks are blocked", async () => {
    // With 2+ blocked tasks, the single-task fallback doesn't apply
    const task1 = makeBlockedTask("task-1", "owner/repo", "42");
    const task2 = makeBlockedTask("task-2", "owner/repo", "99");
    (ctx.taskEngine.getTasksByState as ReturnType<typeof vi.fn>).mockReturnValue([task1, task2]);

    const unlinkable = {
      source: "unknown",
      sender: "someone",
      content: "Random",
      timestamp: "2026-01-01T00:00:00Z",
      reply_to: null,
      platform_metadata: {},
    };
    const plugin = makeCommPlugin("github-comm", [unlinkable]);
    (ctx.registry.getPluginsByType as ReturnType<typeof vi.fn>).mockReturnValue([plugin]);

    const poller = createResponsePoller(ctx, resolver);
    await poller.poll(100_000);

    expect(resolver.tryUnblock).not.toHaveBeenCalled();
  });

  it("excludes a PR-review-pending task — its channel is not polled and the sole-blocked fallback skips it", async () => {
    const reviewPending = {
      ...makeBlockedTask("task-1", "owner/repo", "42"),
      blocked: { reason: BlockReasons.pr_review_pending },
    };
    (ctx.taskEngine.getTasksByState as ReturnType<typeof vi.fn>).mockReturnValue([reviewPending]);

    const unlinkable = {
      source: "telegram",
      sender: "owner",
      content: "ping",
      timestamp: "2026-01-01T00:00:00Z",
      reply_to: null,
      platform_metadata: {},
    };
    const plugin = makeCommPlugin("telegram", [unlinkable]);
    (ctx.registry.getPluginsByType as ReturnType<typeof vi.fn>).mockReturnValue([plugin]);

    const poller = createResponsePoller(ctx, resolver);
    await poller.poll(100_000);

    // the review-pending task is filtered out: it is never the sole blocked task, so its issue channel
    // is not polled and an unlinkable message is not misattributed to it
    expect(plugin.pollMessages).toHaveBeenCalledWith([], expect.anything());
    expect(resolver.tryUnblock).not.toHaveBeenCalled();
  });

  it("handles plugin poll failure gracefully", async () => {
    const task = makeBlockedTask("task-1", "owner/repo", "42");
    (ctx.taskEngine.getTasksByState as ReturnType<typeof vi.fn>).mockReturnValue([task]);

    const plugin = makeCommPlugin("github-comm");
    plugin.pollMessages.mockRejectedValue(new Error("network error"));
    (ctx.registry.getPluginsByType as ReturnType<typeof vi.fn>).mockReturnValue([plugin]);

    const poller = createResponsePoller(ctx, resolver);
    // Should not throw
    await expect(poller.poll(100_000)).resolves.toBeUndefined();
  });

  it("processes dashboard-sourced events from event bus", async () => {
    (ctx.eventBus.getEventsSince as ReturnType<typeof vi.fn>).mockReturnValue([
      {
        type: "comm.message_received",
        source: "dashboard",
        sequence: 1,
        payload: { source: "dashboard", task_id: "task-1", content: "Owner's answer" },
      },
    ]);

    const poller = createResponsePoller(ctx, resolver);
    await poller.poll(100_000);

    expect(resolver.tryUnblock).toHaveBeenCalledWith(
      expect.objectContaining({
        by: "task_id",
        taskId: "task-1",
        source: "dashboard",
      }),
    );
  });

  it("advances the scan cursor past a filtered-out row so the next poll does not re-read it", async () => {
    const getEventsSince = ctx.eventBus.getEventsSince as ReturnType<typeof vi.fn>;
    // Construct against an empty bus so the startup cursor begins at 0.
    const poller = createResponsePoller(ctx, resolver);

    // First scan returns a daemon-sourced row — filtered out (we published it), but the cursor must
    // still advance past it so the next poll resumes after, not before, the filtered row.
    getEventsSince.mockReturnValue([
      { type: "comm.message_received", source: "daemon", sequence: 7, payload: { task_id: "task-1" } },
    ]);
    await poller.poll(100_000);

    // The filtered row never unblocks anything.
    expect(resolver.tryUnblock).not.toHaveBeenCalled();

    // The second scan resumes from the advanced cursor (7), not from before the filtered row.
    getEventsSince.mockClear();
    getEventsSince.mockReturnValue([]);
    await poller.poll(200_000);

    expect(getEventsSince).toHaveBeenCalledWith(7);
  });
});
