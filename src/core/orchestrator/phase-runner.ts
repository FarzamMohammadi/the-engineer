import type { Dispatch } from "../../schemas/ephemeral.js";
import type { Phase, PhaseOutput } from "../../schemas/orchestrator.js";
import { Phases } from "../../schemas/orchestrator.js";
import {
  CheckpointReasons,
  JournalEntryTypes,
  SessionEndReasons,
} from "../../schemas/session-memory.js";
import type { PublishInput } from "../event-bus/index.js";
import type { AndonCord } from "./andon-cord.js";
import type { DecompositionHandler } from "./decomposition-handler.js";
import { PhaseHandlerMissingError, WorkspaceVerificationError } from "./errors.js";
import type { PrManager } from "./pr-manager.js";
import { gatherRepoContextSafe } from "./prompts/index.js";
import {
  type ExecuteTaskResult,
  type OrchestratorContext,
  PHASE_SEQUENCE,
  type PipelineState,
  type PreemptionGate,
} from "./types.js";

// ── Constants ───────────────────────────────────────────────────────────────

// Re-export for backward compatibility (tests import from here).
export { PHASE_SEQUENCE } from "./types.js";

/** Fast-path phases: skip research, planning, demo_prep, integration. */
const FAST_PATH_PHASES: Phase[] = [Phases.execution, Phases.self_review];

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
 * Format a structured SBAR handoff string for phase transitions.
 * Logged at each transition for operational visibility.
 */
export function formatPhaseHandoff(
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
  prManager: PrManager;
  decompositionHandler: DecompositionHandler;
  /** Emergency halt mechanism (Toyota Production System). */
  andonCord: AndonCord;
  /** Cooperative preemption state (Protocol P8). */
  preemption: PreemptionGate;
}

/** Discriminated union of post-phase processing outcomes (internal to the pipeline runner). */
type PhaseCompletionResult =
  | { kind: "continue"; phases: Phase[] }
  | { kind: "loopback"; phases: Phase[]; targetIndex: number }
  | { kind: "exit"; result: ExecuteTaskResult };

// ── Pure Helpers ────────────────────────────────────────────────────────────

