import path from "node:path";
import { ulid } from "ulid";
import type { AgentAdapter } from "../../adapters/agent.js";
import { AdapterTypes, type AgentRunResult } from "../../schemas/adapters.js";
import type { Dispatch } from "../../schemas/ephemeral.js";
import {
  CommMessageSentPayloadSchema,
  CostIncurredPayloadSchema,
  EventTypes,
  GitPrMergedPayloadSchema,
} from "../../schemas/events.js";
import type { PrEventType } from "../../schemas/git-hosting-event-types.js";
import {
  type NotificationCorrelation,
  NotificationKinds,
  correlationFromTraceScope,
} from "../../schemas/notifications.js";
import { ObservationTypes } from "../../schemas/observer.js";
import { type SessionEndReason, SessionEndReasons } from "../../schemas/session-memory.js";
import {
  ActionClasses,
  BlockCategories,
  type BlockCategory,
  type BlockReason,
  BlockReasons,
  type BlockedDetails,
  type Task,
  TaskStates,
} from "../../schemas/task.js";
import { sanitizeErrorMessage, sanitizeSecrets } from "../../utils/sanitize.js";
import type { EventDeclaration } from "../event-bus/topology.js";
import type { ObservationSpan } from "../observer/index.js";
import { emitAgentCost } from "./agent-cost.js";
import { deliverBlockedQuestion } from "./outreach.js";
import { traceScope } from "./pipeline/observability.js";
import { PIPELINE } from "./pipeline/pipeline.js";
import { entryFor, reentryCarry } from "./pipeline/pr-events.js";
import { type Cursor, type ResumeState, type RunnerOutcome, runPipeline } from "./pipeline/runner.js";
import type { BlockDetail, Carry, Ctx, SubPhase } from "./pipeline/types.js";
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
  {
    type: EventTypes["git.pr_merged"],
    description: "Emitted when auto-merge records a task's pull request as merged (self- or external-merge)",
    payloadSchema: GitPrMergedPayloadSchema,
    publishers: ["orchestrator"],
    subscribers: [],
  },
];

/** Bound a hung self-unblock diagnosis: abort the agent run after this long so a stuck diagnosis cannot wedge escalation. */
const SELF_UNBLOCK_TIMEOUT_MS = 300_000; // 5 minutes

// ── Block Reason Derivation ───────────────────────────────────────────────────

/**
 * Collapse the complete {@link BlockCategory} into the coarse {@link BlockReason} the daemon routes
 * on. The waits map one-to-one; an unavailable agent drives retry-policy backoff; every other failure
 * is a generic pipeline failure the owner must look at.
 *
 * Exported because this mapping is load-bearing for loop safety, not just an internal detail: a
 * pipeline block (e.g. delivery's host-blocked merge) chooses only a *category*, and it is this
 * function that decides which daemon poll set the task lands on. `awaiting_human → need_more_info` is
 * what keeps a host-blocked merge OFF the `pr_review_pending` PR-event poll set; were it ever to map
 * to `pr_review_pending`, the promote → doomed-merge → rework loop of issue #47 would silently return.
 * Exported so that link can be asserted directly instead of assumed.
 */
export function toBlockReason(category: BlockCategory): BlockReason {
  switch (category) {
    case BlockCategories.awaiting_pr_review:
      return BlockReasons.pr_review_pending;
    case BlockCategories.agent_unavailable:
      return BlockReasons.agent_unavailable;
    case BlockCategories.awaiting_human:
    case BlockCategories.awaiting_human_decision:
      return BlockReasons.need_more_info;
    default:
      return BlockReasons.pipeline_failed;
  }
}

/** Find a sub-phase across the whole pipeline by its name. Undefined when no phase declares it (a reshape). */
function findSubPhase(name: string): SubPhase | undefined {
  for (const phaseDef of PIPELINE) {
    const match = phaseDef.subPhases.find((sub) => sub.name === name);
    if (match) {
      return match;
    }
  }
  return undefined;
}

/**
 * The `outreach/` directory of the sub-phase that blocked, or null when it is not a known agent
 * sub-phase (an orchestrator sub-phase — verify, the delivery git/PR steps — writes no deliverable,
 * so it has no outreach directory). Resolved through the sub-phase's own `resultDir`, so the layout
 * (including review's nested `review/<lens>` directories) stays single-sourced with where the
 * sub-phase actually writes. Exported for direct unit testing, like `responseCarry`.
 */
