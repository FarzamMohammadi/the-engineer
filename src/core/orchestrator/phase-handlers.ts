import type { Dispatch } from "../../schemas/ephemeral.js";
import { type Phase, type PhaseOutput, Phases } from "../../schemas/orchestrator.js";
import type { LlmCaller } from "./llm-caller.js";
import type { PhaseHandler } from "./phase-runner.js";
import {
  buildDemoPrepPrompt,
  buildExecutionPrompt,
  buildIntakePrompt,
  buildIntegrationPrompt,
  buildPlanningPrompt,
  buildResearchPrompt,
  buildSelfReviewPrompt,
  buildSystemPrompt,
  formatPriorPhaseOutput,
  section,
} from "./prompts/index.js";
import type { PipelineState } from "./types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Extract prior phase data with safe casting. */
function priorData(
  priorOutputs: Map<Phase, PhaseOutput>,
  phase: Phase,
): Record<string, unknown> | null {
  return (priorOutputs.get(phase)?.data as Record<string, unknown> | undefined) ?? null;
}

// ── Phase Handler Factory ────────────────────────────────────────────────────

/**
 * Create all 7 phase handlers bound to the given LlmCaller.
 *
 * Each handler: builds system prompt + phase prompt from prior outputs,
 * then delegates to the agent loop via llmCaller.runPhaseWithAgentLoop().
 */
