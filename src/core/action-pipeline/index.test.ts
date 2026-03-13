import { describe, expect, it, vi } from "vitest";

import type { ActionClass } from "../../schemas/task.js";
import type { EventBus } from "../event-bus/index.js";
import type { SafetyVerdict } from "../safety-layer/index.js";
import type { SafetyLayer } from "../safety-layer/index.js";
import type { PermissionResult } from "../task-engine/index.js";
import type { TaskEngine } from "../task-engine/index.js";
import { ActionPipeline } from "./index.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function createMocks() {
  const taskEngine = {
    checkPermission: vi.fn<(taskId: string, actionClass: ActionClass) => PermissionResult>(),
  };
  const safetyLayer = {
    evaluateAction:
      vi.fn<
        (
          taskId: string,
          actionClass: ActionClass,
          details: Record<string, unknown>,
        ) => SafetyVerdict
      >(),
  };
  const eventBus = {
    publish: vi.fn(),
  };
  const pipeline = new ActionPipeline(
    taskEngine as unknown as TaskEngine,
    safetyLayer as unknown as SafetyLayer,
    eventBus as unknown as EventBus,
  );
  return { pipeline, taskEngine, safetyLayer, eventBus };
}

function allowGate1(taskEngine: ReturnType<typeof createMocks>["taskEngine"]) {
  taskEngine.checkPermission.mockReturnValue({ allowed: true });
}

function allowGate2(safetyLayer: ReturnType<typeof createMocks>["safetyLayer"]) {
  safetyLayer.evaluateAction.mockReturnValue({
    allowed: true,
    action: "proceed",
    reason: "within policy",
  });
}

