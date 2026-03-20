import { describe, expect, it, vi } from "vitest";
import { createTestObserverFacade } from "../../../test/helpers/test-observer-facade.js";
import type { Dispatch } from "../../schemas/ephemeral.js";
import type { PhaseOutput } from "../../schemas/orchestrator.js";
import { Phases } from "../../schemas/orchestrator.js";
import type { Task } from "../../schemas/task.js";
import { createDecompositionHandler } from "./decomposition-handler.js";
import type { OrchestratorContext } from "./types.js";
import type { WorkspaceLifecycle } from "./workspace-lifecycle.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function createMockContext(): OrchestratorContext {
  let taskCounter = 0;
  return {
    eventBus: { publish: vi.fn() } as unknown as OrchestratorContext["eventBus"],
    registry: {
      getPrimaryPlugin: vi.fn().mockReturnValue(null),
      getPluginsByType: vi.fn().mockReturnValue([]),
    } as unknown as OrchestratorContext["registry"],
    taskEngine: {
      updateTaskField: vi.fn(),
      getTask: vi.fn(),
      requestTransition: vi.fn().mockReturnValue({ success: true }),
      createTask: vi.fn(() => {
        taskCounter++;
        return { id: `child-${String(taskCounter).padStart(3, "0")}` };
      }),
    } as unknown as OrchestratorContext["taskEngine"],
    safetyLayer: {} as OrchestratorContext["safetyLayer"],
    actionPipeline: { execute: vi.fn() } as unknown as OrchestratorContext["actionPipeline"],
    sessionMemory: {
      addJournalEntry: vi.fn(),
      endSession: vi.fn(),
      createSession: vi.fn(),
    } as unknown as OrchestratorContext["sessionMemory"],
    workspaceManager: {} as OrchestratorContext["workspaceManager"],
    peopleDirectory: {} as OrchestratorContext["peopleDirectory"],
    observationStore: null,
    observer: createTestObserverFacade("orchestrator"),
  };
}

function createDispatch(): Dispatch {
  return {
    task: {
      id: "task-001",
      title: "Parent task",
      repo: "owner/repo",
      clone_url: "https://github.com/owner/repo.git",
      external_ref: null,
    } as Task,
    resume_from: null,
    knowledge: { repo: [], user: [] },
  } as Dispatch;
}

function createPlanningOutput(decompositionPlan: unknown): PhaseOutput {
  return {
    phase: Phases.planning,
    task_id: "task-001",
    timestamp: new Date().toISOString(),
    data: {
      approach: "Decompose",
      file_changes: [],
      risks: [],
      decomposition_plan: decompositionPlan,
    },
    confidence: "high",
    open_questions: [],
  };
}

