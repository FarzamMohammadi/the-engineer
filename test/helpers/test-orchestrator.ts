import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type Mock, vi } from "vitest";

import type {
  ActionPipeline,
  ExecuteInput,
  PipelineResult,
} from "../../src/core/action-pipeline/index.js";
import type { NotificationRouter } from "../../src/core/daemon/notification-router.js";
import type { EventBus, EventCallback } from "../../src/core/event-bus/index.js";
import type { ISafetyLayer } from "../../src/core/interfaces/safety-layer.interface.js";
import type {
  AddJournalEntryInput,
  CreateCheckpointInput,
  CreateSessionInput,
  ISessionMemory,
} from "../../src/core/interfaces/session-memory.interface.js";
import type { ITaskEngine } from "../../src/core/interfaces/task-engine.interface.js";
import type { WorkspaceVerification } from "../../src/core/interfaces/workspace-manager.interface.js";
import { Orchestrator } from "../../src/core/orchestrator/index.js";
import type { PeopleDirectory } from "../../src/core/people-directory/index.js";
import type { Registry } from "../../src/core/registry/index.js";
import type { WorkspaceManager } from "../../src/core/workspace-manager/index.js";
import type { InferenceResult } from "../../src/schemas/adapters.js";
import { OrchestratorConfigSchema, WorkspaceConfigSchema } from "../../src/schemas/config.js";
import type { Dispatch } from "../../src/schemas/ephemeral.js";
import type { Event } from "../../src/schemas/events.js";
import type { Phase } from "../../src/schemas/orchestrator.js";
import { Complexities, Phases } from "../../src/schemas/orchestrator.js";
import type { Checkpoint, Session } from "../../src/schemas/session-memory.js";
import { CheckpointReasons } from "../../src/schemas/session-memory.js";
import type { Task } from "../../src/schemas/task.js";
import { CascadePolicies, TaskStates } from "../../src/schemas/task.js";
import { createTestObserverFacade } from "./test-observer-facade.js";

// ── Phase Directory Map (mirrors PHASE_DIR_MAP in llm-caller.ts) ─────────────

const PHASE_DIR_MAP: Record<Phase, string> = {
  requirements_gathering: "requirements",
  research: "research",
  planning: "planning",
  execution: "implementation",
  self_review: "review",
  demo_prep: "demo-prep",
  integration: "integration",
};

/** Write valid session-result.json files to all phase directories under a worktree. */
function writeSessionResultFiles(
  worktreePath: string,
  thoughtsDir: string,
  phases: readonly Phase[] = [
    "requirements_gathering",
    "research",
    "planning",
    "execution",
    "self_review",
    "demo_prep",
    "integration",
  ],
): void {
  for (const phase of phases) {
    const phaseDir = path.join(worktreePath, thoughtsDir, PHASE_DIR_MAP[phase]);
    mkdirSync(phaseDir, { recursive: true });
    const resultData = {
      status: "ready",
      next_phase: phase === "integration" ? "integration" : "research",
      summary: `Mock ${phase} complete`,
      complexity: Complexities.moderate,
    };
    writeFileSync(path.join(phaseDir, "session-result.json"), JSON.stringify(resultData));

    // Refinement step reads from review/refinement/ (step-scoped directory)
    if (phase === "self_review") {
      const refinementDir = path.join(phaseDir, "refinement");
      mkdirSync(refinementDir, { recursive: true });
      writeFileSync(
        path.join(refinementDir, "session-result.json"),
        JSON.stringify({
          status: "ready",
          next_phase: Phases.demo_prep,
          summary: "Mock refinement complete",
          complexity: Complexities.moderate,
        }),
      );
    }
  }
}

// ── Valid Phase Data Fixtures ─────────────────────────────────────────────────

