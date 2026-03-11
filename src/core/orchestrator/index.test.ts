import { beforeEach, describe, expect, it } from "vitest";

import {
  FAST_PATH_INTAKE_DATA,
  type TestOrchestratorHandle,
  createMockCheckpoint,
  createMockDispatch,
  createTestOrchestrator,
} from "../../../test/helpers/test-orchestrator.js";
import { PHASE_SEQUENCE } from "./index.js";

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
        // biome-ignore lint/suspicious/noExplicitAny: test mock inspection
        (call: any[]) => call[0]?.details?.operation === "llm_complete",
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
      // First checkpoint (intake_analysis) should reference research
      expect((calls[0][0] as { nextAction: string }).nextAction).toContain("research");
      // Last checkpoint (integration) should say complete
      expect((calls[6][0] as { nextAction: string }).nextAction).toContain("complete");
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
      // 6 phase updates (intake→research, research→planning, ..., demo_prep→integration)
      // Last phase (integration) doesn't trigger an update to a "next" phase
      expect(phaseCalls).toHaveLength(6);
      const phaseValues = phaseCalls.map((call: unknown[]) => (call as string[])[2]);
      expect(phaseValues).toEqual(PHASE_SEQUENCE.slice(1));
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
      expect((readyEvent[0] as { payload: { task_id: string } }).payload.task_id).toBe("task-001");
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
        expect(result.phaseOutputs.has("intake_analysis")).toBe(false);
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
      // Set first response to non-JSON
      handle.setAllPhaseResponses();
      handle.setLlmResponseAtIndex(0, {} as Record<string, unknown>);
      // Override the actionPipeline to return non-JSON content for first call
      let callCount = 0;
      handle.actionPipeline.execute.mockImplementation(
        async (input: { executeFn: () => Promise<unknown>; details?: { operation?: string } }) => {
          callCount++;
          if (callCount === 1 && input.details?.operation === "llm_complete") {
            return {
              outcome: "executed",
              result: {
                content: "This is not JSON at all",
                tool_calls: null,
                finish_reason: "stop",
                usage: {
                  tokens_in: 10,
                  tokens_out: 5,
                  spend_usd: null,
                  remaining: null,
                  resets_at: null,
                },
              },
            };
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
        const intakeOutput = result.phaseOutputs.get("intake_analysis");
        expect(intakeOutput?.confidence).toBe("low");
        expect(intakeOutput?.open_questions.length).toBeGreaterThan(0);
      }
    });

    it("handles schema validation failure with fallback output", async () => {
      // Set first response to valid JSON but wrong shape
      let callCount = 0;
      handle.setAllPhaseResponses();
      handle.actionPipeline.execute.mockImplementation(
        async (input: { executeFn: () => Promise<unknown>; details?: { operation?: string } }) => {
          callCount++;
          if (callCount === 1 && input.details?.operation === "llm_complete") {
            return {
              outcome: "executed",
              result: {
                content: JSON.stringify({ wrong_field: "wrong_value" }),
                tool_calls: null,
                finish_reason: "stop",
                usage: {
                  tokens_in: 10,
                  tokens_out: 5,
                  spend_usd: null,
                  remaining: null,
                  resets_at: null,
                },
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
        const intakeOutput = result.phaseOutputs.get("intake_analysis");
        expect(intakeOutput?.confidence).toBe("low");
      }
    });

    it("fallback output uses default data for the phase", async () => {
      let callCount = 0;
      handle.setAllPhaseResponses();
      handle.actionPipeline.execute.mockImplementation(
        async (input: { executeFn: () => Promise<unknown>; details?: { operation?: string } }) => {
          callCount++;
          if (callCount === 1 && input.details?.operation === "llm_complete") {
            return {
              outcome: "executed",
              result: {
                content: "not json",
                tool_calls: null,
                finish_reason: "stop",
                usage: {
                  tokens_in: 10,
                  tokens_out: 5,
                  spend_usd: null,
                  remaining: null,
                  resets_at: null,
                },
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
        const intakeOutput = result.phaseOutputs.get("intake_analysis");
        // Default intake data has fast_path: false, complexity: "moderate"
        expect(intakeOutput?.data).toHaveProperty("fast_path", false);
        expect(intakeOutput?.data).toHaveProperty("complexity", "moderate");
      }
    });
  });

  // ── Action Pipeline Integration ────────────────────────────────────────────

  describe("action pipeline integration", () => {
    it("execution phase uses actionClass 'write' for tool calls", async () => {
      handle.setAllPhaseResponses();
      const dispatch = createMockDispatch();

      await handle.orchestrator.executeTask(dispatch);

      const writeCalls = handle.actionPipeline.execute.mock.calls.filter(
        (call: unknown[]) => (call[0] as { actionClass: string }).actionClass === "write",
      );
      expect(writeCalls.length).toBeGreaterThanOrEqual(1);
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

  describe("fast-path", () => {
    it("skips research, planning, demo_prep when intake returns fast_path: true", async () => {
      handle.setAllPhaseResponses();
      // Override first LLM response (intake) to return fast_path: true
      handle.setLlmResponseAtIndex(0, FAST_PATH_INTAKE_DATA);

      const dispatch = createMockDispatch();
      const result = await handle.orchestrator.executeTask(dispatch);

      expect(result.outcome).toBe("completed");
      if (result.outcome === "completed") {
        // Should only have: intake_analysis, execution, self_review
        expect(result.phaseOutputs.size).toBe(3);
        expect(result.phaseOutputs.has("intake_analysis")).toBe(true);
        expect(result.phaseOutputs.has("execution")).toBe(true);
        expect(result.phaseOutputs.has("self_review")).toBe(true);
        expect(result.phaseOutputs.has("research")).toBe(false);
        expect(result.phaseOutputs.has("planning")).toBe(false);
        expect(result.phaseOutputs.has("demo_prep")).toBe(false);
        expect(result.phaseOutputs.has("integration")).toBe(false);
      }
    });

    it("fast-path produces fewer checkpoints", async () => {
      handle.setAllPhaseResponses();
      handle.setLlmResponseAtIndex(0, FAST_PATH_INTAKE_DATA);

      const dispatch = createMockDispatch();
      await handle.orchestrator.executeTask(dispatch);

      // 3 phases = 3 checkpoints
      expect(handle.sessionMemory.createCheckpoint).toHaveBeenCalledTimes(3);
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
          if (input.details?.operation === "llm_complete") {
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
        expect(result.phase).toBe("intake_analysis");
      }
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
      const firstPayload = (costEvents[0][0] as { payload: Record<string, unknown> }).payload;
      expect(firstPayload).toHaveProperty("tokens_in", 100);
      expect(firstPayload).toHaveProperty("tokens_out", 50);
      expect(firstPayload).toHaveProperty("spend_usd", 0.01);
      expect(firstPayload).toHaveProperty("task_id", "task-001");
    });
  });
});
