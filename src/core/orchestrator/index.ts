import path from "node:path";
import { ulid } from "ulid";
import type { AgentAdapter } from "../../adapters/agent.js";
import { AdapterTypes, type AgentRunResult } from "../../schemas/adapters.js";
import type { Dispatch } from "../../schemas/ephemeral.js";
import { CommMessageSentPayloadSchema, CostIncurredPayloadSchema, EventTypes } from "../../schemas/events.js";
import { NotificationKinds } from "../../schemas/notifications.js";
import { type SessionEndReason, SessionEndReasons } from "../../schemas/session-memory.js";
import {
  ActionClasses,
  BlockCategories,
  type BlockCategory,
  type BlockReason,
  BlockReasons,
  type BlockedDetails,
  TaskStates,
} from "../../schemas/task.js";
import { sanitizeErrorMessage, sanitizeSecrets } from "../../utils/sanitize.js";
import type { EventDeclaration } from "../event-bus/topology.js";
import type { PublishInput } from "../interfaces/event-bus.interface.js";
import { sendOutreach } from "./outreach-sender.js";
import { PIPELINE } from "./pipeline/pipeline.js";
import { type ResumeState, type RunnerOutcome, runPipeline } from "./pipeline/runner.js";
import type { BlockDetail, Ctx } from "./pipeline/types.js";
import { type ExecuteTaskResult, type OrchestratorContext, Outcomes } from "./types.js";
import { type WorkspaceLifecycle, createWorkspaceLifecycle } from "./workspace-lifecycle.js";

// ── Re-exports ──────────────────────────────────────────────────────────────
// Only the types actually consumed by external modules (daemon, bootstrap).

export type { ExecuteTaskResult, Outcome } from "./types.js";
export { Outcomes } from "./types.js";

// ── Event Declarations ──────────────────────────────────────────────────────

export const EVENTS: EventDeclaration[] = [
  {
    type: EventTypes["cost.incurred"],
    description: "Emitted after each agent run with token/cost details",
    payloadSchema: CostIncurredPayloadSchema,
    publishers: ["orchestrator"],
    subscribers: [],
  },
  {
    type: EventTypes["comm.message_sent"],
    description: "Emitted when a notification is sent to a communication channel",
    payloadSchema: CommMessageSentPayloadSchema,
    publishers: ["orchestrator"],
    subscribers: [],
  },
];

// ── Block Reason Derivation ───────────────────────────────────────────────────

/**
 * Collapse the complete {@link BlockCategory} into the coarse {@link BlockReason} the daemon routes
 * on. The waits map one-to-one; an unavailable agent drives retry-policy backoff; every other failure
 * is a generic pipeline failure the owner must look at.
 */
function toBlockReason(category: BlockCategory): BlockReason {
  switch (category) {
    case BlockCategories.awaiting_pr_review:
      return BlockReasons.pr_review_pending;
    case BlockCategories.agent_unavailable:
      return BlockReasons.agent_unavailable;
    case BlockCategories.awaiting_human:
      return BlockReasons.need_more_info;
    default:
      return BlockReasons.pipeline_failed;
  }
}

/**
 * Resolve where a resumed dispatch picks up. The latest checkpoint names the sub-phase that ran and
 * its counters; the runner re-runs from there, so re-applying its route reproduces the original flow.
 * An unknown phase/sub-phase (a pipeline reshape) falls back to a fresh run.
 */
function resolveResume(dispatch: Dispatch): ResumeState | undefined {
  const checkpoint = dispatch.resume_from;
  if (!checkpoint) {
    return undefined;
  }
  const phaseIndex = PIPELINE.findIndex((definition) => definition.phase === checkpoint.phase);
  if (phaseIndex < 0) {
    return undefined;
  }
  const phaseDef = PIPELINE[phaseIndex];
  const subIndex = checkpoint.sub_phase
    ? (phaseDef?.subPhases.findIndex((sub) => sub.name === checkpoint.sub_phase) ?? -1)
    : 0;
  if (subIndex < 0) {
    return undefined;
  }
  return {
    cursor: { phaseIndex, subIndex },
    phaseIteration: checkpoint.phase_iteration,
    totalReworks: checkpoint.total_reworks,
  };
}

// ── Orchestrator ────────────────────────────────────────────────────────────

/**
 * The brain of the system — drives a task through the sub-phase pipeline from intake to delivery.
 *
 * It sets up the session and workspace, assembles the per-dispatch {@link Ctx}, runs {@link PIPELINE}
 * through the generic runner, and maps the runner's outcome onto the daemon's {@link ExecuteTaskResult}.
 * The runner owns the pipeline logic and observability; the Orchestrator owns the task-state writes
 * (block, complete) the runner deliberately does not perform.
 */