/** Valid phase output data for all 7 phases (passes Zod safeParse). */
export const VALID_PHASE_DATA: Record<Phase, Record<string, unknown>> = {
  requirements_gathering: {
    deliverable_path: "thoughts/test/requirements.md",
    status: "ready",
    contact: null,
    question: null,
    assessment: null,
  },
  research: {
    deliverable_path: "thoughts/test/research.md",
    status: "ready",
    contact: null,
    question: null,
    complexity_hint: null,
  },
  planning: {
    approach: "Implement the feature in src/index.ts",
    file_changes: [{ file: "src/index.ts", change_type: "modify", description: "Add feature" }],
    risks: [],
    decomposition_plan: null,
  },
  execution: {
    files_changed: ["src/index.ts"],
    tests_written: ["src/index.test.ts"],
    test_results: { passed: 5, failed: 0, skipped: 0 },
    build_status: "passing",
  },
  self_review: {
    findings: [],
    refactoring_applied: [],
    quality_assessment: "ship_it",
  },
  demo_prep: {
    artifacts: [{ type: "screenshot", location: "/tmp/demo.png", permanent: true }],
    pr_number: 42,
    pr_description: "Implements the requested feature",
  },
  integration: {
    children_verified: [],
    integration_tests: { passed: 3, failed: 0 },
    conflicts_found: [],
    resolution_actions: [],
  },
};

/** Valid requirements_gathering data for trivial tasks. */
export const TRIVIAL_REQUIREMENTS_DATA: Record<string, unknown> = {
  deliverable_path: "thoughts/test/requirements.md",
  status: "ready",
  contact: null,
  question: null,
  assessment: "trivial task",
};

// ── Mock Task ─────────────────────────────────────────────────────────────────

/** Create a minimal valid Task object for testing. */
export function createMockTask(overrides?: Partial<Task>): Task {
  const now = new Date().toISOString();
  return {
    id: "task-001",
    external_ref: null,
    state: TaskStates.active,
    sub_state: "working",
    phase: null,
    parent_id: null,
    children: [],
    cascade_policy: CascadePolicies.pause_siblings,
    title: "Test task",
    description: "A test task for orchestrator testing",
    source_text: "Test source",
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
    created_at: now,
    started_at: now,
    completed_at: null,
    last_transition_at: now,
    session_id: null,
    ...overrides,
  } as Task;
}

// ── Mock Dispatch ─────────────────────────────────────────────────────────────

/** Create a valid Dispatch object for testing. */
export function createMockDispatch(overrides?: {
  task?: Partial<Task>;
  resume_from?: Checkpoint | null;
}): Dispatch {
  return {
    task: createMockTask(overrides?.task),
    resume_from: overrides?.resume_from ?? null,
    knowledge: {
      repo: [],
      user: [],
    },
  } as Dispatch;
}

// ── Mock Checkpoint ───────────────────────────────────────────────────────────

/** Create a mock Checkpoint for resume testing. */
export function createMockCheckpoint(overrides?: Partial<Checkpoint>): Checkpoint {
  return {
    id: "checkpoint-001",
    session_id: "session-prev",
    task_id: "task-001",
    phase: Phases.research,
    phase_progress: "Completed research",
    context_summary: "Task context summary",
    key_findings: ["finding 1"],
    open_questions: [],
    next_action: "Begin planning phase",
    last_event_id: "event-001",
    workspace_ref: null,
    reason: CheckpointReasons.phase_transition,
    timestamp: new Date().toISOString(),
    journal_offset: 0,
    ...overrides,
  };
}

// ── LLM Response Helper ──────────────────────────────────────────────────────

/**
 * Create an InferenceResult with JSON content matching the agent loop format.
 * Wraps phase data in {"action": "done", "result": {...}} so the agent loop
 * parses it correctly and terminates on the first iteration.
 */
function createLlmResponse(data: Record<string, unknown>): InferenceResult {
  return {
    content: JSON.stringify({ action: "done", result: data }),
    cost_usd: 0.01,
    duration_ms: 100,
    usage: null,
  };
}

// ── Test Handle ──────────────────────────────────────────────────────────────

