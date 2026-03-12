import { execFileSync } from "node:child_process";
import type { ZodType } from "zod";
import type { CommunicationAdapter } from "../../adapters/communication.js";
import type { GitHostingAdapter } from "../../adapters/git-hosting.js";
import type { LLMAdapter } from "../../adapters/llm.js";
import type { ToolAdapter } from "../../adapters/tool.js";
import type { CompletionResult } from "../../schemas/adapters.js";
import type { Dispatch } from "../../schemas/ephemeral.js";
import type { Event } from "../../schemas/events.js";
import {
  DemoPrepOutputSchema,
  ExecutionOutputSchema,
  IntakeAnalysisOutputSchema,
  IntegrationOutputSchema,
  LLMDecompositionPlanSchema,
  type Phase,
  type PhaseOutput,
  PlanningOutputSchema,
  ResearchOutputSchema,
  SelfReviewOutputSchema,
} from "../../schemas/orchestrator.js";
import type { ChildEntry } from "../../schemas/task.js";
import type { ActionPipeline } from "../action-pipeline/index.js";
import type { EventBus, PublishInput } from "../event-bus/index.js";
import type { PeopleDirectory } from "../people-directory/index.js";
import type { Registry } from "../registry/index.js";
import type { SafetyLayer } from "../safety-layer/index.js";
import type { SessionMemory } from "../session-memory/index.js";
import type { TaskEngine } from "../task-engine/index.js";
import type { WorkspaceManager } from "../workspace-manager/index.js";
import { executeAction as executeAgentAction } from "./action-executor.js";
import { type AgentLoopResult, runAgentLoop } from "./agent-loop.js";
import { getPhaseToolConfig } from "./phase-tools.js";
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

// ── Constants ───────────────────────────────────────────────────────────────

/** The standard 7-phase pipeline sequence. */
export const PHASE_SEQUENCE: Phase[] = [
  "intake_analysis",
  "research",
  "planning",
  "execution",
  "self_review",
  "demo_prep",
  "integration",
];

/** Fast-path phases: skip research, planning, demo_prep, integration. */
const FAST_PATH_PHASES: Phase[] = ["execution", "self_review"];

/** Max loopbacks before alerting human (orchestrator.md default: 3). */
const MAX_LOOPBACKS_BEFORE_ALERT = 3;

/** Phase-specific Zod schemas for output validation. */
const PHASE_SCHEMAS: Record<Phase, ZodType> = {
  intake_analysis: IntakeAnalysisOutputSchema,
  research: ResearchOutputSchema,
  planning: PlanningOutputSchema,
  execution: ExecutionOutputSchema,
  self_review: SelfReviewOutputSchema,
  demo_prep: DemoPrepOutputSchema,
  integration: IntegrationOutputSchema,
};

// ── Types ───────────────────────────────────────────────────────────────────

/** Constructor dependencies for the Orchestrator. */
export interface OrchestratorDependencies {
  eventBus: EventBus;
  registry: Registry;
  taskEngine: TaskEngine;
  safetyLayer: SafetyLayer;
  actionPipeline: ActionPipeline;
  sessionMemory: SessionMemory;
  workspaceManager: WorkspaceManager;
  peopleDirectory: PeopleDirectory;
}

/** Discriminated union of executeTask outcomes. */
export type ExecuteTaskResult =
  | { outcome: "completed"; phaseOutputs: Map<Phase, PhaseOutput> }
  | { outcome: "decomposed"; childTaskIds: string[]; phaseOutputs: Map<Phase, PhaseOutput> }
  | { outcome: "preempted"; lastPhase: Phase; checkpointId: string }
  | { outcome: "error"; phase: Phase; reason: string };

// ── Orchestrator ────────────────────────────────────────────────────────────

/**
 * The brain of the system — a 7-phase pipeline that takes a task from intake
 * to integration.
 *
 * Derives from compiler front-end (multi-pass pipeline) + flight director
 * (coordination and communication). This is the skeleton: thin phase handlers
 * that call the LLM adapter, parse responses with `.safeParse()`, and produce
 * PhaseOutputs. Full phase sophistication comes in later refinement.
 *
 * Protocols implemented:
 * - P4 (Phase Transition): checkpoint → journal → update task.phase → next phase
 * - P8 (Preemption): cooperative yield via flag check between phases
 * - P9 (Task Resume): reconstruct from checkpoint, skip completed phases
 */
export class Orchestrator {
  private readonly eventBus: EventBus;
  private readonly registry: Registry;
  private readonly taskEngine: TaskEngine;
  // Stored for future use: Orchestrator will call consultJudgment() directly
  // for should_i_ask queries and cost_check pre-flight. Currently Gate 2 runs
  // through ActionPipeline, so no direct calls in the skeleton.
  private readonly safetyLayer: SafetyLayer;
  private readonly actionPipeline: ActionPipeline;
  private readonly sessionMemory: SessionMemory;
  private readonly workspaceManager: WorkspaceManager;
  private readonly peopleDirectory: PeopleDirectory;

  private preemptionRequested = false;
  private loopbackCount = 0;
  private preemptionPayload: {
    target_task_id: string;
    preempting_task_id: string;
  } | null = null;

  /** Phase handler dispatch map — one method per phase. */
  private readonly phaseHandlers: Record<
    Phase,
    (
      taskId: string,
      dispatch: Dispatch,
      priorOutputs: Map<Phase, PhaseOutput>,
    ) => Promise<PhaseOutput>
  >;

