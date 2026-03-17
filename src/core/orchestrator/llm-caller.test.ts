import { describe, expect, it, vi } from "vitest";
import { createTestObserverFacade } from "../../../test/helpers/test-observer-facade.js";
import type { CompletionResult } from "../../schemas/adapters.js";
import { createLlmCaller, isRetryableError } from "./llm-caller.js";
import type { OrchestratorContext } from "./types.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function createMockContext(overrides?: Partial<OrchestratorContext>): OrchestratorContext {
  return {
    eventBus: {
      publish: vi.fn(),
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      replay: vi.fn(),
      getEventsForTask: vi.fn().mockReturnValue([]),
      getEventsSince: vi.fn().mockReturnValue([]),
    } as unknown as OrchestratorContext["eventBus"],
    registry: {
      getPrimaryPlugin: vi.fn().mockReturnValue(null),
      getPluginsByType: vi.fn().mockReturnValue([]),
      getPlugin: vi.fn().mockReturnValue(null),
    } as unknown as OrchestratorContext["registry"],
    taskEngine: {
      checkPermission: vi.fn().mockReturnValue({ allowed: true }),
      updateTaskField: vi.fn(),
      getTask: vi.fn(),
      requestTransition: vi.fn(),
      updateTracking: vi.fn(),
      createTask: vi.fn(),
    } as unknown as OrchestratorContext["taskEngine"],
    safetyLayer: {} as OrchestratorContext["safetyLayer"],
    actionPipeline: {
      execute: vi.fn(async <T>(input: { executeFn: () => Promise<T> }) => ({
        outcome: "executed" as const,
        result: await input.executeFn(),
      })),
    } as unknown as OrchestratorContext["actionPipeline"],
    sessionMemory: {
      createSession: vi.fn(),
      endSession: vi.fn(),
      addJournalEntry: vi.fn(),
      createCheckpoint: vi.fn(),
      getLatestCheckpoint: vi.fn(),
      storeKnowledge: vi.fn(),
      getKnowledge: vi.fn().mockReturnValue([]),
      queryJournal: vi.fn().mockReturnValue([]),
      getSessionChain: vi.fn().mockReturnValue([]),
    } as unknown as OrchestratorContext["sessionMemory"],
    workspaceManager: {
      getWorktreePath: vi.fn().mockReturnValue("/tmp/worktree"),
      getWorkspaceRecord: vi.fn().mockReturnValue(null),
      createWorkspace: vi.fn(),
      verifyWorkspace: vi.fn(),
      registerExistingWorkspace: vi.fn(),
      pushBranch: vi.fn(),
      cleanupWorkspace: vi.fn(),
    } as unknown as OrchestratorContext["workspaceManager"],
    peopleDirectory: {
      getOwner: vi.fn().mockReturnValue(null),
      resolveContact: vi.fn().mockReturnValue(null),
    } as unknown as OrchestratorContext["peopleDirectory"],
    observationStore: null,
    observer: createTestObserverFacade("orchestrator"),
    ...overrides,
  };
}