function createMockWorkspaceLifecycle(): WorkspaceLifecycle {
  return {
    setupWorkspace: vi.fn(),
    createSession: vi.fn(),
    notifyMilestone: vi.fn(),
    commentOnSourceIssue: vi.fn(),
    getTaskRepo: vi.fn().mockReturnValue(""),
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("DecompositionHandler", () => {
  it("returns null when no decomposition_plan in output", () => {
    const ctx = createMockContext();
    const handler = createDecompositionHandler(ctx, createMockWorkspaceLifecycle());
    const output = createPlanningOutput(null);
    const priorOutputs = new Map<string, PhaseOutput>() as Map<typeof Phases.planning, PhaseOutput>;

    const result = handler.handleDecomposition(
      "session-001",
      "task-001",
      output,
      createDispatch(),
      priorOutputs,
    );

    expect(result).toBeNull();
  });

  it("returns null when decomposition_plan fails validation", () => {
    const ctx = createMockContext();
    const handler = createDecompositionHandler(ctx, createMockWorkspaceLifecycle());
    const output = createPlanningOutput({ invalid: "data" });
    const priorOutputs = new Map<string, PhaseOutput>() as Map<typeof Phases.planning, PhaseOutput>;

    const result = handler.handleDecomposition(
      "session-001",
      "task-001",
      output,
      createDispatch(),
      priorOutputs,
    );

    expect(result).toBeNull();
    expect(ctx.sessionMemory.addJournalEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: expect.stringContaining("Invalid decomposition plan"),
      }),
    );
  });

  it("creates child tasks from valid plan", () => {
    const ctx = createMockContext();
    const handler = createDecompositionHandler(ctx, createMockWorkspaceLifecycle());
    const plan = {
      rationale: "Too complex for one task",
      children: [
        {
          title: "Subtask 1",
          description: "First part",
          acceptance_criteria: ["criterion A"],
          estimated_time_ms: 30000,
          depends_on: [],
        },
        {
          title: "Subtask 2",
          description: "Second part",
          acceptance_criteria: ["criterion B"],
          estimated_time_ms: 30000,
          depends_on: [0],
        },
      ],
      dependency_graph: "linear",
      total_estimated_ms: 60000,
      parallelizable: false,
    };
    const output = createPlanningOutput(plan);
    const priorOutputs = new Map<string, PhaseOutput>() as Map<typeof Phases.planning, PhaseOutput>;

    const result = handler.handleDecomposition(
      "session-001",
      "task-001",
      output,
      createDispatch(),
      priorOutputs,
    );

    expect(result).not.toBeNull();
    expect(result!.outcome).toBe("decomposed");
    if (result!.outcome === "decomposed") {
      expect(result!.childTaskIds).toHaveLength(2);
    }
    expect(ctx.taskEngine.createTask).toHaveBeenCalledTimes(2);
  });

  it("maps dependency indices to task IDs", () => {
    const ctx = createMockContext();
    const handler = createDecompositionHandler(ctx, createMockWorkspaceLifecycle());
    const plan = {
      rationale: "Split into two",
      children: [
        {
          title: "A",
          description: "a",
          acceptance_criteria: [],
          estimated_time_ms: 10000,
          depends_on: [],
        },
        {
          title: "B",
          description: "b",
          acceptance_criteria: [],
          estimated_time_ms: 10000,
          depends_on: [0],
        },
      ],
      dependency_graph: "linear",
      total_estimated_ms: 30000,
      parallelizable: false,
    };
    const output = createPlanningOutput(plan);
    const priorOutputs = new Map<string, PhaseOutput>() as Map<typeof Phases.planning, PhaseOutput>;

    handler.handleDecomposition("session-001", "task-001", output, createDispatch(), priorOutputs);

    // Verify children array written to parent task includes dependency mapping
    const updateCalls = (ctx.taskEngine.updateTaskField as ReturnType<typeof vi.fn>).mock.calls;
    const childrenUpdate = updateCalls.find((c: unknown[]) => c[1] === "children");
    expect(childrenUpdate).toBeDefined();
    const children = childrenUpdate![2] as Array<{ depends_on: string[] }>;
    expect(children[1]!.depends_on).toContain("child-001");
  });

  it("transitions parent to supervising", () => {
    const ctx = createMockContext();
    const handler = createDecompositionHandler(ctx, createMockWorkspaceLifecycle());
    const plan = {
      rationale: "Split",
      children: [
        {
          title: "A",
          description: "a",
          acceptance_criteria: [],
          estimated_time_ms: 10000,
          depends_on: [],
        },
      ],
      dependency_graph: "none",
      total_estimated_ms: 10000,
      parallelizable: true,
    };
    const output = createPlanningOutput(plan);
    const priorOutputs = new Map<string, PhaseOutput>() as Map<typeof Phases.planning, PhaseOutput>;

    handler.handleDecomposition("session-001", "task-001", output, createDispatch(), priorOutputs);

    expect(ctx.taskEngine.requestTransition).toHaveBeenCalledWith(
      "task-001",
      "active",
      "supervising",
      "decomposed_into_children",
      "orchestrator",
    );
  });

  it("comments on source issue with subtask list", () => {
    const ctx = createMockContext();
    const wsl = createMockWorkspaceLifecycle();
    const handler = createDecompositionHandler(ctx, wsl);
    const plan = {
      rationale: "Too large",
      children: [
        {
          title: "Build UI",
          description: "ui",
          acceptance_criteria: [],
          estimated_time_ms: 20000,
          depends_on: [],
        },
        {
          title: "Build API",
          description: "api",
          acceptance_criteria: [],
          estimated_time_ms: 20000,
          depends_on: [],
        },
      ],
      dependency_graph: "parallel",
      total_estimated_ms: 40000,
      parallelizable: true,
    };
    const output = createPlanningOutput(plan);
    const priorOutputs = new Map<string, PhaseOutput>() as Map<typeof Phases.planning, PhaseOutput>;

    handler.handleDecomposition("session-001", "task-001", output, createDispatch(), priorOutputs);

    expect(wsl.commentOnSourceIssue).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("Build UI"),
    );
    expect(wsl.commentOnSourceIssue).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("Build API"),
    );
  });
});
