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
  buildRequirementsGatheringPrompt,
  buildResearchPrompt,
  buildSelfReviewPrompt,
  buildSystemPrompt,
} from "./prompts/index.js";
import type { OrchestratorContext, PipelineState } from "./types.js";

// ── Phase Handler Factory ────────────────────────────────────────────────────

/**
 * Create all 7 phase handlers.
 *
 * Requirements gathering + research use CLI-native invocation (runPhaseWithCli).
 * Planning through integration use the agent loop (runPhaseWithAgentLoop) until Session 072.
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

  // ── Agent-loop phases (Session 072: migrate to CLI-native) ─────────────

  function handlePlanning(
    taskId: string,
    dispatch: Dispatch,
    _priorOutputs: Map<Phase, PhaseOutput>,
    state: PipelineState,
  ): Promise<PhaseOutput> {
    const thoughtsDir = state.thoughtsDir ?? "";
    return llmCaller.runPhaseWithAgentLoop(
      Phases.planning,
      taskId,
      buildSystemPrompt(Phases.planning),
      buildPlanningPrompt({
        task: dispatch.task,
        repoContext: state.repoContext,
        repoKnowledge: dispatch.knowledge.repo,
        userKnowledge: dispatch.knowledge.user,
        thoughtsDir,
      }),
      state,
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

    return llmCaller.runPhaseWithAgentLoop(
      Phases.execution,
      taskId,
      buildSystemPrompt(Phases.execution),
      buildExecutionPrompt({
        task: dispatch.task,
        repoContext: state.repoContext,
        repoKnowledge: dispatch.knowledge.repo,
        userKnowledge: dispatch.knowledge.user,
        thoughtsDir,
        feedbackRounds: unappliedFeedback.length > 0 ? unappliedFeedback : undefined,
      }),
      state,
    );
  }

  function handleSelfReview(
    taskId: string,
    dispatch: Dispatch,
    _priorOutputs: Map<Phase, PhaseOutput>,
    state: PipelineState,
  ): Promise<PhaseOutput> {
    const thoughtsDir = state.thoughtsDir ?? "";
    return llmCaller.runPhaseWithAgentLoop(
      Phases.self_review,
      taskId,
      buildSystemPrompt(Phases.self_review),
      buildSelfReviewPrompt({
        task: dispatch.task,
        repoContext: state.repoContext,
        repoKnowledge: dispatch.knowledge.repo,
        userKnowledge: dispatch.knowledge.user,
        thoughtsDir,
        loopbackCount: state.loopbackCount,
      }),
      state,
    );
  }

  function handleDemoPrep(
    taskId: string,
    dispatch: Dispatch,
    _priorOutputs: Map<Phase, PhaseOutput>,
    state: PipelineState,
  ): Promise<PhaseOutput> {
    const thoughtsDir = state.thoughtsDir ?? "";
    return llmCaller.runPhaseWithAgentLoop(
      Phases.demo_prep,
      taskId,
      buildSystemPrompt(Phases.demo_prep),
      buildDemoPrepPrompt({
        task: dispatch.task,
        repoContext: state.repoContext,
        repoKnowledge: dispatch.knowledge.repo,
        userKnowledge: dispatch.knowledge.user,
        thoughtsDir,
      }),
      state,
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

    return llmCaller.runPhaseWithAgentLoop(
      Phases.integration,
      taskId,
      buildSystemPrompt(Phases.integration),
      buildIntegrationPrompt({
        task: dispatch.task,
        repoContext: state.repoContext,
        thoughtsDir,
        childSummaries,
      }),
      state,
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
