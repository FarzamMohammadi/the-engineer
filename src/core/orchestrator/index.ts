import { ulid } from "ulid";
import type { LLMAdapter } from "../../adapters/llm.js";
import { AdapterTypes, type CompletionResult } from "../../schemas/adapters.js";
import type { Dispatch } from "../../schemas/ephemeral.js";
import {
  CommMessageSentPayloadSchema,
  CostIncurredPayloadSchema,
  type Event,
  EventTypes,
  PreemptionReadyPayloadSchema,
} from "../../schemas/events.js";
import { type Phase, type PhaseOutput, Phases } from "../../schemas/orchestrator.js";
import { ActionClasses, TaskStates } from "../../schemas/task.js";
import type { EventDeclaration } from "../event-bus/topology.js";
import type { IActionPipeline } from "../interfaces/action-pipeline.interface.js";
import type { IEventBus } from "../interfaces/event-bus.interface.js";
import type { IPluginLookup } from "../interfaces/plugin-lookup.interface.js";
import type { ISafetyLayer } from "../interfaces/safety-layer.interface.js";
import type { ISessionMemory } from "../interfaces/session-memory.interface.js";
import type { ITaskEngine } from "../interfaces/task-engine.interface.js";
import type { IWorkspaceManager } from "../interfaces/workspace-manager.interface.js";
import type { IObserver } from "../observer/facade.js";
import type { IObservationStore } from "../observer/types.js";
import type { PeopleDirectory } from "../people-directory/index.js";
import { createDecompositionHandler } from "./decomposition-handler.js";
import { type LlmCaller, createLlmCaller } from "./llm-caller.js";
import { createPhaseHandlerRegistry, runPhasePipeline } from "./phase-runner.js";
import { createPrManager } from "./pr-manager.js";
import { gatherRepoContextSafe } from "./prompts/context.js";
import { buildDemoPrepPrompt } from "./prompts/demo-prep.js";
import { buildExecutionPrompt } from "./prompts/execution.js";
import { formatPriorPhaseOutput, section } from "./prompts/format.js";
import { buildIntakePrompt } from "./prompts/intake.js";
import { buildIntegrationPrompt } from "./prompts/integration.js";
import { buildPlanningPrompt } from "./prompts/planning.js";
import { buildResearchPrompt } from "./prompts/research.js";
import { buildSelfReviewPrompt } from "./prompts/self-review.js";
import { buildSystemPrompt } from "./prompts/system.js";
import type { ExecuteTaskResult, OrchestratorContext, PipelineState } from "./types.js";
import { createWorkspaceLifecycle } from "./workspace-lifecycle.js";

// ── Re-exports ──────────────────────────────────────────────────────────────

export type { ExecuteTaskResult, Outcome } from "./types.js";
export { Outcomes } from "./types.js";
export type { OrchestratorContext, PipelineState } from "./types.js";
export type { WorkspaceLifecycle, AndonCord } from "./workspace-lifecycle.js";
export { createWorkspaceLifecycle } from "./workspace-lifecycle.js";
export type { PrManager } from "./pr-manager.js";
export { createPrManager } from "./pr-manager.js";
export type { DecompositionHandler } from "./decomposition-handler.js";
export { createDecompositionHandler } from "./decomposition-handler.js";
export type { LlmCaller } from "./llm-caller.js";

// ── Event Declarations ──────────────────────────────────────────────────────

export const EVENTS: EventDeclaration[] = [
  {
    type: "cost.incurred",
    description: "Emitted after each LLM call with token/cost details",
    payloadSchema: CostIncurredPayloadSchema,
    publishers: ["orchestrator"],
    subscribers: [],
  },
  {
    type: "preemption.ready",
    description: "Emitted when the orchestrator reaches a safe checkpoint for preemption",
    payloadSchema: PreemptionReadyPayloadSchema,
    publishers: ["orchestrator"],
    subscribers: [],
  },
  {
    type: "comm.message_sent",
    description: "Emitted when a notification is sent to a communication channel",
    payloadSchema: CommMessageSentPayloadSchema,
    publishers: ["orchestrator"],
    subscribers: [],
  },
];

// ── Types ───────────────────────────────────────────────────────────────────

