import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecuteTaskResult } from "../../../../src/core/orchestrator/index.js";
import { EventTypes } from "../../../../src/schemas/events.js";
import { SubStates, TaskStates } from "../../../../src/schemas/task.js";
import { createMockTask } from "../../../helpers/mock-factories.js";
import { type TestDaemonHandle, createTestDaemon } from "../../../helpers/test-daemon.js";

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
      id: overrides?.id ?? "test-comm",
      type: "communication",
      version: "1.0.0",
      name: "Test Comm",
      adapter_meta: { channel },
    },
    hasCapability: vi.fn((cap: string) => capabilities.includes(cap)),
    formatMessage: vi.fn((content: string, _type: string) => `[formatted] ${content}`),
    sendMessage: vi.fn().mockResolvedValue({ message_id: "msg-1" }),
    commentOnTicket: vi.fn().mockResolvedValue(undefined),
  };
}

/** Set up a queued task and configure orchestrator to return the given result. */
function setupTaskDispatch(
  handle: TestDaemonHandle,
  result: ExecuteTaskResult,
  taskOverrides?: Record<string, unknown>,
) {
  const task = createMockTask({
    id: "task-001",
    title: "Fix the bug",
    state: TaskStates.queued,
    sub_state: null,
    external_ref: { type: "test_issue", repo: "owner/repo", id: "42" },
    ...taskOverrides,
  });
  handle.taskEngine.getQueuedByPriority.mockReturnValueOnce([task]);
  handle.taskEngine.getTask.mockReturnValue(task);
  handle.orchestrator.executeTask.mockResolvedValueOnce(result);
  return task;
}

