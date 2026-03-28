import { beforeEach, describe, expect, it } from "vitest";
import {
  type TestOrchestratorHandle,
  VALID_PHASE_DATA,
  createMockDispatch,
  createTestOrchestrator,
} from "../../../test/helpers/test-orchestrator.js";

describe("Orchestrator — Decomposition", () => {
  let h: TestOrchestratorHandle;

  beforeEach(() => {
    h = createTestOrchestrator();
    // Default workspace mock so createWorkspace returns a valid record
    h.workspaceManager.createWorkspace.mockReturnValue({
      taskId: "task-001",
      repo: "test/repo",
      branch: "engineer/task-001-test-task",
      baseBranch: "main",
      worktreePath: "/tmp/worktree/task-001",
    });
  });

  // Valid decomposition plan fixture
  const VALID_DECOMPOSITION_PLAN = {
    rationale: "Task has 3 independent areas of change",
    children: [
      {
        title: "Subtask A: Schema changes",
        description: "Add new fields to schemas",
        estimated_time_ms: 60000,
        depends_on: [],
        acceptance_criteria: ["Schema validates correctly"],
      },
      {
        title: "Subtask B: API endpoint",
        description: "Build the REST endpoint",
        estimated_time_ms: 120000,
        depends_on: [0],
        acceptance_criteria: ["Endpoint returns 200"],
      },
      {
        title: "Subtask C: Frontend integration",
        description: "Wire up the UI",
        estimated_time_ms: 90000,
        depends_on: [1],
        acceptance_criteria: ["UI renders data"],
      },
    ],
    dependency_graph: "A → B → C",
    total_estimated_ms: 270000,
    parallelizable: false,
  };

  it("proceeds normally when decomposition_plan is null", async () => {
    h.setAllPhaseResponses();
    const dispatch = createMockDispatch({
      task: { repo: "test/repo", clone_url: "https://example.com/repo.git" },
    });

    const result = await h.orchestrator.executeTask(dispatch);
    expect(result.outcome).toBe("completed");
  });

  it("creates child tasks when planning returns a valid decomposition plan", async () => {
    // Planning response includes decomposition_plan
    const planningWithDecomposition = {
      ...VALID_PHASE_DATA.planning,
      decomposition_plan: VALID_DECOMPOSITION_PLAN,
    };

    h.setAllPhaseResponses();
    h.setLlmResponseAtIndex(2, planningWithDecomposition); // index 2 = planning

    // Mock createTask to return tasks with incrementing IDs
    let childCounter = 0;
    h.taskEngine.createTask.mockImplementation((input: Record<string, unknown>) => {
      childCounter++;
      const now = new Date().toISOString();
      return {
        id: `child-${String(childCounter).padStart(3, "0")}`,
        title: input["title"],
        state: "intake",
        sub_state: null,
        parent_id: input["parent_id"],
        children: [],
        cascade_policy: "pause_siblings",
        description: input["description"] ?? "",
        source_text: "",
        acceptance_criteria: input["acceptance_criteria"] ?? [],
        team: [],
        related: [],
        decisions: [],
        child_summaries: [],
        workspace: null,
        review: null,
        blocked: null,
        priority: 50,
        llm_tokens: 0,
        llm_cost_usd: 0,
        compute_time_ms: 0,
        created_at: now,
        started_at: null,
        completed_at: null,
        last_transition_at: now,
        session_id: null,
        repo: input["repo"] ?? null,
        clone_url: input["clone_url"] ?? null,
        external_ref: null,
        phase: null,
      };
    });

    const dispatch = createMockDispatch({
      task: {
        repo: "test/repo",
        clone_url: "https://example.com/repo.git",
        external_ref: null,
      },
    });

    const result = await h.orchestrator.executeTask(dispatch);

    expect(result.outcome).toBe("decomposed");
    if (result.outcome === "decomposed") {
      expect(result.childTaskIds).toHaveLength(3);
      expect(result.childTaskIds).toEqual(["child-001", "child-002", "child-003"]);
    }

    // Verify 3 child tasks were created
    expect(h.taskEngine.createTask).toHaveBeenCalledTimes(3);

    // Verify each child was created with parent_id
    for (const call of h.taskEngine.createTask.mock.calls) {
      expect(call[0].parent_id).toBe("task-001");
      expect(call[0].source).toBe("decomposition");
      expect(call[0].cascade_policy).toBe("pause_siblings");
    }

    // Verify each child was transitioned: intake → queued
    const transitionCalls = h.taskEngine.requestTransition.mock.calls.filter(
      (call: unknown[]) => call[3] === "decomposition",
    );
    expect(transitionCalls).toHaveLength(3);

    // Verify parent's children field was updated
    const childrenUpdateCall = h.taskEngine.updateTaskField.mock.calls.find(
      (call: unknown[]) => call[1] === "children",
    );
    expect(childrenUpdateCall).toBeDefined();
    const childEntries = childrenUpdateCall?.[2] as Array<{ id: string; depends_on: string[] }>;
    expect(childEntries).toHaveLength(3);
    // Child B depends on Child A (index 0 → child-001)
    expect(childEntries[1]?.depends_on).toEqual(["child-001"]);
    // Child C depends on Child B (index 1 → child-002)
    expect(childEntries[2]?.depends_on).toEqual(["child-002"]);

    // Verify parent transitioned to active.supervising
    const supervisingCall = h.taskEngine.requestTransition.mock.calls.find(
      (call: unknown[]) => call[2] === "supervising",
    );
    expect(supervisingCall).toBeDefined();
    expect(supervisingCall?.[0]).toBe("task-001");

    // Verify session was ended with "decomposed"
    expect(h.sessionMemory.endSession).toHaveBeenCalledWith(expect.any(String), "decomposed");
  });

  it("proceeds normally when decomposition_plan is invalid (falls back to null)", async () => {
    // When the LLM returns an invalid decomposition_plan, PlanningOutputSchema.safeParse
    // fails at the agent loop level, producing a fallback output with decomposition_plan: null.
    // So handleDecomposition never sees the invalid plan — it sees null and skips.
    const planningWithBadDecomp = {
      ...VALID_PHASE_DATA.planning,
      decomposition_plan: { invalid: "no rationale or children" },
    };

    h.setAllPhaseResponses();
    h.setLlmResponseAtIndex(2, planningWithBadDecomp); // index 2 = planning

    const dispatch = createMockDispatch({
      task: { repo: "test/repo", clone_url: "https://example.com/repo.git" },
    });

    const result = await h.orchestrator.executeTask(dispatch);

    // Should proceed to execution (fallback output has decomposition_plan: null)
    expect(result.outcome).toBe("completed");

    // No child tasks created
    expect(h.taskEngine.createTask).not.toHaveBeenCalled();
  });

  it("comments on source issue listing subtasks", async () => {
    const planningWithDecomposition = {
      ...VALID_PHASE_DATA.planning,
      decomposition_plan: VALID_DECOMPOSITION_PLAN,
    };

    h.setAllPhaseResponses();
    h.setLlmResponseAtIndex(2, planningWithDecomposition);

    let childCounter = 0;
    h.taskEngine.createTask.mockImplementation(() => {
      childCounter++;
      return {
        id: `child-${String(childCounter).padStart(3, "0")}`,
        state: "intake",
        sub_state: null,
        parent_id: "task-001",
        children: [],
        cascade_policy: "pause_siblings",
        title: `Child ${String(childCounter)}`,
        description: "",
        source_text: "",
        acceptance_criteria: [],
        team: [],
        related: [],
        decisions: [],
        child_summaries: [],
        workspace: null,
        review: null,
        blocked: null,
        priority: 50,
        llm_tokens: 0,
        llm_cost_usd: 0,
        compute_time_ms: 0,
        created_at: new Date().toISOString(),
        started_at: null,
        completed_at: null,
        last_transition_at: new Date().toISOString(),
        session_id: null,
        repo: null,
        clone_url: null,
        external_ref: null,
        phase: null,
      };
    });

    // Set up external_ref so commentOnSourceTicket fires
    const dispatch = createMockDispatch({
      task: {
        repo: "test/repo",
        clone_url: "https://example.com/repo.git",
        external_ref: { type: "test_issue", repo: "test/repo", id: "42" },
      },
    });

    // Mock comm plugin with ticket_management capability
    const mockCommPlugin = {
      hasCapability: (cap: string) => cap === "ticket_management",
      commentOnTicket: async () => {},
      manifest: { id: "github-comm" },
    };
    h.registry.getPluginsByType.mockReturnValue([mockCommPlugin]);

    await h.orchestrator.executeTask(dispatch);

    // commentOnSourceTicket was called — the test just verifies no crash
    // The actual comment goes through the comm plugin mock
  });

  it("child tasks inherit clone_url from parent", async () => {
    const planningWithDecomposition = {
      ...VALID_PHASE_DATA.planning,
      decomposition_plan: {
        ...VALID_DECOMPOSITION_PLAN,
        children: [VALID_DECOMPOSITION_PLAN.children[0]],
      },
    };

    h.setAllPhaseResponses();
    h.setLlmResponseAtIndex(2, planningWithDecomposition);

    h.taskEngine.createTask.mockImplementation((input: Record<string, unknown>) => ({
      id: "child-001",
      state: "intake",
      sub_state: null,
      parent_id: input["parent_id"],
      children: [],
      cascade_policy: "pause_siblings",
      title: input["title"],
      description: "",
      source_text: "",
      acceptance_criteria: [],
      team: [],
      related: [],
      decisions: [],
      child_summaries: [],
      workspace: null,
      review: null,
      blocked: null,
      priority: 50,
      llm_tokens: 0,
      llm_cost_usd: 0,
      compute_time_ms: 0,
      created_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
      last_transition_at: new Date().toISOString(),
      session_id: null,
      repo: null,
      clone_url: null,
      external_ref: null,
      phase: null,
    }));

    const dispatch = createMockDispatch({
      task: {
        repo: "test/repo",
        clone_url: "https://github.com/test/repo.git",
      },
    });

    await h.orchestrator.executeTask(dispatch);

    expect(h.taskEngine.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        clone_url: "https://github.com/test/repo.git",
      }),
    );
  });

  it("passes parent branch to createWorkspace for child tasks", async () => {
    // Simulate dispatching a child task (parent_id set, parent has workspace)
    h.setAllPhaseResponses();

    h.taskEngine.getTask.mockReturnValue({
      id: "parent-001",
      workspace: {
        repo: "test/repo",
        branch: "engineer/parent-001-feature",
        worktree_path: "/tmp/parent",
      },
    });

    h.workspaceManager.createWorkspace.mockReturnValue({
      taskId: "child-001",
      repo: "test/repo",
      branch: "engineer/child-001-subtask",
      baseBranch: "engineer/parent-001-feature",
      worktreePath: "/tmp/child",
    });

    const dispatch = createMockDispatch({
      task: {
        id: "child-001",
        parent_id: "parent-001",
        repo: "test/repo",
        clone_url: "https://example.com/repo.git",
      },
    });

    await h.orchestrator.executeTask(dispatch);

    // Verify createWorkspace was called with parent's branch
    expect(h.workspaceManager.createWorkspace).toHaveBeenCalledWith(
      "child-001",
      "test/repo",
      expect.objectContaining({
        parentBranch: "engineer/parent-001-feature",
        cloneUrl: "https://example.com/repo.git",
      }),
    );
  });

  it("reads child_summaries from dispatch.task for integration phase", async () => {
    h.setAllPhaseResponses();

    const dispatch = createMockDispatch({
      task: {
        repo: "test/repo",
        clone_url: "https://example.com/repo.git",
        child_summaries: [
          {
            child_id: "child-001",
            child_title: "Schema changes",
            summary: "Added new fields",
            key_outputs: [
              { type: "file" as const, path: "src/schemas.ts", description: "New schemas" },
            ],
            patterns_introduced: [],
            gotchas: [],
            decisions_made: [],
            pr_number: 5,
            branch: "engineer/child-001-schema",
            test_status: "passing" as const,
          },
        ],
      },
    });

    const result = await h.orchestrator.executeTask(dispatch);
    expect(result.outcome).toBe("completed");
    // Integration phase ran with child summaries — no crash
  });
});