/** Constructor dependencies for the Orchestrator. */
export interface OrchestratorDependencies {
  eventBus: IEventBus;
  registry: IPluginLookup;
  taskEngine: ITaskEngine;
  safetyLayer: ISafetyLayer;
  actionPipeline: IActionPipeline;
  sessionMemory: ISessionMemory;
  workspaceManager: IWorkspaceManager;
  peopleDirectory: PeopleDirectory;
  observationStore: IObservationStore | null;
  observer: IObserver;
}

// ── Orchestrator ────────────────────────────────────────────────────────────

/**
 * The brain of the system — a 7-phase pipeline that takes a task from intake
 * to integration.
 *
 * Derives from compiler front-end (multi-pass pipeline) + flight director
 * (coordination and communication). Delegates to focused subsystems:
 * - LlmCaller: LLM invocation, retry, cost, validation
 * - WorkspaceLifecycle: workspace setup, session, notifications
 * - PrManager: commit, push, PR creation
 * - DecompositionHandler: task decomposition
 * - PhaseRunner: phase pipeline orchestration
 *
 * Protocols implemented:
 * - P4 (Phase Transition): checkpoint → journal → update task.phase → next phase
 * - P8 (Preemption): cooperative yield via flag check between phases
 * - P9 (Task Resume): reconstruct from checkpoint, skip completed phases
 */
export class Orchestrator {
  private readonly ctx: OrchestratorContext;
  private readonly llmCaller: LlmCaller;
  private readonly workspaceLifecycle: ReturnType<typeof createWorkspaceLifecycle>;
  private readonly prManager: ReturnType<typeof createPrManager>;
  private readonly decompositionHandler: ReturnType<typeof createDecompositionHandler>;

  private preemptionRequested = false;
  private preemptionPayload: {
    target_task_id: string;
    preempting_task_id: string;
  } | null = null;

  /** Phase handler dispatch map — one method per phase. */
  private readonly phaseHandlers: ReturnType<typeof createPhaseHandlerRegistry>;

  constructor(deps: OrchestratorDependencies) {
    this.ctx = {
      eventBus: deps.eventBus,
      registry: deps.registry,
      taskEngine: deps.taskEngine,
      safetyLayer: deps.safetyLayer,
      actionPipeline: deps.actionPipeline,
      sessionMemory: deps.sessionMemory,
      workspaceManager: deps.workspaceManager,
      peopleDirectory: deps.peopleDirectory,
      observationStore: deps.observationStore,
      observer: deps.observer,
    };

    // Create subsystems
    this.llmCaller = createLlmCaller(this.ctx);
    this.workspaceLifecycle = createWorkspaceLifecycle(this.ctx);
    this.prManager = createPrManager(this.ctx);
    this.decompositionHandler = createDecompositionHandler(this.ctx);

    // Subscribe to preemption requests (Protocol P8)
    this.ctx.eventBus.subscribe(
      "orchestrator",
      EventTypes["preemption.requested"],
      (event: Event) => {
        this.preemptionRequested = true;
        const payload = event.payload as {
          target_task_id: string;
          preempting_task_id: string;
        };
        this.preemptionPayload = {
          target_task_id: payload.target_task_id,
          preempting_task_id: payload.preempting_task_id,
        };
      },
    );

    // Build phase handler registry
    this.phaseHandlers = createPhaseHandlerRegistry({
      [Phases.intake_analysis]: this.handleIntakeAnalysis.bind(this),
      [Phases.research]: this.handleResearch.bind(this),
      [Phases.planning]: this.handlePlanning.bind(this),
      [Phases.execution]: this.handleExecution.bind(this),
      [Phases.self_review]: this.handleSelfReview.bind(this),
      [Phases.demo_prep]: this.handleDemoPrep.bind(this),
      [Phases.integration]: this.handleIntegration.bind(this),
    });
  }