  constructor(deps: OrchestratorDependencies) {
    this.eventBus = deps.eventBus;
    this.registry = deps.registry;
    this.taskEngine = deps.taskEngine;
    this.safetyLayer = deps.safetyLayer;
    this.actionPipeline = deps.actionPipeline;
    this.sessionMemory = deps.sessionMemory;
    this.workspaceManager = deps.workspaceManager;
    this.peopleDirectory = deps.peopleDirectory;

    // Subscribe to preemption requests (Protocol P8)
    this.eventBus.subscribe("orchestrator", "preemption.requested", (event: Event) => {
      this.preemptionRequested = true;
      const payload = event.payload as {
        target_task_id: string;
        preempting_task_id: string;
      };
      this.preemptionPayload = {
        target_task_id: payload.target_task_id,
        preempting_task_id: payload.preempting_task_id,
      };
    });

    // Bind phase handlers
    this.phaseHandlers = {
      intake_analysis: this.handleIntakeAnalysis.bind(this),
      research: this.handleResearch.bind(this),
      planning: this.handlePlanning.bind(this),
      execution: this.handleExecution.bind(this),
      self_review: this.handleSelfReview.bind(this),
      demo_prep: this.handleDemoPrep.bind(this),
      integration: this.handleIntegration.bind(this),
    };
  }

  /**
   * Execute a task through the phase pipeline.
   *
   * Entry point called by the Daemon. Handles new tasks and resumed tasks.
   * Returns when the pipeline completes, is preempted, decomposed, or encounters an error.
   */
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: main pipeline loop with extracted helpers — further extraction harms readability
  async executeTask(dispatch: Dispatch): Promise<ExecuteTaskResult> {
    const taskId = dispatch.task.id;
    this.loopbackCount = 0;

    // ── Session setup ──────────────────────────────────────────────────────
    const session = this.createSession(dispatch);
    const sessionId = session.id;
    this.taskEngine.updateTaskField(taskId, "session_id", sessionId);

    // ── Workspace setup (D144) ──────────────────────────────────────────
    if (!dispatch.resume_from) {
      const repo = dispatch.task.repo;
      const cloneUrl = dispatch.task.clone_url;
      if (repo && cloneUrl) {
        // Child tasks branch from parent's branch
        let parentBranch: string | undefined;
        if (dispatch.task.parent_id) {
          const parentTask = this.taskEngine.getTask(dispatch.task.parent_id);
          parentBranch = parentTask?.workspace?.branch ?? undefined;
        }
        const record = this.workspaceManager.createWorkspace(
          taskId,
          repo,
          dispatch.task.title,
          undefined,
          parentBranch,
          cloneUrl,
        );
        this.taskEngine.updateTaskField(taskId, "workspace", {
          repo,
          branch: record.branch,
          worktree_path: record.worktreePath,
        });
      }
    } else if (dispatch.task.workspace) {
      this.workspaceManager.registerExistingWorkspace(taskId, dispatch.task.workspace);
    }

    // Notify task pickup (D152) — personal channels + GitHub issue comment
    this.notifyMilestone(dispatch, `Starting work on: ${dispatch.task.title}`);
    this.commentOnSourceIssue(dispatch, "Starting work on this issue.");

    // ── Determine phase sequence ───────────────────────────────────────────
    const { phases: initialPhases, startIndex } = this.resolveStartState(
      dispatch,
      sessionId,
      taskId,
    );
    let phases = initialPhases;

    // Set initial task.phase so Daemon can see what phase we're in
    // biome-ignore lint/style/noNonNullAssertion: startIndex is within bounds (resolveStartState guarantees it)
    const initialPhase = phases[startIndex]!;
    this.taskEngine.updateTaskField(taskId, "phase", initialPhase);

    // ── Phase loop ─────────────────────────────────────────────────────────
    const priorOutputs = new Map<Phase, PhaseOutput>();

    for (let i = startIndex; i < phases.length; i++) {
      if (this.preemptionRequested) {
        // biome-ignore lint/style/noNonNullAssertion: phases[i] is guaranteed valid within loop bounds
        return this.handlePreemption(sessionId, taskId, phases[i]!, priorOutputs);
      }

      // biome-ignore lint/style/noNonNullAssertion: phases[i] is guaranteed valid within loop bounds
      const phase = phases[i]!;

      // Execute the phase handler
      let output: PhaseOutput;
      try {
        output = await this.phaseHandlers[phase](taskId, dispatch, priorOutputs);
      } catch (error: unknown) {
        return this.handlePhaseError(sessionId, taskId, phase, error);
      }

      priorOutputs.set(phase, output);

      // Post-phase processing (fast-path, loopback, transitions, PR creation)
      const postResult = await this.processPhaseCompletion(
        sessionId,
        taskId,
        phase,
        output,
        phases,
        i,
        priorOutputs,
        dispatch,
      );
      if (postResult.decompositionResult) {
        return postResult.decompositionResult;
      }
      if (postResult.loopbackIndex !== null) {
        i = postResult.loopbackIndex;
        continue;
      }
      phases = postResult.phases;
      if (postResult.preemptionResult) {
        return postResult.preemptionResult;
      }
    }

    // ── Pipeline complete ──────────────────────────────────────────────────
    this.sessionMemory.endSession(sessionId, "completed");
    return { outcome: "completed", phaseOutputs: priorOutputs };
  }

  // ── Phase Handlers ──────────────────────────────────────────────────────────

  private handleIntakeAnalysis(
    taskId: string,
    dispatch: Dispatch,
    _priorOutputs: Map<Phase, PhaseOutput>,
  ): Promise<PhaseOutput> {
    const worktreePath = this.workspaceManager.getWorktreePath(taskId);
    const repoContext = gatherRepoContextSafe(worktreePath);
    const systemPrompt = buildSystemPrompt("intake_analysis");
    const prompt = buildIntakePrompt({
      task: dispatch.task,
      repoContext,
      repoKnowledge: dispatch.knowledge.repo,
      userKnowledge: dispatch.knowledge.user,
    });

    return this.runPhaseWithAgentLoop("intake_analysis", taskId, systemPrompt, prompt);
  }

  private handleResearch(
    taskId: string,
    dispatch: Dispatch,
    priorOutputs: Map<Phase, PhaseOutput>,
  ): Promise<PhaseOutput> {
    const worktreePath = this.workspaceManager.getWorktreePath(taskId);
    const repoContext = gatherRepoContextSafe(worktreePath);
    const intakeData = priorOutputs.get("intake_analysis")?.data as
      | Record<string, unknown>
      | undefined;
    const systemPrompt = buildSystemPrompt("research");
    const prompt = buildResearchPrompt({
      task: dispatch.task,
      repoContext,
      intakeOutput: intakeData ?? null,
      repoKnowledge: dispatch.knowledge.repo,
      userKnowledge: dispatch.knowledge.user,
    });

    return this.runPhaseWithAgentLoop("research", taskId, systemPrompt, prompt);
  }

