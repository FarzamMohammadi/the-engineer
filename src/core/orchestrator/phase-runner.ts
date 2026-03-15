import type { Dispatch } from "../../schemas/ephemeral.js";
import type { Phase, PhaseOutput } from "../../schemas/orchestrator.js";
import { Phases } from "../../schemas/orchestrator.js";
import {
  CheckpointReasons,
  JournalEntryTypes,
  SessionEndReasons,
} from "../../schemas/session-memory.js";
import type { PublishInput } from "../event-bus/index.js";
import type { DecompositionHandler } from "./decomposition-handler.js";
import { PhaseHandlerMissingError } from "./errors.js";
import type { PrManager } from "./pr-manager.js";
import type {
  ExecuteTaskResult,
  OrchestratorContext,
  PipelineState,
  ProcessPhaseResult,
} from "./types.js";
import type { WorkspaceLifecycle } from "./workspace-lifecycle.js";

// ── Constants ───────────────────────────────────────────────────────────────

/** The standard 7-phase pipeline sequence. */
export const PHASE_SEQUENCE: Phase[] = [
  Phases.intake_analysis,
  Phases.research,
  Phases.planning,
  Phases.execution,
  Phases.self_review,
  Phases.demo_prep,
  Phases.integration,
];

/** Fast-path phases: skip research, planning, demo_prep, integration. */
const FAST_PATH_PHASES: Phase[] = [Phases.execution, Phases.self_review];

/** Max loopbacks before alerting human (orchestrator.md default: 3). */
const MAX_LOOPBACKS_BEFORE_ALERT = 3;

// ── Phase Handler Registry ─────────────────────────────────────────────────

/** A phase handler function. */
export type PhaseHandler = (
  taskId: string,
  dispatch: Dispatch,
  priorOutputs: Map<Phase, PhaseOutput>,
  state: PipelineState,
) => Promise<PhaseOutput>;

/** Registry of phase handlers (pluggable — add, remove, or reorder without touching the runner). */
export interface PhaseHandlerRegistry {
  get(phase: Phase): PhaseHandler;
}

/** Create a PhaseHandlerRegistry from a record of phase → handler mappings. */
export function createPhaseHandlerRegistry(
  handlers: Record<Phase, PhaseHandler>,
): PhaseHandlerRegistry {
  return {
    get(phase: Phase): PhaseHandler {
      const handler = handlers[phase];
      if (!handler) {
        throw new PhaseHandlerMissingError(phase);
      }
      return handler;
    },
  };
}

// ── SBAR Handoffs (Medicine) ────────────────────────────────────────────────

/**
 * Build a structured SBAR handoff string for phase transitions.
 * Logged at each transition for operational visibility.
 */
export function buildPhaseHandoff(
  completedPhase: Phase,
  nextPhase: Phase,
  output: PhaseOutput,
  dispatch: Dispatch,
): string {
  return [
    `SITUATION: Completed ${completedPhase} phase for task "${dispatch.task.title}"`,
    `BACKGROUND: ${output.confidence} confidence, ${String(output.open_questions.length)} open questions`,
    `ASSESSMENT: ${output.open_questions.length > 0 ? "Open questions need attention" : "Clean handoff"}`,
    `RECOMMENDATION: Proceed with ${nextPhase}`,
  ].join("\n");
}

// ── Pipeline Dependencies ───────────────────────────────────────────────────

/** Dependencies for the phase pipeline runner. */
export interface PhaseRunnerDeps {
  ctx: OrchestratorContext;
  handlers: PhaseHandlerRegistry;
  workspaceLifecycle: WorkspaceLifecycle;
  prManager: PrManager;
  decompositionHandler: DecompositionHandler;
  /** Check if preemption has been requested (set by EventBus subscription). */
  isPreempted: () => boolean;
  /** Get the preemption payload (target + preempting task IDs). */
  getPreemptionPayload: () => { target_task_id: string; preempting_task_id: string } | null;
  /** Reset preemption state after handling. */
  resetPreemption: () => void;
}

// ── Pure Helpers ────────────────────────────────────────────────────────────

