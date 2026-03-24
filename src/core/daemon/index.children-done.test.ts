import { afterEach, describe, expect, it } from "vitest";
import { type TestDaemonHandle, createTestDaemon } from "../../../test/helpers/test-daemon.js";
import { createMockTask } from "../../../test/helpers/test-orchestrator.js";

describe("Daemon — Decomposition", () => {
  let handle: TestDaemonHandle;

  afterEach(async () => {
    if (handle) {
      await handle.daemon.stop();
    }
  });

  describe("checkAndEmitChildrenAllDone", () => {
    it("emits children_all_done when last child completes", async () => {
      handle = createTestDaemon();
      await handle.daemon.start();

      // Set up: parent in supervising, 2 children
      const child1 = createMockTask({ id: "child-1", parent_id: "parent-1", state: "completed" });
      const child2 = createMockTask({ id: "child-2", parent_id: "parent-1", state: "completed" });

      handle.taskEngine.getTask.mockImplementation((id: string) => {
        if (id === "child-2") {
          return child2;
        }
        if (id === "parent-1") {
          return createMockTask({ id: "parent-1", state: "active", sub_state: "supervising" });
        }
        return null;
      });
      handle.taskEngine.getChildren.mockReturnValue([child1, child2]);
      handle.taskEngine.getTasksByState.mockReturnValue([]);
      handle.taskEngine.getQueuedByPriority.mockReturnValue([]);

      // Simulate: orchestrator returns "completed" for child-2
      handle.orchestrator.executeTask.mockResolvedValue({
        outcome: "completed",
        phaseOutputs: new Map(),
      });

      // Dispatch child-2
      handle.taskEngine.getQueuedByPriority.mockReturnValueOnce([
        createMockTask({ id: "child-2", parent_id: "parent-1", state: "queued" }),
      ]);

      await handle.daemon.tick();

      // Wait for the fire-and-forget Promise to resolve
      await new Promise((resolve) => setTimeout(resolve, 10));

      // children_all_done should have been emitted
      const publishCalls = handle.eventBus.publish.mock.calls;
      const childrenDoneEvent = publishCalls.find(
        (call: unknown[]) =>
          (call[0] as Record<string, unknown>)["type"] === "task.children_all_done",
      );
      expect(childrenDoneEvent).toBeDefined();
      const payload = (childrenDoneEvent?.[0] as Record<string, unknown>)["payload"] as Record<
        string,
        unknown
      >;
      expect(payload["parent_task_id"]).toBe("parent-1");
      expect(payload["all_succeeded"]).toBe(true);
      expect(payload["failed_ids"]).toEqual([]);
    });

    it("does not emit when some siblings are still running", async () => {
      handle = createTestDaemon();
      await handle.daemon.start();

      const child1 = createMockTask({ id: "child-1", parent_id: "parent-1", state: "completed" });
      const child2 = createMockTask({
        id: "child-2",
        parent_id: "parent-1",
        state: "active",
        sub_state: "working",
      });

      handle.taskEngine.getTask.mockImplementation((id: string) => {
        if (id === "child-1") {
          return child1;
        }
        if (id === "parent-1") {
          return createMockTask({ id: "parent-1", state: "active", sub_state: "supervising" });
        }
        return null;
      });
      handle.taskEngine.getChildren.mockReturnValue([child1, child2]);
      handle.taskEngine.getTasksByState.mockReturnValue([]);
      handle.taskEngine.getQueuedByPriority.mockReturnValue([]);

      handle.orchestrator.executeTask.mockResolvedValue({
        outcome: "completed",
        phaseOutputs: new Map(),
      });

      handle.taskEngine.getQueuedByPriority.mockReturnValueOnce([
        createMockTask({ id: "child-1", parent_id: "parent-1", state: "queued" }),
      ]);

      await handle.daemon.tick();
      await new Promise((resolve) => setTimeout(resolve, 10));

      const publishCalls = handle.eventBus.publish.mock.calls;
      const childrenDoneEvent = publishCalls.find(
        (call: unknown[]) =>
          (call[0] as Record<string, unknown>)["type"] === "task.children_all_done",
      );
      expect(childrenDoneEvent).toBeUndefined();
    });

    it("emits with failed_ids when a child fails", async () => {
      handle = createTestDaemon();
      await handle.daemon.start();

      const child1 = createMockTask({ id: "child-1", parent_id: "parent-1", state: "completed" });
      const child2 = createMockTask({ id: "child-2", parent_id: "parent-1", state: "failed" });

      handle.taskEngine.getTask.mockImplementation((id: string) => {
        if (id === "child-2") {
          return child2;
        }
        if (id === "parent-1") {
          return createMockTask({ id: "parent-1", state: "active", sub_state: "supervising" });
        }
        return null;
      });
      handle.taskEngine.getChildren.mockReturnValue([child1, child2]);
      handle.taskEngine.getTasksByState.mockReturnValue([]);
      handle.taskEngine.getQueuedByPriority.mockReturnValue([]);

      // child-2 fails via error outcome
      handle.orchestrator.executeTask.mockResolvedValue({
        outcome: "error",
        phase: "execution",
        reason: "test failure",
      });

      handle.taskEngine.getQueuedByPriority.mockReturnValueOnce([
        createMockTask({ id: "child-2", parent_id: "parent-1", state: "queued" }),
      ]);

      await handle.daemon.tick();
      await new Promise((resolve) => setTimeout(resolve, 10));

      const publishCalls = handle.eventBus.publish.mock.calls;
      const childrenDoneEvent = publishCalls.find(
        (call: unknown[]) =>
          (call[0] as Record<string, unknown>)["type"] === "task.children_all_done",
      );
      expect(childrenDoneEvent).toBeDefined();
      const payload = (childrenDoneEvent?.[0] as Record<string, unknown>)["payload"] as Record<
        string,
        unknown
      >;
      expect(payload["all_succeeded"]).toBe(false);
      expect(payload["failed_ids"]).toEqual(["child-2"]);
    });

    it("skips for top-level tasks (no parent_id)", async () => {
      handle = createTestDaemon();
      await handle.daemon.start();

      handle.taskEngine.getTask.mockReturnValue(
        createMockTask({ id: "task-1", parent_id: null, state: "completed" }),
      );
      handle.taskEngine.getTasksByState.mockReturnValue([]);
      handle.taskEngine.getQueuedByPriority.mockReturnValue([]);

      handle.orchestrator.executeTask.mockResolvedValue({
        outcome: "completed",
        phaseOutputs: new Map(),
      });

      handle.taskEngine.getQueuedByPriority.mockReturnValueOnce([
        createMockTask({ id: "task-1", state: "queued" }),
      ]);

      await handle.daemon.tick();
      await new Promise((resolve) => setTimeout(resolve, 10));

      const publishCalls = handle.eventBus.publish.mock.calls;
      const childrenDoneEvent = publishCalls.find(
        (call: unknown[]) =>
          (call[0] as Record<string, unknown>)["type"] === "task.children_all_done",
      );
      expect(childrenDoneEvent).toBeUndefined();
    });
  });

  describe("decomposed outcome handling", () => {
    it("does not transition parent state on decomposed outcome", async () => {
      handle = createTestDaemon();
      await handle.daemon.start();

      handle.taskEngine.getTasksByState.mockReturnValue([]);
      handle.taskEngine.getQueuedByPriority.mockReturnValue([]);

      // Orchestrator returns decomposed
      handle.orchestrator.executeTask.mockResolvedValue({
        outcome: "decomposed",
        childTaskIds: ["child-1", "child-2"],
        phaseOutputs: new Map(),
      });

      const parentTask = createMockTask({ id: "parent-1", state: "queued" });
      handle.taskEngine.getQueuedByPriority.mockReturnValueOnce([parentTask]);
      handle.taskEngine.getTask.mockReturnValue(parentTask);

      await handle.daemon.tick();
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Should NOT call requestTransition for "completed" or "blocked"
      const transitionCalls = handle.taskEngine.requestTransition.mock.calls.filter(
        (call: unknown[]) => call[0] === "parent-1" && call[1] !== "active",
      );
      // Only the initial active.working transition from dispatch
      expect(transitionCalls).toHaveLength(0);
    });
  });

  describe("handleChildrenAllDone populates child_summaries", () => {
    it("stores child summaries on parent before re-dispatch", async () => {
      handle = createTestDaemon();
      await handle.daemon.start();

      const parent = createMockTask({
        id: "parent-1",
        state: "active",
        sub_state: "supervising",
      });

      const child1 = createMockTask({
        id: "child-1",
        title: "Schema changes",
        state: "completed",
        description: "Added new schemas",
        workspace: {
          repo: "test/repo",
          branch: "engineer/child-1-schema",
          worktree_path: null,
          thoughts_dir: null,
        },
        review: { pr_number: 5, pr_state: "draft", demo_artifacts: [], feedback_rounds: [] },
        decisions: [
          {
            what: "Use Zod",
            why: "Type safety",
            alternatives_considered: [],
            decided_by: "agent",
            timestamp: new Date().toISOString(),
          },
        ],
      });

      handle.taskEngine.getTask.mockImplementation((id: string) => {
        if (id === "parent-1") {
          return parent;
        }
        return null;
      });
      handle.taskEngine.getChildren.mockReturnValue([child1]);
      handle.taskEngine.getTasksByState.mockReturnValue([]);
      handle.taskEngine.getQueuedByPriority.mockReturnValue([]);

      const callback = handle.getSubscriptionCallback("task.children_all_done");
      expect(callback).toBeDefined();

      callback?.({
        id: "evt-1",
        type: "task.children_all_done",
        source: "daemon",
        task_id: "parent-1",
        sequence: 1,
        timestamp: new Date().toISOString(),
        payload: {
          parent_task_id: "parent-1",
          child_ids: ["child-1"],
          all_succeeded: true,
          failed_ids: [],
        },
      });

      // Verify child_summaries was written to parent
      const updateCalls = handle.taskEngine.updateTaskField.mock.calls;
      const summaryCall = updateCalls.find(
        (call: unknown[]) => call[0] === "parent-1" && call[1] === "child_summaries",
      );
      expect(summaryCall).toBeDefined();

      const summaries = summaryCall?.[2] as Record<string, unknown>[];
      expect(summaries).toHaveLength(1);
      expect(summaries[0]?.["child_id"]).toBe("child-1");
      expect(summaries[0]?.["child_title"]).toBe("Schema changes");
      expect(summaries[0]?.["branch"]).toBe("engineer/child-1-schema");
      expect(summaries[0]?.["pr_number"]).toBe(5);
      expect(summaries[0]?.["test_status"]).toBe("passing");
      expect(summaries[0]?.["decisions_made"]).toEqual(["Use Zod"]);
    });
  });
});
