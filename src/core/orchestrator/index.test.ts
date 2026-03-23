import { beforeEach, describe, expect, it } from "vitest";

import {
  TRIVIAL_REQUIREMENTS_DATA,
  type TestOrchestratorHandle,
  createMockCheckpoint,
  createMockDispatch,
  createMockTask,
  createTestOrchestrator,
} from "../../../test/helpers/test-orchestrator.js";
import { PHASE_SEQUENCE } from "./phase-runner.js";

describe("Orchestrator", () => {
  let handle: TestOrchestratorHandle;

  beforeEach(() => {
    handle = createTestOrchestrator();
  });

  // ── Pipeline Progression ───────────────────────────────────────────────────

  describe("pipeline progression", () => {
    it("runs through all 7 phases and returns completed", async () => {
      handle.setAllPhaseResponses();
      const dispatch = createMockDispatch();

      const result = await handle.orchestrator.executeTask(dispatch);

      expect(result.outcome).toBe("completed");
      if (result.outcome === "completed") {
        expect(result.phaseOutputs.size).toBe(7);
        for (const phase of PHASE_SEQUENCE) {
          expect(result.phaseOutputs.has(phase)).toBe(true);
        }
      }
    });

    it("produces phase outputs in correct order", async () => {
      handle.setAllPhaseResponses();
      const dispatch = createMockDispatch();

      const result = await handle.orchestrator.executeTask(dispatch);

      if (result.outcome === "completed") {
        const phases = [...result.phaseOutputs.keys()];
        expect(phases).toEqual(PHASE_SEQUENCE);
      }
    });

    it("passes correct task_id in each phase output", async () => {
      handle.setAllPhaseResponses();
      const dispatch = createMockDispatch({ task: { id: "my-task-42" } });

      const result = await handle.orchestrator.executeTask(dispatch);

      if (result.outcome === "completed") {
        for (const output of result.phaseOutputs.values()) {
          expect(output.task_id).toBe("my-task-42");
        }
      }
    });

    it("each phase output has correct phase label", async () => {
      handle.setAllPhaseResponses();
      const dispatch = createMockDispatch();

      const result = await handle.orchestrator.executeTask(dispatch);

      if (result.outcome === "completed") {
        for (const [phase, output] of result.phaseOutputs) {
          expect(output.phase).toBe(phase);
        }
      }
    });

    it("calls LLM adapter once per phase", async () => {
      handle.setAllPhaseResponses();
      const dispatch = createMockDispatch();

      await handle.orchestrator.executeTask(dispatch);

      // 7 phases = 7 LLM calls (all through actionPipeline.execute)
      // execution phase has 2 calls: tool + LLM. So total actionPipeline calls = 8
      const llmCalls = handle.actionPipeline.execute.mock.calls.filter(
        (call: any[]) => call[0]?.details?.operation === "llm_infer",
      );
      expect(llmCalls).toHaveLength(7);
    });
  });

  // ── Checkpointing ──────────────────────────────────────────────────────────

  describe("checkpointing", () => {
    it("creates a checkpoint at each phase transition", async () => {
      handle.setAllPhaseResponses();
      const dispatch = createMockDispatch();

      await handle.orchestrator.executeTask(dispatch);

      // 7 phases = 7 checkpoints
      expect(handle.sessionMemory.createCheckpoint).toHaveBeenCalledTimes(7);
    });

    it("checkpoints have reason 'phase_transition'", async () => {
      handle.setAllPhaseResponses();
      const dispatch = createMockDispatch();

      await handle.orchestrator.executeTask(dispatch);

      for (const call of handle.sessionMemory.createCheckpoint.mock.calls) {
        expect(call[0].reason).toBe("phase_transition");
      }
    });

    it("checkpoints contain correct phase names", async () => {
      handle.setAllPhaseResponses();
      const dispatch = createMockDispatch();

      await handle.orchestrator.executeTask(dispatch);

      const checkpointPhases = handle.sessionMemory.createCheckpoint.mock.calls.map(
        (call: unknown[]) => (call[0] as { phase: string }).phase,
      );
      expect(checkpointPhases).toEqual(PHASE_SEQUENCE);
    });

    it("checkpoint nextAction references next phase", async () => {
      handle.setAllPhaseResponses();
      const dispatch = createMockDispatch();

      await handle.orchestrator.executeTask(dispatch);

      const calls = handle.sessionMemory.createCheckpoint.mock.calls;
      // First checkpoint (requirements_gathering) should reference research
      expect((calls[0]![0] as { nextAction: string }).nextAction).toContain("research");
      // Last checkpoint (integration) should say complete
      expect((calls[6]![0] as { nextAction: string }).nextAction).toContain("complete");
    });
  });

  // ── Journal Entries ────────────────────────────────────────────────────────

  describe("journal entries", () => {
    it("logs a phase_change entry at each transition", async () => {
      handle.setAllPhaseResponses();
      const dispatch = createMockDispatch();

      await handle.orchestrator.executeTask(dispatch);

      const phaseChangeCalls = handle.sessionMemory.addJournalEntry.mock.calls.filter(
        (call: unknown[]) => (call[0] as { type: string }).type === "phase_change",
      );
      // 7 phases = 7 phase_change entries
      expect(phaseChangeCalls).toHaveLength(7);
    });

    it("journal entries have correct phase references", async () => {
      handle.setAllPhaseResponses();
      const dispatch = createMockDispatch();

      await handle.orchestrator.executeTask(dispatch);

      const phaseChangeCalls = handle.sessionMemory.addJournalEntry.mock.calls.filter(
        (call: unknown[]) => (call[0] as { type: string }).type === "phase_change",
      );
      const journalPhases = phaseChangeCalls.map(
        (call: unknown[]) => (call[0] as { phase: string }).phase,
      );
      expect(journalPhases).toEqual(PHASE_SEQUENCE);
    });

    it("journal entries include phase_transition tag", async () => {
      handle.setAllPhaseResponses();
      const dispatch = createMockDispatch();

      await handle.orchestrator.executeTask(dispatch);

      const phaseChangeCalls = handle.sessionMemory.addJournalEntry.mock.calls.filter(
        (call: unknown[]) => (call[0] as { type: string }).type === "phase_change",
      );
      for (const call of phaseChangeCalls) {
        expect((call[0] as { tags: string[] }).tags).toContain("phase_transition");
      }
    });
  });

  // ── Task Field Updates ─────────────────────────────────────────────────────

  describe("task field updates", () => {
    it("updates task.session_id at start", async () => {
      handle.setAllPhaseResponses();
      const dispatch = createMockDispatch();

      await handle.orchestrator.executeTask(dispatch);

      const sessionIdCall = handle.taskEngine.updateTaskField.mock.calls.find(
        (call: unknown[]) => (call as string[])[1] === "session_id",
      );
      expect(sessionIdCall).toBeDefined();
    });

    it("updates task.phase for each phase transition", async () => {
      handle.setAllPhaseResponses();
      const dispatch = createMockDispatch();

      await handle.orchestrator.executeTask(dispatch);

      const phaseCalls = handle.taskEngine.updateTaskField.mock.calls.filter(
        (call: unknown[]) => (call as string[])[1] === "phase",
      );
      // 7 phase updates: 1 initial (requirements_gathering) + 6 transitions (research through integration)
      // Last phase (integration) doesn't trigger a transition, but initial set covers requirements_gathering
      expect(phaseCalls).toHaveLength(7);
      const phaseValues = phaseCalls.map((call: unknown[]) => (call as string[])[2]);
      expect(phaseValues).toEqual(PHASE_SEQUENCE);
    });
  });

  // ── Preemption ─────────────────────────────────────────────────────────────

  describe("preemption", () => {
    it("subscribes to preemption.requested in constructor", () => {
      expect(handle.eventBus.subscribe).toHaveBeenCalledWith(
        "orchestrator",
        "preemption.requested",
        expect.any(Function),
      );
    });

    it("returns preempted when preemption flag is set between phases", async () => {
      handle.setAllPhaseResponses();
      const dispatch = createMockDispatch();

      // Trigger preemption before executeTask — it will be checked between phases
      handle.triggerPreemption("task-001", "task-high-priority");

      const result = await handle.orchestrator.executeTask(dispatch);

      expect(result.outcome).toBe("preempted");
    });

    it("creates checkpoint with reason 'preemption'", async () => {
      handle.setAllPhaseResponses();
      const dispatch = createMockDispatch();

      handle.triggerPreemption("task-001", "task-high-priority");
      await handle.orchestrator.executeTask(dispatch);

      // Find the preemption checkpoint
      const preemptionCheckpoint = handle.sessionMemory.createCheckpoint.mock.calls.find(
        (call: unknown[]) => (call[0] as { reason: string }).reason === "preemption",
      );
      expect(preemptionCheckpoint).toBeDefined();
    });

    it("emits preemption.ready event", async () => {
      handle.setAllPhaseResponses();
      const dispatch = createMockDispatch();

      handle.triggerPreemption("task-001", "task-high-priority");
      await handle.orchestrator.executeTask(dispatch);

      const readyEvent = handle.eventBus.publish.mock.calls.find(
        (call: unknown[]) => (call[0] as { type: string }).type === "preemption.ready",
      );
      expect(readyEvent).toBeDefined();
      expect((readyEvent![0] as { payload: { task_id: string } }).payload.task_id).toBe("task-001");
    });

    it("ends session with reason 'preempted'", async () => {
      handle.setAllPhaseResponses();
      const dispatch = createMockDispatch();

      handle.triggerPreemption("task-001", "task-high-priority");
      await handle.orchestrator.executeTask(dispatch);

      expect(handle.sessionMemory.endSession).toHaveBeenCalledWith(expect.any(String), "preempted");
    });
  });

  // ── Resume from Checkpoint ─────────────────────────────────────────────────

  describe("resume from checkpoint", () => {
    it("skips completed phases when resuming", async () => {
      handle.setAllPhaseResponses();
      const checkpoint = createMockCheckpoint({ phase: "research" });
      const dispatch = createMockDispatch({ resume_from: checkpoint });

      // After research, remaining phases are: planning, execution, self_review, demo_prep, integration
      // Need LLM responses for those 5 phases (indices 2-6 in the full sequence)
      const result = await handle.orchestrator.executeTask(dispatch);

      expect(result.outcome).toBe("completed");
      if (result.outcome === "completed") {
        // Should have 5 phase outputs (planning through integration)
        expect(result.phaseOutputs.size).toBe(5);
        expect(result.phaseOutputs.has("requirements_gathering")).toBe(false);
        expect(result.phaseOutputs.has("research")).toBe(false);
        expect(result.phaseOutputs.has("planning")).toBe(true);
      }
    });

    it("creates linked session with previousSessionId", async () => {
      handle.setAllPhaseResponses();
      const checkpoint = createMockCheckpoint({ session_id: "session-old" });
      const dispatch = createMockDispatch({ resume_from: checkpoint });

      await handle.orchestrator.executeTask(dispatch);

      expect(handle.sessionMemory.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          previousSessionId: "session-old",
          resumedFromCheckpoint: checkpoint.id,
        }),
      );
    });

    it("logs a resume journal entry", async () => {
      handle.setAllPhaseResponses();
      const checkpoint = createMockCheckpoint({ phase: "planning" });
      const dispatch = createMockDispatch({ resume_from: checkpoint });

      await handle.orchestrator.executeTask(dispatch);

      const resumeEntry = handle.sessionMemory.addJournalEntry.mock.calls.find(
        (call: unknown[]) => {
          const input = call[0] as { tags?: string[] };
          return input.tags?.includes("resume");
        },
      );
      expect(resumeEntry).toBeDefined();
    });
  });

  // ── safeParse Failure Handling ─────────────────────────────────────────────

  describe("safeParse failure handling", () => {
    it("handles invalid JSON gracefully with fallback output", async () => {
      // Requirements gathering + research use CLI-native (file-based, content ignored).
      // Planning (LLM calls 3+) uses agent loop — override ALL its iterations to return non-JSON.
      // The agent loop exhausts max_iterations and returns empty phaseData → fallback output.
      handle.setAllPhaseResponses();
      let llmCallCount = 0;
      handle.actionPipeline.execute.mockImplementation(
        async (input: { executeFn: () => Promise<unknown>; details?: { operation?: string } }) => {
          if (input.details?.operation === "llm_infer") {
            llmCallCount++;
            // LLM calls 3+ = planning phase and beyond (agent-loop phases)
            // Return non-JSON for all planning iterations so agent loop exhausts retries
            if (llmCallCount >= 3 && llmCallCount <= 12) {
              return {
                outcome: "executed",
                result: {
                  content: "This is not JSON at all",
                  cost_usd: null,
                  duration_ms: 100,
                  usage: null,
                },
              };
            }
          }
          const result = await input.executeFn();
          return { outcome: "executed", result };
        },
      );

      const dispatch = createMockDispatch();
      const result = await handle.orchestrator.executeTask(dispatch);

      // Pipeline should continue despite parse failure
      expect(result.outcome).toBe("completed");
      if (result.outcome === "completed") {
        // Planning phase gets fallback output (low confidence) from agent loop parse failure
        const planningOutput = result.phaseOutputs.get("planning");
        expect(planningOutput?.confidence).toBe("low");
        expect(planningOutput?.open_questions.length).toBeGreaterThan(0);
      }
    });

    it("agent loop recovers from unparseable first response via retry", async () => {
      // First LLM call returns invalid JSON (no "action" field) — agent loop retries
      // and the second call returns valid data, so the phase succeeds with high confidence
      let callCount = 0;
      handle.setAllPhaseResponses();
      handle.actionPipeline.execute.mockImplementation(
        async (input: { executeFn: () => Promise<unknown>; details?: { operation?: string } }) => {
          callCount++;
          if (callCount === 1 && input.details?.operation === "llm_infer") {
            return {
              outcome: "executed",
              result: {
                content: JSON.stringify({ wrong_field: "wrong_value" }),
                cost_usd: null,
                duration_ms: 100,
                usage: null,
              },
            };
          }
          const result = await input.executeFn();
          return { outcome: "executed", result };
        },
      );

      const dispatch = createMockDispatch();
      const result = await handle.orchestrator.executeTask(dispatch);

      expect(result.outcome).toBe("completed");
      if (result.outcome === "completed") {
        const intakeOutput = result.phaseOutputs.get("requirements_gathering");
        // Agent loop retries successfully, so confidence is high
        expect(intakeOutput?.confidence).toBe("high");
      }
    });

    it("fallback output when all LLM responses are unparseable", async () => {
      // Override ALL LLM calls to return non-JSON — agent loop exhausts retries
      // and returns empty phaseData, which fails schema validation → fallback output.
      // CLI-native phases (requirements_gathering, research) ignore content and use
      // file-based routing, so they get "high" confidence from defaults.
      // Agent-loop phases (planning onwards) get "low" confidence fallback.
      handle.actionPipeline.execute.mockImplementation(
        async (input: { executeFn: () => Promise<unknown>; details?: { operation?: string } }) => {
          if (input.details?.operation === "llm_infer") {
            return {
              outcome: "executed",
              result: {
                content: "not json at all",
                cost_usd: null,
                duration_ms: 100,
                usage: null,
              },
            };
          }
          const result = await input.executeFn();
          return { outcome: "executed", result };
        },
      );

      const dispatch = createMockDispatch();
      const result = await handle.orchestrator.executeTask(dispatch);

      if (result.outcome === "completed") {
        // CLI-native phases return file-based output with "high" confidence
        const reqOutput = result.phaseOutputs.get("requirements_gathering");
        expect(reqOutput?.confidence).toBe("high");
        expect(reqOutput?.data).toHaveProperty("status");
        expect(reqOutput?.data).toHaveProperty("deliverable_path");

        // Agent-loop phases get fallback with "low" confidence
        const planningOutput = result.phaseOutputs.get("planning");
        expect(planningOutput?.confidence).toBe("low");
      }
    });
  });

  // ── Action Pipeline Integration ────────────────────────────────────────────

  describe("action pipeline integration", () => {
    it("all phases use ActionPipeline for LLM calls", async () => {
      handle.setAllPhaseResponses();
      const dispatch = createMockDispatch();

      await handle.orchestrator.executeTask(dispatch);

      // Agent loop calls LLM through ActionPipeline (actionClass: "read" for inference)
      const readCalls = handle.actionPipeline.execute.mock.calls.filter(
        (call: unknown[]) => (call[0] as { actionClass: string }).actionClass === "read",
      );
      expect(readCalls.length).toBeGreaterThanOrEqual(7);
    });

    it("handles pipeline rejection gracefully in execution phase", async () => {
      handle.setAllPhaseResponses();
      // Override actionPipeline to reject write actions
      handle.actionPipeline.execute.mockImplementation(
        async (input: { actionClass: string; executeFn: () => Promise<unknown> }) => {
          if (input.actionClass === "write") {
            return { outcome: "rejected", gate: "safety_layer", reason: "cost limit exceeded" };
          }
          const result = await input.executeFn();
          return { outcome: "executed", result };
        },
      );

      const dispatch = createMockDispatch();
      const result = await handle.orchestrator.executeTask(dispatch);

      // Pipeline should complete (tool rejection doesn't halt the pipeline)
      expect(result.outcome).toBe("completed");
    });
  });

  // ── Fast-Path ──────────────────────────────────────────────────────────────

  describe("trivial tasks (no fast-path skip)", () => {
    it("runs all 7 phases even for trivial requirements_gathering output", async () => {
      handle.setAllPhaseResponses();
      // Override first LLM response (intake) with trivial data — pipeline still runs all phases
      handle.setLlmResponseAtIndex(0, TRIVIAL_REQUIREMENTS_DATA);

      const dispatch = createMockDispatch();
      const result = await handle.orchestrator.executeTask(dispatch);

      expect(result.outcome).toBe("completed");
      if (result.outcome === "completed") {
        // All 7 phases run — no fast-path skipping in current architecture
        expect(result.phaseOutputs.size).toBe(7);
        for (const phase of PHASE_SEQUENCE) {
          expect(result.phaseOutputs.has(phase)).toBe(true);
        }
      }
    });

    it("trivial task produces checkpoints for all 7 phases", async () => {
      handle.setAllPhaseResponses();
      handle.setLlmResponseAtIndex(0, TRIVIAL_REQUIREMENTS_DATA);

      const dispatch = createMockDispatch();
      await handle.orchestrator.executeTask(dispatch);

      // 7 phases = 7 checkpoints (no fast-path reduction)
      expect(handle.sessionMemory.createCheckpoint).toHaveBeenCalledTimes(7);
    });
  });

  // ── Session Lifecycle ──────────────────────────────────────────────────────

  describe("session lifecycle", () => {
    it("creates session at start", async () => {
      handle.setAllPhaseResponses();
      const dispatch = createMockDispatch();

      await handle.orchestrator.executeTask(dispatch);

      expect(handle.sessionMemory.createSession).toHaveBeenCalledTimes(1);
      expect(handle.sessionMemory.createSession).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: "task-001" }),
      );
    });

    it("ends session with 'completed' on success", async () => {
      handle.setAllPhaseResponses();
      const dispatch = createMockDispatch();

      await handle.orchestrator.executeTask(dispatch);

      expect(handle.sessionMemory.endSession).toHaveBeenCalledWith(expect.any(String), "completed");
    });
  });

  // ── Error Handling ─────────────────────────────────────────────────────────

  describe("error handling", () => {
    it("throws clear error when no LLM plugin is registered", async () => {
      handle.registry.getPrimaryPlugin.mockReturnValue(null);
      const dispatch = createMockDispatch();

      const result = await handle.orchestrator.executeTask(dispatch);

      expect(result.outcome).toBe("error");
      if (result.outcome === "error") {
        expect(result.reason).toContain("no LLM plugin");
      }
    });

    it("returns error result when LLM adapter throws", async () => {
      handle.actionPipeline.execute.mockImplementation(
        (input: { details?: { operation?: string } }) => {
          if (input.details?.operation === "llm_infer") {
            return Promise.resolve({
              outcome: "error",
              reason: "LLM provider unavailable",
              error: new Error("LLM down"),
            });
          }
          return Promise.resolve({ outcome: "executed", result: null });
        },
      );
      const dispatch = createMockDispatch();

      const result = await handle.orchestrator.executeTask(dispatch);

      expect(result.outcome).toBe("error");
      if (result.outcome === "error") {
        expect(result.phase).toBe("requirements_gathering");
      }
    });

    it("closes session with 'crashed' when setupWorkspace throws (F3)", async () => {
      handle.workspaceManager.createWorkspace.mockImplementation(() => {
        throw new Error("git clone failed: authentication required");
      });
      // task must have repo + clone_url so setupWorkspace actually calls createWorkspace
      const dispatch = createMockDispatch({
        task: { repo: "owner/repo", clone_url: "https://github.com/owner/repo.git" },
      });

      await expect(handle.orchestrator.executeTask(dispatch)).rejects.toThrow(
        "git clone failed: authentication required",
      );

      expect(handle.sessionMemory.endSession).toHaveBeenCalledWith(expect.any(String), "crashed");
    });
  });

  // ── Cost Tracking ──────────────────────────────────────────────────────────

  describe("cost tracking", () => {
    it("emits cost.incurred event after each LLM call", async () => {
      handle.setAllPhaseResponses();
      const dispatch = createMockDispatch();

      await handle.orchestrator.executeTask(dispatch);

      const costEvents = handle.eventBus.publish.mock.calls.filter(
        (call: unknown[]) => (call[0] as { type: string }).type === "cost.incurred",
      );
      // 7 LLM calls = 7 cost events
      expect(costEvents).toHaveLength(7);
    });

    it("cost.incurred payload includes correct usage data", async () => {
      handle.setAllPhaseResponses();
      const dispatch = createMockDispatch();

      await handle.orchestrator.executeTask(dispatch);

      const costEvents = handle.eventBus.publish.mock.calls.filter(
        (call: unknown[]) => (call[0] as { type: string }).type === "cost.incurred",
      );
      // Agent loop emits aggregate cost per phase
      const firstPayload = (costEvents[0]?.[0] as { payload: Record<string, unknown> }).payload;
      expect(firstPayload).toHaveProperty("spend_usd", 0.01);
      expect(firstPayload).toHaveProperty("task_id", "task-001");
    });
  });

  // ── attemptSelfUnblock ───────────────────────────────────────────────────

  describe("attemptSelfUnblock", () => {
    it("returns false when task is not found", async () => {
      handle.taskEngine.getTask.mockReturnValue(null);

      const result = await handle.orchestrator.attemptSelfUnblock("nonexistent");
      expect(result).toBe(false);
    });

    it("returns false when task is not in blocked state", async () => {
      handle.taskEngine.getTask.mockReturnValue(
        createMockTask({ id: "task-1", state: "active", sub_state: "working" }),
      );

      const result = await handle.orchestrator.attemptSelfUnblock("task-1");
      expect(result).toBe(false);
    });

    it("returns false when no LLM plugin is available", async () => {
      handle.taskEngine.getTask.mockReturnValue(
        createMockTask({ id: "task-1", state: "blocked", sub_state: null }),
      );
      handle.registry.getPrimaryPlugin.mockReturnValue(null);

      const result = await handle.orchestrator.attemptSelfUnblock("task-1");
      expect(result).toBe(false);
    });

    it("returns true when LLM responds with can_resolve: true", async () => {
      handle.taskEngine.getTask.mockReturnValue(
        createMockTask({
          id: "task-1",
          state: "blocked",
          sub_state: null,
          blocked: {
            reason: "Missing dependency",
            efforts_made: [],
            contacted: [],
            needed: "dependency",
            waiting_for: "upstream",
          },
        }),
      );
      handle.sessionMemory.queryJournal.mockReturnValue([]);
      handle.actionPipeline.execute.mockResolvedValue({
        outcome: "executed",
        result: {
          content: JSON.stringify({ can_resolve: true, action: "retry with alternative" }),
          cost_usd: 0.005,
          duration_ms: 100,
          usage: null,
        },
      });

      const result = await handle.orchestrator.attemptSelfUnblock("task-1");
      expect(result).toBe(true);
    });

    it("returns false when LLM responds with can_resolve: false", async () => {
      handle.taskEngine.getTask.mockReturnValue(
        createMockTask({ id: "task-1", state: "blocked", sub_state: null }),
      );
      handle.sessionMemory.queryJournal.mockReturnValue([]);
      handle.actionPipeline.execute.mockResolvedValue({
        outcome: "executed",
        result: {
          content: JSON.stringify({ can_resolve: false, action: "needs human input" }),
          cost_usd: 0.005,
          duration_ms: 100,
          usage: null,
        },
      });

      const result = await handle.orchestrator.attemptSelfUnblock("task-1");
      expect(result).toBe(false);
    });

    it("returns false when pipeline rejects the action", async () => {
      handle.taskEngine.getTask.mockReturnValue(
        createMockTask({ id: "task-1", state: "blocked", sub_state: null }),
      );
      handle.sessionMemory.queryJournal.mockReturnValue([]);
      handle.actionPipeline.execute.mockResolvedValue({
        outcome: "rejected",
        reason: "cost limit exceeded",
      });

      const result = await handle.orchestrator.attemptSelfUnblock("task-1");
      expect(result).toBe(false);
    });

    it("returns false on invalid JSON response", async () => {
      handle.taskEngine.getTask.mockReturnValue(
        createMockTask({ id: "task-1", state: "blocked", sub_state: null }),
      );
      handle.sessionMemory.queryJournal.mockReturnValue([]);
      handle.actionPipeline.execute.mockResolvedValue({
        outcome: "executed",
        result: {
          content: "not valid json",
          cost_usd: 0.005,
          duration_ms: 100,
          usage: null,
        },
      });

      const result = await handle.orchestrator.attemptSelfUnblock("task-1");
      expect(result).toBe(false);
    });

    it("sanitizes secrets in the prompt sent to LLM", async () => {
      const secretToken = `ghp_${"a".repeat(40)}`;
      handle.taskEngine.getTask.mockReturnValue(
        createMockTask({
          id: "task-1",
          state: "blocked",
          sub_state: null,
          title: `Fix auth with ${secretToken}`,
          blocked: {
            reason: `Failed at https://git:${secretToken}@github.com`,
            efforts_made: [],
            contacted: [],
            needed: "fix",
            waiting_for: "resolution",
          },
        }),
      );
      handle.sessionMemory.queryJournal.mockReturnValue([]);

      let capturedPrompt = "";
      handle.actionPipeline.execute.mockImplementation(
        async (input: { executeFn: () => Promise<unknown> }) => {
          const result = await input.executeFn();
          return { outcome: "executed", result };
        },
      );
      const mockLlm = {
        infer: (req: { prompt: string }) => {
          capturedPrompt = req.prompt;
          return {
            content: JSON.stringify({ can_resolve: false, action: "n/a" }),
            cost_usd: 0.005,
            duration_ms: 100,
            usage: null,
          };
        },
      };
      handle.registry.getPrimaryPlugin.mockReturnValue(mockLlm);

      await handle.orchestrator.attemptSelfUnblock("task-1");

      expect(capturedPrompt).not.toContain(secretToken);
      expect(capturedPrompt).toContain("[REDACTED:github_token]");
      expect(capturedPrompt).toContain("https://git:***@");
    });

    it("uses actionClass read for the LLM call", async () => {
      handle.taskEngine.getTask.mockReturnValue(
        createMockTask({ id: "task-1", state: "blocked", sub_state: null }),
      );
      handle.sessionMemory.queryJournal.mockReturnValue([]);
      handle.actionPipeline.execute.mockResolvedValue({
        outcome: "executed",
        result: {
          content: JSON.stringify({ can_resolve: false, action: "n/a" }),
          cost_usd: 0.005,
          duration_ms: 100,
          usage: null,
        },
      });

      await handle.orchestrator.attemptSelfUnblock("task-1");

      expect(handle.actionPipeline.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          actionClass: "read",
          taskId: "task-1",
        }),
      );
    });
  });

  // ── Feedback Loop (resolveStartState, rework push, auto-merge) ──────────

  describe("resolveStartState — feedback rework", () => {
    it("starts from requirements_gathering for task with unapplied feedback", async () => {
      handle.setAllPhaseResponses();
      const dispatch = createMockDispatch({
        task: {
          review: {
            pr_number: 42,
            pr_state: "draft",
            demo_artifacts: [],
            feedback_rounds: [{ stage: "demo", comments: ["Fix naming"], applied: false }],
          },
        },
      });

      const result = await handle.orchestrator.executeTask(dispatch);

      // Should start from intake (index 0), run full pipeline
      expect(result.outcome).toBe("completed");
      // Verify first phase was requirements_gathering (task.phase set to requirements_gathering first)
      const phaseUpdates = handle.taskEngine.updateTaskField.mock.calls
        .filter((c: unknown[]) => c[1] === "phase")
        .map((c: unknown[]) => c[2]);
      expect(phaseUpdates[0]).toBe("requirements_gathering");
    });
  });

  describe("commitPushAndCreatePR — rework path", () => {
    it("re-registers workspace on rework dispatch with existing PR", async () => {
      handle.setAllPhaseResponses();
      const workspace = {
        repo: "org/repo",
        branch: "engineer/task-001-test",
        worktree_path: "/tmp/worktree/task-001",
      };
      // Task already has a PR and workspace (rework scenario)
      const task = createMockTask({
        repo: "org/repo",
        clone_url: "https://github.com/org/repo.git",
        workspace,
        review: {
          pr_number: 42,
          pr_state: "draft",
          demo_artifacts: [],
          feedback_rounds: [{ stage: "demo", comments: ["Fix naming"], applied: false }],
        },
      });

      const dispatch = createMockDispatch({ task });

      await handle.orchestrator.executeTask(dispatch);

      // Should re-register existing workspace, not create new
      expect(handle.workspaceManager.registerExistingWorkspace).toHaveBeenCalledWith(
        "task-001",
        workspace,
      );
      expect(handle.workspaceManager.createWorkspace).not.toHaveBeenCalled();
    });

    it("marks all feedback rounds as applied after rework push", async () => {
      handle.setAllPhaseResponses();
      handle.workspaceManager.getWorkspaceRecord.mockReturnValue({
        taskId: "task-001",
        repo: "org/repo",
        branch: "engineer/task-001-test",
        baseBranch: "main",
        worktreePath: "/tmp/worktree/task-001",
        baseCommit: "abc123",
        thoughtsDir: "thoughts/2026-03-22-issue-1",
      });
      const task = createMockTask({
        repo: "org/repo",
        clone_url: "https://github.com/org/repo.git",
        workspace: {
          repo: "org/repo",
          branch: "engineer/task-001-test",
          worktree_path: "/tmp/worktree/task-001",
        },
        review: {
          pr_number: 42,
          pr_state: "draft",
          demo_artifacts: [],
          feedback_rounds: [{ stage: "demo", comments: ["Fix naming"], applied: false }],
        },
      });
      handle.taskEngine.getTask.mockReturnValue(task);

      const dispatch = createMockDispatch({ task });

      await handle.orchestrator.executeTask(dispatch);

      // Should update review with all feedback applied
      const reviewUpdates = handle.taskEngine.updateTaskField.mock.calls.filter(
        (c: unknown[]) => c[1] === "review",
      );
      const lastReviewUpdate = reviewUpdates[reviewUpdates.length - 1];
      if (lastReviewUpdate) {
        const review = lastReviewUpdate[2] as {
          feedback_rounds: Array<{ applied: boolean }>;
        };
        for (const round of review.feedback_rounds) {
          expect(round.applied).toBe(true);
        }
      }
    });
  });

  describe("workspace guard — rework dispatch", () => {
    it("re-registers existing workspace instead of creating new one", async () => {
      handle.setAllPhaseResponses();
      const workspace = {
        repo: "org/repo",
        branch: "engineer/task-001-fix-bug",
        worktree_path: "/tmp/worktree/task-001",
      };
      handle.workspaceManager.getWorktreePath.mockReturnValue("/tmp/worktree/task-001");

      const dispatch = createMockDispatch({
        task: {
          repo: "org/repo",
          clone_url: "https://github.com/org/repo.git",
          workspace,
        },
      });

      await handle.orchestrator.executeTask(dispatch);

      expect(handle.workspaceManager.registerExistingWorkspace).toHaveBeenCalledWith(
        "task-001",
        workspace,
      );
      expect(handle.workspaceManager.createWorkspace).not.toHaveBeenCalled();
    });
  });
});
