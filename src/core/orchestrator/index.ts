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
import { SessionEndReasons } from "../../schemas/session-memory.js";
import { ActionClasses, TaskStates } from "../../schemas/task.js";
import type { EventDeclaration } from "../event-bus/topology.js";
import { type AndonCord, createAndonCord } from "./andon-cord.js";
import { type DecompositionHandler, createDecompositionHandler } from "./decomposition-handler.js";
import { type LlmCaller, createLlmCaller } from "./llm-caller.js";
import { createPhaseHandlers } from "./phase-handlers.js";
import {
  type PhaseHandlerRegistry,
  createPhaseHandlerRegistry,
  runPhasePipeline,
} from "./phase-runner.js";
import { type PrManager, createPrManager } from "./pr-manager.js";
import { gatherRepoContextSafe } from "./prompts/index.js";
import type {
  ExecuteTaskResult,
  OrchestratorContext,
  PipelineState,
  PreemptionGate,
} from "./types.js";
import {
  type OrchestratorNotifier,
  type WorkspaceLifecycle,
  createWorkspaceLifecycle,
} from "./workspace-lifecycle.js";

// ── Re-exports ──────────────────────────────────────────────────────────────
// Only the types actually consumed by external modules (daemon, bootstrap).

export type { ExecuteTaskResult, Outcome } from "./types.js";
export { Outcomes } from "./types.js";

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

// ── PreemptionGate Factory ────────────────────────────────────────────────

/** Create a PreemptionGate — cooperative preemption state container (Protocol P8). */
function createPreemptionGate(): PreemptionGate & {
  request(payload: { target_task_id: string; preempting_task_id: string }): void;
} {
  let requested = false;
  let payload: { target_task_id: string; preempting_task_id: string } | null = null;
  return {
    isRequested: () => requested,
    getPayload: () => payload,
    reset() {
      requested = false;
      payload = null;
    },
    request(p) {
      requested = true;
      payload = p;
    },
  };
}

// ── Orchestrator ────────────────────────────────────────────────────────────

/**
 * The brain of the system — a 7-phase pipeline that takes a task from intake
 * to integration.
 *
 * Derives from compiler front-end (multi-pass pipeline) + flight director
 * (coordination and communication). Delegates to focused subsystems:
 * - LlmCaller: LLM invocation, retry, cost, validation
 * - WorkspaceLifecycle: workspace setup, session management
 * - OrchestratorNotifier: milestone notifications, issue comments
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
  private readonly workspaceLifecycle: WorkspaceLifecycle;
  private readonly notifier: OrchestratorNotifier;
  private readonly prManager: PrManager;
  private readonly decompositionHandler: DecompositionHandler;
  private readonly andonCord: AndonCord;
  private readonly preemption: ReturnType<typeof createPreemptionGate>;

  /** Phase handler dispatch map — one method per phase. */
  private readonly phaseHandlers: PhaseHandlerRegistry;

  constructor(ctx: OrchestratorContext) {
    this.ctx = ctx;

    // Create subsystems
    this.llmCaller = createLlmCaller(this.ctx);
    const wsl = createWorkspaceLifecycle(this.ctx);
    this.workspaceLifecycle = wsl;
    this.notifier = wsl;
    this.prManager = createPrManager(this.ctx, this.notifier);
    this.decompositionHandler = createDecompositionHandler(this.ctx, this.notifier);
    this.andonCord = createAndonCord();

    // Cooperative preemption state (Protocol P8)
    this.preemption = createPreemptionGate();
    this.ctx.eventBus.subscribe(
      "orchestrator",
      EventTypes["preemption.requested"],
      (event: Event) => {
        const p = event.payload as {
          target_task_id: string;
          preempting_task_id: string;
        };
        this.preemption.request(p);
      },
    );

    // Build phase handler registry from extracted phase-handlers module
    this.phaseHandlers = createPhaseHandlerRegistry(createPhaseHandlers(this.llmCaller));
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
    const isResume = !!dispatch.resume_from;
    const isRework = (dispatch.task.review?.feedback_rounds ?? []).some((r) => !r.applied) ?? false;

    this.ctx.observer.info("Task execution starting", {
      taskId,
      traceId,
      title: dispatch.task.title,
      isResume,
      resumeFromPhase: dispatch.resume_from?.phase ?? null,
      isRework,
    });

    // ── Session setup ──────────────────────────────────────────────────────
    const session = this.workspaceLifecycle.createSession(dispatch);
    const sessionId = session.id;
    this.ctx.taskEngine.updateTaskField(taskId, "session_id", sessionId);
    this.ctx.observer.debug("Session created", { taskId, traceId, sessionId });

    // ── Workspace setup (D144) ──────────────────────────────────────────
    // If workspace creation fails (git failure, disk full, auth error), close the
    // session before re-throwing so it doesn't remain open indefinitely.
    try {
      this.workspaceLifecycle.setupWorkspace(dispatch);
    } catch (workspaceError) {
      this.ctx.sessionMemory.endSession(sessionId, SessionEndReasons.crashed);
      throw workspaceError;
    }

    // Notify task pickup (D152) — personal channels + GitHub issue comment
    this.notifier.notifyMilestone(dispatch, `Starting work on: ${dispatch.task.title}`);
    this.notifier.commentOnSourceIssue(dispatch, "Starting work on this issue.");

    // ── Build pipeline state ───────────────────────────────────────────────
    // Gather repo context once — avoids 5 sync I/O ops × 7 phases per task.
    // Re-gathered after execution phase (the only phase that modifies files).
    const worktreePath = this.ctx.workspaceManager.getWorktreePath(taskId);
    const repoContext = gatherRepoContextSafe(worktreePath, this.ctx.observer);

    const state: PipelineState = {
      traceId,
      sessionId,
      loopbackCount: 0,
      repoContext,
    };

    // ── Run phase pipeline ─────────────────────────────────────────────────
    return runPhasePipeline(dispatch, state, {
      ctx: this.ctx,
      handlers: this.phaseHandlers,
      prManager: this.prManager,
      decompositionHandler: this.decompositionHandler,
      andonCord: this.andonCord,
      preemption: this.preemption,
    });
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

    this.ctx.observer.info("Attempting self-unblock", {
      taskId,
      blockedReason: task.blocked?.reason ?? "unknown",
    });

    const llm = this.ctx.registry.getPrimaryPlugin<LLMAdapter>(AdapterTypes.llm);
    if (!llm) {
      return false;
    }

    const journalEntries = this.ctx.sessionMemory.queryJournal(taskId);
    const recentEntries = journalEntries.slice(-5);
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
      const canResolve = parsed.can_resolve === true;
      this.ctx.observer.info("Self-unblock diagnosis result", { taskId, canResolve });
      return canResolve;
    } catch (err) {
      this.ctx.observer.warn("Self-unblock failed", {
        taskId,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }
}