export class Orchestrator {
  private readonly ctx: OrchestratorContext;
  private readonly workspaceLifecycle: WorkspaceLifecycle;

  constructor(ctx: OrchestratorContext) {
    this.ctx = ctx;
    this.workspaceLifecycle = createWorkspaceLifecycle(this.ctx);
    // Sync portable skills to {workspace_root}/skills/ before any sub-phase resolves their paths.
    this.ctx.skillsManager.sync();
  }

  /**
   * Execute a task through the pipeline. Entry point called by the daemon for new and resumed tasks.
   * Returns `completed` or `blocked`; a preemption/shutdown aborts the in-flight agent and re-throws so
   * the dispatch-tracker routes the termination; a genuine crash re-throws to crash recovery.
   */
  async executeTask(dispatch: Dispatch): Promise<ExecuteTaskResult> {
    const taskId = dispatch.task.id;
    const traceId = ulid();
    const tracedObserver = this.ctx.observer.withTrace(traceId);
    tracedObserver.info("Task execution starting", {
      taskId,
      title: dispatch.task.title,
      isResume: !!dispatch.resume_from,
      resumeFromPhase: dispatch.resume_from?.phase ?? null,
    });

    const session = this.workspaceLifecycle.createSession(dispatch);
    const sessionId = session.id;
    this.ctx.taskEngine.updateTaskField(taskId, "session_id", sessionId);

    // Workspace setup. A failure here (git, disk, auth) closes the session before re-throwing so it
    // does not linger open; the dispatch-tracker routes the throw to crash recovery.
    try {
      this.workspaceLifecycle.setupWorkspace(dispatch);
    } catch (workspaceError) {
      this.endSession(sessionId, SessionEndReasons.crashed, taskId);
      throw workspaceError;
    }

    this.notifyPickup(taskId, dispatch.task.title);

    const ctx = this.buildContext(dispatch, tracedObserver, sessionId, traceId);

    let outcome: RunnerOutcome;
    try {
      outcome = await runPipeline(PIPELINE, ctx, resolveResume(dispatch));
    } catch (error) {
      const reason = dispatch.signal.aborted ? SessionEndReasons.preempted : SessionEndReasons.crashed;
      this.endSession(sessionId, reason, taskId);
      throw error;
    }

    if (outcome.kind === "completed") {
      this.endSession(sessionId, SessionEndReasons.completed, taskId);
      return { outcome: Outcomes.completed };
    }
    return this.blockTask(ctx, sessionId, outcome.detail);
  }

  // ── Dispatch Helpers ────────────────────────────────────────────────────────

  /** Assemble the per-dispatch context the pipeline runs on from the shared context plus this run's state. */
  private buildContext(
    dispatch: Dispatch,
    observer: OrchestratorContext["observer"],
    sessionId: string,
    traceId: string,
  ): Ctx {
    const taskId = dispatch.task.id;
    const worktreePath = this.ctx.workspaceManager.getWorktreePath(taskId);
    const record = this.ctx.workspaceManager.getWorkspaceRecord(taskId);
    return {
      ...this.ctx,
      observer,
      task: dispatch.task,
      sessionId,
      traceId,
      worktreePath,
      thoughtsDir: record?.thoughtsDir ?? null,
      ...(dispatch.signal ? { signal: dispatch.signal } : {}),
    };
  }

  /** Tell the owner work has started, on their channels and on the source ticket. */
  private notifyPickup(taskId: string, title: string): void {
    this.ctx.notifications.notify({
      kind: NotificationKinds.milestone,
      taskId,
      message: `Starting work on: ${title}`,
    });
    this.ctx.notifications.notify({
      kind: NotificationKinds.ticket_comment,
      taskId,
      message: "Starting work on this ticket.",
    });
  }

  /** Transition a blocked task, persist the typed block payload, and deliver any pending outreach. */
  private async blockTask(ctx: Ctx, sessionId: string, detail: BlockDetail): Promise<ExecuteTaskResult> {
    const reason = toBlockReason(detail.category);
    if (detail.category === BlockCategories.awaiting_human) {
      await this.deliverOutreach(ctx);
    }
    this.ctx.taskEngine.requestTransition(ctx.task.id, TaskStates.blocked, null, detail.category, "orchestrator");
    this.ctx.taskEngine.updateTaskField(ctx.task.id, "blocked", {
      reason,
      category: detail.category,
      sub_phase: detail.sub_phase,
      needed: detail.needed,
    } satisfies BlockedDetails);
    this.endSession(sessionId, SessionEndReasons.blocked, ctx.task.id);
    return { outcome: Outcomes.blocked, phase: detail.sub_phase, reason };
  }