  /**
   * Execute a task through the phase pipeline.
   *
   * Entry point called by the Daemon. Handles new tasks and resumed tasks.
   * Returns when the pipeline completes, is preempted, decomposed, or encounters an error.
   */
  async executeTask(dispatch: Dispatch): Promise<ExecuteTaskResult> {
    const taskId = dispatch.task.id;
    const traceId = ulid();

    // ── Session setup ──────────────────────────────────────────────────────
    const session = this.workspaceLifecycle.createSession(dispatch);
    const sessionId = session.id;
    this.ctx.taskEngine.updateTaskField(taskId, "session_id", sessionId);

    // ── Workspace setup (D144) ──────────────────────────────────────────
    this.workspaceLifecycle.setupWorkspace(dispatch);

    // Notify task pickup (D152) — personal channels + GitHub issue comment
    this.workspaceLifecycle.notifyMilestone(dispatch, `Starting work on: ${dispatch.task.title}`);
    this.workspaceLifecycle.commentOnSourceIssue(dispatch, "Starting work on this issue.");

    // ── Build pipeline state ───────────────────────────────────────────────
    const state: PipelineState = {
      traceId,
      sessionId,
      loopbackCount: 0,
    };

    // ── Run phase pipeline ─────────────────────────────────────────────────
    return runPhasePipeline(dispatch, state, {
      ctx: this.ctx,
      handlers: this.phaseHandlers,
      workspaceLifecycle: this.workspaceLifecycle,
      prManager: this.prManager,
      decompositionHandler: this.decompositionHandler,
      isPreempted: () => this.preemptionRequested,
      getPreemptionPayload: () => this.preemptionPayload,
      resetPreemption: () => {
        this.preemptionRequested = false;
        this.preemptionPayload = null;
      },
    });
  }

  // ── Phase Handlers ──────────────────────────────────────────────────────────

  private handleIntakeAnalysis(
    taskId: string,
    dispatch: Dispatch,
    _priorOutputs: Map<Phase, PhaseOutput>,
    state: PipelineState,
  ): Promise<PhaseOutput> {
    const worktreePath = this.ctx.workspaceManager.getWorktreePath(taskId);
    const repoContext = gatherRepoContextSafe(worktreePath);
    const systemPrompt = buildSystemPrompt(Phases.intake_analysis);
    const unappliedFeedback = (dispatch.task.review?.feedback_rounds ?? []).filter(
      (r) => !r.applied,
    );
    const prompt = buildIntakePrompt({
      task: dispatch.task,
      repoContext,
      repoKnowledge: dispatch.knowledge.repo,
      userKnowledge: dispatch.knowledge.user,
      feedbackRounds: unappliedFeedback.length > 0 ? unappliedFeedback : undefined,
      prNumber: dispatch.task.review?.pr_number ?? undefined,
    });

    return this.llmCaller.runPhaseWithAgentLoop(
      Phases.intake_analysis,
      taskId,
      systemPrompt,
      prompt,
      state,
    );
  }

  private handleResearch(
    taskId: string,
    dispatch: Dispatch,
    priorOutputs: Map<Phase, PhaseOutput>,
    state: PipelineState,
  ): Promise<PhaseOutput> {
    const worktreePath = this.ctx.workspaceManager.getWorktreePath(taskId);
    const repoContext = gatherRepoContextSafe(worktreePath);
    const intakeData = priorOutputs.get(Phases.intake_analysis)?.data as
      | Record<string, unknown>
      | undefined;
    const systemPrompt = buildSystemPrompt(Phases.research);
    const prompt = buildResearchPrompt({
      task: dispatch.task,
      repoContext,
      intakeOutput: intakeData ?? null,
      repoKnowledge: dispatch.knowledge.repo,
      userKnowledge: dispatch.knowledge.user,
    });

    return this.llmCaller.runPhaseWithAgentLoop(
      Phases.research,
      taskId,
      systemPrompt,
      prompt,
      state,
    );
  }

  private handlePlanning(
    taskId: string,
    dispatch: Dispatch,
    priorOutputs: Map<Phase, PhaseOutput>,
    state: PipelineState,
  ): Promise<PhaseOutput> {
    const worktreePath = this.ctx.workspaceManager.getWorktreePath(taskId);
    const repoContext = gatherRepoContextSafe(worktreePath);
    const intakeData = priorOutputs.get(Phases.intake_analysis)?.data as
      | Record<string, unknown>
      | undefined;
    const researchData = priorOutputs.get(Phases.research)?.data as
      | Record<string, unknown>
      | undefined;
    const systemPrompt = buildSystemPrompt(Phases.planning);
    const prompt = buildPlanningPrompt({
      task: dispatch.task,
      repoContext,
      intakeOutput: intakeData ?? null,
      researchOutput: researchData ?? null,
      repoKnowledge: dispatch.knowledge.repo,
      userKnowledge: dispatch.knowledge.user,
    });

    return this.llmCaller.runPhaseWithAgentLoop(
      Phases.planning,
      taskId,
      systemPrompt,
      prompt,
      state,
    );
  }

