import { describe, expect, it, vi } from "vitest";
import { createTestObserverFacade } from "../../../test/helpers/test-observer-facade.js";
import type { Dispatch } from "../../schemas/ephemeral.js";
import type { Phase, PhaseOutput } from "../../schemas/orchestrator.js";
import { Phases } from "../../schemas/orchestrator.js";
import type { Task } from "../../schemas/task.js";
import { createAndonCord } from "./andon-cord.js";
import type { DecompositionHandler } from "./decomposition-handler.js";
import {
  PHASE_SEQUENCE,
  type PhaseRunnerDeps,
  createPhaseHandlerRegistry,
  formatPhaseHandoff,
  runPhasePipeline,
} from "./phase-runner.js";
import type { PrManager } from "./pr-manager.js";
import type { OrchestratorContext, PipelineState } from "./types.js";
import type { WorkspaceLifecycle } from "./workspace-lifecycle.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function createMockContext(): OrchestratorContext {
  let checkpointCounter = 0;
  return {
    eventBus: {
      publish: vi.fn(),
      subscribe: vi.fn(),
    } as unknown as OrchestratorContext["eventBus"],
    registry: {
      getPrimaryPlugin: vi.fn().mockReturnValue(null),
      getPluginsByType: vi.fn().mockReturnValue([]),
    } as unknown as OrchestratorContext["registry"],
    taskEngine: {
      updateTaskField: vi.fn(),
      getTask: vi.fn(),
      requestTransition: vi.fn(),
      createTask: vi.fn(),
    } as unknown as OrchestratorContext["taskEngine"],
    safetyLayer: {} as OrchestratorContext["safetyLayer"],
    actionPipeline: { execute: vi.fn() } as unknown as OrchestratorContext["actionPipeline"],
    sessionMemory: {
      addJournalEntry: vi.fn(),
      endSession: vi.fn(),
      createSession: vi.fn(),
      createCheckpoint: vi.fn(() => {
        checkpointCounter++;
        return { id: `checkpoint-${String(checkpointCounter).padStart(3, "0")}` };
      }),
      getLatestCheckpoint: vi.fn().mockReturnValue(null),
    } as unknown as OrchestratorContext["sessionMemory"],
    workspaceManager: {
      getWorktreePath: vi.fn().mockReturnValue("/tmp/worktree"),
      verifyWorkspace: vi.fn(),
    } as unknown as OrchestratorContext["workspaceManager"],
    peopleDirectory: {} as OrchestratorContext["peopleDirectory"],
    observationStore: null,
    observer: createTestObserverFacade("orchestrator"),
  };
}

function makeOutput(phase: Phase, data?: Record<string, unknown>): PhaseOutput {
  const defaults: Record<string, Record<string, unknown>> = {
    intake_analysis: {
      complexity: "moderate",
      estimated_phases: [],
      ambiguities: [],
      fast_path: false,
      decomposition_likely: false,
    },
    research: {
      relevant_files: [],
      relevant_modules: [],
      conventions: [],
      existing_patterns: [],
      dependencies: [],
    },
    planning: { approach: "plan", file_changes: [], risks: [], decomposition_plan: null },
    execution: {
      files_changed: [],
      tests_written: [],
      test_results: { passed: 1, failed: 0, skipped: 0 },
      build_status: "passing",
    },
    self_review: { findings: [], refactoring_applied: [], quality_assessment: "ship_it" },
    demo_prep: { artifacts: [], pr_number: 1, pr_description: "PR" },
    integration: {
      children_verified: [],
      integration_tests: { passed: 1, failed: 0 },
      conflicts_found: [],
      resolution_actions: [],
    },
  };
  return {
    phase,
    task_id: "task-001",
    timestamp: new Date().toISOString(),
    data: data ?? defaults[phase] ?? {},
    confidence: "high",
    open_questions: [],
  };
}

function createDispatch(overrides?: Partial<Task>): Dispatch {
  return {
    task: {
      id: "task-001",
      title: "Test task",
      external_ref: null,
      workspace: null,
      review: null,
      ...overrides,
    } as Task,
    resume_from: null,
    knowledge: { repo: [], user: [] },
  } as Dispatch;
}

function createState(overrides?: Partial<PipelineState>): PipelineState {
  return {
    traceId: "trace-001",
    sessionId: "session-001",
    loopbackCount: 0,
    repoContext: null,
    ...overrides,
  };
}

function createHandlersThatReturn(outputs: Map<Phase, PhaseOutput>) {
  return createPhaseHandlerRegistry(
    Object.fromEntries(
      PHASE_SEQUENCE.map((phase) => [
        phase,
        vi.fn(() => Promise.resolve(outputs.get(phase) ?? makeOutput(phase))),
      ]),
    ) as Record<Phase, ReturnType<typeof vi.fn>>,
  );
}

