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
export function createPhaseHandlers(
  llmCaller: LlmCaller,
  ctx: OrchestratorContext,
): Record<Phase, PhaseHandler> {
  // ── CLI-native phases (RRPIR) ──────────────────────────────────────────

  function handleRequirementsGathering(
    taskId: string,
    dispatch: Dispatch,
    _priorOutputs: Map<Phase, PhaseOutput>,
    state: PipelineState,
  ): Promise<PhaseOutput> {
    const thoughtsDir = state.thoughtsDir ?? "";
    const teamContacts = ctx.peopleDirectory.getAll();
    const unappliedFeedback = (dispatch.task.review?.feedback_rounds ?? []).filter(
      (r) => !r.applied,
    );

    return llmCaller.runPhaseWithCli(
      Phases.requirements_gathering,
      taskId,
      buildCliNativeSystemPrompt(Phases.requirements_gathering),
      buildRequirementsGatheringPrompt({
        task: dispatch.task,
        repoContext: state.repoContext,
        repoKnowledge: dispatch.knowledge.repo,
        userKnowledge: dispatch.knowledge.user,
        teamContacts,
        thoughtsDir,
        feedbackRounds: unappliedFeedback.length > 0 ? unappliedFeedback : undefined,
        prNumber: dispatch.task.review?.pr_number ?? undefined,
        isRerun: state.requirementsLoopCount > 0,
      }),
      state,
      thoughtsDir,
    );
  }

  function handleResearch(
    taskId: string,
    dispatch: Dispatch,
    _priorOutputs: Map<Phase, PhaseOutput>,
    state: PipelineState,
  ): Promise<PhaseOutput> {
    const thoughtsDir = state.thoughtsDir ?? "";

    return llmCaller.runPhaseWithCli(
      Phases.research,
      taskId,
      buildCliNativeSystemPrompt(Phases.research),
      buildResearchPrompt({
        task: dispatch.task,
        repoContext: state.repoContext,
        repoKnowledge: dispatch.knowledge.repo,
        userKnowledge: dispatch.knowledge.user,
        thoughtsDir,
      }),
      state,
      thoughtsDir,
    );
  }

  // ── CLI-native phases (Session 070) ─────────────────────────────────

  function handlePlanning(
    taskId: string,
    dispatch: Dispatch,
    _priorOutputs: Map<Phase, PhaseOutput>,
    state: PipelineState,
  ): Promise<PhaseOutput> {
    const thoughtsDir = state.thoughtsDir ?? "";
    return llmCaller.runPhaseWithCli(
      Phases.planning,
      taskId,
      buildCliNativeSystemPrompt(Phases.planning),
      buildPlanningPrompt({
        task: dispatch.task,
        repoContext: state.repoContext,
        repoKnowledge: dispatch.knowledge.repo,
        userKnowledge: dispatch.knowledge.user,
        thoughtsDir,
      }),
      state,
      thoughtsDir,
    );
  }

  function handleExecution(
    taskId: string,
    dispatch: Dispatch,
    _priorOutputs: Map<Phase, PhaseOutput>,
    state: PipelineState,
  ): Promise<PhaseOutput> {
    const thoughtsDir = state.thoughtsDir ?? "";
    const unappliedFeedback = (dispatch.task.review?.feedback_rounds ?? []).filter(
      (r) => !r.applied,
    );

    return llmCaller.runPhaseWithCli(
      Phases.execution,
      taskId,
      buildCliNativeSystemPrompt(Phases.execution),
      buildExecutionPrompt({
        task: dispatch.task,
        repoContext: state.repoContext,
        repoKnowledge: dispatch.knowledge.repo,
        userKnowledge: dispatch.knowledge.user,
        thoughtsDir,
        feedbackRounds: unappliedFeedback.length > 0 ? unappliedFeedback : undefined,
      }),
      state,
      thoughtsDir,
    );
  }

  // ── CLI-native phases (Session 071) ─────────────────────────────────

  /**
   * Multi-step review pipeline: one CLI call per review lens, then one refinement call.
   *
   * Review sub-phases write findings to `thoughts/{thoughtsDir}/review/{name}.md`.
   * Refinement reads all findings, applies fixes, writes `thoughts/{thoughtsDir}/refinements/`.
   * The refinement step's session-result.json drives routing (loopback to execution or proceed to demo_prep).
   */
  async function handleSelfReview(
    taskId: string,
    dispatch: Dispatch,
    _priorOutputs: Map<Phase, PhaseOutput>,
    state: PipelineState,
  ): Promise<PhaseOutput> {
    const thoughtsDir = state.thoughtsDir ?? "";
    const reviewPhases = ctx.config.rrpir?.review_phases ?? ["requirements_check" as const];

    // Step 1: Run each review sub-phase as a separate CLI call
    for (const reviewPhaseName of reviewPhases) {
      await llmCaller.runPhaseWithCli(
        Phases.self_review,
        taskId,
        buildCliNativeSystemPrompt(Phases.self_review),
        buildReviewSubPhasePrompt({
          task: dispatch.task,
          repoContext: state.repoContext,
          repoKnowledge: dispatch.knowledge.repo,
          userKnowledge: dispatch.knowledge.user,
          thoughtsDir,
          reviewPhaseName,
          loopbackCount: state.loopbackCount,
        }),
        state,
        thoughtsDir,
        "review",
      );
    }

    // Step 2: Run refinement — consolidate findings, apply fixes
    const refinementOutput = await llmCaller.runPhaseWithCli(
      Phases.self_review,
      taskId,
      buildCliNativeSystemPrompt(Phases.self_review),
      buildRefinementPrompt({
        task: dispatch.task,
        repoContext: state.repoContext,
        repoKnowledge: dispatch.knowledge.repo,
        userKnowledge: dispatch.knowledge.user,
        thoughtsDir,
        reviewPhases,
        loopbackCount: state.loopbackCount,
      }),
      state,
      thoughtsDir,
      "refinements",
    );

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
    return llmCaller.runPhaseWithCli(
      Phases.demo_prep,
      taskId,
      buildCliNativeSystemPrompt(Phases.demo_prep),
      buildDemoPrepPrompt({
        task: dispatch.task,
        repoContext: state.repoContext,
        repoKnowledge: dispatch.knowledge.repo,
        userKnowledge: dispatch.knowledge.user,
        thoughtsDir,
      }),
      state,
      thoughtsDir,
    );
  }

  function handleIntegration(
    taskId: string,
    dispatch: Dispatch,
    _priorOutputs: Map<Phase, PhaseOutput>,
    state: PipelineState,
  ): Promise<PhaseOutput> {
    const thoughtsDir = state.thoughtsDir ?? "";
    const childSummaries = (dispatch.task.child_summaries ?? []).map((cs) => ({
      child_id: cs.child_id,
      title: cs.child_title,
      branch: cs.branch,
      test_status: cs.test_status,
      files_changed: cs.key_outputs.map((o) => o.path),
    }));

    return llmCaller.runPhaseWithCli(
      Phases.integration,
      taskId,
      buildCliNativeSystemPrompt(Phases.integration),
      buildIntegrationPrompt({
        task: dispatch.task,
        repoContext: state.repoContext,
        thoughtsDir,
        childSummaries,
      }),
      state,
      thoughtsDir,
    );
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