export function outreachDirForSubPhase(ctx: Ctx, subPhaseName: string): string | null {
  const subPhase = findSubPhase(subPhaseName);
  if (!subPhase?.resultDir) {
    return null;
  }
  return path.join(subPhase.resultDir(ctx), "outreach");
}

/** Locate the pipeline cursor for a phase plus optional sub-phase name. Undefined when the pipeline no longer declares them (a reshape). */
function locateCursor(phase: string, subPhaseName: string | null): Cursor | undefined {
  const phaseIndex = PIPELINE.findIndex((definition) => definition.phase === phase);
  if (phaseIndex < 0) {
    return undefined;
  }
  const phaseDef = PIPELINE[phaseIndex];
  const subIndex = subPhaseName ? (phaseDef?.subPhases.findIndex((sub) => sub.name === subPhaseName) ?? -1) : 0;
  if (subIndex < 0) {
    return undefined;
  }
  return { phaseIndex, subIndex };
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
  const cursor = locateCursor(checkpoint.phase, checkpoint.sub_phase);
  if (!cursor) {
    return undefined;
  }
  return {
    cursor,
    phaseIteration: checkpoint.phase_iteration,
    totalReworks: checkpoint.total_reworks,
  };
}

/**
 * Resolve an external PR-event re-entry into a starting ResumeState. The pending event type maps
 * through {@link entryFor} to a fresh cursor (counters at zero — this is a new pass, not a mid-loop
 * resume) and seeds the carry with the rework reason. Undefined when the event no longer maps to a
 * declared sub-phase, so the caller logs and falls back rather than looping on a poison value.
 */
function resolveReentry(type: PrEventType, task: Task): ResumeState | undefined {
  const entry = entryFor(type);
  const cursor = locateCursor(entry.phase, entry.sub ?? null);
  if (!cursor) {
    return undefined;
  }
  return { cursor, phaseIteration: 0, totalReworks: 0, carry: reentryCarry(type, task) };
}

/**
 * The rework context a re-run opens with after the owner answered a question it raised — used for every
 * `pending_response` resume, whichever phase owns the ask: a requirements scope question, a research
 * `premise_conflict` reconfirm, or any later phase's discretionary decision. Phase-neutral wording so it
 * reads correctly wherever the question came from. Exported for direct unit testing, mirroring the
 * PR-event sibling `reentryCarry` in pr-events.ts.
 */
export function responseCarry(answer: string): Carry {
  return {
    summary: [
      "The owner answered the question(s) you raised. Their answer is authoritative: it defines the scope of this task. Do exactly what they asked and nothing more — it overrides any broader reading you might otherwise infer from the task title or from repo artifacts (asset specs, existing files). If the answer makes the task trivial, say so and scope it as trivial.",
      "",
      "Their answer:",
      answer,
    ].join("\n"),
  };
}

/**
 * The owner-facing pickup messages for a dispatch: "Starting" on a task's first run, "Continuing" on any
 * resume (an answered block, a PR rework, a crash-resume — every re-dispatch carries a `resume_from`
 * checkpoint). Exported for direct unit testing, like {@link responseCarry}.
 */
export function pickupMessages(title: string, isResume: boolean): { milestone: string; ticket: string } {
  const verb = isResume ? "Continuing" : "Starting";
  return { milestone: `${verb} work on: ${title}`, ticket: `${verb} work on this ticket.` };
}

/**
 * Resolve a pending human answer into a starting ResumeState. The answer rides the runner's carry into
 * the sub-phase that asked (the resume checkpoint — requirements/gather), so the re-run addresses the
 * answer instead of re-deriving scope from scratch. With no checkpoint (or a pipeline reshape), fall
 * back to a fresh run from the first sub-phase, still carrying the answer.
 */
function resolveResponse(answer: string, dispatch: Dispatch): ResumeState {
  const carry = responseCarry(answer);
  const resumed = resolveResume(dispatch);
  if (resumed) {
    return { ...resumed, carry };
  }
  return { cursor: { phaseIndex: 0, subIndex: 0 }, phaseIteration: 0, totalReworks: 0, carry };
}