  private handlePlanning(
    taskId: string,
    dispatch: Dispatch,
    priorOutputs: Map<Phase, PhaseOutput>,
  ): Promise<PhaseOutput> {
    const worktreePath = this.workspaceManager.getWorktreePath(taskId);
    const repoContext = gatherRepoContextSafe(worktreePath);
    const intakeData = priorOutputs.get("intake_analysis")?.data as
      | Record<string, unknown>
      | undefined;
    const researchData = priorOutputs.get("research")?.data as Record<string, unknown> | undefined;
    const systemPrompt = buildSystemPrompt("planning");
    const prompt = buildPlanningPrompt({
      task: dispatch.task,
      repoContext,
      intakeOutput: intakeData ?? null,
      researchOutput: researchData ?? null,
      repoKnowledge: dispatch.knowledge.repo,
      userKnowledge: dispatch.knowledge.user,
    });

    return this.runPhaseWithAgentLoop("planning", taskId, systemPrompt, prompt);
  }

  private handleExecution(
    taskId: string,
    dispatch: Dispatch,
    priorOutputs: Map<Phase, PhaseOutput>,
  ): Promise<PhaseOutput> {
    const worktreePath = this.workspaceManager.getWorktreePath(taskId);
    const repoContext = gatherRepoContextSafe(worktreePath);
    const intakeData = priorOutputs.get("intake_analysis")?.data as
      | Record<string, unknown>
      | undefined;
    const researchData = priorOutputs.get("research")?.data as Record<string, unknown> | undefined;
    const planData = priorOutputs.get("planning")?.data as Record<string, unknown> | undefined;
    const systemPrompt = buildSystemPrompt("execution");
    let prompt = buildExecutionPrompt({
      task: dispatch.task,
      repoContext,
      intakeOutput: intakeData ?? null,
      researchOutput: researchData ?? null,
      planningOutput: planData ?? null,
      repoKnowledge: dispatch.knowledge.repo,
      userKnowledge: dispatch.knowledge.user,
    });

    // On loopback: inject self_review findings so execution knows what to fix
    const reviewData = priorOutputs.get("self_review")?.data as Record<string, unknown> | undefined;
    if (reviewData) {
      prompt = `${prompt}\n\n${section("Review Findings to Address", formatPriorPhaseOutput("self_review", reviewData))}`;
    }

    return this.runPhaseWithAgentLoop("execution", taskId, systemPrompt, prompt);
  }

  private handleSelfReview(
    taskId: string,
    dispatch: Dispatch,
    priorOutputs: Map<Phase, PhaseOutput>,
  ): Promise<PhaseOutput> {
    const worktreePath = this.workspaceManager.getWorktreePath(taskId);
    const repoContext = gatherRepoContextSafe(worktreePath);
    const intakeData = priorOutputs.get("intake_analysis")?.data as
      | Record<string, unknown>
      | undefined;
    const planData = priorOutputs.get("planning")?.data as Record<string, unknown> | undefined;
    const execData = priorOutputs.get("execution")?.data as Record<string, unknown> | undefined;
    const selfReviewData = priorOutputs.get("self_review")?.data as
      | Record<string, unknown>
      | undefined;
    const systemPrompt = buildSystemPrompt("self_review");
    const prompt = buildSelfReviewPrompt({
      task: dispatch.task,
      repoContext,
      intakeOutput: intakeData ?? null,
      planningOutput: planData ?? null,
      executionOutput: execData ?? null,
      selfReviewFindings: selfReviewData ?? null,
      loopbackCount: this.loopbackCount,
      repoKnowledge: dispatch.knowledge.repo,
      userKnowledge: dispatch.knowledge.user,
    });

    return this.runPhaseWithAgentLoop("self_review", taskId, systemPrompt, prompt);
  }

  private handleDemoPrep(
    taskId: string,
    dispatch: Dispatch,
    priorOutputs: Map<Phase, PhaseOutput>,
  ): Promise<PhaseOutput> {
    const worktreePath = this.workspaceManager.getWorktreePath(taskId);
    const repoContext = gatherRepoContextSafe(worktreePath);
    const intakeData = priorOutputs.get("intake_analysis")?.data as
      | Record<string, unknown>
      | undefined;
    const planData = priorOutputs.get("planning")?.data as Record<string, unknown> | undefined;
    const execData = priorOutputs.get("execution")?.data as Record<string, unknown> | undefined;
    const selfReviewData = priorOutputs.get("self_review")?.data as
      | Record<string, unknown>
      | undefined;
    const systemPrompt = buildSystemPrompt("demo_prep");
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

    return this.runPhaseWithAgentLoop("demo_prep", taskId, systemPrompt, prompt);
  }

  private handleIntegration(
    taskId: string,
    dispatch: Dispatch,
    priorOutputs: Map<Phase, PhaseOutput>,
  ): Promise<PhaseOutput> {
    const worktreePath = this.workspaceManager.getWorktreePath(taskId);
    const repoContext = gatherRepoContextSafe(worktreePath);
    const execData = priorOutputs.get("execution")?.data as Record<string, unknown> | undefined;
    const selfReviewData = priorOutputs.get("self_review")?.data as
      | Record<string, unknown>
      | undefined;

    // Child summaries are populated on the task by Daemon before re-dispatch
    const childSummaries = (dispatch.task.child_summaries ?? []).map((cs) => ({
      child_id: cs.child_id,
      child_title: cs.child_title,
      branch: cs.branch,
      test_status: cs.test_status,
      files_changed: cs.key_outputs.map((o) => o.path),
    }));

    const systemPrompt = buildSystemPrompt("integration");
    const prompt = buildIntegrationPrompt({
      task: dispatch.task,
      repoContext,
      executionOutput: execData ?? null,
      selfReviewOutput: selfReviewData ?? null,
      childSummaries,
      repoKnowledge: dispatch.knowledge.repo,
      userKnowledge: dispatch.knowledge.user,
    });

    return this.runPhaseWithAgentLoop("integration", taskId, systemPrompt, prompt);
  }

