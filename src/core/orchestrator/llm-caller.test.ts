import { describe, expect, it, vi } from "vitest";
import { createTestObserverFacade } from "../../../test/helpers/test-observer-facade.js";
import { AdapterMethodError, createAdapterError } from "../../adapters/index.js";
import type { InferenceResult } from "../../schemas/adapters.js";
import { OrchestratorConfigSchema } from "../../schemas/config.js";
import { Complexities, Phases } from "../../schemas/orchestrator.js";
import type { SessionResult } from "../../schemas/orchestrator.js";
import { createLlmCaller, isRetryableError } from "./llm-caller.js";
import { backupSessionResult, readSessionResult } from "./session-result.js";

// Mock session-result reader — allows tests to control what readSessionResult returns
vi.mock("./session-result.js", () => ({
  readSessionResult: vi.fn().mockReturnValue(null),
  backupSessionResult: vi.fn(),
}));
import type { OrchestratorContext } from "./types.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function createMockContext(overrides?: Partial<OrchestratorContext>): OrchestratorContext {
  return {
    config: OrchestratorConfigSchema.parse({}),
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
    notifications: {
      notify: vi.fn(),
      syncStateToCommPlugin: vi.fn(),
    } as unknown as OrchestratorContext["notifications"],
    tracesDir: null,
    ...overrides,
  };
}

