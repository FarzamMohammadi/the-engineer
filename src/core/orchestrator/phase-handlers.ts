import path from "node:path";
import { ReviewPhaseNames } from "../../schemas/config.js";
import type { Dispatch } from "../../schemas/ephemeral.js";
import { type Phase, type PhaseOutput, Phases } from "../../schemas/orchestrator.js";
import type { LlmCaller } from "./llm-caller.js";
import type { PhaseHandler } from "./phase-runner.js";
import {
  buildCliNativeSystemPrompt,
  buildDemoPrepPrompt,
  buildExecutionPrompt,
  buildIntegrationPrompt,
  buildPlanningPrompt,
  buildRefinementPrompt,
  buildRequirementsGatheringPrompt,
  buildResearchPrompt,
  buildReviewSubPhasePrompt,
} from "./prompts/index.js";
import type { OrchestratorContext, PipelineState } from "./types.js";

// ── Phase Handler Factory ────────────────────────────────────────────────────

/**
 * Create all 7 phase handlers.
 *
 * All phases use CLI-native invocation (runPhaseWithCli).
 * Self-review runs a multi-step review pipeline: one CLI call per review lens + one refinement call.
 */
export function createPhaseHandlers(llmCaller: LlmCaller, ctx: OrchestratorContext): Record<Phase, PhaseHandler> {
  // ── Helpers ────────────────────────────────────────────────────────────

  /** Absolute path to skills directory, resolved from workspace config. */
  const skillsDir = ctx.workspaceManager.getSkillsDir();

  /** Resolve absolute thoughts dir for use in prompts (LLM sees these paths). */
  function absThoughts(taskId: string, thoughtsDir: string): string {
    const wt = ctx.workspaceManager.getWorktreePath(taskId);
    return wt ? path.join(wt, thoughtsDir) : thoughtsDir;
  }

  // ── CLI-native phases (RRPIR) ──────────────────────────────────────────

  function handleRequirementsGathering(
    taskId: string,
    dispatch: Dispatch,
    _priorOutputs: Map<Phase, PhaseOutput>,
    state: PipelineState,
  ): Promise<PhaseOutput> {
    const thoughtsDir = state.thoughtsDir ?? "";
    const teamContacts = ctx.peopleDirectory.getAll();
    const unappliedFeedback = (dispatch.task.review?.feedback_rounds ?? []).filter((r) => !r.applied);

    return llmCaller.runPhaseWithCli({
      phase: Phases.requirements_gathering,
      taskId,
      systemPrompt: buildCliNativeSystemPrompt(Phases.requirements_gathering),
      prompt: buildRequirementsGatheringPrompt({
        task: dispatch.task,
        repoContext: state.repoContext,
        repoKnowledge: dispatch.knowledge.repo,
        userKnowledge: dispatch.knowledge.user,
        teamContacts,
        thoughtsDir: absThoughts(taskId, thoughtsDir),
        feedbackRounds: unappliedFeedback.length > 0 ? unappliedFeedback : undefined,
        prNumber: dispatch.task.review?.pr_number ?? undefined,
        isRerun: state.requirementsLoopCount > 0 || state.returnToPhase !== null,
      }),
      state,
      thoughtsDir,
    });
  }

  function handleResearch(
    taskId: string,
    dispatch: Dispatch,
    _priorOutputs: Map<Phase, PhaseOutput>,
    state: PipelineState,
  ): Promise<PhaseOutput> {
    const thoughtsDir = state.thoughtsDir ?? "";

    return llmCaller.runPhaseWithCli({
      phase: Phases.research,
      taskId,
      systemPrompt: buildCliNativeSystemPrompt(Phases.research),
      prompt: buildResearchPrompt({
        task: dispatch.task,
        repoContext: state.repoContext,
        repoKnowledge: dispatch.knowledge.repo,
        userKnowledge: dispatch.knowledge.user,
        thoughtsDir: absThoughts(taskId, thoughtsDir),
      }),
      state,
      thoughtsDir,
    });
  }

  // ── CLI-native phases (Session 070) ─────────────────────────────────

  function handlePlanning(
    taskId: string,
    dispatch: Dispatch,
    _priorOutputs: Map<Phase, PhaseOutput>,
    state: PipelineState,
  ): Promise<PhaseOutput> {
    const thoughtsDir = state.thoughtsDir ?? "";
    const task = ctx.taskEngine.getTask(taskId);
    return llmCaller.runPhaseWithCli({
      phase: Phases.planning,
      taskId,
      systemPrompt: buildCliNativeSystemPrompt(Phases.planning),
      prompt: buildPlanningPrompt({
        task: dispatch.task,
        repoContext: state.repoContext,
        repoKnowledge: dispatch.knowledge.repo,
        userKnowledge: dispatch.knowledge.user,
        thoughtsDir: absThoughts(taskId, thoughtsDir),
        skipResearch: task?.skip_research ?? false,
      }),
      state,
      thoughtsDir,
    });
  }

  function handleExecution(
    taskId: string,
    dispatch: Dispatch,
    _priorOutputs: Map<Phase, PhaseOutput>,
    state: PipelineState,
  ): Promise<PhaseOutput> {
    const thoughtsDir = state.thoughtsDir ?? "";
    const task = ctx.taskEngine.getTask(taskId);
    const unappliedFeedback = (dispatch.task.review?.feedback_rounds ?? []).filter((r) => !r.applied);

    return llmCaller.runPhaseWithCli({
      phase: Phases.execution,
      taskId,
      systemPrompt: buildCliNativeSystemPrompt(Phases.execution),
      prompt: buildExecutionPrompt({
        task: dispatch.task,
        repoContext: state.repoContext,
        repoKnowledge: dispatch.knowledge.repo,
        userKnowledge: dispatch.knowledge.user,
        thoughtsDir: absThoughts(taskId, thoughtsDir),
        skillsDir,
        feedbackRounds: unappliedFeedback.length > 0 ? unappliedFeedback : undefined,
        skipResearch: task?.skip_research ?? false,
      }),
      state,
      thoughtsDir,
    });
  }

  // ── CLI-native phases (Session 071) ─────────────────────────────────

  /**
   * Multi-step review pipeline: one CLI call per review lens, then one refinement call.
   *
   * Review sub-phases write findings to `thoughts/{thoughtsDir}/review/{name}.md`.
   * Refinement reads all findings, applies fixes, writes `thoughts/{thoughtsDir}/review/`.
   * The refinement step's session-result.json drives routing (loopback to execution or proceed to demo_prep).
   */
  async function handleSelfReview(
    taskId: string,
    dispatch: Dispatch,
    _priorOutputs: Map<Phase, PhaseOutput>,
    state: PipelineState,
  ): Promise<PhaseOutput> {
    const thoughtsDir = state.thoughtsDir ?? "";
    const reviewPhases = ctx.config.rrpir?.review_phases ?? [ReviewPhaseNames.requirements_check];

    // Step 1: Run each review sub-phase as a separate CLI call
    for (const reviewPhaseName of reviewPhases) {
      await llmCaller.runPhaseWithCli({
        phase: Phases.self_review,
        taskId,
        systemPrompt: buildCliNativeSystemPrompt(Phases.self_review),
        prompt: buildReviewSubPhasePrompt({
          task: dispatch.task,
          repoContext: state.repoContext,
          repoKnowledge: dispatch.knowledge.repo,
          userKnowledge: dispatch.knowledge.user,
          thoughtsDir: absThoughts(taskId, thoughtsDir),
          skillsDir,
          reviewPhaseName,
          loopbackCount: state.loopbackCount,
        }),
        state,
        thoughtsDir,
        overridePhaseDir: "review",
        stepName: reviewPhaseName.replace(/_/g, "-"),
        requiresSessionResult: false, // sub-phases don't write session-result.json
      });
    }

    // Step 2: Run refinement — consolidate findings, apply fixes
    const refinementOutput = await llmCaller.runPhaseWithCli({
      phase: Phases.self_review,
      taskId,
      systemPrompt: buildCliNativeSystemPrompt(Phases.self_review),
      prompt: buildRefinementPrompt({
        task: dispatch.task,
        repoContext: state.repoContext,
        repoKnowledge: dispatch.knowledge.repo,
        userKnowledge: dispatch.knowledge.user,
        thoughtsDir: absThoughts(taskId, thoughtsDir),
        skillsDir,
        reviewPhases,
        loopbackCount: state.loopbackCount,
      }),
      state,
      thoughtsDir,
      overridePhaseDir: "review",
      stepName: "refinement",
      requiresSessionResult: true, // refinement writes session-result.json for routing
    });

    // Step 3: Map next_phase → quality_assessment for checkSelfReviewLoopback compatibility
    const nextPhase = (refinementOutput.data as { next_phase?: string }).next_phase;
    const qualityAssessment =
      nextPhase === "execution"
        ? "needs_work"
        : nextPhase === "requirements_gathering"
          ? "fundamental_issues"
          : "ship_it";

    return {
      ...refinementOutput,
      data: {
        ...refinementOutput.data,
        quality_assessment: qualityAssessment,
      },
    };
  }

  function handleDemoPrep(
    taskId: string,
    dispatch: Dispatch,
    _priorOutputs: Map<Phase, PhaseOutput>,
    state: PipelineState,
  ): Promise<PhaseOutput> {
    const thoughtsDir = state.thoughtsDir ?? "";
    const reviewPhases = ctx.config.rrpir?.review_phases ?? [ReviewPhaseNames.requirements_check];
    return llmCaller.runPhaseWithCli({
      phase: Phases.demo_prep,
      taskId,
      systemPrompt: buildCliNativeSystemPrompt(Phases.demo_prep),
      prompt: buildDemoPrepPrompt({
        task: dispatch.task,
        repoContext: state.repoContext,
        repoKnowledge: dispatch.knowledge.repo,
        userKnowledge: dispatch.knowledge.user,
        thoughtsDir: absThoughts(taskId, thoughtsDir),
        reviewPhases,
      }),
      state,
      thoughtsDir,
    });
  }

  function handleIntegration(
    taskId: string,
    dispatch: Dispatch,
    _priorOutputs: Map<Phase, PhaseOutput>,
    state: PipelineState,
  ): Promise<PhaseOutput> {
    const thoughtsDir = state.thoughtsDir ?? "";

    return llmCaller.runPhaseWithCli({
      phase: Phases.integration,
      taskId,
      systemPrompt: buildCliNativeSystemPrompt(Phases.integration),
      prompt: buildIntegrationPrompt({
        task: dispatch.task,
        repoContext: state.repoContext,
        thoughtsDir: absThoughts(taskId, thoughtsDir),
        skillsDir,
        childSummaries: [],
      }),
      state,
      thoughtsDir,
    });
  }

  return {
    [Phases.requirements_gathering]: handleRequirementsGathering,
    [Phases.research]: handleResearch,
    [Phases.planning]: handlePlanning,
    [Phases.execution]: handleExecution,
    [Phases.self_review]: handleSelfReview,
    [Phases.demo_prep]: handleDemoPrep,
    [Phases.integration]: handleIntegration,
  };
}