  // ── Extracted Helpers (for cognitive complexity) ─────────────────────────────

  /** Determine start index and log resume context (Protocol P9). */
  private resolveStartState(
    dispatch: Dispatch,
    sessionId: string,
    taskId: string,
  ): { phases: Phase[]; startIndex: number } {
    const phases = [...PHASE_SEQUENCE];

    if (!dispatch.resume_from) {
      return { phases, startIndex: 0 };
    }

    const checkpoint = dispatch.resume_from;
    const checkpointPhaseIndex = phases.indexOf(checkpoint.phase as Phase);
    const startIndex = checkpointPhaseIndex >= 0 ? checkpointPhaseIndex + 1 : 0;

    // Verify workspace integrity before resuming (Plan step 2)
    this.workspaceManager.verifyWorkspace(taskId);

    this.sessionMemory.addJournalEntry({
      sessionId,
      taskId,
      phase: checkpoint.phase,
      type: "phase_change",
      summary: `Resumed from checkpoint in ${checkpoint.phase} phase. Reason: ${checkpoint.reason}.`,
      detail: checkpoint.next_action,
      tags: ["resume"],
    });

    return { phases, startIndex };
  }

  /** Handle post-phase logic: fast-path, decomposition, loopback, transitions, preemption, PR creation. */
  private async processPhaseCompletion(
    sessionId: string,
    taskId: string,
    phase: Phase,
    output: PhaseOutput,
    currentPhases: Phase[],
    currentIndex: number,
    priorOutputs: Map<Phase, PhaseOutput>,
    dispatch: Dispatch,
  ): Promise<{
    phases: Phase[];
    loopbackIndex: number | null;
    preemptionResult: ExecuteTaskResult | null;
    decompositionResult: ExecuteTaskResult | null;
  }> {
    let phases = currentPhases;

    // Fast-path: after intake_analysis, check if we should skip phases
    if (phase === "intake_analysis") {
      phases = this.applyFastPathIfNeeded(output, phases);
    }

    // Decomposition: after planning, check if task should be split into children
    if (phase === "planning") {
      const decompositionResult = this.handleDecomposition(
        sessionId,
        taskId,
        output,
        dispatch,
        priorOutputs,
      );
      if (decompositionResult) {
        return { phases, loopbackIndex: null, preemptionResult: null, decompositionResult };
      }
    }

    // Self-review quality gate: loopback to execution if needs_work
    if (phase === "self_review") {
      const loopbackResult = this.checkSelfReviewLoopback(sessionId, taskId, output, phases);
      if (loopbackResult) {
        this.taskEngine.updateTaskField(taskId, "phase", "execution");
        return {
          phases,
          loopbackIndex: loopbackResult.targetIndex - 1,
          preemptionResult: null,
          decompositionResult: null,
        };
      }
    }

    // After demo_prep: commit, push, create draft PR (D149, D150)
    if (phase === "demo_prep") {
      await this.commitPushAndCreatePR(sessionId, taskId, output, dispatch);
    }

    // Protocol P4: Phase transition
    const isLastPhase = currentIndex === phases.length - 1;

    // Fast-path PR: when self_review is the final phase (no demo_prep), still create PR
    if (phase === "self_review" && isLastPhase) {
      await this.commitPushAndCreatePR(sessionId, taskId, output, dispatch);
    }
    // biome-ignore lint/style/noNonNullAssertion: next phase exists when not last
    const nextPhase = isLastPhase ? null : phases[currentIndex + 1]!;
    this.recordPhaseTransition(sessionId, taskId, phase, nextPhase, priorOutputs);

    // Check preemption after phase completion
    if (this.preemptionRequested && nextPhase) {
      return {
        phases,
        loopbackIndex: null,
        preemptionResult: this.handlePreemption(sessionId, taskId, nextPhase, priorOutputs),
        decompositionResult: null,
      };
    }

    return { phases, loopbackIndex: null, preemptionResult: null, decompositionResult: null };
  }

  /** Log error and build error result for a failed phase. */
  private handlePhaseError(
    sessionId: string,
    taskId: string,
    phase: Phase,
    error: unknown,
  ): ExecuteTaskResult {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? (error.stack ?? null) : null;

    this.sessionMemory.addJournalEntry({
      sessionId,
      taskId,
      phase,
      type: "error",
      summary: `Phase ${phase} failed: ${message}`,
      errorDetail: stack,
      tags: ["phase_error"],
    });

    return { outcome: "error", phase, reason: message };
  }

  /** Record a phase transition: checkpoint + journal + update task.phase (Protocol P4). */
  private recordPhaseTransition(
    sessionId: string,
    taskId: string,
    completedPhase: Phase,
    nextPhase: Phase | null,
    priorOutputs: Map<Phase, PhaseOutput>,
  ): void {
    this.createPhaseCheckpoint(sessionId, taskId, completedPhase, priorOutputs, nextPhase);

    this.sessionMemory.addJournalEntry({
      sessionId,
      taskId,
      phase: completedPhase,
      type: "phase_change",
      summary: nextPhase
        ? `Completed ${completedPhase}, entering ${nextPhase}`
        : `Completed ${completedPhase} (final phase)`,
      tags: ["phase_transition"],
    });

    if (nextPhase) {
      this.taskEngine.updateTaskField(taskId, "phase", nextPhase);
    }
  }

  /** Check if intake output enables fast-path, return updated phases array. */
  private applyFastPathIfNeeded(intakeOutput: PhaseOutput, currentPhases: Phase[]): Phase[] {
    const intakeData = intakeOutput.data as { fast_path?: boolean };
    if (intakeData.fast_path === true) {
      return ["intake_analysis", ...FAST_PATH_PHASES];
    }
    return currentPhases;
  }