  /** Deliver the questions the requirements phase wrote to its outreach directory, if any. */
  private async deliverOutreach(ctx: Ctx): Promise<void> {
    if (!(ctx.worktreePath && ctx.thoughtsDir)) {
      return;
    }
    const outreachDir = path.join(ctx.worktreePath, ctx.thoughtsDir, "requirements", "outreach");
    const result = await sendOutreach(ctx.task.id, outreachDir, ctx.task.external_ref, {
      peopleDirectory: this.ctx.peopleDirectory,
      notifications: this.ctx.notifications,
      eventBus: this.ctx.eventBus,
      observer: ctx.observer,
    });
    if (!result.delivered) {
      ctx.observer.warn("Task blocked on a human, but no outreach was delivered", {
        taskId: ctx.task.id,
        reason: result.reason,
      });
    }
  }

  /** Close a session, never letting a close failure swallow the outcome that earned it. */
  private endSession(sessionId: string, reason: SessionEndReason, taskId: string): void {
    try {
      this.ctx.sessionMemory.sessions.end(sessionId, reason);
    } catch (error) {
      this.ctx.observer.error("Failed to close session", {
        taskId,
        sessionId,
        error: sanitizeErrorMessage(error),
      });
    }
  }

  // ── Self-Unblock ──────────────────────────────────────────────────────────

  /**
   * Attempt to self-diagnose and resolve a blocked task. Called by the daemon during blocked-timeout
   * escalation. Returns `true` if the block looks auto-resolvable, `false` otherwise.
   */
  async attemptSelfUnblock(taskId: string): Promise<boolean> {
    const task = this.ctx.taskEngine.getTask(taskId);
    if (!task || task.state !== TaskStates.blocked) {
      return false;
    }
    const agent = this.ctx.registry.getPrimaryPlugin<AgentAdapter>(AdapterTypes.agent);
    if (!agent) {
      return false;
    }

    this.ctx.observer.info("Attempting self-unblock", { taskId, blockedReason: task.blocked?.reason ?? "unknown" });

    const recentEntries = this.ctx.sessionMemory.journal.query(taskId).slice(-5);
    const prompt = sanitizeSecrets(
      [
        "A task is blocked and needs diagnosis.",
        `Task: "${task.title}"`,
        `Blocked reason: ${task.blocked?.reason ?? "unknown"}`,
        `Recent activity: ${JSON.stringify(recentEntries.map((entry) => ({ type: entry.type, summary: entry.summary })))}`,
        "",
        "Can this be automatically resolved? Respond with JSON:",
        '{ "can_resolve": boolean, "action": "description of resolution or why not" }',
      ].join("\n"),
    );

    try {
      const pipelineResult = await this.ctx.actionPipeline.execute<AgentRunResult>({
        taskId,
        actionClass: ActionClasses.read,
        details: { operation: "self_unblock_diagnosis" },
        requestedBy: "orchestrator",
        executeFn: () => agent.run({ prompt, system_prompt: null, cwd: null, trace_output_path: null }),
      });
      if (pipelineResult.outcome !== "executed") {
        return false;
      }
      this.emitCost(taskId, agent, pipelineResult.result, "self_unblock");
      const parsed = JSON.parse(pipelineResult.result.content) as { can_resolve?: boolean };
      const canResolve = parsed.can_resolve === true;
      this.ctx.observer.info("Self-unblock diagnosis result", { taskId, canResolve });
      return canResolve;
    } catch (error) {
      this.ctx.observer.warn("Self-unblock failed", { taskId, error: sanitizeErrorMessage(error) });
      return false;
    }
  }

  /** Emit cost.incurred for an agent run, carrying the real plugin id (Session 37 handoff). */
  private emitCost(taskId: string, agent: AgentAdapter, result: AgentRunResult, operation: string): void {
    const repo = this.ctx.taskEngine.getTask(taskId)?.repo ?? "";
    const usage = result.usage;
    this.ctx.eventBus.publish({
      type: "cost.incurred",
      source: "orchestrator",
      task_id: taskId,
      payload: {
        task_id: taskId,
        repo,
        provider_id: agent.manifest.id,
        operation,
        spend_usd: result.cost_usd,
        duration_ms: result.duration_ms,
        input_tokens: usage?.tokens.input_tokens ?? null,
        output_tokens: usage?.tokens.output_tokens ?? null,
        total_tokens: usage?.tokens.total_tokens ?? null,
        cache_read_tokens: usage?.tokens.cache_read_tokens ?? null,
        model_id: usage?.model_id ?? null,
      },
    } satisfies PublishInput<"cost.incurred">);
    this.ctx.taskEngine.updateTracking(
      taskId,
      usage?.tokens.total_tokens ?? 0,
      result.cost_usd ?? 0,
      result.duration_ms,
    );
  }
}