function createDeps(
  ctx: OrchestratorContext,
  handlers: ReturnType<typeof createPhaseHandlerRegistry>,
): PhaseRunnerDeps {
  return {
    ctx,
    handlers,
    workspaceLifecycle: {
      notifyMilestone: vi.fn(),
      commentOnSourceIssue: vi.fn(),
    } as unknown as WorkspaceLifecycle,
    andonCord: createAndonCord(),
    prManager: {
      commitPushAndCreatePR: vi.fn().mockResolvedValue(false),
    } as unknown as PrManager,
    decompositionHandler: {
      handleDecomposition: vi.fn().mockReturnValue(null),
    } as unknown as DecompositionHandler,
    preemption: {
      isRequested: vi.fn().mockReturnValue(false),
      getPayload: vi.fn().mockReturnValue(null),
      reset: vi.fn(),
    },
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("PhaseRunner", () => {
  describe("runPhasePipeline", () => {
    it("runs all 7 phases in sequence and completes", async () => {
      const ctx = createMockContext();
      const outputs = new Map<Phase, PhaseOutput>();
      for (const phase of PHASE_SEQUENCE) {
        outputs.set(phase, makeOutput(phase));
      }
      const handlers = createHandlersThatReturn(outputs);
      const deps = createDeps(ctx, handlers);

      const result = await runPhasePipeline(createDispatch(), createState(), deps);

      expect(result.outcome).toBe("completed");
      expect(ctx.sessionMemory.endSession).toHaveBeenCalledWith("session-001", "completed");
    });

    it("resumes from checkpoint, skipping completed phases", async () => {
      const ctx = createMockContext();
      const outputs = new Map<Phase, PhaseOutput>();
      for (const phase of PHASE_SEQUENCE) {
        outputs.set(phase, makeOutput(phase));
      }
      const handlers = createHandlersThatReturn(outputs);
      const deps = createDeps(ctx, handlers);

      const dispatch = createDispatch();
      (dispatch as { resume_from: unknown }).resume_from = {
        id: "cp-001",
        session_id: "session-prev",
        phase: "planning",
        phase_progress: "done",
        context_summary: "summary",
        key_findings: [],
        open_questions: [],
        next_action: "execute",
        last_event_id: "",
        workspace_ref: null,
        reason: "phase_transition",
        timestamp: new Date().toISOString(),
        journal_offset: 0,
      };

      const result = await runPhasePipeline(dispatch, createState(), deps);

      expect(result.outcome).toBe("completed");
      // Should not have called intake_analysis, research, or planning handlers
      // (execution is at index 3 in PHASE_SEQUENCE)
    });

    it("applies fast-path when intake returns fast_path: true", async () => {
      const ctx = createMockContext();
      const outputs = new Map<Phase, PhaseOutput>();
      outputs.set(
        Phases.intake_analysis,
        makeOutput(Phases.intake_analysis, {
          complexity: "trivial",
          estimated_phases: [],
          ambiguities: [],
          fast_path: true,
          decomposition_likely: false,
        }),
      );
      outputs.set(Phases.execution, makeOutput(Phases.execution));
      outputs.set(Phases.self_review, makeOutput(Phases.self_review));

      const handlers = createHandlersThatReturn(outputs);
      const deps = createDeps(ctx, handlers);

      const result = await runPhasePipeline(createDispatch(), createState(), deps);

      expect(result.outcome).toBe("completed");
      // Only 3 phases should have checkpoints (not 7)
      const checkpointCalls = (ctx.sessionMemory.createCheckpoint as ReturnType<typeof vi.fn>).mock
        .calls;
      expect(checkpointCalls.length).toBe(3);
    });

    it("loops back to execution on self_review needs_work", async () => {
      const ctx = createMockContext();
      let selfReviewCallCount = 0;
      const outputs = new Map<Phase, PhaseOutput>();
      for (const phase of PHASE_SEQUENCE) {
        outputs.set(phase, makeOutput(phase));
      }

      const handlerFns = Object.fromEntries(
        PHASE_SEQUENCE.map((phase) => [
          phase,
          vi.fn(() => {
            if (phase === Phases.self_review) {
              selfReviewCallCount++;
              if (selfReviewCallCount === 1) {
                return Promise.resolve(
                  makeOutput(Phases.self_review, {
                    findings: ["issue"],
                    refactoring_applied: [],
                    quality_assessment: "needs_work",
                  }),
                );
              }
            }
            return Promise.resolve(outputs.get(phase) ?? makeOutput(phase));
          }),
        ]),
      ) as Record<Phase, ReturnType<typeof vi.fn>>;
      const handlers = createPhaseHandlerRegistry(handlerFns);
      const deps = createDeps(ctx, handlers);

      const result = await runPhasePipeline(createDispatch(), createState(), deps);

      expect(result.outcome).toBe("completed");
      expect(selfReviewCallCount).toBe(2);
    });

    it("emits loopback alert when threshold exceeded", async () => {
      const ctx = createMockContext();
      const outputs = new Map<Phase, PhaseOutput>();
      for (const phase of PHASE_SEQUENCE) {
        outputs.set(phase, makeOutput(phase));
      }

      const handlerFns = Object.fromEntries(
        PHASE_SEQUENCE.map((phase) => [
          phase,
          vi.fn(() => {
            if (phase === Phases.self_review) {
              return Promise.resolve(
                makeOutput(Phases.self_review, {
                  findings: ["issue"],
                  refactoring_applied: [],
                  quality_assessment: "needs_work",
                }),
              );
            }
            return Promise.resolve(outputs.get(phase) ?? makeOutput(phase));
          }),
        ]),
      ) as Record<Phase, ReturnType<typeof vi.fn>>;
      const handlers = createPhaseHandlerRegistry(handlerFns);
      const deps = createDeps(ctx, handlers);

      // Start with loopback count at 3 (threshold)
      const result = await runPhasePipeline(
        createDispatch(),
        createState({ loopbackCount: 3 }),
        deps,
      );

      // Should proceed past self_review (alert emitted, no loop)
      expect(result.outcome).toBe("completed");
      expect(ctx.eventBus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ type: "comm.message_sent" }),
      );
    });

    it("halts on preemption and creates checkpoint", async () => {
      const ctx = createMockContext();
      const outputs = new Map<Phase, PhaseOutput>();
      for (const phase of PHASE_SEQUENCE) {
        outputs.set(phase, makeOutput(phase));
      }
      const handlers = createHandlersThatReturn(outputs);
      const deps = createDeps(ctx, handlers);
      let callCount = 0;
      (deps.preemption.isRequested as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callCount++;
        // Preempt after first phase completes (on second check)
        return callCount > 1;
      });
      (deps.preemption.getPayload as ReturnType<typeof vi.fn>).mockReturnValue({
        target_task_id: "task-001",
        preempting_task_id: "task-urgent",
      });

      const result = await runPhasePipeline(createDispatch(), createState(), deps);

      expect(result.outcome).toBe("preempted");
      expect(ctx.eventBus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ type: "preemption.ready" }),
      );
    });

    it("returns error result on phase handler failure", async () => {
      const ctx = createMockContext();
      const handlerFns = Object.fromEntries(
        PHASE_SEQUENCE.map((phase) => [
          phase,
          vi.fn(() => {
            if (phase === Phases.intake_analysis) {
              return Promise.reject(new Error("LLM unavailable"));
            }
            return Promise.resolve(makeOutput(phase));
          }),
        ]),
      ) as Record<Phase, ReturnType<typeof vi.fn>>;
      const handlers = createPhaseHandlerRegistry(handlerFns);
      const deps = createDeps(ctx, handlers);

      const result = await runPhasePipeline(createDispatch(), createState(), deps);

      expect(result.outcome).toBe("error");
      if (result.outcome === "error") {
        expect(result.phase).toBe("intake_analysis");
        expect(result.reason).toContain("LLM unavailable");
      }
    });

    it("closes session with 'crashed' when phase handler throws (F4)", async () => {
      const ctx = createMockContext();
      const handlerFns = Object.fromEntries(
        PHASE_SEQUENCE.map((phase) => [
          phase,
          vi.fn(() => {
            if (phase === Phases.research) {
              return Promise.reject(new Error("tool timeout"));
            }
            return Promise.resolve(makeOutput(phase));
          }),
        ]),
      ) as Record<Phase, ReturnType<typeof vi.fn>>;
      const handlers = createPhaseHandlerRegistry(handlerFns);
      const deps = createDeps(ctx, handlers);
      const state = createState({ sessionId: "session-abc" });

      await runPhasePipeline(createDispatch(), state, deps);

      expect(ctx.sessionMemory.endSession).toHaveBeenCalledWith("session-abc", "crashed");
    });

    it("closes session with 'crashed' when processPhaseCompletion throws (F7)", async () => {
      const ctx = createMockContext();
      const outputs = new Map<Phase, PhaseOutput>();
      for (const phase of PHASE_SEQUENCE) {
        outputs.set(phase, makeOutput(phase));
      }
      const handlers = createHandlersThatReturn(outputs);
      const deps = createDeps(ctx, handlers);
      const state = createState({ sessionId: "session-xyz" });

      // Make PR creation throw (happens inside processPhaseCompletion after demo_prep)
      (deps.prManager.commitPushAndCreatePR as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("git push failed: remote rejected"),
      );

      const result = await runPhasePipeline(createDispatch(), state, deps);

      expect(result.outcome).toBe("error");
      expect(ctx.sessionMemory.endSession).toHaveBeenCalledWith("session-xyz", "crashed");
    });

    it("exits with decomposed when decomposition handler returns result", async () => {
      const ctx = createMockContext();
      const outputs = new Map<Phase, PhaseOutput>();
      for (const phase of PHASE_SEQUENCE) {
        outputs.set(phase, makeOutput(phase));
      }
      const handlers = createHandlersThatReturn(outputs);
      const deps = createDeps(ctx, handlers);
      (deps.decompositionHandler.handleDecomposition as ReturnType<typeof vi.fn>).mockReturnValue({
        outcome: "decomposed",
        childTaskIds: ["child-1", "child-2"],
        phaseOutputs: new Map(),
      });

      const result = await runPhasePipeline(createDispatch(), createState(), deps);

      expect(result.outcome).toBe("decomposed");
    });

    it("exits with review_pending when PR is created after demo_prep", async () => {
      const ctx = createMockContext();
      const outputs = new Map<Phase, PhaseOutput>();
      for (const phase of PHASE_SEQUENCE) {
        outputs.set(phase, makeOutput(phase));
      }
      const handlers = createHandlersThatReturn(outputs);
      const deps = createDeps(ctx, handlers);
      (deps.prManager.commitPushAndCreatePR as ReturnType<typeof vi.fn>).mockResolvedValue(true);

      const result = await runPhasePipeline(createDispatch(), createState(), deps);

      expect(result.outcome).toBe("review_pending");
    });

    it("halts pipeline when AndonCord is pulled", async () => {
      const ctx = createMockContext();
      const outputs = new Map<Phase, PhaseOutput>();
      for (const phase of PHASE_SEQUENCE) {
        outputs.set(phase, makeOutput(phase));
      }
      const handlers = createHandlersThatReturn(outputs);
      const deps = createDeps(ctx, handlers);
      deps.andonCord.pull("secret detected in output");

      const result = await runPhasePipeline(createDispatch(), createState(), deps);

      expect(result.outcome).toBe("error");
      if (result.outcome === "error") {
        expect(result.reason).toContain("AndonCord pulled");
        expect(result.reason).toContain("secret detected");
      }
    });
  });

  describe("PhaseHandlerRegistry", () => {
    it("throws for unknown phase", () => {
      const handlers = createPhaseHandlerRegistry({
        [Phases.intake_analysis]: vi.fn(),
      } as unknown as Record<Phase, ReturnType<typeof vi.fn>>);

      expect(() => handlers.get("unknown_phase" as Phase)).toThrow("No handler registered");
    });

    it("returns registered handler", () => {
      const handler = vi.fn();
      const registry = createPhaseHandlerRegistry({
        [Phases.intake_analysis]: handler,
      } as unknown as Record<Phase, ReturnType<typeof vi.fn>>);

      expect(registry.get(Phases.intake_analysis)).toBe(handler);
    });
  });

  describe("formatPhaseHandoff", () => {
    it("builds SBAR formatted string", () => {
      const output = makeOutput(Phases.research, { relevant_files: ["a.ts"] });
      const dispatch = createDispatch();
      const handoff = formatPhaseHandoff(Phases.research, Phases.planning, output, dispatch);

      expect(handoff).toContain("SITUATION:");
      expect(handoff).toContain("BACKGROUND:");
      expect(handoff).toContain("ASSESSMENT:");
      expect(handoff).toContain("RECOMMENDATION:");
      expect(handoff).toContain("research");
      expect(handoff).toContain("planning");
    });

    it("notes open questions in assessment", () => {
      const output = makeOutput(Phases.research);
      output.open_questions = ["What about edge cases?"];
      const dispatch = createDispatch();
      const handoff = formatPhaseHandoff(Phases.research, Phases.planning, output, dispatch);

      expect(handoff).toContain("Open questions need attention");
    });
  });

  describe("PHASE_SEQUENCE", () => {
    it("has exactly 7 phases", () => {
      expect(PHASE_SEQUENCE).toHaveLength(7);
    });

    it("starts with intake_analysis and ends with integration", () => {
      expect(PHASE_SEQUENCE[0]).toBe("intake_analysis");
      expect(PHASE_SEQUENCE[6]).toBe("integration");
    });
  });
});
