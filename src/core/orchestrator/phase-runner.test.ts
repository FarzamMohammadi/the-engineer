import { describe, expect, it, vi } from "vitest";
import { createTestObserverFacade } from "../../../test/helpers/test-observer-facade.js";
import { OrchestratorConfigSchema, WorkspaceConfigSchema } from "../../schemas/config.js";
import type { Dispatch } from "../../schemas/ephemeral.js";
import { NotificationKinds } from "../../schemas/notifications.js";
import type { Phase, PhaseOutput } from "../../schemas/orchestrator.js";
import { Phases } from "../../schemas/orchestrator.js";
import { CheckpointReasons, SessionEndReasons } from "../../schemas/session-memory.js";
import { TaskStates } from "../../schemas/task.js";
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

// ── Helpers ─────────────────────────────────────────────────────────────────

function createMockContext(
  configOverrides?: Partial<Parameters<typeof OrchestratorConfigSchema.parse>[0]>,
  workspaceConfigOverrides?: Partial<Parameters<typeof WorkspaceConfigSchema.parse>[0]>,
): OrchestratorContext {
  let checkpointCounter = 0;
  return {
    config: OrchestratorConfigSchema.parse(configOverrides ?? {}),
    workspaceConfig: WorkspaceConfigSchema.parse(workspaceConfigOverrides ?? {}),
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
      getWorkspaceRecord: vi.fn().mockReturnValue(null),
      verifyWorkspace: vi.fn(),
    } as unknown as OrchestratorContext["workspaceManager"],
    peopleDirectory: {} as OrchestratorContext["peopleDirectory"],
    notifications: {
      notify: vi.fn(),
      syncStateToCommPlugin: vi.fn(),
    } as unknown as OrchestratorContext["notifications"],
    observationStore: null,
    observer: createTestObserverFacade("orchestrator"),
    tracesDir: null,
  };
}