function makeCompletion(content: string): InferenceResult {
  return {
    content,
    cost_usd: 0.01,
    duration_ms: 150,
    usage: null,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("LlmCaller", () => {
  describe("callLlm", () => {
    it("calls LLM through ActionPipeline successfully", async () => {
      const completion = makeCompletion("hello");
      const fakeLlm = {
        infer: vi.fn().mockResolvedValue(completion),
        getCapabilities: vi.fn().mockReturnValue({
          model_id: "test-model",
          supports_usage_reporting: false,
          supports_quota_reporting: false,
          context_window: null,
        }),
      };
      const ctx = createMockContext();
      (ctx.registry.getPrimaryPlugin as ReturnType<typeof vi.fn>).mockReturnValue(fakeLlm);

      const caller = createLlmCaller(ctx);
      const result = await caller.callLlm("test prompt", "task-001");

      expect(result.content).toBe("hello");
      expect(fakeLlm.infer).toHaveBeenCalledOnce();
    });

    it("throws when no LLM plugin is registered", async () => {
      const ctx = createMockContext();
      const caller = createLlmCaller(ctx);

      await expect(caller.callLlm("test", "task-001")).rejects.toThrow("no LLM plugin");
    });

    it("throws when pipeline rejects the call", async () => {
      const fakeLlm = {
        infer: vi.fn().mockResolvedValue(makeCompletion("ok")),
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
        infer: vi
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
      expect(fakeLlm.infer).toHaveBeenCalledTimes(2);
    });

    it("does not retry non-retryable errors", async () => {
      const fakeLlm = {
        infer: vi.fn().mockRejectedValueOnce(new Error("authentication failed")),
        getCapabilities: vi.fn(),
      };
      const ctx = createMockContext();
      (ctx.registry.getPrimaryPlugin as ReturnType<typeof vi.fn>).mockReturnValue(fakeLlm);

      const caller = createLlmCaller(ctx);
      await expect(caller.callLlm("test", "task-001")).rejects.toThrow("authentication failed");
      expect(fakeLlm.infer).toHaveBeenCalledOnce();
    });

    it("throws after exhausting retries", async () => {
      const fakeLlm = {
        infer: vi.fn().mockRejectedValue(new Error("timeout")),
        getCapabilities: vi.fn(),
      };
      const ctx = createMockContext();
      (ctx.registry.getPrimaryPlugin as ReturnType<typeof vi.fn>).mockReturnValue(fakeLlm);

      const caller = createLlmCaller(ctx);
      await expect(caller.callLlm("test", "task-001")).rejects.toThrow("timeout");
      expect(fakeLlm.infer).toHaveBeenCalledTimes(3);
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

    it("returns true for AdapterMethodError with retryable: true", () => {
      const err = new AdapterMethodError(
        createAdapterError("cli_error", "some transient failure", { retryable: true }),
      );
      expect(isRetryableError(err)).toBe(true);
    });

    it("returns false for AdapterMethodError with retryable: false", () => {
      const err = new AdapterMethodError(
        createAdapterError("cli_error", "CLI exited with code 143: killed", { retryable: false }),
      );
      expect(isRetryableError(err)).toBe(false);
    });

    it("does not false-positive on long message containing 'timeout' deep in body", () => {
      // Simulate a CLI error where "timeout" appears far into the output (beyond 500 chars)
      const padding = "x".repeat(600);
      const err = new Error(`CLI error: ${padding} timeout occurred in user code`);
      expect(isRetryableError(err)).toBe(false);
    });

    it("matches 'timeout' when it appears in the first 500 chars", () => {
      const err = new Error("request timeout after 30s");
      expect(isRetryableError(err)).toBe(true);
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
            spend_usd: 0.01,
            duration_ms: 150,
          }),
        }),
      );
    });
  });

  describe("runPhaseWithCli error recovery", () => {
    const readSessionResultMock = vi.mocked(readSessionResult);

    function setupForRunPhaseWithCli() {
      readSessionResultMock.mockReset().mockReturnValue(null);

      const fakeLlm = {
        infer: vi.fn(),
        getCapabilities: vi
          .fn()
          .mockReturnValue({ model_id: "test-model", context_window: 100000 }),
        hasCapability: vi.fn().mockReturnValue(true),
        manifest: { id: "test-llm", type: "llm" as const },
      };

      const ctx = createMockContext();
      (ctx.registry.getPrimaryPlugin as ReturnType<typeof vi.fn>).mockReturnValue(fakeLlm);
      return { ctx, fakeLlm };
    }

    it("recovers when callLlm throws but session-result.json exists with status ready", async () => {
      const { ctx, fakeLlm } = setupForRunPhaseWithCli();
      fakeLlm.infer.mockRejectedValue(new Error("CLI exited with code 143"));

      const sessionResult: SessionResult = {
        status: "ready",
        next_phase: Phases.self_review,
        summary: "Implementation complete",
        complexity: Complexities.trivial,
      };
      readSessionResultMock.mockReturnValue(sessionResult);

      const caller = createLlmCaller(ctx);
      const output = await caller.runPhaseWithCli(
        Phases.execution,
        "task-001",
        "system prompt",
        "do work",
        {
          traceId: "trace-001",
          sessionId: "session-001",
          loopbackCount: 0,
          requirementsLoopCount: 0,
          thoughtsDir: null,
          repoContext: null,
          returnToPhase: null,
          phaseSequence: 1,
        },
        "thoughts/2026-03-31-issue-5",
      );

      expect(output.data["status"]).toBe("ready");
      expect(output.data["next_phase"]).toBe(Phases.self_review);
      expect(output.data["summary"]).toBe("Implementation complete");
    });

    it("recovers when session-result.json has status need_more_info", async () => {
      const { ctx, fakeLlm } = setupForRunPhaseWithCli();
      fakeLlm.infer.mockRejectedValue(new Error("CLI exited with code 143"));

      const sessionResult: SessionResult = {
        status: "need_more_info",
        next_phase: Phases.requirements_gathering,
        summary: "Need clarification on scope",
        complexity: Complexities.moderate,
      };
      readSessionResultMock.mockReturnValue(sessionResult);

      const caller = createLlmCaller(ctx);
      const output = await caller.runPhaseWithCli(
        Phases.execution,
        "task-001",
        "system prompt",
        "do work",
        {
          traceId: "trace-001",
          sessionId: "session-001",
          loopbackCount: 0,
          requirementsLoopCount: 0,
          thoughtsDir: null,
          repoContext: null,
          returnToPhase: null,
          phaseSequence: 1,
        },
        "thoughts/2026-03-31-issue-5",
      );

      expect(output.data["status"]).toBe("need_more_info");
    });

    it("rethrows when callLlm throws and no session-result.json found", async () => {
      const { ctx, fakeLlm } = setupForRunPhaseWithCli();
      fakeLlm.infer.mockRejectedValue(new Error("CLI crashed hard"));
      readSessionResultMock.mockReturnValue(null);

      const caller = createLlmCaller(ctx);
      await expect(
        caller.runPhaseWithCli(
          Phases.execution,
          "task-001",
          "system prompt",
          "do work",
          {
            traceId: "trace-001",
            sessionId: "session-001",
            loopbackCount: 0,
            requirementsLoopCount: 0,
            thoughtsDir: null,
            repoContext: null,
            returnToPhase: null,
            phaseSequence: 1,
          },
          "thoughts/2026-03-31-issue-5",
        ),
      ).rejects.toThrow("CLI crashed hard");
    });

    it("rethrows when callLlm throws and session-result.json is invalid", async () => {
      const { ctx, fakeLlm } = setupForRunPhaseWithCli();
      fakeLlm.infer.mockRejectedValue(new Error("CLI crashed hard"));
      readSessionResultMock.mockReturnValue("invalid");

      const caller = createLlmCaller(ctx);
      await expect(
        caller.runPhaseWithCli(
          Phases.execution,
          "task-001",
          "system prompt",
          "do work",
          {
            traceId: "trace-001",
            sessionId: "session-001",
            loopbackCount: 0,
            requirementsLoopCount: 0,
            thoughtsDir: null,
            repoContext: null,
            returnToPhase: null,
            phaseSequence: 1,
          },
          "thoughts/2026-03-31-issue-5",
        ),
      ).rejects.toThrow("CLI crashed hard");
    });

    it("skips cost emission on recovery path", async () => {
      const { ctx, fakeLlm } = setupForRunPhaseWithCli();
      fakeLlm.infer.mockRejectedValue(new Error("CLI exited with code 143"));

      const sessionResult: SessionResult = {
        status: "ready",
        next_phase: Phases.self_review,
        summary: "Done",
        complexity: Complexities.trivial,
      };
      readSessionResultMock.mockReturnValue(sessionResult);

      const caller = createLlmCaller(ctx);
      await caller.runPhaseWithCli(
        Phases.execution,
        "task-001",
        "system prompt",
        "do work",
        {
          traceId: "trace-001",
          sessionId: "session-001",
          loopbackCount: 0,
          requirementsLoopCount: 0,
          thoughtsDir: null,
          repoContext: null,
          returnToPhase: null,
          phaseSequence: 1,
        },
        "thoughts/2026-03-31-issue-5",
      );

      // cost.incurred event should NOT be published on recovery path
      const costCalls = (ctx.eventBus.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: unknown[]) => (call[0] as { type: string }).type === "cost.incurred",
      );
      expect(costCalls).toHaveLength(0);
    });
  });

  describe("step-scoped directories and requiresSessionResult", () => {
    const readSessionResultMock = vi.mocked(readSessionResult);
    const backupSessionResultMock = vi.mocked(backupSessionResult);

    function setupForStepTests() {
      readSessionResultMock.mockReset().mockReturnValue(null);
      backupSessionResultMock.mockReset();

      const fakeLlm = {
        infer: vi.fn().mockResolvedValue({
          content: "done",
          cost_usd: 0.01,
          duration_ms: 100,
          usage: null,
        }),
        getCapabilities: vi
          .fn()
          .mockReturnValue({ model_id: "test-model", context_window: 100000 }),
        hasCapability: vi.fn().mockReturnValue(true),
        manifest: { id: "test-llm", type: "llm" as const },
      };

      const ctx = createMockContext();
      (ctx.registry.getPrimaryPlugin as ReturnType<typeof vi.fn>).mockReturnValue(fakeLlm);
      return { ctx, fakeLlm };
    }

    const baseState = {
      traceId: "trace-001",
      sessionId: "session-001",
      loopbackCount: 0,
      requirementsLoopCount: 0,
      thoughtsDir: null,
      repoContext: null,
      returnToPhase: null,
      phaseSequence: 1,
    };

    it("skips backup and validation when requiresSessionResult is false", async () => {
      const { ctx } = setupForStepTests();
      const caller = createLlmCaller(ctx);

      const output = await caller.runPhaseWithCli(
        Phases.self_review,
        "task-001",
        "system prompt",
        "review code",
        baseState,
        "thoughts/2026-04-09-issue-5",
        "review",
        "requirements-check",
        false,
      );

      expect(backupSessionResultMock).not.toHaveBeenCalled();
      expect(readSessionResultMock).not.toHaveBeenCalled();
      expect(output.data["status"]).toBe("ready");
    });

    it("returns synthetic passthrough PhaseOutput when requiresSessionResult is false", async () => {
      const { ctx } = setupForStepTests();
      const caller = createLlmCaller(ctx);

      const output = await caller.runPhaseWithCli(
        Phases.self_review,
        "task-001",
        "system prompt",
        "review code",
        baseState,
        "thoughts/2026-04-09-issue-5",
        "review",
        "requirements-check",
        false,
      );

      expect(output.phase).toBe(Phases.self_review);
      expect(output.data["status"]).toBe("ready");
      expect(output.data["summary"]).toBe("");
      expect(output.data["complexity"]).toBe(Complexities.moderate);
    });

    it("uses step-scoped deliverable_path when stepName is provided", async () => {
      const { ctx } = setupForStepTests();
      const caller = createLlmCaller(ctx);

      const output = await caller.runPhaseWithCli(
        Phases.self_review,
        "task-001",
        "system prompt",
        "review code",
        baseState,
        "thoughts/2026-04-09-issue-5",
        "review",
        "requirements-check",
        false,
      );

      expect(output.data["deliverable_path"]).toBe(
        "thoughts/2026-04-09-issue-5/review/requirements-check",
      );
    });

    it("runs backup and validation when requiresSessionResult is true", async () => {
      const { ctx } = setupForStepTests();
      const sessionResult: SessionResult = {
        status: "ready",
        next_phase: Phases.demo_prep,
        summary: "Refinement complete",
        complexity: Complexities.moderate,
      };
      readSessionResultMock.mockReturnValue(sessionResult);

      const caller = createLlmCaller(ctx);
      const output = await caller.runPhaseWithCli(
        Phases.self_review,
        "task-001",
        "system prompt",
        "refine code",
        baseState,
        "thoughts/2026-04-09-issue-5",
        "review",
        "refinement",
        true,
      );

      expect(backupSessionResultMock).toHaveBeenCalled();
      expect(readSessionResultMock).toHaveBeenCalled();
      expect(output.data["status"]).toBe("ready");
      expect(output.data["next_phase"]).toBe(Phases.demo_prep);
    });

    it("throws when requiresSessionResult is true and session-result.json is missing", async () => {
      const { ctx } = setupForStepTests();
      readSessionResultMock.mockReturnValue(null);

      const caller = createLlmCaller(ctx);
      await expect(
        caller.runPhaseWithCli(
          Phases.self_review,
          "task-001",
          "system prompt",
          "refine code",
          baseState,
          "thoughts/2026-04-09-issue-5",
          "review",
          "refinement",
          true,
        ),
      ).rejects.toThrow("session-result.json was not created by the CLI");
    });

    it("defaults requiresSessionResult to true when omitted", async () => {
      const { ctx } = setupForStepTests();
      readSessionResultMock.mockReturnValue(null);

      const caller = createLlmCaller(ctx);
      await expect(
        caller.runPhaseWithCli(
          Phases.execution,
          "task-001",
          "system prompt",
          "do work",
          baseState,
          "thoughts/2026-04-09-issue-5",
        ),
      ).rejects.toThrow("session-result.json was not created by the CLI");

      expect(backupSessionResultMock).toHaveBeenCalled();
    });
  });
});