  private handleExecution(
    taskId: string,
    dispatch: Dispatch,
    priorOutputs: Map<Phase, PhaseOutput>,
    state: PipelineState,
  ): Promise<PhaseOutput> {
    const worktreePath = this.ctx.workspaceManager.getWorktreePath(taskId);
    const repoContext = gatherRepoContextSafe(worktreePath);
    const intakeData = priorOutputs.get(Phases.intake_analysis)?.data as
      | Record<string, unknown>
      | undefined;
    const researchData = priorOutputs.get(Phases.research)?.data as
      | Record<string, unknown>
      | undefined;
    const planData = priorOutputs.get(Phases.planning)?.data as Record<string, unknown> | undefined;
    const systemPrompt = buildSystemPrompt(Phases.execution);
    const unappliedFeedback = (dispatch.task.review?.feedback_rounds ?? []).filter(
      (r) => !r.applied,
    );
    let prompt = buildExecutionPrompt({
      task: dispatch.task,
      repoContext,
      intakeOutput: intakeData ?? null,
      researchOutput: researchData ?? null,
      planningOutput: planData ?? null,
      repoKnowledge: dispatch.knowledge.repo,
      userKnowledge: dispatch.knowledge.user,
      feedbackRounds: unappliedFeedback.length > 0 ? unappliedFeedback : undefined,
    });

    // On loopback: inject self_review findings so execution knows what to fix
    const reviewData = priorOutputs.get(Phases.self_review)?.data as
      | Record<string, unknown>
      | undefined;
    if (reviewData) {
      prompt = `${prompt}\n\n${section("Review Findings to Address", formatPriorPhaseOutput(Phases.self_review, reviewData))}`;
    }

    return this.llmCaller.runPhaseWithAgentLoop(
      Phases.execution,
      taskId,
      systemPrompt,
      prompt,
      state,
    );
  }

  private handleSelfReview(
    taskId: string,
    dispatch: Dispatch,
    priorOutputs: Map<Phase, PhaseOutput>,
    state: PipelineState,
  ): Promise<PhaseOutput> {
    const worktreePath = this.ctx.workspaceManager.getWorktreePath(taskId);
    const repoContext = gatherRepoContextSafe(worktreePath);
    const intakeData = priorOutputs.get(Phases.intake_analysis)?.data as
      | Record<string, unknown>
      | undefined;
    const planData = priorOutputs.get(Phases.planning)?.data as Record<string, unknown> | undefined;
    const execData = priorOutputs.get(Phases.execution)?.data as
      | Record<string, unknown>
      | undefined;
    const selfReviewData = priorOutputs.get(Phases.self_review)?.data as
      | Record<string, unknown>
      | undefined;
    const systemPrompt = buildSystemPrompt(Phases.self_review);
    const prompt = buildSelfReviewPrompt({
      task: dispatch.task,
      repoContext,
      intakeOutput: intakeData ?? null,
      planningOutput: planData ?? null,
      executionOutput: execData ?? null,
      selfReviewFindings: selfReviewData ?? null,
      loopbackCount: state.loopbackCount,
      repoKnowledge: dispatch.knowledge.repo,
      userKnowledge: dispatch.knowledge.user,
    });

    return this.llmCaller.runPhaseWithAgentLoop(
      Phases.self_review,
      taskId,
      systemPrompt,
      prompt,
      state,
    );
  }