/** Flush microtask queue so fire-and-forget promises resolve. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Daemon Notifications", () => {
  let handle: TestDaemonHandle;

  beforeEach(() => {
    handle = createTestDaemon();
  });

  afterEach(() => {
    handle.cleanup();
  });

  // ── Task Completion Notifications ─────────────────────────────────────

  describe("task completion notification", () => {
    it("sends milestone notification to owner when task completes", async () => {
      const commPlugin = createMockCommPlugin();
      handle.registry.getPluginsByType.mockReturnValue([commPlugin]);
      handle.peopleDirectory.getOwner.mockReturnValue({
        id: "farzam",
        contacts: [{ channel: "telegram", handle: "@farzam" }],
      });
      setupTaskDispatch(handle, { outcome: "completed" });

      await handle.daemon.tick();
      await flush();

      const sendCalls = commPlugin.sendMessage.mock.calls;
      const completionCall = sendCalls.find((call: unknown[]) =>
        (call[1] as { content: string }).content.includes("completed successfully"),
      );
      expect(completionCall).toBeDefined();
    });

    it("posts GitHub issue comment when task completes", async () => {
      const commPlugin = createMockCommPlugin({ capabilities: ["send", "ticket_management"] });
      handle.registry.getPluginsByType.mockReturnValue([commPlugin]);
      handle.peopleDirectory.getOwner.mockReturnValue({ id: "farzam", contacts: [] });
      setupTaskDispatch(handle, { outcome: "completed" });

      await handle.daemon.tick();
      await flush();

      const commentCalls = commPlugin.commentOnTicket.mock.calls;
      const completionComment = commentCalls.find((call: unknown[]) =>
        (call[1] as string).includes("completed successfully"),
      );
      expect(completionComment).toBeDefined();
    });

    it("skips notification when no owner configured", async () => {
      const commPlugin = createMockCommPlugin();
      handle.registry.getPluginsByType.mockReturnValue([commPlugin]);
      handle.peopleDirectory.getOwner.mockReturnValue(null);
      setupTaskDispatch(handle, { outcome: "completed" });

      await handle.daemon.tick();
      await flush();

      const sendCalls = commPlugin.sendMessage.mock.calls;
      const completionCall = sendCalls.find((call: unknown[]) =>
        (call[1] as { content: string }).content.includes("completed successfully"),
      );
      expect(completionCall).toBeUndefined();
    });

    it("skips GitHub comment when task has no external_ref", async () => {
      const commPlugin = createMockCommPlugin({ capabilities: ["send", "ticket_management"] });
      handle.registry.getPluginsByType.mockReturnValue([commPlugin]);
      handle.peopleDirectory.getOwner.mockReturnValue({ id: "farzam", contacts: [] });
      setupTaskDispatch(
        handle,
        { outcome: "completed" },
        {
          external_ref: null,
        },
      );

      await handle.daemon.tick();
      await flush();

      expect(commPlugin.commentOnTicket).not.toHaveBeenCalled();
    });

    it("notification failure never throws", async () => {
      const commPlugin = createMockCommPlugin();
      commPlugin.sendMessage.mockRejectedValue(new Error("Network error"));
      handle.registry.getPluginsByType.mockReturnValue([commPlugin]);
      handle.peopleDirectory.getOwner.mockReturnValue({
        id: "farzam",
        contacts: [{ channel: "telegram", handle: "@farzam" }],
      });
      setupTaskDispatch(handle, { outcome: "completed" });

      // Should not throw
      await handle.daemon.tick();
      await flush();
    });

    it("does not notify on preemption", async () => {
      const commPlugin = createMockCommPlugin();
      handle.registry.getPluginsByType.mockReturnValue([commPlugin]);
      handle.peopleDirectory.getOwner.mockReturnValue({
        id: "farzam",
        contacts: [{ channel: "telegram", handle: "@farzam" }],
      });
      setupTaskDispatch(handle, {
        outcome: "terminated",
        reason: "cooperative_preemption",
        lastPhase: "execution",
        checkpointId: "cp-1",
      });

      await handle.daemon.tick();
      await flush();

      // No completion or error notifications for preemption
      const sendCalls = commPlugin.sendMessage.mock.calls;
      const milestoneCall = sendCalls.find(
        (call: unknown[]) =>
          (call[1] as { content: string }).content.includes("completed") ||
          (call[1] as { content: string }).content.includes("error"),
      );
      expect(milestoneCall).toBeUndefined();
    });
  });

  // ── Task Error Notifications ──────────────────────────────────────────

  describe("task error notification", () => {
    it("sends alert notification when task errors", async () => {
      const commPlugin = createMockCommPlugin();
      handle.registry.getPluginsByType.mockReturnValue([commPlugin]);
      handle.peopleDirectory.getOwner.mockReturnValue({
        id: "farzam",
        contacts: [{ channel: "telegram", handle: "@farzam" }],
      });
      setupTaskDispatch(handle, {
        outcome: "error",
        phase: "execution",
        reason: "build_failed",
      } as ExecuteTaskResult);

      await handle.daemon.tick();
      await flush();

      const formatCalls = commPlugin.formatMessage.mock.calls;
      const alertCall = formatCalls.find(
        (call: unknown[]) => (call[0] as string).includes("build_failed") && call[1] === "alert",
      );
      expect(alertCall).toBeDefined();
    });

    it("posts GitHub issue comment with error reason", async () => {
      const commPlugin = createMockCommPlugin({ capabilities: ["send", "ticket_management"] });
      handle.registry.getPluginsByType.mockReturnValue([commPlugin]);
      handle.peopleDirectory.getOwner.mockReturnValue({ id: "farzam", contacts: [] });
      setupTaskDispatch(handle, {
        outcome: "error",
        phase: "execution",
        reason: "build_failed",
      } as ExecuteTaskResult);

      await handle.daemon.tick();
      await flush();

      const commentCalls = commPlugin.commentOnTicket.mock.calls;
      const errorComment = commentCalls.find((call: unknown[]) => (call[1] as string).includes("build_failed"));
      expect(errorComment).toBeDefined();
    });

    it("uses alert message type for error notifications", async () => {
      const commPlugin = createMockCommPlugin();
      handle.registry.getPluginsByType.mockReturnValue([commPlugin]);
      handle.peopleDirectory.getOwner.mockReturnValue({
        id: "farzam",
        contacts: [{ channel: "telegram", handle: "@farzam" }],
      });
      setupTaskDispatch(handle, {
        outcome: "error",
        phase: "execution",
        reason: "test_failure",
      } as ExecuteTaskResult);

      await handle.daemon.tick();
      await flush();

      const formatCalls = commPlugin.formatMessage.mock.calls;
      const alertCall = formatCalls.find((call: unknown[]) => call[1] === "alert");
      expect(alertCall).toBeDefined();
    });
  });

  // ── Cost Limit Notifications ──────────────────────────────────────────

  describe("cost limit notification", () => {
    it("sends alert when task blocked due to cost limit", async () => {
      const commPlugin = createMockCommPlugin();
      handle.peopleDirectory.getOwner.mockReturnValue({
        id: "farzam",
        contacts: [{ channel: "telegram", handle: "@farzam" }],
      });

      const task = createMockTask({
        id: "task-cost",
        title: "Expensive task",
        state: TaskStates.active,
        sub_state: SubStates.working,
        external_ref: { type: "test_issue", repo: "owner/repo", id: "10" },
      });
      handle.taskEngine.getTask.mockReturnValue(task);
      handle.registry.getPluginsByType.mockReturnValue([commPlugin]);

      // Start to register subscriptions, then trigger event + tick manually
      await handle.daemon.start();

      const costCallback = handle.getSubscriptionCallback(EventTypes["cost.limit_reached"]);
      expect(costCallback).toBeDefined();
      costCallback!({
        id: "evt-cost",
        sequence: 1,
        type: EventTypes["cost.limit_reached"],
        source: "safety_layer",
        task_id: "task-cost",
        timestamp: new Date().toISOString(),
        payload: {
          task_id: "task-cost",
          limit_type: "daily",
          current: 10,
          limit: 5,
        },
      });

      // Call tick directly to process cost limits
      await handle.daemon.tick();
      await flush();
      await handle.daemon.stop();

      const formatCalls = commPlugin.formatMessage.mock.calls;
      const costCall = formatCalls.find(
        (call: unknown[]) => (call[0] as string).includes("cost limit") && call[1] === "alert",
      );
      expect(costCall).toBeDefined();
    });

    it("posts GitHub issue comment for cost limit", async () => {
      const commPlugin = createMockCommPlugin({ capabilities: ["send", "ticket_management"] });
      handle.peopleDirectory.getOwner.mockReturnValue({ id: "farzam", contacts: [] });

      const task = createMockTask({
        id: "task-cost",
        title: "Expensive task",
        state: TaskStates.active,
        sub_state: SubStates.working,
        external_ref: { type: "test_issue", repo: "owner/repo", id: "10" },
      });
      handle.taskEngine.getTask.mockReturnValue(task);
      handle.registry.getPluginsByType.mockReturnValue([commPlugin]);

      await handle.daemon.start();

      const costCallback = handle.getSubscriptionCallback(EventTypes["cost.limit_reached"]);
      costCallback!({
        id: "evt-cost",
        sequence: 1,
        type: EventTypes["cost.limit_reached"],
        source: "safety_layer",
        task_id: "task-cost",
        timestamp: new Date().toISOString(),
        payload: {
          task_id: "task-cost",
          limit_type: "daily",
          current: 10,
          limit: 5,
        },
      });

      await handle.daemon.tick();
      await flush();
      await handle.daemon.stop();

      const commentCalls = commPlugin.commentOnTicket.mock.calls;
      const costComment = commentCalls.find((call: unknown[]) => (call[1] as string).includes("cost limit"));
      expect(costComment).toBeDefined();
    });
  });

  // ── commentOnTaskTicket helper ─────────────────────────────────────────

  describe("commentOnTaskTicket helper", () => {
    it("routes to comm plugin with ticket_management capability", async () => {
      const sendOnlyPlugin = createMockCommPlugin({ id: "telegram-comm", capabilities: ["send"] });
      const issuePlugin = createMockCommPlugin({
        id: "github-comm",
        capabilities: ["send", "ticket_management"],
      });
      handle.registry.getPluginsByType.mockReturnValue([sendOnlyPlugin, issuePlugin]);
      handle.peopleDirectory.getOwner.mockReturnValue({ id: "farzam", contacts: [] });
      setupTaskDispatch(handle, { outcome: "completed" });

      await handle.daemon.tick();
      await flush();

      // Only issuePlugin should have commentOnTicket called
      expect(issuePlugin.commentOnTicket).toHaveBeenCalled();
      expect(sendOnlyPlugin.commentOnTicket).not.toHaveBeenCalled();
    });

    it("passes correct repo and issue number from external_ref", async () => {
      const commPlugin = createMockCommPlugin({ capabilities: ["send", "ticket_management"] });
      handle.registry.getPluginsByType.mockReturnValue([commPlugin]);
      handle.peopleDirectory.getOwner.mockReturnValue({ id: "farzam", contacts: [] });
      setupTaskDispatch(
        handle,
        { outcome: "completed" },
        {
          external_ref: { type: "test_issue", repo: "acme/widgets", id: "99" },
        },
      );

      await handle.daemon.tick();
      await flush();

      const commentCalls = commPlugin.commentOnTicket.mock.calls;
      const matchingCall = commentCalls.find((call: unknown[]) => {
        const ref = call[0] as { repo: string; id: string };
        return ref.repo === "acme/widgets" && ref.id === "99";
      });
      expect(matchingCall).toBeDefined();
    });

    it("handles commentOnTicket failure silently", async () => {
      const commPlugin = createMockCommPlugin({ capabilities: ["send", "ticket_management"] });
      commPlugin.commentOnTicket.mockRejectedValue(new Error("GitHub API down"));
      handle.registry.getPluginsByType.mockReturnValue([commPlugin]);
      handle.peopleDirectory.getOwner.mockReturnValue({ id: "farzam", contacts: [] });
      setupTaskDispatch(handle, { outcome: "completed" });

      // Should not throw
      await handle.daemon.tick();
      await flush();
    });

    it("skips when no comm plugin has ticket_management", async () => {
      const commPlugin = createMockCommPlugin({ capabilities: ["send"] });
      handle.registry.getPluginsByType.mockReturnValue([commPlugin]);
      handle.peopleDirectory.getOwner.mockReturnValue({ id: "farzam", contacts: [] });
      setupTaskDispatch(handle, { outcome: "completed" });

      await handle.daemon.tick();
      await flush();

      expect(commPlugin.commentOnTicket).not.toHaveBeenCalled();
    });
  });

  // ── Health Event Notifications ──────────────────────────────────────────

  describe("health event notifications", () => {
    function setupCommAndOwner(handle: TestDaemonHandle) {
      const commPlugin = createMockCommPlugin();
      handle.registry.getPluginsByType.mockReturnValue([commPlugin]);
      handle.peopleDirectory.getOwner.mockReturnValue({
        id: "farzam",
        contacts: [{ channel: "telegram", handle: "@farzam" }],
      });
      return commPlugin;
    }

    it("notifies owner when health.trigger_failure fires", async () => {
      const commPlugin = setupCommAndOwner(handle);
      await handle.daemon.start();

      const callback = handle.getSubscriptionCallback("health.trigger_failure");
      expect(callback).toBeDefined();
      callback!({
        id: "evt-1",
        sequence: 1,
        type: "health.trigger_failure",
        source: "daemon",
        task_id: null,
        timestamp: new Date().toISOString(),
        payload: {
          trigger_id: "github-trigger",
          consecutive_failures: 5,
          threshold: 3,
          last_error: "auth_failed: 401 Unauthorized",
          last_success: null,
        },
      });
      await flush();
      await handle.daemon.stop();

      const formatCalls = commPlugin.formatMessage.mock.calls;
      const alertCall = formatCalls.find(
        (call: unknown[]) =>
          (call[0] as string).includes("github-trigger") &&
          (call[0] as string).includes("auth_failed") &&
          call[1] === "alert",
      );
      expect(alertCall).toBeDefined();
    });

    it("notifies owner when health.stuck_detected fires", async () => {
      const commPlugin = setupCommAndOwner(handle);
      handle.taskEngine.getTask.mockReturnValue(
        createMockTask({ id: "task-stuck", title: "Stuck task", state: "active" }),
      );
      await handle.daemon.start();

      const callback = handle.getSubscriptionCallback("health.stuck_detected");
      expect(callback).toBeDefined();
      callback!({
        id: "evt-2",
        sequence: 2,
        type: "health.stuck_detected",
        source: "daemon",
        task_id: "task-stuck",
        timestamp: new Date().toISOString(),
        payload: {
          task_id: "task-stuck",
          condition: "stale_journal",
          threshold_ms: 1_800_000,
          elapsed_ms: 2_400_000,
          last_activity: null,
        },
      });
      await flush();
      await handle.daemon.stop();

      const formatCalls = commPlugin.formatMessage.mock.calls;
      const alertCall = formatCalls.find(
        (call: unknown[]) =>
          (call[0] as string).includes("Stuck task") &&
          (call[0] as string).includes("stale_journal") &&
          call[1] === "alert",
      );
      expect(alertCall).toBeDefined();
    });

    it("notifies owner when health.plugin_failed fires", async () => {
      const commPlugin = setupCommAndOwner(handle);
      await handle.daemon.start();

      const callback = handle.getSubscriptionCallback("health.plugin_failed");
      expect(callback).toBeDefined();
      callback!({
        id: "evt-3",
        sequence: 3,
        type: "health.plugin_failed",
        source: "registry",
        task_id: null,
        timestamp: new Date().toISOString(),
        payload: {
          plugin_id: "github-trigger",
          plugin_type: "trigger",
          error: "auth_failed",
          consecutive_failures: 5,
          threshold: 3,
        },
      });
      await flush();
      await handle.daemon.stop();

      const formatCalls = commPlugin.formatMessage.mock.calls;
      const alertCall = formatCalls.find(
        (call: unknown[]) =>
          (call[0] as string).includes("github-trigger") &&
          (call[0] as string).includes("trigger") &&
          call[1] === "alert",
      );
      expect(alertCall).toBeDefined();
    });

    it("deduplicates health notifications within cooldown period", async () => {
      const commPlugin = setupCommAndOwner(handle);
      await handle.daemon.start();

      const callback = handle.getSubscriptionCallback("health.trigger_failure");
      const event = {
        id: "evt-dup",
        sequence: 1,
        type: "health.trigger_failure" as const,
        source: "daemon",
        task_id: null,
        timestamp: new Date().toISOString(),
        payload: {
          trigger_id: "github-trigger",
          consecutive_failures: 5,
          threshold: 3,
          last_error: "auth_failed",
          last_success: null,
        },
      };

      // Fire twice without advancing clock — second should be suppressed
      callback!(event);
      callback!(event);
      await flush();
      await handle.daemon.stop();

      const formatCalls = commPlugin.formatMessage.mock.calls;
      const alertCalls = formatCalls.filter(
        (call: unknown[]) => (call[0] as string).includes("github-trigger") && call[1] === "alert",
      );
      expect(alertCalls).toHaveLength(1);
    });

    it("sends new notification after cooldown expires", async () => {
      const commPlugin = setupCommAndOwner(handle);
      await handle.daemon.start();

      const callback = handle.getSubscriptionCallback("health.trigger_failure");
      const event = {
        id: "evt-cd",
        sequence: 1,
        type: "health.trigger_failure" as const,
        source: "daemon",
        task_id: null,
        timestamp: new Date().toISOString(),
        payload: {
          trigger_id: "github-trigger",
          consecutive_failures: 5,
          threshold: 3,
          last_error: "auth_failed",
          last_success: null,
        },
      };

      // First notification
      callback!(event);
      await flush();

      // Advance past cooldown (5 minutes)
      handle.clock.advance(300_001);

      // Second notification — should go through
      callback!(event);
      await flush();
      await handle.daemon.stop();

      const formatCalls = commPlugin.formatMessage.mock.calls;
      const alertCalls = formatCalls.filter(
        (call: unknown[]) => (call[0] as string).includes("github-trigger") && call[1] === "alert",
      );
      expect(alertCalls).toHaveLength(2);
    });
  });
});