/** Check if intake output enables fast-path, return updated phases array. */
function applyFastPathIfNeeded(
  intakeOutput: PhaseOutput,
  currentPhases: Phase[],
  ctx: OrchestratorContext,
): Phase[] {
  if (!ctx.config.fast_path.enabled) {
    ctx.observer.debug("Fast-path disabled by config");
    return currentPhases;
  }
  const intakeData = intakeOutput.data as { fast_path?: boolean };
  if (intakeData.fast_path === true) {
    const newPhases = [Phases.intake_analysis, ...FAST_PATH_PHASES];
    ctx.observer.info("Fast-path enabled", { phases: newPhases });
    return newPhases;
  }
  ctx.observer.debug("Fast-path not applied", { phaseCount: currentPhases.length });
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

  // Verify workspace integrity before resuming.
  // If workspace was deleted between runs (disk cleanup, manual intervention),
  // throw a descriptive error that handlePhaseError will catch in the main loop.
  try {
    ctx.workspaceManager.verifyWorkspace(taskId);
  } catch (verifyErr) {
    const msg = verifyErr instanceof Error ? verifyErr.message : String(verifyErr);
    throw new WorkspaceVerificationError(msg);
  }

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
      const handoff = formatPhaseHandoff(completedPhase, nextPhase, output, dispatch);
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

/** Log error and build error result for a failed phase. Closes the session. */
function handlePhaseError(
  sessionId: string,
  taskId: string,
  phase: Phase,
  error: unknown,
  ctx: OrchestratorContext,
): ExecuteTaskResult {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? (error.stack ?? null) : null;

  // Ensure the task record reflects the phase where failure occurred,
  // even if it happened during post-phase processing.
  ctx.taskEngine.updateTaskField(taskId, "phase", phase);

  ctx.sessionMemory.addJournalEntry({
    sessionId,
    taskId,
    phase,
    type: JournalEntryTypes.error,
    summary: `Phase ${phase} failed: ${message}`,
    errorDetail: stack,
    tags: ["phase_error"],
  });

  // Close the session so it doesn't remain open indefinitely in the DB.
  // Crash recovery re-dispatch will create a new session.
  ctx.sessionMemory.endSession(sessionId, SessionEndReasons.crashed);

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

  if (newLoopbackCount > ctx.config.phases.max_loopbacks_before_alert) {
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
  priorOutputs: Map<Phase, PhaseOutput>,
  ctx: OrchestratorContext,
  prManager: PrManager,
): Promise<PhaseCompletionResult | null> {
  const prCreated = await prManager.commitPushAndCreatePR(sessionId, taskId, output, dispatch);
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
    ctx.observer.error("BUG: Post-PR bookkeeping threw (PR already created)", {
      taskId,
      error: errMsg,
      stack: errStack,
    });
  }

  return {
    kind: "exit",
    result: { outcome: "review_pending", phase, phaseOutputs: priorOutputs },
  };
}

/** Handle post-phase logic: fast-path, decomposition, loopback, transitions, preemption, PR creation. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: multi-branch pipeline orchestration
async function handlePostPhaseActions(
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
): Promise<{ completion: PhaseCompletionResult; loopbackCount: number }> {
  const { ctx, prManager, decompositionHandler } = deps;
  let phases = currentPhases;
  let loopbackCount = state.loopbackCount;

  // Fast-path: after intake_analysis, check if we should skip phases
  if (phase === Phases.intake_analysis) {
    phases = applyFastPathIfNeeded(output, phases, ctx);
  }

  // Decomposition: after planning, check if task should be split into children
  if (phase === Phases.planning) {
    const decompositionResult = decompositionHandler.handleDecomposition(
      sessionId,
      taskId,
      output,
      dispatch,
      priorOutputs,
    );
    if (decompositionResult) {
      return {
        completion: { kind: "exit", result: decompositionResult },
        loopbackCount,
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
        completion: { kind: "loopback", phases, targetIndex: loopbackResult.targetIndex - 1 },
        loopbackCount,
      };
    }
  }

  // After demo_prep: commit, push, create draft PR — then exit pipeline for review
  if (phase === Phases.demo_prep) {
    const prResult = await tryCreatePRAndExitForReview(
      sessionId,
      taskId,
      phase,
      output,
      dispatch,
      priorOutputs,
      ctx,
      prManager,
    );
    if (prResult) {
      return { completion: prResult, loopbackCount };
    }
  }

  // Protocol P4: Phase transition
  const isLastPhase = currentIndex === phases.length - 1;

  ctx.observer.debug("Phase completion processing", {
    taskId,
    phase,
    currentIndex,
    phaseCount: phases.length,
    isLastPhase,
  });

  // Fast-path PR: when self_review is the final phase
  if (phase === Phases.self_review && isLastPhase) {
    ctx.observer.info("Fast-path PR exit: self_review is last phase, creating PR", { taskId });
    const prResult = await tryCreatePRAndExitForReview(
      sessionId,
      taskId,
      phase,
      output,
      dispatch,
      priorOutputs,
      ctx,
      prManager,
    );
    ctx.observer.debug("Fast-path PR result", { taskId, hasResult: !!prResult });
    if (prResult) {
      return { completion: prResult, loopbackCount };
    }
  }

  // biome-ignore lint/style/noNonNullAssertion: next phase exists when not last
  const nextPhase = isLastPhase ? null : phases[currentIndex + 1]!;
  recordPhaseTransition(sessionId, taskId, phase, nextPhase, priorOutputs, dispatch, ctx);

  // Check preemption after phase completion
  if (deps.preemption.isRequested() && nextPhase) {
    const preemptingId = deps.preemption.getPayload()?.preempting_task_id ?? "unknown";
    deps.preemption.reset();
    return {
      completion: {
        kind: "exit",
        result: handlePreemption(sessionId, taskId, nextPhase, ctx, preemptingId),
      },
      loopbackCount,
    };
  }

  return {
    completion: { kind: "continue", phases },
    loopbackCount,
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
  ctx.observer.info("Phase pipeline starting", {
    taskId,
    startIndex,
    phases,
    resumeFrom: dispatch.resume_from?.phase ?? "none",
  });

  // Set initial task.phase
  // biome-ignore lint/style/noNonNullAssertion: startIndex is within bounds
  const initialPhase = phases[startIndex]!;
  ctx.taskEngine.updateTaskField(taskId, "phase", initialPhase);

  // ── Phase loop ─────────────────────────────────────────────────────────
  const priorOutputs = new Map<Phase, PhaseOutput>();

  for (let i = startIndex; i < phases.length; i++) {
    // Check preemption before phase start
    if (deps.preemption.isRequested()) {
      const preemptingId = deps.preemption.getPayload()?.preempting_task_id ?? "unknown";
      deps.preemption.reset();
      // biome-ignore lint/style/noNonNullAssertion: phases[i] is guaranteed valid within loop bounds
      return handlePreemption(sessionId, taskId, phases[i]!, ctx, preemptingId);
    }

    // biome-ignore lint/style/noNonNullAssertion: phases[i] is guaranteed valid within loop bounds
    const phase = phases[i]!;

    ctx.observer.debug("Phase loop iteration", { index: i, phase, phaseCount: phases.length });

    // Check AndonCord
    if (deps.andonCord.isPulled()) {
      const reason = deps.andonCord.getReason() ?? "unknown";
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
    ctx.observer.info("Phase starting", { taskId, phase });
    const phaseStart = Date.now();
    try {
      const handler = handlers.get(phase);
      output = await handler(taskId, dispatch, priorOutputs, currentState);
    } catch (error: unknown) {
      return handlePhaseError(sessionId, taskId, phase, error, ctx);
    }
    ctx.observer.info("Phase completed", { taskId, phase, durationMs: Date.now() - phaseStart });

    priorOutputs.set(phase, output);

    // Refresh cached repo context after execution (the only phase that modifies files).
    // This ensures self_review, demo_prep, and integration see the updated state.
    if (phase === Phases.execution) {
      const worktreePath = ctx.workspaceManager.getWorktreePath(taskId);
      currentState = {
        ...currentState,
        repoContext: gatherRepoContextSafe(worktreePath, ctx.observer),
      };
    }

    // Post-phase processing: decomposition, PR creation, transitions, loopback, preemption.
    // Wrapped separately so errors here (e.g. DB failure, PR creation exception) are caught
    // and routed through handlePhaseError, which also closes the session.
    let completion: PhaseCompletionResult;
    try {
      const result = await handlePostPhaseActions(
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
      completion = result.completion;
      currentState = { ...currentState, loopbackCount: result.loopbackCount };
    } catch (completionError) {
      return handlePhaseError(sessionId, taskId, phase, completionError, ctx);
    }

    switch (completion.kind) {
      case "exit":
        return completion.result;
      case "loopback": {
        phases = completion.phases;
        i = completion.targetIndex;
        continue;
      }
      case "continue":
        phases = completion.phases;
        break;
      default: {
        const Exhaustive: never = completion;
        throw new Error(`Unexpected completion kind: ${JSON.stringify(Exhaustive)}`);
      }
    }
  }

  // ── Pipeline complete ──────────────────────────────────────────────────
  // Session close is important but not worth losing the completed outcome over.
  // If endSession throws (DB corruption, connection closed), log and continue.
  try {
    ctx.sessionMemory.endSession(sessionId, SessionEndReasons.completed);
  } catch (endErr) {
    ctx.observer.error("Failed to close session after pipeline completion", {
      taskId,
      sessionId,
      error: endErr instanceof Error ? endErr.message : String(endErr),
    });
  }
  ctx.observer.info("Phase pipeline completed", {
    taskId,
    sessionId,
    phasesRun: phases.length - startIndex,
    outcome: "completed",
  });
  return { outcome: "completed", phaseOutputs: priorOutputs };
}
