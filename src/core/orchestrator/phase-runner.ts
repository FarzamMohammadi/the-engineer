import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import type { CommunicationAdapter } from "../../adapters/communication.js";
import { AdapterTypes } from "../../schemas/adapters.js";
import type { Dispatch } from "../../schemas/ephemeral.js";
import type { Phase, PhaseOutput } from "../../schemas/orchestrator.js";
import { PHASE_DIRECTORIES, Phases } from "../../schemas/orchestrator.js";
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

// ── Outreach Helpers ─────────────────────────────────────────────────────

const TXT_SUFFIX_RE = /\.txt$/;

/**
 * Read outreach messages from `outreach/` directory and send via comm plugins.
 *
 * The LLM writes one `.txt` file per person to contact:
 *   `thoughts/{id}/requirements/outreach/{person-id}.txt`
 * Filename = person ID from People Directory. Content = the message to send.
 * No parsing — the LLM does the heavy lifting, we just deliver files.
 */
async function sendOutreachFromFiles(
  taskId: string,
  outreachDir: string,
  ctx: OrchestratorContext,
): Promise<void> {
  if (!existsSync(outreachDir)) {
    return;
  }

  const files = readdirSync(outreachDir).filter((f) => f.endsWith(".txt"));
  if (files.length === 0) {
    return;
  }

  const commPlugins = ctx.registry.getPluginsByType<CommunicationAdapter>(
    AdapterTypes.communication,
  );
  const sendPlugins = commPlugins.filter((p) => p.hasCapability("send"));
  if (sendPlugins.length === 0) {
    ctx.observer.warn("No comm plugins with send capability — outreach not delivered", {
      taskId,
      fileCount: files.length,
    });
    return;
  }

  const sendPromises: Promise<void>[] = [];

  for (const file of files) {
    const personId = file.replace(TXT_SUFFIX_RE, "");
    const message = readFileSync(path.join(outreachDir, file), "utf-8").trim();
    if (!message) {
      continue;
    }

    // Match person against People Directory, fall back to owner
    const contact = ctx.peopleDirectory.getPerson(personId) ?? ctx.peopleDirectory.getOwner();
    if (!contact) {
      ctx.observer.warn("Outreach: no contact found for person", { taskId, personId });
      continue;
    }

    for (const plugin of sendPlugins) {
      const formatted = plugin.formatMessage(message, "notification");
      sendPromises.push(
        plugin
          .sendMessage(
            { user_id: contact.id, channel: null },
            { content: formatted, metadata: { task_id: taskId, type: "notification" } },
          )
          .then((result) => {
            if (result.success) {
              ctx.observer.info("Outreach delivered", {
                taskId,
                personId,
                pluginId: plugin.manifest.id,
              });
              ctx.eventBus.publish({
                type: "comm.message_sent",
                source: "orchestrator",
                task_id: taskId,
                payload: {
                  task_id: taskId,
                  target: personId,
                  message_type: "notification" as const,
                  content_summary: message,
                  channel: plugin.manifest.id,
                },
              } satisfies PublishInput<"comm.message_sent">);
            } else {
              ctx.observer.warn("Outreach delivery failed", {
                taskId,
                personId,
                pluginId: plugin.manifest.id,
                error: result.error?.message ?? "unknown",
              });
            }
          })
          .catch((err: unknown) => {
            ctx.observer.warn("Outreach send error", {
              taskId,
              personId,
              error: err instanceof Error ? err.message : String(err),
            });
          }),
      );
    }
  }

  // Also comment on the source issue with a summary
  const task = ctx.taskEngine.getTask(taskId);
  const issuePlugin = commPlugins.find((p) => p.hasCapability("issue_management"));
  if (issuePlugin && task?.external_ref) {
    const { type, repo, number } = task.external_ref;
    if (type === "github_issue" || type === "github_pr") {
      const summary = files.map((f) => `- ${f.replace(TXT_SUFFIX_RE, "")}`).join("\n");
      sendPromises.push(
        issuePlugin
          .commentOnIssue(repo, number, `Blocked — reaching out for answers:\n\n${summary}`)
          .then(() => {
            ctx.observer.info("Outreach issue comment posted", { taskId, repo, number });
          })
          .catch((err: unknown) => {
            ctx.observer.warn("Issue comment for outreach failed", {
              taskId,
              error: err instanceof Error ? err.message : String(err),
            });
          }),
      );
    }
  }

  await Promise.allSettled(sendPromises);
}