const DEFAULT_DETAILS = { repo: "owner/repo", branch: "main" };

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("ActionPipeline", () => {
  // ── Gate 1: Task Engine ───────────────────────────────────────────────────

  describe("Gate 1 — Task Engine", () => {
    it("rejects when task engine denies permission", async () => {
      const { pipeline, taskEngine } = createMocks();
      taskEngine.checkPermission.mockReturnValue({
        allowed: false,
        reason: "not permitted in state",
      });

      const executeFn = vi.fn();
      const result = await pipeline.execute({
        taskId: "t1",
        actionClass: "git_remote",
        details: DEFAULT_DETAILS,
        requestedBy: "orchestrator",
        executeFn,
      });

      expect(result).toStrictEqual({
        outcome: "rejected",
        gate: "task_engine",
        reason: "not permitted in state",
      });
      expect(executeFn).not.toHaveBeenCalled();
    });

    it("emits action.rejected event with gate=task_engine on rejection", async () => {
      const { pipeline, taskEngine, eventBus } = createMocks();
      taskEngine.checkPermission.mockReturnValue({ allowed: false, reason: "blocked state" });

      await pipeline.execute({
        taskId: "t1",
        actionClass: "merge",
        details: { repo: "owner/repo" },
        requestedBy: "workspace_manager",
        executeFn: () => null,
      });

      expect(eventBus.publish).toHaveBeenCalledOnce();
      const call = eventBus.publish.mock.calls[0]?.[0];
      expect(call).toMatchObject({
        type: "action.rejected",
        source: "action_pipeline",
        task_id: "t1",
        payload: {
          task_id: "t1",
          action_class: "merge",
          gate: "task_engine",
          reason: "blocked state",
          details: { repo: "owner/repo" },
          requested_by: "workspace_manager",
        },
      });
    });

    it("does not call Gate 2 when Gate 1 rejects", async () => {
      const { pipeline, taskEngine, safetyLayer } = createMocks();
      taskEngine.checkPermission.mockReturnValue({ allowed: false, reason: "denied" });

      await pipeline.execute({
        taskId: "t1",
        actionClass: "write",
        details: DEFAULT_DETAILS,
        requestedBy: "orchestrator",
        executeFn: () => null,
      });

      expect(safetyLayer.evaluateAction).not.toHaveBeenCalled();
    });

    it("proceeds past Gate 1 when conditional permission is granted", async () => {
      const { pipeline, taskEngine, safetyLayer } = createMocks();
      taskEngine.checkPermission.mockReturnValue({
        allowed: true,
        conditional: "auto_merge_after_approval configured for repo",
      });
      allowGate2(safetyLayer);

      const executeFn = vi.fn(() => "done");
      const result = await pipeline.execute({
        taskId: "t1",
        actionClass: "merge",
        details: DEFAULT_DETAILS,
        requestedBy: "orchestrator",
        executeFn,
      });

      expect(result).toStrictEqual({ outcome: "executed", result: "done" });
      expect(executeFn).toHaveBeenCalledOnce();
    });
  });

  // ── Gate 2: Safety Layer ──────────────────────────────────────────────────

  describe("Gate 2 — Safety Layer", () => {
    it("rejects when safety layer denies", async () => {
      const { pipeline, taskEngine, safetyLayer } = createMocks();
      allowGate1(taskEngine);
      safetyLayer.evaluateAction.mockReturnValue({
        allowed: false,
        action: "deny",
        reason: "branch not in whitelist",
      });

      const executeFn = vi.fn();
      const result = await pipeline.execute({
        taskId: "t1",
        actionClass: "git_remote",
        details: DEFAULT_DETAILS,
        requestedBy: "orchestrator",
        executeFn,
      });

      expect(result).toStrictEqual({
        outcome: "rejected",
        gate: "safety_layer",
        reason: "branch not in whitelist",
      });
      expect(executeFn).not.toHaveBeenCalled();
    });

    it("emits action.rejected event with gate=safety_layer on deny", async () => {
      const { pipeline, taskEngine, safetyLayer, eventBus } = createMocks();
      allowGate1(taskEngine);
      safetyLayer.evaluateAction.mockReturnValue({
        allowed: false,
        action: "deny",
        reason: "out of scope",
      });

      await pipeline.execute({
        taskId: "t2",
        actionClass: "write",
        details: { file: "secret.env" },
        requestedBy: "orchestrator",
        executeFn: () => null,
      });

      expect(eventBus.publish).toHaveBeenCalledOnce();
      const call = eventBus.publish.mock.calls[0]?.[0];
      expect(call).toMatchObject({
        type: "action.rejected",
        source: "action_pipeline",
        payload: {
          gate: "safety_layer",
          reason: "out of scope",
        },
      });
    });

    it("returns ask_human when safety layer requires human approval", async () => {
      const { pipeline, taskEngine, safetyLayer } = createMocks();
      allowGate1(taskEngine);
      safetyLayer.evaluateAction.mockReturnValue({
        allowed: false,
        action: "ask_human",
        reason: "exceeds autonomy scope",
      });

      const executeFn = vi.fn();
      const result = await pipeline.execute({
        taskId: "t1",
        actionClass: "deploy",
        details: DEFAULT_DETAILS,
        requestedBy: "orchestrator",
        executeFn,
      });

      expect(result).toStrictEqual({ outcome: "ask_human", reason: "exceeds autonomy scope" });
      expect(executeFn).not.toHaveBeenCalled();
    });

    it("passes warnings through on ask_human verdict", async () => {
      const { pipeline, taskEngine, safetyLayer } = createMocks();
      allowGate1(taskEngine);
      safetyLayer.evaluateAction.mockReturnValue({
        allowed: false,
        action: "ask_human",
        reason: "needs approval",
        warnings: ["cost at 90% of daily limit"],
      });

      const result = await pipeline.execute({
        taskId: "t1",
        actionClass: "communicate",
        details: DEFAULT_DETAILS,
        requestedBy: "orchestrator",
        executeFn: () => null,
      });

      expect(result).toStrictEqual({
        outcome: "ask_human",
        reason: "needs approval",
        warnings: ["cost at 90% of daily limit"],
      });
    });

    it("emits action.rejected event for ask_human verdict", async () => {
      const { pipeline, taskEngine, safetyLayer, eventBus } = createMocks();
      allowGate1(taskEngine);
      safetyLayer.evaluateAction.mockReturnValue({
        allowed: false,
        action: "ask_human",
        reason: "needs human judgment",
      });

      await pipeline.execute({
        taskId: "t1",
        actionClass: "merge",
        details: DEFAULT_DETAILS,
        requestedBy: "orchestrator",
        executeFn: () => null,
      });

      expect(eventBus.publish).toHaveBeenCalledOnce();
      expect(eventBus.publish.mock.calls[0]?.[0]).toMatchObject({
        type: "action.rejected",
        payload: { gate: "safety_layer", reason: "needs human judgment" },
      });
    });
  });

  // ── Read-only skip ────────────────────────────────────────────────────────

  describe("read-only skip", () => {
    it("skips Gate 2 for read actions", async () => {
      const { pipeline, taskEngine, safetyLayer } = createMocks();
      allowGate1(taskEngine);

      const executeFn = vi.fn(() => "data");
      const result = await pipeline.execute({
        taskId: "t1",
        actionClass: "read",
        details: DEFAULT_DETAILS,
        requestedBy: "orchestrator",
        executeFn,
      });

      expect(safetyLayer.evaluateAction).not.toHaveBeenCalled();
      expect(result).toStrictEqual({ outcome: "executed", result: "data" });
    });

    it("calls Gate 2 for non-read actions", async () => {
      const { pipeline, taskEngine, safetyLayer } = createMocks();
      allowGate1(taskEngine);
      allowGate2(safetyLayer);

      await pipeline.execute({
        taskId: "t1",
        actionClass: "write",
        details: DEFAULT_DETAILS,
        requestedBy: "orchestrator",
        executeFn: () => null,
      });

      expect(safetyLayer.evaluateAction).toHaveBeenCalledOnce();
      expect(safetyLayer.evaluateAction).toHaveBeenCalledWith("t1", "write", DEFAULT_DETAILS);
    });
  });

  // ── Execute ───────────────────────────────────────────────────────────────

  describe("execute", () => {
    it("calls executeFn and returns result when both gates pass", async () => {
      const { pipeline, taskEngine, safetyLayer } = createMocks();
      allowGate1(taskEngine);
      allowGate2(safetyLayer);

      const result = await pipeline.execute({
        taskId: "t1",
        actionClass: "git_remote",
        details: DEFAULT_DETAILS,
        requestedBy: "orchestrator",
        executeFn: () => ({ sha: "abc123" }),
      });

      expect(result).toStrictEqual({ outcome: "executed", result: { sha: "abc123" } });
    });

    it("handles async executeFn", async () => {
      const { pipeline, taskEngine, safetyLayer } = createMocks();
      allowGate1(taskEngine);
      allowGate2(safetyLayer);

      const result = await pipeline.execute({
        taskId: "t1",
        actionClass: "write",
        details: DEFAULT_DETAILS,
        requestedBy: "orchestrator",
        executeFn: () => Promise.resolve(42),
      });

      expect(result).toStrictEqual({ outcome: "executed", result: 42 });
    });

    it("catches executeFn Error and returns error outcome", async () => {
      const { pipeline, taskEngine, safetyLayer, eventBus } = createMocks();
      allowGate1(taskEngine);
      allowGate2(safetyLayer);

      const result = await pipeline.execute({
        taskId: "t1",
        actionClass: "git_remote",
        details: DEFAULT_DETAILS,
        requestedBy: "orchestrator",
        executeFn: () => {
          throw new Error("git push failed");
        },
      });

      expect(result.outcome).toBe("error");
      if (result.outcome === "error") {
        expect(result.reason).toBe("git push failed");
        expect(result.error).toBeInstanceOf(Error);
      }
      // Execution errors do not emit action.rejected
      expect(eventBus.publish).not.toHaveBeenCalled();
    });

    it("stringifies non-Error throws", async () => {
      const { pipeline, taskEngine, safetyLayer } = createMocks();
      allowGate1(taskEngine);
      allowGate2(safetyLayer);

      const result = await pipeline.execute({
        taskId: "t1",
        actionClass: "write",
        details: DEFAULT_DETAILS,
        requestedBy: "orchestrator",
        executeFn: () => {
          // biome-ignore lint/style/useThrowOnlyError: testing non-Error throw handling
          throw "unexpected string error";
        },
      });

      expect(result.outcome).toBe("error");
      if (result.outcome === "error") {
        expect(result.reason).toBe("unexpected string error");
        expect(result.error).toBe("unexpected string error");
      }
    });
  });

  // ── Notify ────────────────────────────────────────────────────────────────

  describe("notify", () => {
    it("calls notifyFn with the execution result", async () => {
      const { pipeline, taskEngine, safetyLayer } = createMocks();
      allowGate1(taskEngine);
      allowGate2(safetyLayer);

      const notifyFn = vi.fn();
      await pipeline.execute({
        taskId: "t1",
        actionClass: "git_remote",
        details: DEFAULT_DETAILS,
        requestedBy: "orchestrator",
        executeFn: () => ({ pushed: true }),
        notifyFn,
      });

      expect(notifyFn).toHaveBeenCalledOnce();
      expect(notifyFn).toHaveBeenCalledWith({ pushed: true });
    });

    it("succeeds when notifyFn is omitted", async () => {
      const { pipeline, taskEngine, safetyLayer } = createMocks();
      allowGate1(taskEngine);
      allowGate2(safetyLayer);

      const result = await pipeline.execute({
        taskId: "t1",
        actionClass: "write",
        details: DEFAULT_DETAILS,
        requestedBy: "orchestrator",
        executeFn: () => "done",
      });

      expect(result).toStrictEqual({ outcome: "executed", result: "done" });
    });

    it("logs and swallows notifyFn errors", async () => {
      const { pipeline, taskEngine, safetyLayer } = createMocks();
      allowGate1(taskEngine);
      allowGate2(safetyLayer);

      // biome-ignore lint/suspicious/noEmptyBlockStatements: suppress console.error noise in tests
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const result = await pipeline.execute({
        taskId: "t1",
        actionClass: "write",
        details: DEFAULT_DETAILS,
        requestedBy: "orchestrator",
        executeFn: () => "ok",
        notifyFn: () => {
          throw new Error("notify boom");
        },
      });

      expect(result).toStrictEqual({ outcome: "executed", result: "ok" });
      expect(consoleSpy).toHaveBeenCalledWith("ActionPipeline: notifyFn threw:", expect.any(Error));
      consoleSpy.mockRestore();
    });
  });

  // ── Event shape ───────────────────────────────────────────────────────────

  describe("event shape", () => {
    it("rejection event has all ActionRejectedPayload fields", async () => {
      const { pipeline, taskEngine, eventBus } = createMocks();
      taskEngine.checkPermission.mockReturnValue({ allowed: false, reason: "state denies" });

      await pipeline.execute({
        taskId: "task-42",
        actionClass: "deploy",
        details: { environment: "prod" },
        requestedBy: "orchestrator",
        executeFn: () => null,
      });

      const payload = eventBus.publish.mock.calls[0]?.[0]?.payload;
      expect(payload).toStrictEqual({
        task_id: "task-42",
        action_class: "deploy",
        gate: "task_engine",
        reason: "state denies",
        details: { environment: "prod" },
        requested_by: "orchestrator",
      });
    });

    it("rejection event source is action_pipeline", async () => {
      const { pipeline, taskEngine, eventBus } = createMocks();
      taskEngine.checkPermission.mockReturnValue({ allowed: false, reason: "no" });

      await pipeline.execute({
        taskId: "t1",
        actionClass: "write",
        details: {},
        requestedBy: "orchestrator",
        executeFn: () => null,
      });

      expect(eventBus.publish.mock.calls[0]?.[0]?.source).toBe("action_pipeline");
    });
  });
});