function makeCompletion(content: string): CompletionResult {
  return {
    content,
    tool_calls: null,
    finish_reason: "stop",
    usage: { tokens_in: 100, tokens_out: 50, spend_usd: 0.01, remaining: null, resets_at: null },
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("LlmCaller", () => {
  describe("callLlm", () => {
    it("calls LLM through ActionPipeline successfully", async () => {
      const completion = makeCompletion("hello");
      const fakeLlm = {
        complete: vi.fn().mockResolvedValue(completion),
        getCapabilities: vi.fn().mockReturnValue({ max_context: 128_000 }),
      };
      const ctx = createMockContext();
      (ctx.registry.getPrimaryPlugin as ReturnType<typeof vi.fn>).mockReturnValue(fakeLlm);

      const caller = createLlmCaller(ctx);
      const result = await caller.callLlm("test prompt", "task-001");

      expect(result.content).toBe("hello");
      expect(fakeLlm.complete).toHaveBeenCalledOnce();
    });

    it("throws when no LLM plugin is registered", async () => {
      const ctx = createMockContext();
      const caller = createLlmCaller(ctx);

      await expect(caller.callLlm("test", "task-001")).rejects.toThrow("no LLM plugin");
    });

    it("throws when pipeline rejects the call", async () => {
      const fakeLlm = {
        complete: vi.fn().mockResolvedValue(makeCompletion("ok")),
        getCapabilities: vi.fn(),
      };
      const ctx = createMockContext();
      (ctx.registry.getPrimaryPlugin as ReturnType<typeof vi.fn>).mockReturnValue(fakeLlm);
      (ctx.actionPipeline.execute as ReturnType<typeof vi.fn>).mockResolvedValue({
        outcome: "rejected",
        reason: "cost limit",
      });

      const caller = createLlmCaller(ctx);
      await expect(caller.callLlm("test", "task-001")).rejects.toThrow("LLM call rejected");
    });

    it("retries on transient errors", async () => {
      const fakeLlm = {
        complete: vi
          .fn()
          .mockRejectedValueOnce(new Error("503 service unavailable"))
          .mockResolvedValueOnce(makeCompletion("recovered")),
        getCapabilities: vi.fn(),
      };
      const ctx = createMockContext();
      (ctx.registry.getPrimaryPlugin as ReturnType<typeof vi.fn>).mockReturnValue(fakeLlm);

      const caller = createLlmCaller(ctx);
      const result = await caller.callLlm("test", "task-001");

      expect(result.content).toBe("recovered");
      expect(fakeLlm.complete).toHaveBeenCalledTimes(2);
    });

    it("does not retry non-retryable errors", async () => {
      const fakeLlm = {
        complete: vi.fn().mockRejectedValueOnce(new Error("authentication failed")),
        getCapabilities: vi.fn(),
      };
      const ctx = createMockContext();
      (ctx.registry.getPrimaryPlugin as ReturnType<typeof vi.fn>).mockReturnValue(fakeLlm);

      const caller = createLlmCaller(ctx);
      await expect(caller.callLlm("test", "task-001")).rejects.toThrow("authentication failed");
      expect(fakeLlm.complete).toHaveBeenCalledOnce();
    });

    it("throws after exhausting retries", async () => {
      const fakeLlm = {
        complete: vi.fn().mockRejectedValue(new Error("timeout")),
        getCapabilities: vi.fn(),
      };
      const ctx = createMockContext();
      (ctx.registry.getPrimaryPlugin as ReturnType<typeof vi.fn>).mockReturnValue(fakeLlm);

      const caller = createLlmCaller(ctx);
      await expect(caller.callLlm("test", "task-001")).rejects.toThrow("timeout");
      expect(fakeLlm.complete).toHaveBeenCalledTimes(3);
    });
  });

  describe("isRetryableError", () => {
    it("returns true for timeout errors", () => {
      expect(isRetryableError(new Error("request timeout"))).toBe(true);
    });

    it("returns true for rate limit errors", () => {
      expect(isRetryableError(new Error("429 rate limit exceeded"))).toBe(true);
    });

    it("returns true for 503 errors", () => {
      expect(isRetryableError(new Error("503 service unavailable"))).toBe(true);
    });

    it("returns true for 529 overloaded errors", () => {
      expect(isRetryableError(new Error("529 overloaded"))).toBe(true);
    });

    it("returns false for non-Error values", () => {
      expect(isRetryableError("string error")).toBe(false);
    });

    it("returns false for authentication errors", () => {
      expect(isRetryableError(new Error("401 unauthorized"))).toBe(false);
    });
  });

  describe("emitCostIncurred", () => {
    it("publishes cost.incurred event with correct payload", () => {
      const ctx = createMockContext();
      const caller = createLlmCaller(ctx);
      const completion = makeCompletion("test");

      caller.emitCostIncurred("task-001", completion);

      expect(ctx.eventBus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "cost.incurred",
          task_id: "task-001",
          payload: expect.objectContaining({
            tokens_in: 100,
            tokens_out: 50,
            spend_usd: 0.01,
          }),
        }),
      );
    });
  });
});
