import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildChannel,
  classifyInbound,
  createResponsePoller,
  linkMessageToTask,
} from "../../../../src/core/daemon/response-poller.js";
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
    safetyLayer: {
      consultJudgment: vi.fn().mockReturnValue({ allowed: true, action: "proceed", reason: "cost within limits" }),
    },
    notifications: { notify: vi.fn(), syncStateToCommPlugin: vi.fn() },
    peopleDirectory: { getOwner: vi.fn().mockReturnValue({ id: "owner-1", role: "owner", contacts: [] }) },
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

describe("classifyInbound", () => {
  it("routes a metadata-linked message as a reply", () => {
    expect(classifyInbound(true, "status", 1)).toEqual({ route: "linked_reply" });
  });

  it("routes a prefixed command as a query, winning over the sole-blocked reply", () => {
    // Exactly one task blocked, but the content is "!status" — query wins (the owner can ask mid-block).
    expect(classifyInbound(false, "!status", 1)).toEqual({
      route: "query",
      reason: "command",
      blockedCount: 1,
    });
  });

  it("routes a free-text message as the sole-blocked reply when exactly one task is blocked", () => {
    expect(classifyInbound(false, "use the second approach", 1)).toEqual({ route: "sole_blocked_reply" });
  });

  it("routes free text containing a command word as the sole-blocked reply (the incident)", () => {
    // A reply that merely mentions "help" must reach the blocked task, never the command handler.
    expect(classifyInbound(false, "the desc should help capture why", 1)).toEqual({ route: "sole_blocked_reply" });
  });

  it("routes a prefix-without-known-keyword message as free text, not a command", () => {
    expect(classifyInbound(false, "!foo", 1)).toEqual({ route: "sole_blocked_reply" });
  });

  it("routes any message as a query when no task is blocked", () => {
    expect(classifyInbound(false, "ping", 0)).toEqual({ route: "query", reason: "no_blocked_task", blockedCount: 0 });
  });

  it("routes a token-less non-query message as an unmatchable query when 2+ tasks are blocked", () => {
    expect(classifyInbound(false, "go ahead", 2)).toEqual({
      route: "query",
      reason: "unmatched_multi_blocked",
      blockedCount: 2,
    });
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

  it("routes a token-less non-query message to the query handler with a couldn't-match notice when 2+ tasks are blocked", async () => {
    // With 2+ blocked tasks, the single-task fallback doesn't apply — the message can't be matched to one,
    // so it is routed to the query handler (which sends the owner a "couldn't match" notice), not unblocked.
    const task1 = makeBlockedTask("task-1", "owner/repo", "42");
    const task2 = makeBlockedTask("task-2", "owner/repo", "99");
    (ctx.taskEngine.getTasksByState as ReturnType<typeof vi.fn>).mockReturnValue([task1, task2]);

    const unlinkable = {
      source: "telegram",
      sender: "owner",
      content: "yes go ahead",
      timestamp: "2026-01-01T00:00:00Z",
      reply_to: null,
      platform_metadata: {},
    };
    const plugin = makeCommPlugin("telegram", [unlinkable]);
    (ctx.registry.getPluginsByType as ReturnType<typeof vi.fn>).mockReturnValue([plugin]);

    const poller = createResponsePoller(ctx, resolver);
    await poller.poll(100_000);

    expect(resolver.tryUnblock).not.toHaveBeenCalled();
    const message = (ctx.notifications.notify as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]?.message as string;
    expect(message).toContain("couldn't match");
    expect(message).toContain("2");
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

  it("routes a dashboard re-run request to a fresh clone of the cancelled source task", async () => {
    const taskEngine = ctx.taskEngine as unknown as {
      getTask: ReturnType<typeof vi.fn>;
      findKeyHolder: ReturnType<typeof vi.fn>;
      createTask: ReturnType<typeof vi.fn>;
      updateTaskField: ReturnType<typeof vi.fn>;
    };
    taskEngine.getTask = vi.fn(() => ({
      id: "old-1",
      state: "cancelled",
      reaped_at: "2026-01-16T09:00:00Z",
      idempotency_key: "github:issue-42",
      title: "Fix the bug",
      repo: "acme/app",
      description: "",
      source_text: "",
      acceptance_criteria: [],
      external_ref: null,
      priority: 50,
      clone_url: null,
      thoughts_id: null,
    }));
    taskEngine.findKeyHolder = vi.fn(() => null);
    taskEngine.createTask = vi.fn(() => ({ id: "new-1" }));
    taskEngine.updateTaskField = vi.fn();

    (ctx.eventBus.getEventsSince as ReturnType<typeof vi.fn>).mockReturnValue([
      { type: "task.rerun_requested", source: "dashboard", sequence: 1, payload: { task_id: "old-1" } },
    ]);

    const poller = createResponsePoller(ctx, resolver);
    await poller.poll(100_000);

    expect(taskEngine.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ idempotency_key: "github:issue-42", source: "rerun" }),
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

  // ── Query routing (Slice 10 S5) ──────────────────────────────────────────

  function telegramMessage(content: string) {
    return {
      source: "telegram",
      sender: "owner",
      content,
      timestamp: "2026-01-01T00:00:00Z",
      reply_to: null,
      platform_metadata: {},
    };
  }

  async function runWithMessage(content: string, blockedTasks: unknown[]): Promise<void> {
    (ctx.taskEngine.getTasksByState as ReturnType<typeof vi.fn>).mockImplementation((state: string) =>
      state === "blocked" ? blockedTasks : [],
    );
    const plugin = makeCommPlugin("telegram", [telegramMessage(content)]);
    (ctx.registry.getPluginsByType as ReturnType<typeof vi.fn>).mockReturnValue([plugin]);
    const poller = createResponsePoller(ctx, resolver);
    await poller.poll(100_000);
  }

  it("routes '!status' to the query handler even when exactly one task is blocked (query wins)", async () => {
    await runWithMessage("!status", [makeBlockedTask("task-1", "owner/repo", "42")]);

    expect(resolver.tryUnblock).not.toHaveBeenCalled();
    expect(ctx.notifications.notify).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "status_response", personId: "owner-1" }),
    );
  });

  it("routes free text to the unblock resolver when exactly one task is blocked", async () => {
    await runWithMessage("use the second approach", [makeBlockedTask("task-1", "owner/repo", "42")]);

    expect(resolver.tryUnblock).toHaveBeenCalledWith(
      expect.objectContaining({ by: "task_id", taskId: "task-1", content: "use the second approach" }),
    );
    expect(ctx.notifications.notify).not.toHaveBeenCalled();
  });

  it("routes free text containing a command word to the blocked task, not the command handler (the incident)", async () => {
    // The reported incident: a long answer with "help" buried in it must unblock the sole blocked task.
    const content = "pull request desc should provide context that help capture why the changes are proposed";
    await runWithMessage(content, [makeBlockedTask("task-1", "owner/repo", "42")]);

    expect(resolver.tryUnblock).toHaveBeenCalledWith(
      expect.objectContaining({ by: "task_id", taskId: "task-1", content }),
    );
    expect(ctx.notifications.notify).not.toHaveBeenCalled();
  });

  it("routes '!status' to the query handler when no task is blocked", async () => {
    await runWithMessage("!status", []);

    expect(resolver.tryUnblock).not.toHaveBeenCalled();
    expect(ctx.notifications.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: "status_response" }));
  });

  it("routes '!status' to the query handler when 2+ tasks are blocked", async () => {
    await runWithMessage("!status", [
      makeBlockedTask("task-1", "owner/repo", "42"),
      makeBlockedTask("task-2", "owner/repo", "99"),
    ]);

    expect(resolver.tryUnblock).not.toHaveBeenCalled();
    expect(ctx.notifications.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: "status_response" }));
  });

  it("publishes a task_id=null audit event for a query (not attributed to any task)", async () => {
    await runWithMessage("!status", [makeBlockedTask("task-1", "owner/repo", "42")]);

    const commEvents = (ctx.eventBus.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call: unknown[]) => (call[0] as { type: string }).type === "comm.message_received",
    );
    expect(commEvents.length).toBe(1);
    expect((commEvents[0]?.[0] as { task_id: string | null }).task_id).toBeNull();
  });
});