export interface TestOrchestratorHandle {
  orchestrator: Orchestrator;
  eventBus: {
    publish: Mock;
    subscribe: Mock;
    unsubscribe: Mock;
    replay: Mock;
    getEventsForTask: Mock;
    getEventsSince: Mock;
  };
  registry: {
    getPrimaryPlugin: Mock;
    getPluginsByType: Mock;
    getPlugin: Mock;
  };
  taskEngine: {
    checkPermission: Mock;
    updateTaskField: Mock;
    getTask: Mock;
    requestTransition: Mock;
    updateTracking: Mock;
    createTask: Mock;
  };
  safetyLayer: {
    evaluateAction: Mock;
    consultJudgment: Mock;
    checkAutoMergeAllowed: Mock;
    flushCostSnapshot: Mock;
  };
  actionPipeline: {
    execute: Mock;
  };
  sessionMemory: {
    createSession: Mock;
    endSession: Mock;
    addJournalEntry: Mock;
    createCheckpoint: Mock;
    getLatestCheckpoint: Mock;
    storeKnowledge: Mock;
    getKnowledge: Mock;
    queryJournal: Mock;
    getLatestJournalTimestamp: Mock;
    getSessionChain: Mock;
    supersedeKnowledge: Mock;
    confirmKnowledge: Mock;
  };
  workspaceManager: {
    createWorkspace: Mock;
    verifyWorkspace: Mock;
    getWorktreePath: Mock;
    getWorkspaceRecord: Mock;
    registerExistingWorkspace: Mock;
    pushBranch: Mock;
    cleanupWorkspace: Mock;
  };
  notifications: {
    notify: Mock;
    syncStateToCommPlugin: Mock;
  };
  /** Get the preemption.requested subscriber callback captured from subscribe(). */
  triggerPreemption: (targetTaskId: string, preemptingTaskId: string) => void;
  /** Set LLM responses for all 7 phases (happy path). */
  setAllPhaseResponses: () => void;
  /** Set a custom LLM response for a specific phase index (0-based call order). */
  setLlmResponseAtIndex: (index: number, data: Record<string, unknown>) => void;
}

// ── Factory ──────────────────────────────────────────────────────────────────