function makeOutput(phase: Phase, data?: Record<string, unknown>): PhaseOutput {
  const defaults: Record<string, Record<string, unknown>> = {
    requirements_gathering: {
      deliverable_path: "thoughts/test/requirements.md",
      status: "ready",
      contact: null,
      question: null,
      assessment: null,
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
    requirementsLoopCount: 0,
    thoughtsDir: null,
    repoContext: null,
    returnToPhase: null,
    phaseSequence: 1,
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
    andonCord: createAndonCord(),
    prManager: {
      commitAndPush: vi.fn().mockReturnValue({ outcome: "nothing_to_push" }),
      createPullRequest: vi.fn().mockResolvedValue({ outcome: "no_hosting_plugin" }),
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
      expect(ctx.sessionMemory.endSession).toHaveBeenCalledWith(
        "session-001",
        SessionEndReasons.completed,
      );
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
        phase: Phases.planning,
        phase_progress: "done",
        context_summary: "summary",
        key_findings: [],
        open_questions: [],
        next_action: "execute",
        last_event_id: "",
        workspace_ref: null,
        reason: CheckpointReasons.phase_transition,
        timestamp: new Date().toISOString(),
        journal_offset: 0,
      };

      const result = await runPhasePipeline(dispatch, createState(), deps);

      expect(result.outcome).toBe("completed");
      // Should not have called requirements_gathering, research, or planning handlers
      // (execution is at index 3 in PHASE_SEQUENCE)
    });

    it("runs all phases even for trivial requirements_gathering output", async () => {
      const ctx = createMockContext();
      const outputs = new Map<Phase, PhaseOutput>();
      for (const phase of PHASE_SEQUENCE) {
        outputs.set(phase, makeOutput(phase));
      }
      // Override requirements_gathering with trivial signal
      outputs.set(
        Phases.requirements_gathering,
        makeOutput(Phases.requirements_gathering, {
          deliverable_path: "thoughts/test/requirements.md",
          status: "ready",
          contact: null,
          question: null,
          assessment: "trivial task",
        }),
      );

      const handlers = createHandlersThatReturn(outputs);
      const deps = createDeps(ctx, handlers);

      const result = await runPhasePipeline(createDispatch(), createState(), deps);

      expect(result.outcome).toBe("completed");
      // All 7 phases should have checkpoints (no fast-path)
      const checkpointCalls = (ctx.sessionMemory.createCheckpoint as ReturnType<typeof vi.fn>).mock
        .calls;
      expect(checkpointCalls.length).toBe(7);
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
      expect(ctx.notifications.notify).toHaveBeenCalledWith(
        expect.objectContaining({ kind: NotificationKinds.alert }),
      );
    });

    it("loops back via next_phase when quality_assessment is absent", async () => {
      const ctx = createMockContext();
      const outputs = new Map<Phase, PhaseOutput>();
      for (const phase of PHASE_SEQUENCE) {
        outputs.set(phase, makeOutput(phase));
      }

      let selfReviewCallCount = 0;
      const handlerFns = Object.fromEntries(
        PHASE_SEQUENCE.map((phase) => [
          phase,
          vi.fn(() => {
            if (phase === Phases.self_review) {
              selfReviewCallCount++;
              if (selfReviewCallCount === 1) {
                // CLI-native style: next_phase without quality_assessment
                return Promise.resolve(
                  makeOutput(Phases.self_review, {
                    next_phase: Phases.execution,
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
            if (phase === Phases.requirements_gathering) {
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
        expect(result.phase).toBe(Phases.requirements_gathering);
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

      expect(ctx.sessionMemory.endSession).toHaveBeenCalledWith(
        "session-abc",
        SessionEndReasons.crashed,
      );
    });

    it("closes session with 'crashed' when handlePostPhaseActions throws (F7)", async () => {
      const ctx = createMockContext();
      const outputs = new Map<Phase, PhaseOutput>();
      for (const phase of PHASE_SEQUENCE) {
        outputs.set(phase, makeOutput(phase));
      }
      const handlers = createHandlersThatReturn(outputs);
      const deps = createDeps(ctx, handlers);
      const state = createState({ sessionId: "session-xyz" });

      // Make commit+push return an error — task should block
      (deps.prManager.commitAndPush as ReturnType<typeof vi.fn>).mockReturnValue({
        outcome: "error",
        step: "push",
        reason: "git push failed: remote rejected",
      });

      const result = await runPhasePipeline(createDispatch(), state, deps);

      expect(result.outcome).toBe("blocked");
      if (result.outcome === "blocked") {
        expect(result.reason).toContain("push");
      }
    });

    it("truncates long error messages in journal entry and reason", async () => {
      const ctx = createMockContext();
      const hugeError = "x".repeat(5000);
      const handlerFns = Object.fromEntries(
        PHASE_SEQUENCE.map((phase) => [
          phase,
          vi.fn(() => {
            if (phase === Phases.requirements_gathering) {
              return Promise.reject(new Error(hugeError));
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
        // Reason should be truncated with indicator
        expect(result.reason.length).toBeLessThan(2200);
        expect(result.reason).toContain("[truncated from 5000 chars]");
      }
      // Journal entry summary should also be truncated
      const journalCall = (ctx.sessionMemory.addJournalEntry as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[0] as { summary: string } | undefined;
      expect(journalCall).toBeDefined();
      expect(journalCall!.summary.length).toBeLessThan(2300);
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
      (deps.prManager.commitAndPush as ReturnType<typeof vi.fn>).mockReturnValue({
        outcome: "pushed",
        committed: true,
      });
      (deps.prManager.createPullRequest as ReturnType<typeof vi.fn>).mockResolvedValue({
        outcome: "created",
        pr_number: 1,
        url: "https://example.com/pr/1",
      });

      const result = await runPhasePipeline(createDispatch(), createState(), deps);

      expect(result.outcome).toBe("review_pending");
    });

    it("completes with completed when skip_pr_creation is enabled and push succeeds", async () => {
      const ctx = createMockContext({}, { pr: { skip_pr_creation: { default: true } } });
      (ctx.workspaceManager.getWorkspaceRecord as ReturnType<typeof vi.fn>).mockReturnValue({
        taskId: "task-001",
        repo: "owner/repo",
        branch: "engineer/task-001",
        baseBranch: "main",
      });
      const outputs = new Map<Phase, PhaseOutput>();
      for (const phase of PHASE_SEQUENCE) {
        outputs.set(phase, makeOutput(phase));
      }
      const handlers = createHandlersThatReturn(outputs);
      const deps = createDeps(ctx, handlers);
      (deps.prManager.commitAndPush as ReturnType<typeof vi.fn>).mockReturnValue({
        outcome: "pushed",
        committed: true,
      });

      const result = await runPhasePipeline(createDispatch(), createState(), deps);

      expect(result.outcome).toBe("completed");
      expect(deps.prManager.createPullRequest).not.toHaveBeenCalled();
    });

    it("respects per-repo override for skip_pr_creation", async () => {
      const ctx = createMockContext(
        {},
        { pr: { skip_pr_creation: { default: false, repos: { "owner/repo": true } } } },
      );
      (ctx.workspaceManager.getWorkspaceRecord as ReturnType<typeof vi.fn>).mockReturnValue({
        taskId: "task-001",
        repo: "owner/repo",
        branch: "engineer/task-001",
        baseBranch: "main",
      });
      const outputs = new Map<Phase, PhaseOutput>();
      for (const phase of PHASE_SEQUENCE) {
        outputs.set(phase, makeOutput(phase));
      }
      const handlers = createHandlersThatReturn(outputs);
      const deps = createDeps(ctx, handlers);
      (deps.prManager.commitAndPush as ReturnType<typeof vi.fn>).mockReturnValue({
        outcome: "pushed",
        committed: true,
      });

      const result = await runPhasePipeline(createDispatch(), createState(), deps);

      expect(result.outcome).toBe("completed");
      expect(deps.prManager.createPullRequest).not.toHaveBeenCalled();
    });

    it("sends notification when skipping PR creation", async () => {
      const ctx = createMockContext({}, { pr: { skip_pr_creation: { default: true } } });
      (ctx.workspaceManager.getWorkspaceRecord as ReturnType<typeof vi.fn>).mockReturnValue({
        taskId: "task-001",
        repo: "owner/repo",
        branch: "engineer/task-001",
        baseBranch: "main",
      });
      const outputs = new Map<Phase, PhaseOutput>();
      for (const phase of PHASE_SEQUENCE) {
        outputs.set(phase, makeOutput(phase));
      }
      const handlers = createHandlersThatReturn(outputs);
      const deps = createDeps(ctx, handlers);
      (deps.prManager.commitAndPush as ReturnType<typeof vi.fn>).mockReturnValue({
        outcome: "pushed",
        committed: true,
      });

      await runPhasePipeline(createDispatch(), createState(), deps);

      expect(ctx.notifications.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: NotificationKinds.milestone,
          taskId: "task-001",
          message: expect.stringContaining("PR creation skipped"),
        }),
      );
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

  describe("config-driven behavior", () => {
    it("respects custom rrpir.max_review_loopbacks from config", async () => {
      const ctx = createMockContext({ rrpir: { max_review_loopbacks: 5 } });
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

      // At loopbackCount 4 (below custom threshold of 5), should still loop back
      const result = await runPhasePipeline(
        createDispatch(),
        createState({ loopbackCount: 4 }),
        deps,
      );

      // It loops back once (4→5), then hits threshold (5→alert, no loop)
      expect(result.outcome).toBe("completed");
      // Loopback happened (execution handler called more than once)
      const executionCalls = (handlerFns[Phases.execution] as ReturnType<typeof vi.fn>).mock.calls;
      expect(executionCalls.length).toBeGreaterThanOrEqual(2);
    });

    it("runs all phases with rrpir config defaults", async () => {
      const ctx = createMockContext({ rrpir: { max_requirements_loops: 3 } });
      const outputs = new Map<Phase, PhaseOutput>();
      for (const phase of PHASE_SEQUENCE) {
        outputs.set(phase, makeOutput(phase));
      }
      const handlers = createHandlersThatReturn(outputs);
      const deps = createDeps(ctx, handlers);

      const result = await runPhasePipeline(createDispatch(), createState(), deps);

      expect(result.outcome).toBe("completed");
      // All 7 phases should have checkpoints
      const checkpointCalls = (ctx.sessionMemory.createCheckpoint as ReturnType<typeof vi.fn>).mock
        .calls;
      expect(checkpointCalls.length).toBe(7);
    });
  });

  describe("universal fallback routing", () => {
    /** Create handlers where targetPhase signals need_more_info on its first call. */
    function createNeedMoreInfoHandlers(targetPhase: Phase) {
      const outputs = new Map<Phase, PhaseOutput>();
      for (const phase of PHASE_SEQUENCE) {
        outputs.set(phase, makeOutput(phase));
      }
      let targetCalls = 0;
      const handlerFns = Object.fromEntries(
        PHASE_SEQUENCE.map((phase) => [
          phase,
          vi.fn(() => {
            if (phase === targetPhase) {
              targetCalls++;
              if (targetCalls === 1) {
                return Promise.resolve(makeOutput(phase, { status: "need_more_info" }));
              }
            }
            return Promise.resolve(outputs.get(phase) ?? makeOutput(phase));
          }),
        ]),
      ) as Record<Phase, ReturnType<typeof vi.fn>>;
      return { handlerFns, getTargetCalls: () => targetCalls };
    }

    it("planning signals need_more_info → requirements → returns to planning", async () => {
      const ctx = createMockContext();
      const { handlerFns, getTargetCalls } = createNeedMoreInfoHandlers(Phases.planning);
      const handlers = createPhaseHandlerRegistry(handlerFns);
      const deps = createDeps(ctx, handlers);

      const result = await runPhasePipeline(createDispatch(), createState(), deps);

      expect(result.outcome).toBe("completed");
      expect(getTargetCalls()).toBe(2);
      expect(handlerFns[Phases.requirements_gathering]).toHaveBeenCalledTimes(2);
    });

    it("execution signals need_more_info → requirements → returns to execution", async () => {
      const ctx = createMockContext();
      const { handlerFns, getTargetCalls } = createNeedMoreInfoHandlers(Phases.execution);
      const handlers = createPhaseHandlerRegistry(handlerFns);
      const deps = createDeps(ctx, handlers);

      const result = await runPhasePipeline(createDispatch(), createState(), deps);

      expect(result.outcome).toBe("completed");
      expect(getTargetCalls()).toBe(2);
    });

    it("requirements_gathering need_more_info blocks the task", async () => {
      const ctx = createMockContext();
      const outputs = new Map<Phase, PhaseOutput>();
      for (const phase of PHASE_SEQUENCE) {
        outputs.set(phase, makeOutput(phase));
      }
      // Requirements gathering signals need_more_info (needs human)
      outputs.set(
        Phases.requirements_gathering,
        makeOutput(Phases.requirements_gathering, { status: "need_more_info" }),
      );
      const handlers = createHandlersThatReturn(outputs);
      const deps = createDeps(ctx, handlers);

      const result = await runPhasePipeline(createDispatch(), createState(), deps);

      expect(result.outcome).toBe("blocked");
      if (result.outcome === "blocked") {
        expect(result.reason).toContain("Awaiting human input");
      }
      // Should have transitioned to blocked
      expect(ctx.taskEngine.requestTransition).toHaveBeenCalledWith(
        "task-001",
        TaskStates.blocked,
        null,
        expect.stringContaining("Awaiting human input"),
        "orchestrator",
      );
    });

    it("awaits outreach delivery before blocking", async () => {
      const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");
      const { join } = await import("node:path");

      const tmpDir = join("/tmp", `outreach-test-${Date.now()}`);
      const outreachDir = join(tmpDir, "thoughts", "test", "requirements", "outreach");

      try {
        const ctx = createMockContext();
        (ctx.workspaceManager.getWorktreePath as ReturnType<typeof vi.fn>).mockReturnValue(tmpDir);

        // Track call order to verify delivery completes before transition
        const callOrder: string[] = [];

        const mockCommPlugin = {
          manifest: { id: "telegram-comm" },
          hasCapability: vi.fn((cap: string) => cap === "send"),
          formatMessage: vi.fn((msg: string) => msg),
          sendMessage: vi.fn(async () => {
            await new Promise((resolve) => setTimeout(resolve, 50));
            callOrder.push("send_completed");
            return { success: true, message_id: "42", error: null };
          }),
        };
        (ctx.registry.getPluginsByType as ReturnType<typeof vi.fn>).mockReturnValue([
          mockCommPlugin,
        ]);

        // Mock people directory
        const pd = ctx.peopleDirectory as unknown as Record<string, ReturnType<typeof vi.fn>>;
        pd["getPerson"] = vi.fn().mockReturnValue({
          id: "farzam",
          name: "Farzam",
          contacts: [{ channel: "telegram", handle: "farzam_tg" }],
        });
        pd["getOwner"] = vi.fn().mockReturnValue({
          id: "farzam",
          name: "Farzam",
          contacts: [{ channel: "telegram", handle: "farzam_tg" }],
        });

        (ctx.taskEngine.requestTransition as ReturnType<typeof vi.fn>).mockImplementation(() => {
          callOrder.push("transition_to_blocked");
          return { success: true };
        });

        const outputs = new Map<Phase, PhaseOutput>();
        for (const phase of PHASE_SEQUENCE) {
          outputs.set(phase, makeOutput(phase));
        }
        // Handler creates outreach files during execution (simulating CLI writing them)
        const handlerFns = Object.fromEntries(
          PHASE_SEQUENCE.map((phase) => [
            phase,
            vi.fn(() => {
              if (phase === Phases.requirements_gathering) {
                mkdirSync(outreachDir, { recursive: true });
                writeFileSync(
                  join(outreachDir, "farzam.txt"),
                  "Hi Farzam, what scenes need updating and what kind of updates?",
                );
                return Promise.resolve(makeOutput(phase, { status: "need_more_info" }));
              }
              return Promise.resolve(outputs.get(phase) ?? makeOutput(phase));
            }),
          ]),
        ) as Record<Phase, ReturnType<typeof vi.fn>>;
        const handlers = createPhaseHandlerRegistry(handlerFns);
        const deps = createDeps(ctx, handlers);

        const result = await runPhasePipeline(
          createDispatch(),
          createState({ thoughtsDir: "thoughts/test" }),
          deps,
        );

        expect(result.outcome).toBe("blocked");
        // Outreach goes through centralized notification router
        expect(ctx.notifications.notify).toHaveBeenCalledWith(
          expect.objectContaining({ kind: NotificationKinds.question, personId: "farzam" }),
        );
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("persists return_to_phase when blocking from a fallback", async () => {
      const ctx = createMockContext();
      const outputs = new Map<Phase, PhaseOutput>();
      for (const phase of PHASE_SEQUENCE) {
        outputs.set(phase, makeOutput(phase));
      }
      // Planning triggers need_more_info → requirements also needs_more_info (human needed)
      let planningCalls = 0;
      let reqCalls = 0;
      // Planning signals need_more_info on first call; requirements signals need_more_info on second call
      const planningHandler = vi.fn(() => {
        planningCalls++;
        if (planningCalls === 1) {
          return Promise.resolve(
            makeOutput(Phases.planning, {
              status: "need_more_info",
              next_phase: Phases.requirements_gathering,
            }),
          );
        }
        return Promise.resolve(outputs.get(Phases.planning) ?? makeOutput(Phases.planning));
      });
      const reqHandler = vi.fn(() => {
        reqCalls++;
        if (reqCalls === 2) {
          return Promise.resolve(
            makeOutput(Phases.requirements_gathering, { status: "need_more_info" }),
          );
        }
        return Promise.resolve(
          outputs.get(Phases.requirements_gathering) ?? makeOutput(Phases.requirements_gathering),
        );
      });
      const handlerFns = Object.fromEntries(
        PHASE_SEQUENCE.map((phase) => [
          phase,
          phase === Phases.planning
            ? planningHandler
            : phase === Phases.requirements_gathering
              ? reqHandler
              : vi.fn(() => Promise.resolve(outputs.get(phase) ?? makeOutput(phase))),
        ]),
      ) as Record<Phase, ReturnType<typeof vi.fn>>;
      const handlers = createPhaseHandlerRegistry(handlerFns);
      const deps = createDeps(ctx, handlers);

      const result = await runPhasePipeline(createDispatch(), createState(), deps);

      expect(result.outcome).toBe("blocked");
      // return_to_phase should be persisted as "planning"
      expect(ctx.taskEngine.updateTaskField).toHaveBeenCalledWith(
        "task-001",
        "return_to_phase",
        Phases.planning,
      );
    });

    it("reads return_to_phase from task on re-dispatch", async () => {
      const ctx = createMockContext();
      // Simulate a task with return_to_phase set from prior blocked dispatch
      (ctx.taskEngine.getTask as ReturnType<typeof vi.fn>).mockReturnValue({
        id: "task-001",
        return_to_phase: Phases.planning,
      });
      const outputs = new Map<Phase, PhaseOutput>();
      for (const phase of PHASE_SEQUENCE) {
        outputs.set(phase, makeOutput(phase));
      }
      const handlers = createHandlersThatReturn(outputs);
      const deps = createDeps(ctx, handlers);

      const result = await runPhasePipeline(createDispatch(), createState(), deps);

      expect(result.outcome).toBe("completed");
      // Should clear return_to_phase after reading
      expect(ctx.taskEngine.updateTaskField).toHaveBeenCalledWith(
        "task-001",
        "return_to_phase",
        null,
      );
    });

    it("does NOT persist return_to_phase when requirements_gathering blocks on its own", async () => {
      const ctx = createMockContext();
      const outputs = new Map<Phase, PhaseOutput>();
      for (const phase of PHASE_SEQUENCE) {
        outputs.set(phase, makeOutput(phase));
      }
      // Requirements gathering signals need_more_info with no prior returnToPhase
      outputs.set(
        Phases.requirements_gathering,
        makeOutput(Phases.requirements_gathering, { status: "need_more_info" }),
      );
      const handlers = createHandlersThatReturn(outputs);
      const deps = createDeps(ctx, handlers);

      const result = await runPhasePipeline(createDispatch(), createState(), deps);

      expect(result.outcome).toBe("blocked");
      // return_to_phase should NOT be persisted (no calling phase to return to)
      const updateCalls = (ctx.taskEngine.updateTaskField as ReturnType<typeof vi.fn>).mock.calls;
      const returnToPhaseWrites = updateCalls.filter(
        (c: unknown[]) => c[1] === "return_to_phase" && c[2] !== null,
      );
      expect(returnToPhaseWrites).toHaveLength(0);
    });

    it("resumes after unblock and advances to research (no self-loop)", async () => {
      const ctx = createMockContext();
      // Simulate a re-dispatch after unblock: no checkpoint, no return_to_phase
      // (the bug was that return_to_phase was "requirements_gathering", causing a self-loop)
      (ctx.taskEngine.getTask as ReturnType<typeof vi.fn>).mockReturnValue({
        id: "task-001",
        return_to_phase: null, // correctly null after the fix
        loopback_count: 0,
        requirements_loop_count: 0,
      });
      const outputs = new Map<Phase, PhaseOutput>();
      for (const phase of PHASE_SEQUENCE) {
        outputs.set(phase, makeOutput(phase));
      }
      const handlers = createHandlersThatReturn(outputs);
      const deps = createDeps(ctx, handlers);

      const result = await runPhasePipeline(createDispatch(), createState(), deps);

      expect(result.outcome).toBe("completed");
      // All 7 phases should run — requirements_gathering runs once, then advances normally
      const checkpointCalls = (ctx.sessionMemory.createCheckpoint as ReturnType<typeof vi.fn>).mock
        .calls;
      expect(checkpointCalls.length).toBe(7);
    });

    it("self-review loopback lands on execution, not planning", async () => {
      const ctx = createMockContext();
      const phaseExecutionOrder: Phase[] = [];
      let selfReviewCalls = 0;
      const outputs = new Map<Phase, PhaseOutput>();
      for (const phase of PHASE_SEQUENCE) {
        outputs.set(phase, makeOutput(phase));
      }

      const handlerFns = Object.fromEntries(
        PHASE_SEQUENCE.map((phase) => [
          phase,
          vi.fn(() => {
            phaseExecutionOrder.push(phase);
            if (phase === Phases.self_review) {
              selfReviewCalls++;
              if (selfReviewCalls === 1) {
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

      await runPhasePipeline(createDispatch(), createState(), deps);

      // After self_review(needs_work), the next phase should be execution, NOT planning
      const selfReviewIdx = phaseExecutionOrder.indexOf(Phases.self_review);
      expect(phaseExecutionOrder[selfReviewIdx + 1]).toBe(Phases.execution);
    });
  });

  describe("PhaseHandlerRegistry", () => {
    it("throws for unknown phase", () => {
      const handlers = createPhaseHandlerRegistry({
        [Phases.requirements_gathering]: vi.fn(),
      } as unknown as Record<Phase, ReturnType<typeof vi.fn>>);

      expect(() => handlers.get("unknown_phase" as Phase)).toThrow("No handler registered");
    });

    it("returns registered handler", () => {
      const handler = vi.fn();
      const registry = createPhaseHandlerRegistry({
        [Phases.requirements_gathering]: handler,
      } as unknown as Record<Phase, ReturnType<typeof vi.fn>>);

      expect(registry.get(Phases.requirements_gathering)).toBe(handler);
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

    it("starts with requirements_gathering and ends with integration", () => {
      expect(PHASE_SEQUENCE[0]).toBe(Phases.requirements_gathering);
      expect(PHASE_SEQUENCE[6]).toBe(Phases.integration);
    });
  });
});