export function createPhaseHandlers(llmCaller: LlmCaller): Record<Phase, PhaseHandler> {
  function handleIntakeAnalysis(
    taskId: string,
    dispatch: Dispatch,
    _priorOutputs: Map<Phase, PhaseOutput>,
    state: PipelineState,
  ): Promise<PhaseOutput> {
    const unappliedFeedback = (dispatch.task.review?.feedback_rounds ?? []).filter(
      (r) => !r.applied,
    );
    return llmCaller.runPhaseWithAgentLoop(
      Phases.intake_analysis,
      taskId,
      buildSystemPrompt(Phases.intake_analysis),
      buildIntakePrompt({
        task: dispatch.task,
        repoContext: state.repoContext,
        repoKnowledge: dispatch.knowledge.repo,
        userKnowledge: dispatch.knowledge.user,
        feedbackRounds: unappliedFeedback.length > 0 ? unappliedFeedback : undefined,
        prNumber: dispatch.task.review?.pr_number ?? undefined,
      }),
      state,
    );
  }

  function handleResearch(
    taskId: string,
    dispatch: Dispatch,
    priorOutputs: Map<Phase, PhaseOutput>,
    state: PipelineState,
  ): Promise<PhaseOutput> {
    return llmCaller.runPhaseWithAgentLoop(
      Phases.research,
      taskId,
      buildSystemPrompt(Phases.research),
      buildResearchPrompt({
        task: dispatch.task,
        repoContext: state.repoContext,
        intakeOutput: priorData(priorOutputs, Phases.intake_analysis),
        repoKnowledge: dispatch.knowledge.repo,
        userKnowledge: dispatch.knowledge.user,
      }),
      state,
    );
  }

  function handlePlanning(
    taskId: string,
    dispatch: Dispatch,
    priorOutputs: Map<Phase, PhaseOutput>,
    state: PipelineState,
  ): Promise<PhaseOutput> {
    return llmCaller.runPhaseWithAgentLoop(
      Phases.planning,
      taskId,
      buildSystemPrompt(Phases.planning),
      buildPlanningPrompt({
        task: dispatch.task,
        repoContext: state.repoContext,
        intakeOutput: priorData(priorOutputs, Phases.intake_analysis),
        researchOutput: priorData(priorOutputs, Phases.research),
        repoKnowledge: dispatch.knowledge.repo,
        userKnowledge: dispatch.knowledge.user,
      }),
      state,
    );
  }

  function handleExecution(
    taskId: string,
    dispatch: Dispatch,
    priorOutputs: Map<Phase, PhaseOutput>,
    state: PipelineState,
  ): Promise<PhaseOutput> {
    const unappliedFeedback = (dispatch.task.review?.feedback_rounds ?? []).filter(
      (r) => !r.applied,
    );
    let prompt = buildExecutionPrompt({
      task: dispatch.task,
      repoContext: state.repoContext,
      intakeOutput: priorData(priorOutputs, Phases.intake_analysis),
      researchOutput: priorData(priorOutputs, Phases.research),
      planningOutput: priorData(priorOutputs, Phases.planning),
      repoKnowledge: dispatch.knowledge.repo,
      userKnowledge: dispatch.knowledge.user,
      feedbackRounds: unappliedFeedback.length > 0 ? unappliedFeedback : undefined,
    });

    // On loopback: inject self_review findings so execution knows what to fix
    const reviewData = priorData(priorOutputs, Phases.self_review);
    if (reviewData) {
      prompt = `${prompt}\n\n${section("Review Findings to Address", formatPriorPhaseOutput(Phases.self_review, reviewData))}`;
    }

    return llmCaller.runPhaseWithAgentLoop(
      Phases.execution,
      taskId,
      buildSystemPrompt(Phases.execution),
      prompt,
      state,
    );
  }

  function handleSelfReview(
    taskId: string,
    dispatch: Dispatch,
    priorOutputs: Map<Phase, PhaseOutput>,
    state: PipelineState,
  ): Promise<PhaseOutput> {
    return llmCaller.runPhaseWithAgentLoop(
      Phases.self_review,
      taskId,
      buildSystemPrompt(Phases.self_review),
      buildSelfReviewPrompt({
        task: dispatch.task,
        repoContext: state.repoContext,
        intakeOutput: priorData(priorOutputs, Phases.intake_analysis),
        planningOutput: priorData(priorOutputs, Phases.planning),
        executionOutput: priorData(priorOutputs, Phases.execution),
        selfReviewFindings: priorData(priorOutputs, Phases.self_review),
        loopbackCount: state.loopbackCount,
        repoKnowledge: dispatch.knowledge.repo,
        userKnowledge: dispatch.knowledge.user,
      }),
      state,
    );
  }

  function handleDemoPrep(
    taskId: string,
    dispatch: Dispatch,
    priorOutputs: Map<Phase, PhaseOutput>,
    state: PipelineState,
  ): Promise<PhaseOutput> {
    return llmCaller.runPhaseWithAgentLoop(
      Phases.demo_prep,
      taskId,
      buildSystemPrompt(Phases.demo_prep),
      buildDemoPrepPrompt({
        task: dispatch.task,
        repoContext: state.repoContext,
        intakeOutput: priorData(priorOutputs, Phases.intake_analysis),
        planningOutput: priorData(priorOutputs, Phases.planning),
        executionOutput: priorData(priorOutputs, Phases.execution),
        selfReviewOutput: priorData(priorOutputs, Phases.self_review),
        repoKnowledge: dispatch.knowledge.repo,
        userKnowledge: dispatch.knowledge.user,
      }),
      state,
    );
  }

  function handleIntegration(
    taskId: string,
    dispatch: Dispatch,
    priorOutputs: Map<Phase, PhaseOutput>,
    state: PipelineState,
  ): Promise<PhaseOutput> {
    const childSummaries = (dispatch.task.child_summaries ?? []).map((cs) => ({
      child_id: cs.child_id,
      child_title: cs.child_title,
      branch: cs.branch,
      test_status: cs.test_status,
      files_changed: cs.key_outputs.map((o) => o.path),
    }));

    return llmCaller.runPhaseWithAgentLoop(
      Phases.integration,
      taskId,
      buildSystemPrompt(Phases.integration),
      buildIntegrationPrompt({
        task: dispatch.task,
        repoContext: state.repoContext,
        executionOutput: priorData(priorOutputs, Phases.execution),
        selfReviewOutput: priorData(priorOutputs, Phases.self_review),
        childSummaries,
        repoKnowledge: dispatch.knowledge.repo,
        userKnowledge: dispatch.knowledge.user,
      }),
      state,
    );
  }

  return {
    [Phases.intake_analysis]: handleIntakeAnalysis,
    [Phases.research]: handleResearch,
    [Phases.planning]: handlePlanning,
    [Phases.execution]: handleExecution,
    [Phases.self_review]: handleSelfReview,
    [Phases.demo_prep]: handleDemoPrep,
    [Phases.integration]: handleIntegration,
  };
}
