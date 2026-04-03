import path from "node:path";
import type { OrchestratorConfig } from "../../schemas/config.js";
import type { Dispatch } from "../../schemas/ephemeral.js";
import type { Phase, PhaseOutput } from "../../schemas/orchestrator.js";
import { ComplexitySchema, Phases } from "../../schemas/orchestrator.js";
import {
  CheckpointReasons,
  JournalEntryTypes,
  SessionEndReasons,
} from "../../schemas/session-memory.js";
import { TaskStates } from "../../schemas/task.js";
import type { PublishInput } from "../event-bus/index.js";
import type { AndonCord } from "./andon-cord.js";
import type { DecompositionHandler } from "./decomposition-handler.js";
import { PhaseHandlerMissingError, WorkspaceVerificationError } from "./errors.js";
import { sendOutreach } from "./outreach-sender.js";
import { PhaseNavigator } from "./phase-navigator.js";
import type { PrManager } from "./pr-manager.js";
import { gatherRepoContextSafe } from "./prompts/index.js";
import {
  type ExecuteTaskResult,
  type OrchestratorContext,
  type PipelineState,
  type PreemptionGate,
  buildPhaseSequence,
} from "./types.js";

// ── Constants ───────────────────────────────────────────────────────────────

// Re-export for backward compatibility (tests import from here).
export { PHASE_SEQUENCE } from "./types.js";

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
  /** Cooperative shutdown gate — yields between phases when shutdown is requested. */
  shutdown?: { isRequested(): boolean };
}

// ── Outreach Helpers ─────────────────────────────────────────────────────

/** Discriminated union of post-phase processing outcomes (internal to the pipeline runner). */
type PhaseCompletionResult =
  | { kind: "continue"; phases: Phase[] }
  | { kind: "loopback"; phases: Phase[]; targetPhase: Phase }
  | { kind: "exit"; result: ExecuteTaskResult };

// ── Pure Helpers ────────────────────────────────────────────────────────────

/** Determine if research should be skipped based on complexity assessment. */
export function shouldSkipResearch(output: PhaseOutput, config: OrchestratorConfig): boolean {
  if (config.phases.force_full_pipeline) {
    return false;
  }
  const data = output.data as { complexity?: string };
  const parsed = ComplexitySchema.safeParse(data.complexity);
  return parsed.success && parsed.data === "trivial";
}