// ── Orchestrator ────────────────────────────────────────────────────────────

/**
 * The brain of the system — drives a task through the sub-phase pipeline from intake to merged pull request.
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

    // Root span for the whole dispatch — the end-to-end "tracer bullet", chained to the prior dispatch's
    // trace for continuity. Opened BEFORE workspace setup so the setup belongs to the trace (see
    // openRootSpan). The pipeline spine (each phase entry and sub_phase_started) nests directly under it via
    // Ctx.rootObservationId; each run's own observations (agent run, gates, verdict, decisions) nest one level
    // deeper under their sub_phase_started via Ctx.subPhaseRunObsId — a two-level tree the observer can open as
    // one task's complete trace from intake to outcome, and that can later be exported whole.
    const rootSpan = this.openRootSpan(dispatch, tracedObserver, traceId, sessionId);

    // Workspace setup. A failure here (git, disk, auth) ends the root span as crashed and closes the
    // session before re-throwing so neither lingers open; the dispatch-tracker routes the throw to crash
    // recovery. The trace context nests the worktree_created observation under the root span.
    try {
      this.workspaceLifecycle.setupWorkspace(dispatch, { traceId, parentObservationId: rootSpan.id });
    } catch (workspaceError) {
      rootSpan.setError(workspaceError);
      rootSpan.end({ outcome: "crashed" });
      this.endSession(sessionId, SessionEndReasons.crashed, taskId);
      throw workspaceError;
    }

    // The pickup moment — the engine took this task and told the owner — is the first beat of the run, so it
    // anchors the trace under the root span rather than sitting outside it. The notification behavior is
    // unchanged; this only moves it inside the span and records the lifecycle observation alongside it.
    const pickupScope = {
      task_id: taskId,
      trace_id: traceId,
      session_id: sessionId,
      parent_observation_id: rootSpan.id,
    };
    const isResume = !!dispatch.resume_from;
    tracedObserver.observe(
      ObservationTypes.lifecycle,
      "task_picked_up",
      { title: dispatch.task.title, isResume },
      pickupScope,
    );
    // The pickup notification is emitted inside this dispatch — carry the same trace context as the
    // task_picked_up observation (no phase yet; the pipeline has not entered one) so its delivery
    // observation anchors to the task's trace rather than orphaning with an empty trace.
    this.notifyPickup(taskId, dispatch.task.title, isResume, correlationFromTraceScope(pickupScope));

    const ctx = this.buildContext(dispatch, tracedObserver, sessionId, traceId, rootSpan.id);
    const resume = this.resolveDispatchStart(dispatch, tracedObserver);

    let outcome: RunnerOutcome;
    try {
      outcome = await runPipeline(PIPELINE, ctx, resume);
    } catch (error) {
      rootSpan.setError(error);
      rootSpan.end({ outcome: dispatch.signal.aborted ? "aborted" : "crashed" });
      const reason = dispatch.signal.aborted ? SessionEndReasons.preempted : SessionEndReasons.crashed;
      this.endSession(sessionId, reason, taskId);
      throw error;
    }

    if (outcome.kind === "completed") {
      rootSpan.end({ outcome: "completed" });
      this.endSession(sessionId, SessionEndReasons.completed, taskId);
      return { outcome: Outcomes.completed };
    }
    rootSpan.end({ outcome: "blocked", category: outcome.detail.category, sub_phase: outcome.detail.sub_phase });
    return this.blockTask(ctx, sessionId, outcome.detail);
  }

  // ── Dispatch Helpers ────────────────────────────────────────────────────────

  /**
   * Open the dispatch's root `task_execution` span and advance the task's trace lineage.
   *
   * Trace continuity: each dispatch is its OWN bounded trace — a single task-long trace would be
   * dominated by idle blocked-waits (a task can sit awaiting PR review for days) and useless as a flame
   * graph, with no single open root surviving a daemon restart. So when a prior dispatch ran (a resume,
   * rework, or PR-event re-entry) we link this root back to that dispatch's root via an OTLP span link,
   * chaining the lifecycle without merging it. We then record THIS root as the task's lineage head — one
   * atomic {trace_id, observation_id} value — so the NEXT dispatch links back to it. It is set even for a
   * crashed/blocked dispatch, because that dispatch is a valid predecessor for the resume that follows.
   */
  private openRootSpan(
    dispatch: Dispatch,
    observer: OrchestratorContext["observer"],
    traceId: string,
    sessionId: string,
  ): ObservationSpan {
    const taskId = dispatch.task.id;
    const priorLink = dispatch.task.last_trace_link;
    const rootSpan = observer.startSpan(
      ObservationTypes.task_execution,
      "execute_task",
      { taskId, title: dispatch.task.title, isResume: !!dispatch.resume_from },
      {
        task_id: taskId,
        trace_id: traceId,
        session_id: sessionId,
        ...(priorLink ? { links: [priorLink] } : {}),
      },
    );
    // Advance the lineage head only when tracing produced a real anchor. With no observation store
    // attached (a no-op span), `id` is empty — recording it would persist a degenerate link the exporter
    // could never resolve. A null lineage simply means the next dispatch starts a fresh (unlinked) chain.
    if (rootSpan.id) {
      this.ctx.taskEngine.updateTaskField(taskId, "last_trace_link", {
        trace_id: traceId,
        observation_id: rootSpan.id,
      });
    }
    return rootSpan;
  }

  /** Assemble the per-dispatch context the pipeline runs on from the shared context plus this run's state. */
  private buildContext(
    dispatch: Dispatch,
    observer: OrchestratorContext["observer"],
    sessionId: string,
    traceId: string,
    rootObservationId: string,
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
      rootObservationId,
      // No sub-phase run is open at dispatch start; the runner stamps this per sub-phase (see Ctx.subPhaseRunObsId).
      subPhaseRunObsId: undefined,
      ...(dispatch.signal ? { signal: dispatch.signal } : {}),
    };
  }

  /**
   * Decide where this dispatch starts. A pending human answer or external PR event takes precedence over
   * a resume checkpoint — each is a fresh re-entry, not a mid-loop continuation — and is consumed (cleared)
   * on read so it fires exactly once. A human answer (the owner replied to a question the task raised)
   * re-enters where it asked, carrying the answer; a PR event re-enters via entryFor. The two are mutually
   * exclusive in practice (a task awaiting a human is never simultaneously awaiting PR review), but the
   * answer is checked first since it is the one a person is actively waiting on. With neither pending, fall
   * back to the resume checkpoint (then a fresh run).
   */
  private resolveDispatchStart(dispatch: Dispatch, observer: OrchestratorContext["observer"]): ResumeState | undefined {
    const answer = dispatch.task.pending_response;
    if (answer) {
      this.ctx.taskEngine.updateTaskField(dispatch.task.id, "pending_response", null);
      observer.info("Re-entering pipeline with the owner's answer", { taskId: dispatch.task.id });
      return resolveResponse(answer, dispatch);
    }

    const pending = dispatch.task.pending_pr_event;
    if (!pending) {
      return resolveResume(dispatch);
    }
    this.ctx.taskEngine.updateTaskField(dispatch.task.id, "pending_pr_event", null);
    const reentry = resolveReentry(pending, dispatch.task);
    if (!reentry) {
      observer.warn("Pending PR event does not map to a pipeline entry — resuming normally", {
        taskId: dispatch.task.id,
        event: pending,
      });
      return resolveResume(dispatch);
    }
    observer.info("Re-entering pipeline from PR event", {
      taskId: dispatch.task.id,
      event: pending,
      entryPhase: PIPELINE[reentry.cursor.phaseIndex]?.phase ?? null,
    });
    return reentry;
  }

  /** Tell the owner work has started — or resumed — on their channels and on the source ticket. */
  private notifyPickup(taskId: string, title: string, isResume: boolean, correlation: NotificationCorrelation): void {
    const messages = pickupMessages(title, isResume);
    this.ctx.notifications.notify({
      kind: NotificationKinds.milestone,
      taskId,
      message: messages.milestone,
      correlation,
    });
    this.ctx.notifications.notify({
      kind: NotificationKinds.ticket_comment,
      taskId,
      message: messages.ticket,
      correlation,
    });
  }

  /** Transition a blocked task: deliver its question uniformly to every surface, then persist the payload. */
  private blockTask(ctx: Ctx, sessionId: string, detail: BlockDetail): ExecuteTaskResult {
    const reason = toBlockReason(detail.category);
    // A human wait — a sub-phase's `needs_human` or the autonomy policy's escalated decision — resolves to
    // ONE canonical question, delivered to the owner's chat and the source ticket, and persisted as `needed`
    // so the dashboard renders the same text. The outreach directory is the blocking sub-phase's own (not
    // just requirements'), so a question from any phase delivers; resolving from it consumes the files, so a
    // later block cannot re-send a stale ask. Any non-human block carries its `needed` unchanged.
    const isHumanWait =
      detail.category === BlockCategories.awaiting_human || detail.category === BlockCategories.awaiting_human_decision;
    const hasWorktree = !!(ctx.worktreePath && ctx.thoughtsDir);
    const needed = isHumanWait
      ? deliverBlockedQuestion(
          {
            peopleDirectory: this.ctx.peopleDirectory,
            notifications: this.ctx.notifications,
            observer: ctx.observer,
          },
          {
            taskId: ctx.task.id,
            subPhase: detail.sub_phase,
            outreachDir: hasWorktree ? outreachDirForSubPhase(ctx, detail.sub_phase) : null,
            needed: detail.needed,
            // The question is emitted inside this dispatch — carry its trace context so the delivery
            // observation lands on the task's timeline instead of orphaned with an empty trace/phase.
            correlation: correlationFromTraceScope(traceScope(ctx)),
          },
        )
      : detail.needed;
    this.ctx.taskEngine.requestTransition(ctx.task.id, TaskStates.blocked, null, detail.category, "orchestrator");
    this.ctx.taskEngine.updateTaskField(ctx.task.id, "blocked", {
      reason,
      category: detail.category,
      sub_phase: detail.sub_phase,
      needed,
    } satisfies BlockedDetails);
    this.endSession(sessionId, SessionEndReasons.blocked, ctx.task.id);
    return { outcome: Outcomes.blocked, phase: detail.sub_phase, reason };
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

    // No dispatch owns this call (the task is blocked, not running), so bound it with a local
    // AbortController + timeout — that signal threads into the agent spawn (slice-8 signal honoring),
    // so a hung diagnosis SIGTERMs the child instead of wedging escalation.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SELF_UNBLOCK_TIMEOUT_MS);
    try {
      const pipelineResult = await this.ctx.actionPipeline.execute<AgentRunResult>({
        taskId,
        actionClass: ActionClasses.read,
        details: { operation: "self_unblock_diagnosis" },
        requestedBy: "orchestrator",
        executeFn: () =>
          agent.run({ prompt, system_prompt: null, cwd: null, trace_output_path: null, signal: controller.signal }),
      });
      if (pipelineResult.outcome !== "executed") {
        return false;
      }
      emitAgentCost(this.ctx.eventBus, this.ctx.taskEngine, {
        taskId,
        repo: this.ctx.taskEngine.getTask(taskId)?.repo ?? "",
        providerId: agent.manifest.id,
        operation: "self_unblock",
        result: pipelineResult.result,
      });
      const parsed = JSON.parse(pipelineResult.result.content) as { can_resolve?: boolean; action?: string };
      const canResolve = parsed.can_resolve === true;
      // This is a real autonomy fork — resume a blocked task on its own, or leave it escalated to the owner.
      // Record it as a decision (not a log line) so the road not taken stays inspectable, with the agent's
      // own reasoning carried in.
      this.ctx.observer.recordDecision(
        "self_unblock_diagnosis",
        `Blocked task "${task.title}" (${task.blocked?.reason ?? "unknown"})`,
        [
          { id: "auto_resolve", description: "Engine believes the block is self-resolvable and will resume it" },
          { id: "escalate", description: "Leave the task blocked for the owner" },
        ],
        canResolve ? "auto_resolve" : "escalate",
        parsed.action ?? "no reasoning given",
        1,
        { task_id: taskId },
      );
      return canResolve;
    } catch (error) {
      this.ctx.observer.warn("Self-unblock failed", { taskId, error: sanitizeErrorMessage(error) });
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }
}
