import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestObserverFacade } from "../../../test/helpers/test-observer-facade.js";
import { buildChannel, createResponsePoller, linkMessageToTask } from "./response-poller.js";
import type { ResponsePollerContext } from "./types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function createMockContext(): ResponsePollerContext {
  return {
    config: {
      trigger_poll_interval_ms: 30_000,
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
    observer: createTestObserverFacade("response-poller"),
  } as unknown as ResponsePollerContext;
}

function createMockResolver() {
  return {
    tryUnblock: vi.fn().mockReturnValue({ unblocked: false, taskId: null, reason: "no_match" }),
  };
}

function makeBlockedTask(id: string, repo: string, number: number) {
  return {
    id,
    state: "blocked",
    external_ref: { type: "test_issue", repo, number },
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
    expect(buildChannel({ type: "test_issue", repo: "owner/repo", number: 42 })).toBe(
      "owner/repo#42",
    );
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
        external_ref: { type: "test_issue", repo: "owner/repo", number: 42 },
        comment_id: 123,
      },
    });
    expect(result).toEqual({
      by: "external_ref",
      ref: { type: "test_issue", repo: "owner/repo", number: 42 },
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

  it("skips polling when no blocked tasks exist", async () => {
    const plugin = makeCommPlugin("github-comm");
    (ctx.registry.getPluginsByType as ReturnType<typeof vi.fn>).mockReturnValue([plugin]);

    const poller = createResponsePoller(ctx, resolver);
    await poller.poll(100_000);

    expect(plugin.pollMessages).not.toHaveBeenCalled();
  });

  it("polls receive-capable plugins with channels from blocked tasks", async () => {
    const task = makeBlockedTask("task-1", "owner/repo", 42);
    (ctx.taskEngine.getTasksByState as ReturnType<typeof vi.fn>).mockReturnValue([task]);

    const plugin = makeCommPlugin("github-comm");
    (ctx.registry.getPluginsByType as ReturnType<typeof vi.fn>).mockReturnValue([plugin]);

    const poller = createResponsePoller(ctx, resolver);
    await poller.poll(100_000);

    // Cursor defaults to ISO timestamp of "now" (100_000ms) on first poll — skips historical comments
    expect(plugin.pollMessages).toHaveBeenCalledWith(
      ["owner/repo#42"],
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    );
  });

  it("does not poll plugins without receive capability", async () => {
    const task = makeBlockedTask("task-1", "owner/repo", 42);
    (ctx.taskEngine.getTasksByState as ReturnType<typeof vi.fn>).mockReturnValue([task]);

    const sendOnly = makeCommPlugin("telegram");
    sendOnly.hasCapability.mockReturnValue(false);
    (ctx.registry.getPluginsByType as ReturnType<typeof vi.fn>).mockReturnValue([sendOnly]);

    const poller = createResponsePoller(ctx, resolver);
    await poller.poll(100_000);

    expect(sendOnly.pollMessages).not.toHaveBeenCalled();
  });

  it("calls UnblockResolver when message links to task via external_ref", async () => {
    const task = makeBlockedTask("task-1", "owner/repo", 42);
    (ctx.taskEngine.getTasksByState as ReturnType<typeof vi.fn>).mockReturnValue([task]);

    const message = {
      source: "github",
      sender: "farzam",
      content: "Here's your answer",
      timestamp: "2026-01-01T00:00:00Z",
      reply_to: null,
      platform_metadata: {
        external_ref: { type: "test_issue", repo: "owner/repo", number: 42 },
        comment_id: 999,
      },
    };
    const plugin = makeCommPlugin("github-comm", [message]);
    (ctx.registry.getPluginsByType as ReturnType<typeof vi.fn>).mockReturnValue([plugin]);

    const poller = createResponsePoller(ctx, resolver);
    await poller.poll(100_000);

    expect(resolver.tryUnblock).toHaveBeenCalledWith({
      by: "external_ref",
      ref: { type: "test_issue", repo: "owner/repo", number: 42 },
      source: "github",
      content: "Here's your answer",
    });
  });

  it("emits comm.message_received event for audit trail", async () => {
    const task = makeBlockedTask("task-1", "owner/repo", 42);
    (ctx.taskEngine.getTasksByState as ReturnType<typeof vi.fn>).mockReturnValue([task]);

    const message = {
      source: "github",
      sender: "farzam",
      content: "Response",
      timestamp: "2026-01-01T00:00:00Z",
      reply_to: null,
      platform_metadata: {
        external_ref: { type: "test_issue", repo: "owner/repo", number: 42 },
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
    const task1 = makeBlockedTask("task-1", "owner/repo", 42);
    const task2 = makeBlockedTask("task-2", "owner/repo", 99);
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

  it("handles plugin poll failure gracefully", async () => {
    const task = makeBlockedTask("task-1", "owner/repo", 42);
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
});