/** Determine start index and phase sequence (Protocol P9 resume). */
function resolveStartState(
  dispatch: Dispatch,
  sessionId: string,
  taskId: string,
  ctx: OrchestratorContext,
): { phases: Phase[]; startIndex: number } {
  const task = ctx.taskEngine.getTask(taskId);
  const phases = buildPhaseSequence(task?.skip_research ?? false);

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

/** Maximum error message length stored in journal entries and propagated as reason. */
const MAX_ERROR_MESSAGE_LENGTH = 2000;

/** Log error and build error result for a failed phase. Closes the session. */
function handlePhaseError(
  sessionId: string,
  taskId: string,
  phase: Phase,
  error: unknown,
  ctx: OrchestratorContext,
): ExecuteTaskResult {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? (error.stack ?? null) : null;

  // Truncate to prevent megabyte-sized error messages from flowing through
  // journal entries, daemon notifications, and GitHub comments.
  const message =
    rawMessage.length > MAX_ERROR_MESSAGE_LENGTH
      ? `${rawMessage.slice(0, MAX_ERROR_MESSAGE_LENGTH)}\n... [truncated from ${String(rawMessage.length)} chars]`
      : rawMessage;

  if (rawMessage.length > MAX_ERROR_MESSAGE_LENGTH) {
    ctx.observer.warn("Phase error message truncated", {
      taskId,
      phase,
      originalLength: rawMessage.length,
      truncatedTo: MAX_ERROR_MESSAGE_LENGTH,
    });
  }

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
): { targetPhase: Phase; loopbackCount: number } | null {
  const reviewData = output.data as { quality_assessment?: string; next_phase?: string };

  // Primary: quality_assessment from handler (CLI-native maps next_phase → quality_assessment).
  // Fallback: derive from next_phase directly (defense-in-depth).
  let assessment = reviewData.quality_assessment ?? "";
  if (!assessment && reviewData.next_phase) {
    assessment =
      reviewData.next_phase === "execution"
        ? "needs_work"
        : reviewData.next_phase === "requirements_gathering"
          ? "fundamental_issues"
          : "";
  }

  // Only loopback when the LLM explicitly assessed "needs_work" or
  // "fundamental_issues". Any other value (including "unknown" from fallback
  // outputs, "ship_it", "acceptable", or free-form positive assessments)
  // passes through to the next phase.
  if (assessment !== "needs_work" && assessment !== "fundamental_issues") {
    return null;
  }

  const newLoopbackCount = state.loopbackCount + 1;

  if (newLoopbackCount > ctx.config.rrpir.max_review_loopbacks) {
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

  if (!phases.includes(Phases.execution)) {
    return null;
  }
  return { targetPhase: Phases.execution, loopbackCount: newLoopbackCount };
}

/** Alert human that loopbacks have exceeded the safety threshold. */
function emitLoopbackAlert(
  sessionId: string,
  taskId: string,
  count: number,
  assessment: string,
  ctx: OrchestratorContext,
): void {
  const alertContent = `Self-review loopback threshold exceeded (${String(count)} attempts, assessment: ${assessment}). Proceeding to demo_prep for human review.`;

  // Deliver alert via centralized notification router
  ctx.notifications.notify({ kind: "alert", taskId, message: alertContent });

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

/** Handle post-phase logic: decomposition, loopback, transitions, preemption, PR creation. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: multi-branch pipeline orchestration
async function handlePostPhaseActions(
  sessionId: string,
  taskId: string,
  phase: Phase,
  output: PhaseOutput,
  currentPhases: Phase[],
  priorOutputs: Map<Phase, PhaseOutput>,
  dispatch: Dispatch,
  state: PipelineState,
  deps: PhaseRunnerDeps,
): Promise<{
  completion: PhaseCompletionResult;
  loopbackCount: number;
  requirementsLoopCount: number;
  returnToPhase: Phase | null;
}> {
  const { ctx, prManager, decompositionHandler } = deps;
  const phases = currentPhases;
  let loopbackCount = state.loopbackCount;
  let { requirementsLoopCount, returnToPhase } = state;

  // Universal fallback: any non-requirements phase can signal need_more_info → requirements_gathering
  // Routing is driven by status only. next_phase is for the Orchestrator's default sequencing.
  if (phase !== Phases.requirements_gathering) {
    const phaseData = output.data as { status?: string };
    if (phaseData.status === "need_more_info") {
      const maxLoops = ctx.config.rrpir?.max_requirements_loops ?? 5;
      const newLoopCount = requirementsLoopCount + 1;
      if (newLoopCount <= maxLoops) {
        ctx.observer.info("Phase needs more info, routing to requirements gathering", {
          taskId,
          callingPhase: phase,
          loopCount: newLoopCount,
          maxLoops,
        });
        requirementsLoopCount = newLoopCount;
        returnToPhase = phase;
        if (phases.includes(Phases.requirements_gathering)) {
          return {
            completion: { kind: "loopback", phases, targetPhase: Phases.requirements_gathering },
            loopbackCount,
            requirementsLoopCount,
            returnToPhase,
          };
        }
      } else {
        ctx.observer.warn("Max requirements loops exceeded, continuing to next phase", {
          taskId,
          callingPhase: phase,
          loopCount: newLoopCount,
          maxLoops,
        });
      }
    }
  }

  // Requirements_gathering signals need_more_info = needs a human. Block the task.
  // Must check BEFORE returnToPhase routing — blocking takes priority over returning.
  if (phase === Phases.requirements_gathering) {
    const reqData = output.data as { status?: string };
    if (reqData.status === "need_more_info") {
      ctx.observer.info("Requirements gathering needs human input, blocking task", { taskId });

      // Send outreach messages before blocking — read .txt files from outreach/ directory
      const worktreePath = ctx.workspaceManager.getWorktreePath(taskId);
      let contacted: Array<{ person: string; channel: string; timestamp: string }> = [];
      let shouldBlock = true;

      if (worktreePath && state.thoughtsDir) {
        const outreachDir = path.join(worktreePath, state.thoughtsDir, "requirements", "outreach");
        const task = ctx.taskEngine.getTask(taskId);
        const outreachResult = await sendOutreach(taskId, outreachDir, task?.external_ref ?? null, {
          peopleDirectory: ctx.peopleDirectory,
          notifications: ctx.notifications,
          eventBus: ctx.eventBus,
          observer: ctx.observer,
        });
        if (outreachResult.delivered) {
          contacted = outreachResult.contacted;
        } else if (outreachResult.reason === "no_contacts") {
          // No contacts resolved — don't block, task proceeds without human input
          shouldBlock = false;
          ctx.observer.warn(
            "No contacts resolved — skipping blocking, proceeding without human input",
            { taskId },
          );
        }
        // "all_delivery_failed" or "no_files" — still block, but contacted stays empty
      }

      if (!shouldBlock) {
        // Skip blocking — task proceeds to next phase (no send adapters)
        return {
          completion: { kind: "continue", phases },
          loopbackCount,
          requirementsLoopCount,
          returnToPhase,
        };
      }

      // Persist return_to_phase only when blocking from a fallback (another phase routed here).
      // When returnToPhase is null, requirements_gathering blocked on its own — no return
      // target needed; on resume the pipeline runs requirements_gathering then advances normally.
      if (returnToPhase) {
        ctx.taskEngine.updateTaskField(taskId, "return_to_phase", returnToPhase);
      }

      ctx.taskEngine.requestTransition(
        taskId,
        TaskStates.blocked,
        null,
        "Awaiting human input — see requirements.md",
        "orchestrator",
      );
      ctx.taskEngine.updateTaskField(taskId, "blocked", {
        reason: "need_more_info",
        efforts_made: ["Requirements gathering documented questions in requirements.md"],
        contacted,
        needed: "Human input on questions in requirements.md",
        waiting_for: "human",
      });

      ctx.observationStore?.observe(
        "state_transition",
        "task_blocked",
        { task_id: taskId, reason: "need_more_info", return_to_phase: returnToPhase ?? phase },
        { task_id: taskId, session_id: sessionId, trace_id: state.traceId },
      );

      ctx.sessionMemory.endSession(sessionId, SessionEndReasons.blocked);
      return {
        completion: {
          kind: "exit",
          result: {
            outcome: "blocked",
            phase,
            reason: "Awaiting human input — see requirements.md",
          },
        },
        loopbackCount,
        requirementsLoopCount,
        returnToPhase,
      };
    }
  }

  // After requirements_gathering: if returnToPhase is set, jump back to calling phase
  if (phase === Phases.requirements_gathering && returnToPhase) {
    const returnPhase = returnToPhase;
    returnToPhase = null;
    if (phases.includes(returnPhase)) {
      ctx.observer.info("Requirements complete, returning to calling phase", {
        taskId,
        returnToPhase: returnPhase,
      });
      return {
        completion: { kind: "loopback", phases, targetPhase: returnPhase },
        loopbackCount,
        requirementsLoopCount,
        returnToPhase,
      };
    }
  }

  // Complexity-based research skip: trivial tasks go straight to planning
  if (phase === Phases.requirements_gathering && !returnToPhase) {
    if (shouldSkipResearch(output, ctx.config)) {
      const newPhases = buildPhaseSequence(true);
      ctx.taskEngine.updateTaskField(taskId, "skip_research", true);
      ctx.observer.info("Trivial task — skipping research phase", { taskId });
      return {
        completion: { kind: "continue", phases: newPhases },
        loopbackCount,
        requirementsLoopCount,
        returnToPhase,
      };
    }
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
        requirementsLoopCount,
        returnToPhase,
      };
    }
  }

  // Self-review quality gate: loopback to execution if needs_work
  if (phase === Phases.self_review) {
    const loopbackResult = checkSelfReviewLoopback(sessionId, taskId, output, phases, state, ctx);
    if (loopbackResult) {
      loopbackCount = loopbackResult.loopbackCount;

      ctx.observationStore?.observe(
        "decision_point",
        "loopback_decision",
        {
          from_phase: Phases.self_review,
          to_phase: Phases.execution,
          loopback_count: loopbackResult.loopbackCount,
        },
        { task_id: taskId, session_id: sessionId, trace_id: state.traceId },
      );

      ctx.taskEngine.updateTaskField(taskId, "phase", Phases.execution);
      return {
        completion: { kind: "loopback", phases, targetPhase: loopbackResult.targetPhase },
        loopbackCount,
        requirementsLoopCount,
        returnToPhase,
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
      return { completion: prResult, loopbackCount, requirementsLoopCount, returnToPhase };
    }
  }

  // Protocol P4: Phase transition
  const currentIndex = phases.indexOf(phase);
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
      return { completion: prResult, loopbackCount, requirementsLoopCount, returnToPhase };
    }
  }

  // biome-ignore lint/style/noNonNullAssertion: next phase exists when not last
  const nextPhase = isLastPhase ? null : phases[currentIndex + 1]!;
  recordPhaseTransition(sessionId, taskId, phase, nextPhase, priorOutputs, dispatch, ctx);

  // Check preemption after phase completion
  if (deps.preemption.isRequested(taskId) && nextPhase) {
    const preemptingId = deps.preemption.getPayload(taskId)?.preempting_task_id ?? "unknown";
    deps.preemption.reset(taskId);
    return {
      completion: {
        kind: "exit",
        result: handlePreemption(sessionId, taskId, nextPhase, ctx, preemptingId),
      },
      loopbackCount,
      requirementsLoopCount,
      returnToPhase,
    };
  }

  // Check cooperative shutdown after phase completion
  if (deps.shutdown?.isRequested() && nextPhase) {
    return {
      completion: {
        kind: "exit",
        result: handlePreemption(sessionId, taskId, nextPhase, ctx, "shutdown"),
      },
      loopbackCount,
      requirementsLoopCount,
      returnToPhase,
    };
  }

  return {
    completion: { kind: "continue", phases },
    loopbackCount,
    requirementsLoopCount,
    returnToPhase,
  };
}

// ── Main Pipeline ───────────────────────────────────────────────────────────

/**
 * Execute a task through the phase pipeline.
 *
 * This is the main loop extracted from Orchestrator.executeTask().
 * Handles: phase sequence, loopback, preemption, decomposition,
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
  const navigator = new PhaseNavigator(initialPhases, startIndex);
  ctx.observer.info("Phase pipeline starting", {
    taskId,
    startIndex,
    phases: navigator.getPhases(),
    resumeFrom: dispatch.resume_from?.phase ?? "none",
  });

  // ── Pipeline observation span ──────────────────────────────────────────
  const pipelineSpan =
    ctx.observationStore && state.traceId && state.sessionId
      ? ctx.observationStore.startSpan(
          "lifecycle",
          "pipeline",
          {
            task_id: taskId,
            start_index: startIndex,
            resume_from: dispatch.resume_from?.phase ?? null,
          },
          { task_id: taskId, session_id: state.sessionId, trace_id: state.traceId },
        )
      : null;

  /** End the pipeline span with the given result before returning. */
  function endPipelineSpan(result: ExecuteTaskResult, phasesRun: number): ExecuteTaskResult {
    pipelineSpan?.end({ outcome: result.outcome, phases_run: phasesRun });
    return result;
  }

  // Set initial task.phase
  ctx.taskEngine.updateTaskField(taskId, "phase", navigator.current());

  // ── Restore persisted pipeline state from task record ────────────────
  const task = ctx.taskEngine.getTask(taskId);

  // Restore loopback counts (crash recovery — counters survive re-dispatch)
  if (task) {
    currentState = {
      ...currentState,
      loopbackCount: task.loopback_count,
      requirementsLoopCount: task.requirements_loop_count,
    };
  }

  // Restore return_to_phase from prior blocked dispatch.
  // When return_to_phase is set, always start at requirements_gathering (index 0).
  // Requirements_gathering reads the response, decides if satisfied, and the
  // returnToPhase routing sends it back to the right phase.
  if (task?.return_to_phase) {
    currentState = { ...currentState, returnToPhase: task.return_to_phase };
    ctx.taskEngine.updateTaskField(taskId, "return_to_phase", null);
    ctx.observer.info("Restored return_to_phase from prior blocked dispatch", {
      taskId,
      returnToPhase: task.return_to_phase,
    });
  }

  // ── Phase loop ─────────────────────────────────────────────────────────
  const priorOutputs = new Map<Phase, PhaseOutput>();

  while (navigator.hasMore()) {
    const phase = navigator.current();

    // Check preemption before phase start
    if (deps.preemption.isRequested(taskId)) {
      const preemptingId = deps.preemption.getPayload(taskId)?.preempting_task_id ?? "unknown";
      deps.preemption.reset(taskId);
      return endPipelineSpan(
        handlePreemption(sessionId, taskId, phase, ctx, preemptingId),
        navigator.phasesRun(),
      );
    }

    // Check cooperative shutdown before phase start (same checkpoint pattern as preemption)
    if (deps.shutdown?.isRequested()) {
      return endPipelineSpan(
        handlePreemption(sessionId, taskId, phase, ctx, "shutdown"),
        navigator.phasesRun(),
      );
    }

    ctx.observer.debug("Phase loop iteration", {
      index: navigator.currentIndex(),
      phase,
      phaseCount: navigator.getPhases().length,
    });

    // Check AndonCord
    if (deps.andonCord.isPulled()) {
      const reason = deps.andonCord.getReason() ?? "unknown";
      return endPipelineSpan(
        handlePhaseError(sessionId, taskId, phase, new Error(`AndonCord pulled: ${reason}`), ctx),
        navigator.phasesRun(),
      );
    }

    // Execute the phase handler
    currentState = { ...currentState, phaseSequence: currentState.phaseSequence + 1 };
    let output: PhaseOutput;
    ctx.observer.info("Phase starting", {
      taskId,
      phase,
      phaseSequence: currentState.phaseSequence,
    });
    const phaseStart = Date.now();
    try {
      const handler = handlers.get(phase);
      output = await handler(taskId, dispatch, priorOutputs, currentState);
    } catch (error: unknown) {
      ctx.observer.error("Phase handler threw", {
        taskId,
        phase,
        errorType: error instanceof Error ? error.constructor.name : typeof error,
        message: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
      });
      return endPipelineSpan(
        handlePhaseError(sessionId, taskId, phase, error, ctx),
        navigator.phasesRun(),
      );
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
        navigator.getPhases(),
        priorOutputs,
        dispatch,
        currentState,
        deps,
      );
      completion = result.completion;

      // Persist loopback counts if changed (crash recovery)
      if (result.loopbackCount !== currentState.loopbackCount) {
        ctx.taskEngine.updateTaskField(taskId, "loopback_count", result.loopbackCount);
      }
      if (result.requirementsLoopCount !== currentState.requirementsLoopCount) {
        ctx.taskEngine.updateTaskField(
          taskId,
          "requirements_loop_count",
          result.requirementsLoopCount,
        );
      }

      currentState = {
        ...currentState,
        loopbackCount: result.loopbackCount,
        requirementsLoopCount: result.requirementsLoopCount,
        returnToPhase: result.returnToPhase,
      };
    } catch (completionError) {
      return endPipelineSpan(
        handlePhaseError(sessionId, taskId, phase, completionError, ctx),
        navigator.phasesRun() + 1,
      );
    }

    switch (completion.kind) {
      case "exit":
        return endPipelineSpan(completion.result, navigator.phasesRun() + 1);
      case "loopback": {
        // Clear phase outputs that will be re-generated — prevents unbounded memory growth
        // across loopback cycles (self-review → execution → self-review → ...)
        for (const p of navigator.phasesFromCursor()) {
          priorOutputs.delete(p);
        }
        navigator.replaceSequence(completion.phases);
        navigator.jumpTo(completion.targetPhase);
        continue;
      }
      case "continue": {
        navigator.replaceSequence(completion.phases);
        navigator.advance();
        continue;
      }
      default: {
        const Exhaustive: never = completion;
        throw new Error(`Unexpected completion kind: ${JSON.stringify(Exhaustive)}`);
      }
    }
  }

  // ── Pipeline complete ──────────────────────────────────────────────────
  // Clear loopback counters — task completed successfully, no need to persist
  ctx.taskEngine.updateTaskField(taskId, "loopback_count", 0);
  ctx.taskEngine.updateTaskField(taskId, "requirements_loop_count", 0);

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
    phasesRun: navigator.phasesRun(),
    outcome: "completed",
  });
  return endPipelineSpan(
    { outcome: "completed", phaseOutputs: priorOutputs },
    navigator.phasesRun(),
  );
}