/** Check if intake output enables fast-path, return updated phases array. */
function applyFastPathIfNeeded(intakeOutput: PhaseOutput, currentPhases: Phase[]): Phase[] {
  const intakeData = intakeOutput.data as { fast_path?: boolean };
  console.log(
    `[phase-runner] applyFastPathIfNeeded: fast_path=${String(intakeData.fast_path)} (type=${typeof intakeData.fast_path}) confidence=${intakeOutput.confidence}`,
  );
  if (intakeData.fast_path === true) {
    const newPhases = [Phases.intake_analysis, ...FAST_PATH_PHASES];
    console.log(`[phase-runner] Fast-path ENABLED: phases=[${newPhases.join(",")}]`);
    return newPhases;
  }
  console.log(
    `[phase-runner] Fast-path NOT applied, keeping ${String(currentPhases.length)} phases`,
  );
  return currentPhases;
}

/** Determine start index and phase sequence (Protocol P9 resume). */
function resolveStartState(
  dispatch: Dispatch,
  sessionId: string,
  taskId: string,
  ctx: OrchestratorContext,
): { phases: Phase[]; startIndex: number } {
  const phases = [...PHASE_SEQUENCE];

  if (!dispatch.resume_from) {
    return { phases, startIndex: 0 };
  }

  const checkpoint = dispatch.resume_from;
  const checkpointPhaseIndex = phases.indexOf(checkpoint.phase as Phase);
  const startIndex = checkpointPhaseIndex >= 0 ? checkpointPhaseIndex + 1 : 0;

  // Verify workspace integrity before resuming
  ctx.workspaceManager.verifyWorkspace(taskId);

  ctx.sessionMemory.addJournalEntry({
    sessionId,
    taskId,
    phase: checkpoint.phase,
    type: JournalEntryTypes.phase_change,
    summary: `Resumed from checkpoint in ${checkpoint.phase} phase. Reason: ${checkpoint.reason}.`,
    detail: checkpoint.next_action,
    tags: ["resume"],
  });

  return { phases, startIndex };
}

/** Create a checkpoint at a phase transition (Protocol P4). */
function createPhaseCheckpoint(
  sessionId: string,
  taskId: string,
  completedPhase: Phase,
  priorOutputs: Map<Phase, PhaseOutput>,
  nextPhase: Phase | null,
  ctx: OrchestratorContext,
): string {
  const output = priorOutputs.get(completedPhase);
  const checkpoint = ctx.sessionMemory.createCheckpoint({
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
    reason: CheckpointReasons.phase_transition,
    journalOffset: 0,
  });
  return checkpoint.id;
}

/** Record a phase transition: checkpoint + journal + update task.phase (Protocol P4). */
function recordPhaseTransition(
  sessionId: string,
  taskId: string,
  completedPhase: Phase,
  nextPhase: Phase | null,
  priorOutputs: Map<Phase, PhaseOutput>,
  dispatch: Dispatch,
  ctx: OrchestratorContext,
): void {
  createPhaseCheckpoint(sessionId, taskId, completedPhase, priorOutputs, nextPhase, ctx);

  // SBAR handoff logging
  if (nextPhase) {
    const output = priorOutputs.get(completedPhase);
    if (output) {
      const handoff = buildPhaseHandoff(completedPhase, nextPhase, output, dispatch);
      ctx.sessionMemory.addJournalEntry({
        sessionId,
        taskId,
        phase: completedPhase,
        type: JournalEntryTypes.phase_change,
        summary: `Completed ${completedPhase}, entering ${nextPhase}`,
        detail: handoff,
        tags: ["phase_transition", "sbar_handoff"],
      });
    } else {
      ctx.sessionMemory.addJournalEntry({
        sessionId,
        taskId,
        phase: completedPhase,
        type: JournalEntryTypes.phase_change,
        summary: `Completed ${completedPhase}, entering ${nextPhase}`,
        tags: ["phase_transition"],
      });
    }
  } else {
    ctx.sessionMemory.addJournalEntry({
      sessionId,
      taskId,
      phase: completedPhase,
      type: JournalEntryTypes.phase_change,
      summary: `Completed ${completedPhase} (final phase)`,
      tags: ["phase_transition"],
    });
  }

  if (nextPhase) {
    ctx.taskEngine.updateTaskField(taskId, "phase", nextPhase);
  }
}

/** Log error and build error result for a failed phase. */
function handlePhaseError(
  sessionId: string,
  taskId: string,
  phase: Phase,
  error: unknown,
  ctx: OrchestratorContext,
): ExecuteTaskResult {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? (error.stack ?? null) : null;

  ctx.sessionMemory.addJournalEntry({
    sessionId,
    taskId,
    phase,
    type: JournalEntryTypes.error,
    summary: `Phase ${phase} failed: ${message}`,
    errorDetail: stack,
    tags: ["phase_error"],
  });

  return { outcome: "error", phase, reason: message };
}