  private handleDemoPrep(
    taskId: string,
    dispatch: Dispatch,
    priorOutputs: Map<Phase, PhaseOutput>,
    state: PipelineState,
  ): Promise<PhaseOutput> {
    const worktreePath = this.ctx.workspaceManager.getWorktreePath(taskId);
    const repoContext = gatherRepoContextSafe(worktreePath);
    const intakeData = priorOutputs.get(Phases.intake_analysis)?.data as
      | Record<string, unknown>
      | undefined;
    const planData = priorOutputs.get(Phases.planning)?.data as Record<string, unknown> | undefined;
    const execData = priorOutputs.get(Phases.execution)?.data as
      | Record<string, unknown>
      | undefined;
    const selfReviewData = priorOutputs.get(Phases.self_review)?.data as
      | Record<string, unknown>
      | undefined;
    const systemPrompt = buildSystemPrompt(Phases.demo_prep);
    const prompt = buildDemoPrepPrompt({
      task: dispatch.task,
      repoContext,
      intakeOutput: intakeData ?? null,
      planningOutput: planData ?? null,
      executionOutput: execData ?? null,
      selfReviewOutput: selfReviewData ?? null,
      repoKnowledge: dispatch.knowledge.repo,
      userKnowledge: dispatch.knowledge.user,
    });

    return this.llmCaller.runPhaseWithAgentLoop(
      Phases.demo_prep,
      taskId,
      systemPrompt,
      prompt,
      state,
    );
  }

  private handleIntegration(
    taskId: string,
    dispatch: Dispatch,
    priorOutputs: Map<Phase, PhaseOutput>,
    state: PipelineState,
  ): Promise<PhaseOutput> {
    const worktreePath = this.ctx.workspaceManager.getWorktreePath(taskId);
    const repoContext = gatherRepoContextSafe(worktreePath);
    const execData = priorOutputs.get(Phases.execution)?.data as
      | Record<string, unknown>
      | undefined;
    const selfReviewData = priorOutputs.get(Phases.self_review)?.data as
      | Record<string, unknown>
      | undefined;

    const childSummaries = (dispatch.task.child_summaries ?? []).map((cs) => ({
      child_id: cs.child_id,
      child_title: cs.child_title,
      branch: cs.branch,
      test_status: cs.test_status,
      files_changed: cs.key_outputs.map((o) => o.path),
    }));

    const systemPrompt = buildSystemPrompt(Phases.integration);
    const prompt = buildIntegrationPrompt({
      task: dispatch.task,
      repoContext,
      executionOutput: execData ?? null,
      selfReviewOutput: selfReviewData ?? null,
      childSummaries,
      repoKnowledge: dispatch.knowledge.repo,
      userKnowledge: dispatch.knowledge.user,
    });

    return this.llmCaller.runPhaseWithAgentLoop(
      Phases.integration,
      taskId,
      systemPrompt,
      prompt,
      state,
    );
  }

  // ── Self-Unblock ──────────────────────────────────────────────────────────

  /**
   * Attempt to self-diagnose and resolve a blocked task.
   *
   * Called by the Daemon during Stage 2 of blocked timeout escalation.
   * Returns `true` if the block was resolved, `false` otherwise.
   */
  async attemptSelfUnblock(taskId: string): Promise<boolean> {
    const task = this.ctx.taskEngine.getTask(taskId);
    if (!task || task.state !== TaskStates.blocked) {
      return false;
    }

    const llm = this.ctx.registry.getPrimaryPlugin<LLMAdapter>(AdapterTypes.llm);
    if (!llm) {
      return false;
    }

    const entries = this.ctx.sessionMemory.queryJournal(taskId);
    const recentEntries = entries.slice(-5);
    const blockedReason = task.blocked?.reason ?? "unknown";

    const prompt = [
      "A task is blocked and needs diagnosis.",
      `Task: "${task.title}"`,
      `Blocked reason: ${blockedReason}`,
      `Recent activity: ${JSON.stringify(recentEntries.map((e) => ({ type: e.type, summary: e.summary })))}`,
      "",
      "Can this be automatically resolved? Respond with JSON:",
      '{ "can_resolve": boolean, "action": "description of resolution or why not" }',
    ].join("\n");

    try {
      const pipelineResult = await this.ctx.actionPipeline.execute<CompletionResult>({
        taskId,
        actionClass: ActionClasses.read,
        details: { operation: "self_unblock_diagnosis" },
        requestedBy: "orchestrator",
        executeFn: () =>
          llm.complete({
            prompt,
            system_prompt: null,
            options: { max_tokens: 200, temperature: null, stop: null, tools: null },
          }),
      });

      if (pipelineResult.outcome !== "executed") {
        return false;
      }

      this.llmCaller.emitCostIncurred(taskId, pipelineResult.result);

      const parsed = JSON.parse(pipelineResult.result.content) as { can_resolve?: boolean };
      return parsed.can_resolve === true;
    } catch {
      return false;
    }
  }
}