/** Discriminated union of post-phase processing outcomes (internal to the pipeline runner). */
type PhaseCompletionResult =
  | { kind: "continue"; phases: Phase[] }
  | { kind: "loopback"; phases: Phase[]; targetIndex: number }
  | { kind: "exit"; result: ExecuteTaskResult };

// ── Pure Helpers ────────────────────────────────────────────────────────────

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

/** Handle post-phase logic: decomposition, loopback, transitions, preemption, PR creation. */
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
        // targetIndex - 1 because the for loop's i++ will increment to the target
        const reqIndex = phases.indexOf(Phases.requirements_gathering);
        if (reqIndex >= 0) {
          return {
            completion: { kind: "loopback", phases, targetIndex: reqIndex - 1 },
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
      if (worktreePath && state.thoughtsDir) {
        const outreachDir = path.join(
          worktreePath,
          state.thoughtsDir,
          PHASE_DIRECTORIES[0],
          "outreach",
        );
        await sendOutreachFromFiles(taskId, outreachDir, ctx);
      }

      // Always persist return_to_phase when blocking — defaults to the current phase.
      // On resume, the pipeline reads this and routes back here after requirements_gathering.
      ctx.taskEngine.updateTaskField(taskId, "return_to_phase", returnToPhase ?? phase);

      // No checkpoint — blocking is a pause, not a completion. Re-dispatch starts fresh
      // at requirements_gathering (startIndex 0). The workspace already exists and is
      // re-registered via the task's persisted workspace field.

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
        waiting_for: "human",
      });

      // TODO: Add "blocked" to SessionEndReasonSchema — using "crashed" as closest available
      ctx.sessionMemory.endSession(sessionId, SessionEndReasons.crashed);
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
    const returnIndex = phases.indexOf(returnPhase);
    if (returnIndex >= 0) {
      ctx.observer.info("Requirements complete, returning to calling phase", {
        taskId,
        returnToPhase: returnPhase,
      });
      // targetIndex - 1 because the for loop's i++ will increment to the target
      return {
        completion: { kind: "loopback", phases, targetIndex: returnIndex - 1 },
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
      ctx.taskEngine.updateTaskField(taskId, "phase", Phases.execution);
      return {
        completion: { kind: "loopback", phases, targetIndex: loopbackResult.targetIndex - 1 },
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
  if (deps.preemption.isRequested() && nextPhase) {
    const preemptingId = deps.preemption.getPayload()?.preempting_task_id ?? "unknown";
    deps.preemption.reset();
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

  // ── Restore return_to_phase from prior blocked dispatch ──────────────
  // When return_to_phase is set, always start at requirements_gathering (index 0).
  // Requirements_gathering reads the response, decides if satisfied, and the
  // returnToPhase routing sends it back to the right phase.
  const task = ctx.taskEngine.getTask(taskId);
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

    // Clean outreach directory at requirements_gathering start so stale files aren't re-sent
    if (phase === Phases.requirements_gathering) {
      const wt = ctx.workspaceManager.getWorktreePath(taskId);
      if (wt && currentState.thoughtsDir) {
        const outreachDir = path.join(
          wt,
          currentState.thoughtsDir,
          PHASE_DIRECTORIES[0],
          "outreach",
        );
        if (existsSync(outreachDir)) {
          rmSync(outreachDir, { recursive: true, force: true });
        }
      }
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
      currentState = {
        ...currentState,
        loopbackCount: result.loopbackCount,
        requirementsLoopCount: result.requirementsLoopCount,
        returnToPhase: result.returnToPhase,
      };
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