  /** Check if self-review output requires loopback to execution. */
  private checkSelfReviewLoopback(
    sessionId: string,
    taskId: string,
    output: PhaseOutput,
    phases: Phase[],
  ): { targetIndex: number } | null {
    // Only trust quality assessment from real LLM output (not fallback defaults)
    if (output.confidence === "low") {
      return null;
    }

    const reviewData = output.data as { quality_assessment?: string };
    const assessment = reviewData.quality_assessment;

    if (assessment !== "needs_work" && assessment !== "fundamental_issues") {
      return null;
    }

    this.loopbackCount++;

    if (this.loopbackCount > MAX_LOOPBACKS_BEFORE_ALERT) {
      this.emitLoopbackAlert(sessionId, taskId, this.loopbackCount, assessment);
      return null; // Proceed to demo_prep — human will review
    }

    this.sessionMemory.addJournalEntry({
      sessionId,
      taskId,
      phase: "self_review",
      type: "phase_change",
      summary: `Quality assessment: ${assessment}. Looping back to execution (attempt ${String(this.loopbackCount)}).`,
      tags: ["loopback", assessment],
    });

    const executionIndex = phases.indexOf("execution");
    if (executionIndex < 0) {
      return null; // Shouldn't happen, but defensive
    }
    return { targetIndex: executionIndex };
  }

  /** Alert human that loopbacks have exceeded the safety threshold. */
  private emitLoopbackAlert(
    sessionId: string,
    taskId: string,
    count: number,
    assessment: string,
  ): void {
    this.eventBus.publish({
      type: "comm.message_sent",
      source: "orchestrator",
      task_id: taskId,
      payload: {
        task_id: taskId,
        target: "owner",
        message_type: "alert",
        content_summary: `Self-review loopback threshold exceeded (${String(count)} attempts, assessment: ${assessment}). Proceeding to demo_prep for human review.`,
        channel: "primary",
      },
    } satisfies PublishInput<"comm.message_sent">);

    this.sessionMemory.addJournalEntry({
      sessionId,
      taskId,
      phase: "self_review",
      type: "error",
      summary: `Loopback threshold exceeded (${String(count)} attempts, assessment: ${assessment}). Proceeding to demo_prep for human review.`,
      tags: ["loopback_alert"],
    });
  }

  // ── Decomposition ───────────────────────────────────────────────────────────

  /**
   * After planning: check if the LLM produced a decomposition plan.
   * If so, create child tasks, transition parent to supervising, and return.
   */
  private handleDecomposition(
    sessionId: string,
    taskId: string,
    planningOutput: PhaseOutput,
    dispatch: Dispatch,
    priorOutputs: Map<Phase, PhaseOutput>,
  ): ExecuteTaskResult | null {
    const planData = planningOutput.data as { decomposition_plan?: unknown };
    if (!planData.decomposition_plan) {
      return null;
    }

    const parseResult = LLMDecompositionPlanSchema.safeParse(planData.decomposition_plan);
    if (!parseResult.success) {
      this.sessionMemory.addJournalEntry({
        sessionId,
        taskId,
        phase: "planning",
        type: "error",
        summary: `Invalid decomposition plan from LLM: ${parseResult.error.message}`,
        tags: ["decomposition", "validation_error"],
      });
      return null;
    }

    const plan = parseResult.data;
    const childIds: string[] = [];

    for (const childSpec of plan.children) {
      const childTask = this.taskEngine.createTask({
        title: childSpec.title,
        repo: dispatch.task.repo ?? "",
        source: "decomposition",
        description: childSpec.description,
        parent_id: taskId,
        acceptance_criteria: childSpec.acceptance_criteria,
        clone_url: dispatch.task.clone_url,
        cascade_policy: "pause_siblings",
      });

      this.taskEngine.requestTransition(
        childTask.id,
        "queued",
        null,
        "decomposition",
        "orchestrator",
      );

      childIds.push(childTask.id);
    }

    // Build children array with dependency mapping (index-based → task ID)
    const childEntries: ChildEntry[] = childIds.map((id, idx) => {
      // biome-ignore lint/style/noNonNullAssertion: idx is within bounds
      const spec = plan.children[idx]!;
      const dependsOnIds = spec.depends_on
        .filter((depIdx) => depIdx >= 0 && depIdx < childIds.length)
        // biome-ignore lint/style/noNonNullAssertion: filter guarantees valid index
        .map((depIdx) => childIds[depIdx]!);
      return { id, state: "queued" as const, depends_on: dependsOnIds };
    });
    this.taskEngine.updateTaskField(taskId, "children", childEntries);

    // Transition parent: active.working → active.supervising
    this.taskEngine.requestTransition(
      taskId,
      "active",
      "supervising",
      "decomposed_into_children",
      "orchestrator",
    );

    this.sessionMemory.addJournalEntry({
      sessionId,
      taskId,
      phase: "planning",
      type: "phase_change",
      summary: `Task decomposed into ${String(childIds.length)} child tasks: ${childIds.join(", ")}`,
      tags: ["decomposition"],
    });

    const subtaskList = plan.children.map((c, i) => `${String(i + 1)}. ${c.title}`).join("\n");
    this.commentOnSourceIssue(
      dispatch,
      `Decomposing into ${String(plan.children.length)} subtasks:\n${subtaskList}`,
    );

    this.sessionMemory.endSession(sessionId, "decomposed");

    return { outcome: "decomposed", childTaskIds: childIds, phaseOutputs: priorOutputs };
  }

  // ── Workspace Integration (D149, D150, D152) ────────────────────────────────