/** Create an Orchestrator with all-mock dependencies for testing. */
export function createTestOrchestrator(): TestOrchestratorHandle {
  let preemptionCallback: EventCallback | null = null;
  let llmCallIndex = 0;
  let llmResponses: InferenceResult[] = [];

  // ── EventBus mock ──────────────────────────────────────────────────────
  const eventBus = {
    publish: vi.fn(),
    subscribe: vi.fn((_subscriberId: string, eventType: string, callback: EventCallback) => {
      if (eventType === "preemption.requested") {
        preemptionCallback = callback;
      }
    }),
    unsubscribe: vi.fn(),
    replay: vi.fn(),
    getEventsForTask: vi.fn().mockReturnValue([]),
    getEventsSince: vi.fn().mockReturnValue([]),
  };

  // ── Registry mock ──────────────────────────────────────────────────────
  // Returns a fake LLM that uses llmResponses array
  const worktreePath = "/tmp/worktree/task-001";
  const thoughtsDir = "thoughts/2026-03-22-issue-1";

  const fakeLlm = {
    infer: vi.fn(() => {
      const response = llmResponses[llmCallIndex] ?? createLlmResponse({});
      llmCallIndex++;
      // Write session-result.json to all phase directories so runPhaseWithCli
      // finds valid output after the CLI call. In production, the CLI writes this.
      writeSessionResultFiles(worktreePath, thoughtsDir);
      return Promise.resolve(response);
    }),
    getCapabilities: vi.fn().mockReturnValue({
      model_id: "fake-model",
      supports_usage_reporting: false,
      supports_quota_reporting: false,
      context_window: null,
    }),
    getQuotaStatus: vi.fn().mockResolvedValue(null),
  };

  const fakeTool = {
    execute: vi.fn(async () => ({
      success: true,
      output: "Tool executed",
      side_effects: [],
    })),
    describe: vi.fn().mockReturnValue({
      name: "fake-tool",
      description: "A fake tool",
      parameters: {},
      action_classes: ["write"],
    }),
  };

  const registry = {
    getPrimaryPlugin: vi.fn((type: string) => {
      if (type === "llm") {
        return fakeLlm;
      }
      if (type === "tool") {
        return fakeTool;
      }
      return null;
    }),
    getPluginsByType: vi.fn().mockReturnValue([]),
    getPlugin: vi.fn().mockReturnValue(null),
  };

  // ── TaskEngine mock ────────────────────────────────────────────────────
  const taskEngine = {
    checkPermission: vi.fn().mockReturnValue({ allowed: true }),
    updateTaskField: vi.fn(),
    getTask: vi.fn(),
    requestTransition: vi.fn().mockReturnValue({ success: true }),
    updateTracking: vi.fn(),
    createTask: vi.fn(),
  };

  // ── SafetyLayer mock ───────────────────────────────────────────────────
  const safetyLayer = {
    evaluateAction: vi.fn().mockReturnValue({
      allowed: true,
      action: "proceed",
      reason: "allowed",
      warnings: null,
    }),
    consultJudgment: vi.fn(),
    checkAutoMergeAllowed: vi.fn().mockReturnValue(false),
    flushCostSnapshot: vi.fn(),
  };

  // ── ActionPipeline mock — passthrough by default ───────────────────────
  const actionPipeline = {
    execute: vi.fn(async <T>(input: ExecuteInput<T>): Promise<PipelineResult<T>> => {
      const result = await input.executeFn();
      return { outcome: "executed", result };
    }),
  };

  // ── ISessionMemory mock ─────────────────────────────────────────────────
  let checkpointCounter = 0;
  let sessionCounter = 0;

  const sessionMemory = {
    createSession: vi.fn((input: CreateSessionInput) => {
      sessionCounter++;
      return {
        id: `session-${String(sessionCounter).padStart(3, "0")}`,
        task_id: input.taskId,
        started_at: new Date().toISOString(),
        ended_at: null,
        end_reason: null,
        previous_session_id: input.previousSessionId ?? null,
        resumed_from_checkpoint: input.resumedFromCheckpoint ?? null,
      } satisfies Session;
    }),
    endSession: vi.fn(),
    addJournalEntry: vi.fn((input: AddJournalEntryInput) => ({
      id: `journal-${Date.now()}`,
      session_id: input.sessionId,
      task_id: input.taskId,
      timestamp: new Date().toISOString(),
      phase: input.phase,
      type: input.type,
      summary: input.summary,
      detail: input.detail ?? null,
      action_type: input.actionType ?? null,
      finding_type: input.findingType ?? null,
      decision_key: input.decisionKey ?? null,
      error_detail: input.errorDetail ?? null,
      comm_target: input.commTarget ?? null,
      tags: input.tags ?? [],
    })),
    createCheckpoint: vi.fn((input: CreateCheckpointInput) => {
      checkpointCounter++;
      return {
        id: `checkpoint-${String(checkpointCounter).padStart(3, "0")}`,
        session_id: input.sessionId,
        task_id: input.taskId,
        phase: input.phase,
        phase_progress: input.phaseProgress,
        context_summary: input.contextSummary,
        key_findings: input.keyFindings,
        open_questions: input.openQuestions,
        next_action: input.nextAction,
        last_event_id: input.lastEventId,
        workspace_ref: input.workspaceRef,
        reason: input.reason,
        timestamp: new Date().toISOString(),
        journal_offset: input.journalOffset,
      } satisfies Checkpoint;
    }),
    getLatestCheckpoint: vi.fn().mockReturnValue(null),
    storeKnowledge: vi.fn(),
    getKnowledge: vi.fn().mockReturnValue([]),
    queryJournal: vi.fn().mockReturnValue([]),
    getLatestJournalTimestamp: vi.fn().mockReturnValue(null),
    getSessionChain: vi.fn().mockReturnValue([]),
    supersedeKnowledge: vi.fn(),
    confirmKnowledge: vi.fn(),
  };

  // ── WorkspaceManager mock ──────────────────────────────────────────────
  const workspaceManager = {
    createWorkspace: vi.fn(),
    verifyWorkspace: vi.fn().mockReturnValue({
      status: "valid",
      currentCommit: "abc123",
      recoveryAction: null,
    } satisfies WorkspaceVerification),
    getWorktreePath: vi.fn().mockReturnValue(worktreePath),
    getWorkspaceRecord: vi.fn().mockReturnValue({
      taskId: "task-001",
      repo: "test/repo",
      branch: "engineer/task-001-test",
      worktreePath,
      baseBranch: "main",
      baseCommit: "abc123",
      thoughtsDir,
    }),
    registerExistingWorkspace: vi.fn(),
    pushBranch: vi.fn(),
    cleanupWorkspace: vi.fn(),
    getSkillsDir: vi.fn().mockReturnValue("/tmp/test-skills"),
    syncSkills: vi.fn(),
  };

  // ── Build Orchestrator ─────────────────────────────────────────────────
  const peopleDirectory = {
    getOwner: vi.fn().mockReturnValue(null),
    resolveContact: vi.fn().mockReturnValue(null),
    getAll: vi.fn().mockReturnValue([]),
  };

  const notifications: NotificationRouter = {
    notify: vi.fn(),
    syncStateToCommPlugin: vi.fn(),
  };

  const orchestrator = new Orchestrator({
    config: OrchestratorConfigSchema.parse({}),
    workspaceConfig: WorkspaceConfigSchema.parse({}),
    eventBus: eventBus as unknown as EventBus,
    registry: registry as unknown as Registry,
    taskEngine: taskEngine as unknown as ITaskEngine,
    safetyLayer: safetyLayer as unknown as ISafetyLayer,
    actionPipeline: actionPipeline as unknown as ActionPipeline,
    sessionMemory: sessionMemory as unknown as ISessionMemory,
    workspaceManager: workspaceManager as unknown as WorkspaceManager,
    peopleDirectory: peopleDirectory as unknown as PeopleDirectory,
    notifications,
    observationStore: null,
    observer: createTestObserverFacade("orchestrator"),
    tracesDir: null,
  });

  // ── Helpers ────────────────────────────────────────────────────────────
  const setAllPhaseResponses = (): void => {
    llmCallIndex = 0;
    llmResponses = [
      createLlmResponse(VALID_PHASE_DATA.requirements_gathering),
      createLlmResponse(VALID_PHASE_DATA.research),
      createLlmResponse(VALID_PHASE_DATA.planning),
      createLlmResponse(VALID_PHASE_DATA.execution),
      createLlmResponse(VALID_PHASE_DATA.self_review),
      createLlmResponse(VALID_PHASE_DATA.demo_prep),
      createLlmResponse(VALID_PHASE_DATA.integration),
    ];
  };

  const setLlmResponseAtIndex = (index: number, data: Record<string, unknown>): void => {
    llmResponses[index] = createLlmResponse(data);
  };

  const triggerPreemption = (targetTaskId: string, preemptingTaskId: string): void => {
    if (preemptionCallback) {
      preemptionCallback({
        id: "preempt-event-001",
        sequence: 1,
        type: "preemption.requested",
        source: "daemon",
        task_id: targetTaskId,
        timestamp: new Date().toISOString(),
        payload: {
          target_task_id: targetTaskId,
          preempting_task_id: preemptingTaskId,
          reason: "priority_delta_exceeded",
          priority_delta: 25,
        },
      } satisfies Event);
    }
  };

  return {
    orchestrator,
    eventBus,
    registry,
    taskEngine,
    safetyLayer,
    actionPipeline,
    sessionMemory,
    workspaceManager,
    notifications: notifications as unknown as { notify: Mock; syncStateToCommPlugin: Mock },
    triggerPreemption,
    setAllPhaseResponses,
    setLlmResponseAtIndex,
  };
}