/** Handle preemption: checkpoint, end session, emit ready (Protocol P8). */
function handlePreemption(
  sessionId: string,
  taskId: string,
  currentPhase: Phase,
  ctx: OrchestratorContext,
  preemptingId: string,
): ExecuteTaskResult {
  const checkpoint = ctx.sessionMemory.createCheckpoint({
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
    reason: CheckpointReasons.preemption,
    journalOffset: 0,
  });

  ctx.sessionMemory.addJournalEntry({
    sessionId,
    taskId,
    phase: currentPhase,
    type: JournalEntryTypes.checkpoint_marker,
    summary: `Preempted by ${preemptingId}`,
    tags: ["preemption"],
  });

  ctx.sessionMemory.endSession(sessionId, SessionEndReasons.preempted);

  ctx.eventBus.publish({
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

  return { outcome: "preempted", lastPhase: currentPhase, checkpointId: checkpoint.id };
}

/** Check if self-review output requires loopback to execution. */
function checkSelfReviewLoopback(
  sessionId: string,
  taskId: string,
  output: PhaseOutput,
  phases: Phase[],
  state: PipelineState,
  ctx: OrchestratorContext,
): { targetIndex: number; loopbackCount: number } | null {
  const reviewData = output.data as { quality_assessment?: string };
  const assessment = reviewData.quality_assessment ?? "";

  // Only loopback when the LLM explicitly assessed "needs_work" or
  // "fundamental_issues". Any other value (including "unknown" from fallback
  // outputs, "ship_it", "acceptable", or free-form positive assessments)
  // passes through to the next phase.
  if (assessment !== "needs_work" && assessment !== "fundamental_issues") {
    return null;
  }

  const newLoopbackCount = state.loopbackCount + 1;

  if (newLoopbackCount > MAX_LOOPBACKS_BEFORE_ALERT) {
    emitLoopbackAlert(sessionId, taskId, newLoopbackCount, assessment, ctx);
    return null;
  }

  ctx.sessionMemory.addJournalEntry({
    sessionId,
    taskId,
    phase: Phases.self_review,
    type: JournalEntryTypes.phase_change,
    summary: `Quality assessment: ${assessment}. Looping back to execution (attempt ${String(newLoopbackCount)}).`,
    tags: ["loopback", assessment],
  });

  const executionIndex = phases.indexOf(Phases.execution);
  if (executionIndex < 0) {
    return null;
  }
  return { targetIndex: executionIndex, loopbackCount: newLoopbackCount };
}

/** Alert human that loopbacks have exceeded the safety threshold. */
function emitLoopbackAlert(
  sessionId: string,
  taskId: string,
  count: number,
  assessment: string,
  ctx: OrchestratorContext,
): void {
  ctx.eventBus.publish({
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

  ctx.sessionMemory.addJournalEntry({
    sessionId,
    taskId,
    phase: Phases.self_review,
    type: JournalEntryTypes.error,
    summary: `Loopback threshold exceeded (${String(count)} attempts, assessment: ${assessment}). Proceeding to demo_prep for human review.`,
    tags: ["loopback_alert"],
  });
}

/** Attempt PR creation; if successful, exit the pipeline for human review. */
async function tryCreatePRAndExitForReview(
  sessionId: string,
  taskId: string,
  phase: Phase,
  output: PhaseOutput,
  dispatch: Dispatch,
  phases: Phase[],
  priorOutputs: Map<Phase, PhaseOutput>,
  ctx: OrchestratorContext,
  prManager: PrManager,
  workspaceLifecycle: WorkspaceLifecycle,
): Promise<ProcessPhaseResult | null> {
  const prCreated = await prManager.commitPushAndCreatePR(
    sessionId,
    taskId,
    output,
    dispatch,
    (d, m) => workspaceLifecycle.commentOnSourceIssue(d, m),
    (d, m) => workspaceLifecycle.notifyMilestone(d, m),
  );
  if (!prCreated) {
    return null;
  }

  // PR is created — from here, we MUST return reviewPendingResult regardless of errors.
  // If recordPhaseTransition or endSession throws, a crash_recovery re-dispatch
  // would resume at demo_prep (bypassing the fast-path exit).
  try {
    recordPhaseTransition(sessionId, taskId, phase, null, priorOutputs, dispatch, ctx);
    ctx.sessionMemory.endSession(sessionId, SessionEndReasons.review_pending);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const errStack = err instanceof Error ? err.stack : "";
    console.error(
      `[phase-runner] BUG: Post-PR bookkeeping threw (PR already created). Error: ${errMsg}\nStack: ${errStack}`,
    );
  }

  return {
    phases,
    loopbackIndex: null,
    preemptionResult: null,
    decompositionResult: null,
    reviewPendingResult: { outcome: "review_pending", phase, phaseOutputs: priorOutputs },
  };
}

/** Handle post-phase logic: fast-path, decomposition, loopback, transitions, preemption, PR creation. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: multi-branch pipeline orchestration
async function processPhaseCompletion(
  sessionId: string,
  taskId: string,
  phase: Phase,
  output: PhaseOutput,
  currentPhases: Phase[],
  currentIndex: number,
  priorOutputs: Map<Phase, PhaseOutput>,
  dispatch: Dispatch,
  state: PipelineState,
  deps: PhaseRunnerDeps,
): Promise<{ result: ProcessPhaseResult; updatedLoopbackCount: number }> {
  const { ctx, prManager, decompositionHandler, workspaceLifecycle } = deps;
  let phases = currentPhases;
  let loopbackCount = state.loopbackCount;

  // Fast-path: after intake_analysis, check if we should skip phases
  if (phase === Phases.intake_analysis) {
    phases = applyFastPathIfNeeded(output, phases);
  }

  // Decomposition: after planning, check if task should be split into children
  if (phase === Phases.planning) {
    const decompositionResult = decompositionHandler.handleDecomposition(
      sessionId,
      taskId,
      output,
      dispatch,
      priorOutputs,
      (d, m) => workspaceLifecycle.commentOnSourceIssue(d, m),
    );
    if (decompositionResult) {
      return {
        result: {
          phases,
          loopbackIndex: null,
          preemptionResult: null,
          decompositionResult,
          reviewPendingResult: null,
        },
        updatedLoopbackCount: loopbackCount,
      };
    }
  }

  // Self-review quality gate: loopback to execution if needs_work
  if (phase === Phases.self_review) {
    const loopbackResult = checkSelfReviewLoopback(sessionId, taskId, output, phases, state, ctx);
    if (loopbackResult) {
      loopbackCount = loopbackResult.loopbackCount;
      ctx.taskEngine.updateTaskField(taskId, "phase", Phases.execution);
      return {
        result: {
          phases,
          loopbackIndex: loopbackResult.targetIndex - 1,
          preemptionResult: null,
          decompositionResult: null,
          reviewPendingResult: null,
        },
        updatedLoopbackCount: loopbackCount,
      };
    }
  }

  // After demo_prep: commit, push, create draft PR — then exit pipeline for review
  if (phase === Phases.demo_prep) {
    const result = await tryCreatePRAndExitForReview(
      sessionId,
      taskId,
      phase,
      output,
      dispatch,
      phases,
      priorOutputs,
      ctx,
      prManager,
      workspaceLifecycle,
    );
    if (result) {
      return { result, updatedLoopbackCount: loopbackCount };
    }
  }

  // Protocol P4: Phase transition
  const isLastPhase = currentIndex === phases.length - 1;

  console.log(
    `[phase-runner] processPhaseCompletion: phase=${phase} currentIndex=${String(currentIndex)} phases.length=${String(phases.length)} isLastPhase=${String(isLastPhase)} phases=[${phases.join(",")}]`,
  );

  // Fast-path PR: when self_review is the final phase
  if (phase === Phases.self_review && isLastPhase) {
    console.log("[phase-runner] Fast-path PR exit: self_review is last phase, creating PR");
    const result = await tryCreatePRAndExitForReview(
      sessionId,
      taskId,
      phase,
      output,
      dispatch,
      phases,
      priorOutputs,
      ctx,
      prManager,
      workspaceLifecycle,
    );
    console.log(
      `[phase-runner] tryCreatePRAndExitForReview returned: ${result ? `result (has reviewPendingResult=${String(!!result.reviewPendingResult)})` : "null"}`,
    );
    if (result) {
      console.log("[phase-runner] RETURNING reviewPendingResult from processPhaseCompletion");
      return { result, updatedLoopbackCount: loopbackCount };
    }
  }

  // biome-ignore lint/style/noNonNullAssertion: next phase exists when not last
  const nextPhase = isLastPhase ? null : phases[currentIndex + 1]!;
  recordPhaseTransition(sessionId, taskId, phase, nextPhase, priorOutputs, dispatch, ctx);

  // Check preemption after phase completion
  if (deps.isPreempted() && nextPhase) {
    const preemptingId = deps.getPreemptionPayload()?.preempting_task_id ?? "unknown";
    deps.resetPreemption();
    return {
      result: {
        phases,
        loopbackIndex: null,
        preemptionResult: handlePreemption(sessionId, taskId, nextPhase, ctx, preemptingId),
        decompositionResult: null,
        reviewPendingResult: null,
      },
      updatedLoopbackCount: loopbackCount,
    };
  }

  return {
    result: {
      phases,
      loopbackIndex: null,
      preemptionResult: null,
      decompositionResult: null,
      reviewPendingResult: null,
    },
    updatedLoopbackCount: loopbackCount,
  };
}

// ── Main Pipeline ───────────────────────────────────────────────────────────

/**
 * Execute a task through the phase pipeline.
 *
 * This is the main loop extracted from Orchestrator.executeTask().
 * Handles: phase sequence, fast-path, loopback, preemption, decomposition,
 * PR creation, and phase transitions.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: main pipeline loop with extracted helpers
export async function runPhasePipeline(
  dispatch: Dispatch,
  state: PipelineState,
  deps: PhaseRunnerDeps,
): Promise<ExecuteTaskResult> {
  const { ctx, handlers } = deps;
  const { sessionId } = state;
  const taskId = dispatch.task.id;
  let currentState = { ...state };

  // ── Determine phase sequence ───────────────────────────────────────────
  const { phases: initialPhases, startIndex } = resolveStartState(dispatch, sessionId, taskId, ctx);
  let phases = initialPhases;
  console.log(
    `[phase-runner] runPhasePipeline START: taskId=${taskId} startIndex=${String(startIndex)} phases=[${phases.join(",")}] resume_from=${dispatch.resume_from ? dispatch.resume_from.phase : "none"}`,
  );

  // Set initial task.phase
  // biome-ignore lint/style/noNonNullAssertion: startIndex is within bounds
  const initialPhase = phases[startIndex]!;
  ctx.taskEngine.updateTaskField(taskId, "phase", initialPhase);

  // ── Phase loop ─────────────────────────────────────────────────────────
  const priorOutputs = new Map<Phase, PhaseOutput>();

  for (let i = startIndex; i < phases.length; i++) {
    // Check preemption before phase start
    if (deps.isPreempted()) {
      const preemptingId = deps.getPreemptionPayload()?.preempting_task_id ?? "unknown";
      deps.resetPreemption();
      // biome-ignore lint/style/noNonNullAssertion: phases[i] is guaranteed valid within loop bounds
      return handlePreemption(sessionId, taskId, phases[i]!, ctx, preemptingId);
    }

    // biome-ignore lint/style/noNonNullAssertion: phases[i] is guaranteed valid within loop bounds
    const phase = phases[i]!;

    console.log(
      `[phase-runner] loop: i=${String(i)} phase=${phase} phases=[${phases.join(",")}] len=${String(phases.length)}`,
    );

    // Check AndonCord
    if (deps.workspaceLifecycle.andonCord.isPulled()) {
      const reason = deps.workspaceLifecycle.andonCord.getReason() ?? "unknown";
      return handlePhaseError(
        sessionId,
        taskId,
        phase,
        new Error(`AndonCord pulled: ${reason}`),
        ctx,
      );
    }

    // Execute the phase handler
    let output: PhaseOutput;
    try {
      const handler = handlers.get(phase);
      output = await handler(taskId, dispatch, priorOutputs, currentState);
    } catch (error: unknown) {
      return handlePhaseError(sessionId, taskId, phase, error, ctx);
    }

    priorOutputs.set(phase, output);

    // Post-phase processing
    const { result: postResult, updatedLoopbackCount } = await processPhaseCompletion(
      sessionId,
      taskId,
      phase,
      output,
      phases,
      i,
      priorOutputs,
      dispatch,
      currentState,
      deps,
    );

    currentState = { ...currentState, loopbackCount: updatedLoopbackCount };

    if (postResult.decompositionResult) {
      return postResult.decompositionResult;
    }
    if (postResult.reviewPendingResult) {
      console.log("[phase-runner] PIPELINE EXITING with reviewPendingResult");
      return postResult.reviewPendingResult;
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
  ctx.sessionMemory.endSession(sessionId, SessionEndReasons.completed);
  return { outcome: "completed", phaseOutputs: priorOutputs };
}