  /**
   * Send a milestone notification via PeopleDirectory + comm plugins (D152).
   *
   * Resolves the owner from PeopleDirectory, then sends to all registered
   * communication plugins. Fire-and-forget — errors are logged, never block
   * the pipeline.
   */
  private notifyMilestone(dispatch: Dispatch, message: string): void {
    try {
      const owner = this.peopleDirectory.getOwner();
      if (!owner || owner.contacts.length === 0) {
        return; // No owner or no contacts configured
      }

      const commPlugins = this.registry.getPluginsByType<CommunicationAdapter>("communication");
      if (commPlugins.length === 0) {
        return; // No comm plugins registered
      }

      const taskId = dispatch.task.id;

      // Route by contact channel → matching comm plugin
      // Contact channel is "telegram", plugin ID is "telegram-comm".
      // Convention: plugin ID = "{channel}-comm"
      for (const contact of owner.contacts) {
        const plugin = commPlugins.find(
          (p) => p.manifest.id === `${contact.channel}-comm` || p.manifest.id === contact.channel,
        );
        if (!plugin) {
          continue; // No plugin for this channel
        }

        const target = {
          user_id: contact.handle,
          channel: contact.channel,
        };

        const formatted = {
          content: plugin.formatMessage(message, "milestone"),
          metadata: { task_id: taskId, type: "milestone" as const },
        };

        // Fire-and-forget — catch all errors
        plugin.sendMessage(target, formatted).catch(() => {
          // Silent — notification failure must never block the pipeline
        });
      }
    } catch {
      // Silent — notification failure must never block the pipeline
    }
  }

  /**
   * Post a comment on the source GitHub issue (the issue that triggered this task).
   *
   * Uses task.external_ref to find the issue, then routes through the first
   * comm plugin with "issue_management" capability. Fire-and-forget — errors
   * are silently caught, never block the pipeline.
   */
  private commentOnSourceIssue(dispatch: Dispatch, message: string): void {
    try {
      const externalRef = dispatch.task.external_ref;
      if (
        !externalRef ||
        (externalRef.type !== "github_issue" && externalRef.type !== "github_pr")
      ) {
        return; // No GitHub issue/PR to comment on
      }

      const commPlugins = this.registry.getPluginsByType<CommunicationAdapter>("communication");
      const plugin = commPlugins.find((p) => p.hasCapability("issue_management"));
      if (!plugin) {
        return; // No plugin with issue_management capability
      }

      plugin.commentOnIssue(externalRef.repo, externalRef.number, message).catch(() => {
        // Silent — issue comment failure must never block the pipeline
      });
    } catch {
      // Silent — notification failure must never block the pipeline
    }
  }

  /**
   * Commit all changes, push branch, and create a draft PR (D149, D150, D151).
   *
   * Called after demo_prep completes. Deterministic commit ensures all LLM
   * changes are captured. Push via WorkspaceManager (token injection).
   * PR creation via GitHostingAdapter.
   */
  private async commitPushAndCreatePR(
    sessionId: string,
    taskId: string,
    demoPrepOutput: PhaseOutput,
    dispatch: Dispatch,
  ): Promise<void> {
    const worktreePath = this.workspaceManager.getWorktreePath(taskId);
    if (!worktreePath) {
      return; // No workspace — no PR (e.g., fast-path without repo)
    }

    const record = this.workspaceManager.getWorkspaceRecord(taskId);
    if (!record) {
      return;
    }

    // 1. Deterministic commit: git add -A && git commit
    //    Claude Code CLI may have already committed changes via its internal tools,
    //    so we also check for commits ahead of base to avoid skipping push/PR.
    let hasNewCommit = false;
    try {
      execFileSync("git", ["add", "-A"], {
        cwd: worktreePath,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });

      // Check if there are staged changes
      let hasStagedChanges = false;
      try {
        execFileSync("git", ["diff", "--cached", "--quiet"], {
          cwd: worktreePath,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch {
        // Non-zero exit = there ARE staged changes
        hasStagedChanges = true;
      }

      if (hasStagedChanges) {
        const commitMessage = `feat: ${dispatch.task.title}\n\nAutomated by The Engineer`;
        execFileSync("git", ["commit", "-m", commitMessage], {
          cwd: worktreePath,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        });
        hasNewCommit = true;
      }
    } catch (error) {
      this.logPrStepFailure(sessionId, taskId, "commit", error);
      return;
    }

    // Check if branch has commits ahead of base (covers Claude CLI internal commits)
    if (!hasNewCommit) {
      try {
        const aheadCount = execFileSync(
          "git",
          ["rev-list", "--count", `origin/${record.baseBranch}..HEAD`],
          { cwd: worktreePath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
        ).trim();
        if (aheadCount === "0") {
          return; // Truly no changes — nothing to push or PR
        }
      } catch {
        return; // Can't determine — skip to be safe
      }
    }

    // 2. Push via WorkspaceManager (D151 — token injection)
    try {
      this.workspaceManager.pushBranch(taskId);
    } catch (error) {
      this.logPrStepFailure(sessionId, taskId, "push", error);
      return;
    }

    // 3. Create draft PR via GitHostingAdapter
    const gitHosting = this.registry.getPrimaryPlugin<GitHostingAdapter>("git_hosting");
    if (!gitHosting) {
      return; // No hosting plugin — skip PR creation
    }

    try {
      const prDescription =
        (demoPrepOutput.data as { pr_description?: string }).pr_description ??
        `Automated PR for: ${dispatch.task.title}`;

      const prResult = await gitHosting.createPR({
        repo: record.repo,
        branch: record.branch,
        base: record.baseBranch,
        title: dispatch.task.title,
        body: prDescription,
        draft: true,
        labels: null,
        reviewers: null,
      });

      // Update task review state
      this.taskEngine.updateTaskField(taskId, "review", {
        pr_number: prResult.pr_number,
        pr_state: "draft",
        demo_artifacts: [],
        feedback_rounds: [],
      });

      // Notify PR creation — personal channels + GitHub issue comment
      this.notifyMilestone(dispatch, `Draft PR created: ${prResult.url}`);
      this.commentOnSourceIssue(dispatch, `Draft PR created: ${prResult.url}`);
    } catch (error) {
      this.logPrStepFailure(sessionId, taskId, "pr_creation", error);
    }
  }

  /** Log a PR workflow step failure to the session journal. */
  private logPrStepFailure(sessionId: string, taskId: string, step: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.sessionMemory.addJournalEntry({
      sessionId,
      taskId,
      phase: "demo_prep",
      type: "error",
      summary: `PR workflow failed at ${step}: ${message}`,
      tags: ["pr_workflow", step],
    });
  }

  /** Extract repository identifier from task (workspace or external_ref). */
  private getTaskRepo(dispatch: Dispatch): string {
    return dispatch.task.workspace?.repo ?? dispatch.task.external_ref?.repo ?? "";
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  /**
   * Call the LLM adapter through the Action Pipeline, parse the response,
   * and validate with the phase-specific schema.
   *
   * Emits a `cost.incurred` event after each successful call.
   * On safeParse failure, returns a fallback PhaseOutput (Decision #85).
   */
  private async callLlmAndParse(
    phase: Phase,
    taskId: string,
    prompt: string,
  ): Promise<PhaseOutput> {
    const completion = await this.callLlm(prompt, taskId);

    // Emit cost.incurred event
    this.emitCostIncurred(taskId, completion);

    // Parse JSON from LLM response
    let parsed: unknown;
    try {
      parsed = JSON.parse(completion.content);
    } catch {
      return this.buildFallbackOutput(
        phase,
        taskId,
        `Invalid JSON from LLM: ${completion.content.slice(0, 200)}`,
      );
    }

    // Validate against phase schema
    const schema = PHASE_SCHEMAS[phase];
    const result = schema.safeParse(parsed);
    if (!result.success) {
      return this.buildFallbackOutput(
        phase,
        taskId,
        `Schema validation failed: ${result.error.message}`,
      );
    }

    return this.buildPhaseOutput(phase, taskId, result.data as Record<string, unknown>, "high", []);
  }

  /**
   * Call the LLM adapter through the Action Pipeline.
   * Throws if no LLM plugin is registered or if the pipeline rejects.
   */
  private async callLlm(
    prompt: string,
    taskId: string,
    systemPrompt?: string | null,
  ): Promise<CompletionResult> {
    const llm = this.registry.getPrimaryPlugin<LLMAdapter>("llm");
    if (!llm) {
      throw new Error("Orchestrator: no LLM plugin registered");
    }

    // Set CWD to worktree so CLI-based plugins load the target repo's context, not the daemon's.
    const worktreePath = this.workspaceManager.getWorktreePath(taskId);

    const pipelineResult = await this.actionPipeline.execute<CompletionResult>({
      taskId,
      actionClass: "read",
      details: { operation: "llm_complete" },
      requestedBy: "orchestrator",
      executeFn: () =>
        llm.complete({
          prompt,
          system_prompt: systemPrompt ?? null,
          options: {
            max_tokens: null,
            temperature: null,
            stop: null,
            tools: null,
            cwd: worktreePath,
          },
        }),
    });

    if (pipelineResult.outcome !== "executed") {
      const reason = "reason" in pipelineResult ? pipelineResult.reason : "unknown";
      throw new Error(`LLM call rejected: ${pipelineResult.outcome} - ${reason}`);
    }

    return pipelineResult.result;
  }

  /**
   * Run a phase using the agent loop (multi-turn LLM + tool execution).
   *
   * The Engineer IS the agent: call LLM → parse action → execute tool → repeat.
   * Falls back to callLlmAndParse if no worktree is available.
   */
  private async runPhaseWithAgentLoop(
    phase: Phase,
    taskId: string,
    systemPrompt: string,
    initialPrompt: string,
  ): Promise<PhaseOutput> {
    const toolConfig = getPhaseToolConfig(phase);
    const worktreePath = this.workspaceManager.getWorktreePath(taskId);

    const toolAdapter = this.registry.getPrimaryPlugin<ToolAdapter>("tool") ?? null;

    const loopResult = await runAgentLoop(
      {
        phase,
        taskId,
        systemPrompt,
        initialPrompt,
        toolConfig,
        worktreePath,
      },
      // Inject LLM call through ActionPipeline
      (prompt, sysPrompt) => this.callLlm(prompt, taskId, sysPrompt),
      // Inject action execution
      (action, wPath) =>
        executeAgentAction(action, wPath, {
          actionPipeline: this.actionPipeline,
          toolAdapter,
          taskId,
        }),
    );

    // Emit cost for the entire loop
    this.emitAgentLoopCost(taskId, loopResult);

    // Validate output against phase schema
    return this.validateLoopResult(phase, taskId, loopResult);
  }

  /** Emit cost.incurred event for an agent loop's accumulated cost. */
  private emitAgentLoopCost(taskId: string, loopResult: AgentLoopResult): void {
    this.eventBus.publish({
      type: "cost.incurred",
      source: "orchestrator",
      task_id: taskId,
      payload: {
        task_id: taskId,
        repo: "",
        provider_id: "llm",
        provider_type: "api",
        operation: "agent_loop",
        tokens_in: loopResult.totalCost.tokens_in,
        tokens_out: loopResult.totalCost.tokens_out,
        spend_usd: loopResult.totalCost.spend_usd,
        usage_units: null,
        remaining: null,
      },
    } satisfies PublishInput<"cost.incurred">);
  }

  /** Validate agent loop result against phase schema, build PhaseOutput. */
  private validateLoopResult(
    phase: Phase,
    taskId: string,
    loopResult: AgentLoopResult,
  ): PhaseOutput {
    const schema = PHASE_SCHEMAS[phase];
    const result = schema.safeParse(loopResult.phaseData);

    if (!result.success) {
      return this.buildFallbackOutput(
        phase,
        taskId,
        `Agent loop output invalid: ${result.error.message} (after ${String(loopResult.iterations)} iterations)`,
      );
    }

    return this.buildPhaseOutput(phase, taskId, result.data as Record<string, unknown>, "high", []);
  }

  /** Emit a cost.incurred event from LLM completion usage data. */
  private emitCostIncurred(taskId: string, completion: CompletionResult): void {
    this.eventBus.publish({
      type: "cost.incurred",
      source: "orchestrator",
      task_id: taskId,
      payload: {
        task_id: taskId,
        repo: "",
        provider_id: "llm",
        provider_type: "api",
        operation: "phase_completion",
        tokens_in: completion.usage.tokens_in,
        tokens_out: completion.usage.tokens_out,
        spend_usd: completion.usage.spend_usd,
        usage_units: null,
        remaining: completion.usage.remaining,
      },
    } satisfies PublishInput<"cost.incurred">);
  }

  /** Build a PhaseOutput envelope. */
  private buildPhaseOutput(
    phase: Phase,
    taskId: string,
    data: Record<string, unknown>,
    confidence: "high" | "medium" | "low",
    openQuestions: string[],
  ): PhaseOutput {
    return {
      phase,
      task_id: taskId,
      timestamp: new Date().toISOString(),
      data,
      confidence,
      open_questions: openQuestions,
    };
  }

  /** Build a fallback PhaseOutput when safeParse fails (Decision #85). */
  private buildFallbackOutput(phase: Phase, taskId: string, errorMessage: string): PhaseOutput {
    return this.buildPhaseOutput(phase, taskId, this.getDefaultData(phase), "low", [errorMessage]);
  }

  /** Get default/empty data for a phase when LLM output is invalid. */
  private getDefaultData(phase: Phase): Record<string, unknown> {
    const defaults: Record<Phase, Record<string, unknown>> = {
      intake_analysis: {
        complexity: "moderate",
        estimated_phases: [...PHASE_SEQUENCE],
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
      planning: {
        approach: "Unable to generate plan from LLM output",
        file_changes: [],
        risks: [],
        decomposition_plan: null,
      },
      execution: {
        files_changed: [],
        tests_written: [],
        test_results: { passed: 0, failed: 0, skipped: 0 },
        build_status: "failing",
      },
      self_review: {
        findings: [],
        refactoring_applied: [],
        quality_assessment: "needs_work",
      },
      demo_prep: {
        artifacts: [],
        pr_number: 1,
        pr_description: "Unable to generate PR description from LLM output",
      },
      integration: {
        children_verified: [],
        integration_tests: { passed: 0, failed: 0 },
        conflicts_found: [],
        resolution_actions: [],
      },
    };
    return defaults[phase];
  }

  /** Create a checkpoint at a phase transition (Protocol P4). */
  private createPhaseCheckpoint(
    sessionId: string,
    taskId: string,
    completedPhase: Phase,
    priorOutputs: Map<Phase, PhaseOutput>,
    nextPhase: Phase | null,
  ): string {
    const output = priorOutputs.get(completedPhase);
    const checkpoint = this.sessionMemory.createCheckpoint({
      sessionId,
      taskId,
      phase: completedPhase,
      phaseProgress: `Completed ${completedPhase}`,
      contextSummary: `Phase ${completedPhase} complete. ${output ? `Confidence: ${output.confidence}` : ""}`,
      keyFindings: output?.open_questions ?? [],
      openQuestions: output?.open_questions ?? [],
      nextAction: nextPhase ? `Begin ${nextPhase} phase` : "Pipeline complete",
      lastEventId: "",
      workspaceRef: null,
      reason: "phase_transition",
      journalOffset: 0,
    });
    return checkpoint.id;
  }

  /** Handle preemption: checkpoint, end session, emit ready (Protocol P8). */
  private handlePreemption(
    sessionId: string,
    taskId: string,
    currentPhase: Phase,
    _priorOutputs: Map<Phase, PhaseOutput>,
  ): ExecuteTaskResult {
    const preemptingId = this.preemptionPayload?.preempting_task_id ?? "unknown";

    // Create preemption checkpoint
    const checkpoint = this.sessionMemory.createCheckpoint({
      sessionId,
      taskId,
      phase: currentPhase,
      phaseProgress: `Preempted during ${currentPhase}`,
      contextSummary: `Task preempted by ${preemptingId} before completing ${currentPhase}`,
      keyFindings: [],
      openQuestions: [],
      nextAction: `Resume at ${currentPhase}`,
      lastEventId: "",
      workspaceRef: null,
      reason: "preemption",
      journalOffset: 0,
    });

    // Log journal entry
    this.sessionMemory.addJournalEntry({
      sessionId,
      taskId,
      phase: currentPhase,
      type: "checkpoint_marker",
      summary: `Preempted by ${preemptingId}`,
      tags: ["preemption"],
    });

    // End session
    this.sessionMemory.endSession(sessionId, "preempted");

    // Emit preemption.ready
    this.eventBus.publish({
      type: "preemption.ready",
      source: "orchestrator",
      task_id: taskId,
      payload: {
        task_id: taskId,
        checkpoint_id: checkpoint.id,
        phase: currentPhase,
        atomic_op: "phase_complete",
      },
    } satisfies PublishInput<"preemption.ready">);

    // Reset flag
    this.preemptionRequested = false;
    this.preemptionPayload = null;

    return { outcome: "preempted", lastPhase: currentPhase, checkpointId: checkpoint.id };
  }

  /**
   * Attempt to self-diagnose and resolve a blocked task.
   *
   * Called by the Daemon during Stage 2 of blocked timeout escalation.
   * Makes a lightweight LLM call to assess whether the block can be
   * automatically resolved. Thin for v1 — Phase 16 adds real prompt
   * engineering.
   *
   * Returns `true` if the block was resolved, `false` otherwise.
   */
  async attemptSelfUnblock(taskId: string): Promise<boolean> {
    const task = this.taskEngine.getTask(taskId);
    if (!task || task.state !== "blocked") {
      return false;
    }

    const llm = this.registry.getPrimaryPlugin<LLMAdapter>("llm");
    if (!llm) {
      return false;
    }

    // Gather recent journal context
    const entries = this.sessionMemory.queryJournal(taskId);
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
      const pipelineResult = await this.actionPipeline.execute<CompletionResult>({
        taskId,
        actionClass: "read",
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

      this.emitCostIncurred(taskId, pipelineResult.result);

      const parsed = JSON.parse(pipelineResult.result.content) as { can_resolve?: boolean };
      return parsed.can_resolve === true;
    } catch {
      return false;
    }
  }

  /** Create a session — new for fresh tasks, linked for resumed tasks. */
  private createSession(dispatch: Dispatch) {
    if (dispatch.resume_from) {
      return this.sessionMemory.createSession({
        taskId: dispatch.task.id,
        previousSessionId: dispatch.resume_from.session_id,
        resumedFromCheckpoint: dispatch.resume_from.id,
      });
    }
    return this.sessionMemory.createSession({
      taskId: dispatch.task.id,
    });
  }
}
