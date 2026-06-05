import { ObservationTypes } from "../../../schemas/observer.js";
import { CheckpointReasons, JournalEntryTypes } from "../../../schemas/session-memory.js";
import { traceScope } from "./observability.js";
import {
  BlockCategories,
  type BlockCategory,
  type BlockDetail,
  type Carry,
  type Ctx,
  DecisionsSchema,
  type Phase,
  type PhaseDefinition,
  type RoutableResult,
  type Route,
  type SubPhaseResult,
  type SurfacedDecision,
} from "./types.js";

// ── Outcome & Position ───────────────────────────────────────────────────────

/** The terminal outcome of a pipeline run. Failures and waits both surface as `blocked`. */
export type RunnerOutcome = { readonly kind: "completed" } | { readonly kind: "blocked"; readonly detail: BlockDetail };

/** Position in the pipeline: which phase, which sub-phase within it. */
export interface Cursor {
  readonly phaseIndex: number;
  readonly subIndex: number;
}

/**
 * Where a resumed dispatch picks up. The cursor restores the position; the two counters restore the
 * iteration guards so a task that keeps getting preempted mid-loop still trips its cap. Absent on a
 * fresh dispatch — the runner starts at the first sub-phase with both counters at zero.
 *
 * `carry` seeds the first sub-phase's context. A preempt-resume leaves it undefined (re-running the
 * checkpointed sub-phase reproduces the flow); an external PR-event re-entry sets it to the rework
 * reason so the re-entered phase opens by addressing what came back, via the normal carry rendering.
 */
export interface ResumeState {
  readonly cursor: Cursor;
  readonly phaseIteration: number;
  readonly totalReworks: number;
  readonly carry?: Carry;
}

/** Thrown when a `next` function returns a structurally invalid route (a bug in the sub-phase). */
export class InvalidRouteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRouteError";
  }
}

/**
 * Generous global backstop on backward `jump`s within one dispatch. Catches cross-phase
 * oscillation (refine → execution → refine → …) that a per-phase cap cannot see.
 */
const MAX_TOTAL_REWORKS = 20;

/**
 * Absolute step ceiling — pure insurance against a cap-logic bug spinning the daemon.
 * The real bounds are the per-phase `maxIterations` and {@link MAX_TOTAL_REWORKS}; this
 * sits far above any legitimate pipeline and only ever trips on a programming error.
 */
const MAX_STEPS = 10_000;

// ── The Runner ───────────────────────────────────────────────────────────────

/**
 * Drive a task through a declared pipeline. Holds the cursor, calls skip → run → next on
 * each sub-phase, interprets the route, enforces the iteration caps, checkpoints after
 * each sub-phase, and emits every piece of observability. It knows nothing about any
 * specific phase — it drives whatever the pipeline declares.
 *
 * Returns `completed` or `blocked`. A failed sub-phase auto-blocks (every failure blocks,
 * by construction). An aborted dispatch (preemption, shutdown, cost limit) re-throws so the
 * caller can checkpoint-and-resume; a thrown orchestrator step that is *not* an abort
 * becomes a `blocked(orchestrator_error)`.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the routing decision is extracted to the pure planRoute; what remains is a cohesive cursor state machine (skip, run, emit, apply) that does not decompose without fragmenting the cursor and counters across functions.
export async function runPipeline(
  pipeline: readonly PhaseDefinition[],
  ctx: Ctx,
  resume?: ResumeState,
): Promise<RunnerOutcome> {
  let cursor = resume?.cursor ?? { phaseIndex: 0, subIndex: 0 };
  let phaseIteration = resume?.phaseIteration ?? 0;
  let totalReworks = resume?.totalReworks ?? 0;
  let carry: Ctx["carry"] = resume?.carry;

  emitPhaseEnter(ctx, phaseAt(pipeline, cursor).phase);

  for (let step = 0; step < MAX_STEPS; step += 1) {
    const phaseDef = phaseAt(pipeline, cursor);
    const subPhase = phaseDef.subPhases[cursor.subIndex];
    if (!subPhase) {
      throw new InvalidRouteError(`Cursor ${cursor.phaseIndex}:${cursor.subIndex} is out of range`);
    }

    // ── skip ──
    const skipReason = subPhase.skip?.(ctx) ?? null;
    if (skipReason !== null) {
      emitSkip(ctx, phaseDef.phase, subPhase.name, skipReason);
      const moved = nextPosition(pipeline, cursor);
      if (!moved) {
        return emitCompleted(ctx, phaseDef.phase);
      }
      cursor = moved.cursor;
      // carry is deliberately NOT cleared here: a repeat/jump seeds carry for the phase's first
      // sub-phase, and if that sub-phase skips (e.g. an opt-in lens disabled in config) the carry
      // must still reach the first sub-phase that actually runs. A run consuming it is what clears it.
      if (moved.enteredNewPhase) {
        phaseIteration = 0;
        emitPhaseEnter(ctx, phaseAt(pipeline, cursor).phase);
      }
      continue;
    }

    // ── run ──
    emitSubPhaseStart(ctx, phaseDef.phase, subPhase.name);
    persistTaskPosition(ctx, phaseDef.phase, subPhase.name, phaseIteration, totalReworks);
    let result: SubPhaseResult;
    try {
      result = await subPhase.run({ ...ctx, currentPhase: phaseDef.phase, ...(carry ? { carry } : {}) });
    } catch (error) {
      if (ctx.signal?.aborted) {
        throw error; // preemption / shutdown / cost-limit — the caller checkpoints and resumes
      }
      // An unexpected throw (not an abort) is a real failure, not a decided block — record it with its
      // stack so the dashboard's error view shows what crashed and where, then block loud and recoverable.
      ctx.observer.recordError(
        error,
        { operation: `sub_phase:${subPhase.name}`, component: "orchestrator" },
        undefined,
        traceScope(ctx, phaseDef.phase),
      );
      const detail = error instanceof Error ? error.message : String(error);
      return emitBlock(ctx, phaseDef.phase, {
        category: BlockCategories.orchestrator_error,
        sub_phase: subPhase.name,
        needed: detail,
      });
    }
    emitSubPhaseResult(ctx, phaseDef.phase, subPhase.name, result);
    writeCheckpoint(ctx, phaseDef.phase, subPhase.name, phaseIteration, totalReworks, result);

    // ── auto-block on failure (every failure blocks, by construction) ──
    if (result.outcome === "failed") {
      return emitBlock(ctx, phaseDef.phase, {
        category: result.category,
        sub_phase: subPhase.name,
        needed: result.detail,
      });
    }

    // ── autonomy escalation: consult the owner's policy per surfaced decision ──
    // An effect (it records the verdict observation), so it lives here in the loop rather than in the
    // pure next(): a sub-phase cannot forget to be consulted. An ask_human verdict turns the agent's
    // quiet "I decided X" into a stop-and-ask before the work proceeds; otherwise routing continues.
    const ask = consultDecisions(ctx, phaseDef.phase, subPhase.name, result);
    if (ask) {
      return emitBlock(ctx, phaseDef.phase, ask);
    }

    // ── route (ok | needs_human): plan purely, then apply and emit ──
    const route = subPhase.next(result, ctx);
    emitRouteDecision(ctx, phaseDef.phase, subPhase.name, result, route);
    const plan = planRoute(route, cursor, pipeline, phaseIteration, totalReworks, subPhase.name);

    if (plan.loop) {
      emitLoop(ctx, phaseDef.phase, plan.loop.kind, plan.loop.count);
    }
    if (plan.kind === "complete") {
      return emitCompleted(ctx, phaseDef.phase);
    }
    if (plan.kind === "block") {
      return emitBlock(ctx, phaseDef.phase, plan.detail);
    }
    if (plan.enteredNewPhase) {
      emitPhaseEnter(ctx, phaseAt(pipeline, plan.cursor).phase);
    }
    cursor = plan.cursor;
    phaseIteration = plan.phaseIteration;
    totalReworks = plan.totalReworks;
    carry = plan.carry;
  }

  throw new InvalidRouteError(`Pipeline exceeded ${String(MAX_STEPS)} steps without terminating — cap logic is broken`);
}

// ── Pure Helpers ─────────────────────────────────────────────────────────────

/** The phase definition at a cursor. Throws on an out-of-range cursor (an invariant violation). */
function phaseAt(pipeline: readonly PhaseDefinition[], cursor: Cursor): PhaseDefinition {
  const phaseDef = pipeline[cursor.phaseIndex];
  if (!phaseDef) {
    throw new InvalidRouteError(`Cursor phase index ${String(cursor.phaseIndex)} is out of range`);
  }
  return phaseDef;
}

/** Index of a phase by name, or -1 if the pipeline does not declare it. */
function phaseIndexOf(pipeline: readonly PhaseDefinition[], phase: Phase): number {
  return pipeline.findIndex((p) => p.phase === phase);
}

/**
 * The position after one `advance`: the next sub-phase, or the first sub-phase of the next
 * phase, or null when the last sub-phase of the last phase is done. `enteredNewPhase` tells
 * the caller to reset the iteration counter and emit a phase-enter.
 */
function nextPosition(
  pipeline: readonly PhaseDefinition[],
  cursor: Cursor,
): { readonly cursor: Cursor; readonly enteredNewPhase: boolean } | null {
  const phaseDef = phaseAt(pipeline, cursor);
  if (cursor.subIndex + 1 < phaseDef.subPhases.length) {
    return { cursor: { phaseIndex: cursor.phaseIndex, subIndex: cursor.subIndex + 1 }, enteredNewPhase: false };
  }
  if (cursor.phaseIndex + 1 < pipeline.length) {
    return { cursor: { phaseIndex: cursor.phaseIndex + 1, subIndex: 0 }, enteredNewPhase: true };
  }
  return null;
}

/** A loop increment the runner records when a route repeats or jumps. */
interface LoopEmit {
  readonly kind: "repeat" | "jump";
  readonly count: number;
}

/** The pure plan for a route: complete the task, block it, or move the cursor. */
type RoutePlan =
  | { readonly kind: "complete"; readonly loop?: LoopEmit }
  | { readonly kind: "block"; readonly detail: BlockDetail; readonly loop?: LoopEmit }
  | {
      readonly kind: "move";
      readonly cursor: Cursor;
      readonly phaseIteration: number;
      readonly totalReworks: number;
      readonly carry: Carry | undefined;
      readonly enteredNewPhase: boolean;
      readonly loop?: LoopEmit;
    };

/**
 * Decide where a route leads — purely, with no effects. Reads the route and the loop state
 * and returns the next cursor and counters, a block, or completion, plus any loop increment
 * for the runner to record. This is the FCIS core of the routing logic, unit-tested directly.
 */
function planRoute(
  route: Route,
  cursor: Cursor,
  pipeline: readonly PhaseDefinition[],
  phaseIteration: number,
  totalReworks: number,
  subPhase: string,
): RoutePlan {
  switch (route.go) {
    case "done":
      return { kind: "complete" };
    case "block":
      return { kind: "block", detail: { category: route.category, sub_phase: subPhase, needed: route.needed } };
    case "advance": {
      const moved = nextPosition(pipeline, cursor);
      if (!moved) {
        return { kind: "complete" };
      }
      return {
        kind: "move",
        cursor: moved.cursor,
        phaseIteration: moved.enteredNewPhase ? 0 : phaseIteration,
        totalReworks,
        carry: undefined,
        enteredNewPhase: moved.enteredNewPhase,
      };
    }
    case "repeat": {
      const phaseDef = phaseAt(pipeline, cursor);
      const count = phaseIteration + 1;
      const loop: LoopEmit = { kind: "repeat", count };
      if (count > phaseDef.maxIterations) {
        const needed = `${phaseDef.phase} did not converge within ${String(phaseDef.maxIterations)} iterations — inspect why`;
        return {
          kind: "block",
          detail: { category: BlockCategories.iteration_cap_hit, sub_phase: subPhase, needed },
          loop,
        };
      }
      return {
        kind: "move",
        cursor: { phaseIndex: cursor.phaseIndex, subIndex: 0 },
        phaseIteration: count,
        totalReworks,
        carry: route.carry,
        enteredNewPhase: false,
        loop,
      };
    }
    case "jump": {
      const target = phaseIndexOf(pipeline, route.to);
      if (target < 0) {
        throw new InvalidRouteError(`Cannot jump to unknown phase "${route.to}"`);
      }
      if (target === cursor.phaseIndex) {
        throw new InvalidRouteError(`Cannot jump to the current phase "${route.to}" — use repeat`);
      }
      const count = totalReworks + 1;
      const loop: LoopEmit = { kind: "jump", count };
      if (count > MAX_TOTAL_REWORKS) {
        const needed = `dispatch exceeded ${String(MAX_TOTAL_REWORKS)} cross-phase reworks — inspect why`;
        return {
          kind: "block",
          detail: { category: BlockCategories.iteration_cap_hit, sub_phase: subPhase, needed },
          loop,
        };
      }
      return {
        kind: "move",
        cursor: { phaseIndex: target, subIndex: 0 },
        phaseIteration: 0,
        totalReworks: count,
        carry: route.carry,
        enteredNewPhase: true,
        loop,
      };
    }
    default: {
      const exhaustive: never = route;
      throw new InvalidRouteError(`Unhandled route: ${JSON.stringify(exhaustive)}`);
    }
  }
}

// ── Effects: position ────────────────────────────────────────────────────────

/**
 * Checkpoint after a sub-phase so a crash or preempt resumes at the right cursor with its caps intact.
 * Position and counters ride in their own typed columns; `phase_progress` is the human one-liner.
 */
function writeCheckpoint(
  ctx: Ctx,
  phase: Phase,
  subPhase: string,
  phaseIteration: number,
  totalReworks: number,
  result: SubPhaseResult,
): void {
  ctx.sessionMemory.checkpoints.create({
    sessionId: ctx.sessionId,
    taskId: ctx.task.id,
    phase,
    subPhase,
    phaseIteration,
    totalReworks,
    phaseProgress: `${phase}/${subPhase}`,
    contextSummary: result.summary,
    keyFindings: [],
    openQuestions: [],
    nextAction: `After ${phase}/${subPhase}`,
    lastEventId: "",
    workspaceRef: null,
    reason: CheckpointReasons.phase_transition,
    journalOffset: 0,
  });
}

/**
 * Mirror the live position onto the task row so `engineer status` and the dashboard see where a task
 * is without reading its checkpoints. The checkpoint is the resume source of truth; this is the
 * queryable snapshot. Written at each sub-phase start, so an active task reflects what is running now.
 */
function persistTaskPosition(
  ctx: Ctx,
  phase: Phase,
  subPhase: string,
  phaseIteration: number,
  totalReworks: number,
): void {
  ctx.taskEngine.updateTaskField(ctx.task.id, "phase", phase);
  ctx.taskEngine.updateTaskField(ctx.task.id, "sub_phase", subPhase);
  ctx.taskEngine.updateTaskField(ctx.task.id, "phase_iteration", phaseIteration);
  ctx.taskEngine.updateTaskField(ctx.task.id, "total_reworks", totalReworks);
}

// ── Effects: autonomy escalation ─────────────────────────────────────────────

/**
 * Consult the owner's autonomy policy for every discretionary decision the sub-phase surfaced in
 * `result.data.decisions`. The safety layer records each verdict as an `autonomy_policy` decision
 * nested in the dispatch trace (via the threaded scope). On the FIRST escalated verdict, returns the
 * block detail that turns the agent's quiet decision into a stop-and-ask (the orchestrator delivers
 * the synthesized question and the owner's reply re-enters the asking sub-phase on resume); returns
 * null when there are no decisions or the policy lets the agent decide every one.
 *
 * No-owner edge: if the policy escalates but no owner is configured, blocking would strand the task
 * forever with no one to answer. So the runner proceeds autonomously instead and records a loud,
 * sub-full-confidence decision naming exactly what was decided without the owner. The `getOwner()`
 * check lives HERE in the runner — the safety layer stays owner-agnostic (it only judges the policy).
 */
function consultDecisions(ctx: Ctx, phase: Phase, subPhase: string, result: SubPhaseResult): BlockDetail | null {
  const decisions = readSurfacedDecisions(result);
  if (decisions.length === 0) {
    return null;
  }
  const repo = ctx.task.repo ?? "";
  const hasOwner = ctx.peopleDirectory.getOwner() !== null;
  for (const decision of decisions) {
    const verdict = ctx.safetyLayer.consultJudgment({
      type: "should_i_ask",
      context: {
        task_id: ctx.task.id,
        repo,
        decision_category: decision.category,
        details: decision.details ?? {},
      },
      trace: traceScope(ctx, phase),
    });
    // `proceed` is the only verdict that lets the agent decide alone. Anything else — ask_human from the
    // policy, or a deny from a malformed consult — would normally fail safe to asking the owner rather
    // than slipping a discretionary decision through unseen.
    if (verdict.action === "proceed") {
      continue;
    }
    // No owner to ask: do not strand the task. Proceed with the agent's call and record it loudly so the
    // owner (whenever one is configured) can see exactly what was decided in their absence.
    if (!hasOwner) {
      recordOwnerlessProceed(ctx, phase, decision, verdict.reason);
      continue;
    }
    // The category is `awaiting_human_decision`, distinct from a sub-phase's `awaiting_human` (stuck,
    // needs info): only the OWNER can resolve a discretionary call they asked to confirm, so the daemon
    // must NOT later self-unblock it (see health-monitor's exemption).
    return {
      category: BlockCategories.awaiting_human_decision,
      sub_phase: subPhase,
      needed: synthesizeQuestion(decision),
    };
  }
  return null;
}

/**
 * Record that the engine made a discretionary call WITHOUT the owner, because the policy escalated it
 * but no owner is configured to ask. A warn-level, sub-full-confidence decision — the road not taken is
 * "block and ask the owner", which was impossible here — so the trail shows the autonomy that was
 * exercised in the owner's absence rather than hiding it as a silent proceed.
 */
function recordOwnerlessProceed(ctx: Ctx, phase: Phase, decision: SurfacedDecision, policyReason: string): void {
  ctx.observer.warn("Proceeding on a discretionary decision with no owner to ask", {
    taskId: ctx.task.id,
    phase,
    category: decision.category,
    chosen: decision.chosen,
  });
  ctx.observer.recordDecision(
    "autonomy_no_owner",
    `The autonomy policy asks to confirm a "${decision.category}" decision, but no owner is configured: ${policyReason}`,
    [
      {
        id: "proceed_without_owner",
        description: "Proceed with the agent's call — no owner to ask, do not strand the task",
      },
      { id: "block_and_ask", description: "Block and ask the owner (not possible — no owner configured)" },
    ],
    "proceed_without_owner",
    `${decision.summary} Proceeding with "${decision.chosen}" (${decision.reasoning}) without owner confirmation — configure an owner to be consulted on these.`,
    0.5,
    { ...traceScope(ctx, phase), level: "warn" },
  );
}

/** Pull the validated surfaced-decision array off an `ok` result's data; empty for any other outcome. */
function readSurfacedDecisions(result: SubPhaseResult): readonly SurfacedDecision[] {
  if (result.outcome !== "ok" || result.data?.["decisions"] === undefined) {
    return [];
  }
  // agent-step.mapResult already validated this against DecisionsSchema; re-parse to recover the type
  // (a failure here would mean the contract drifted between validation and read — treat as none).
  const parsed = DecisionsSchema.safeParse(result.data["decisions"]);
  return parsed.success ? parsed.data : [];
}

/** Turn a surfaced decision into the question the owner is asked when the policy escalates it. */
function synthesizeQuestion(decision: SurfacedDecision): string {
  return `${decision.summary} I chose "${decision.chosen}" because ${decision.reasoning}. This is a "${decision.category}" decision your autonomy policy asks me to confirm — proceed with this choice, or tell me what to do instead?`;
}

// ── Effects: observability ───────────────────────────────────────────────────
// Every transition flows through here, so a sub-phase cannot forget to emit. Each event
// lands in the journal (durable narrative) and the observation store (dashboard); routing
// and skip choices are recorded as decisions with their alternatives. The {task, session,
// trace, phase} correlation scope is built by the shared `traceScope` (observability.ts), so
// these runner emissions and every sub-phase's own observations stitch together on the dashboard.

function emitPhaseEnter(ctx: Ctx, phase: Phase): void {
  ctx.observer.info("Phase entered", { taskId: ctx.task.id, phase });
  ctx.observer.observe(ObservationTypes.phase_transition, "phase_entered", { phase }, traceScope(ctx, phase));
  ctx.sessionMemory.journal.addEntry({
    sessionId: ctx.sessionId,
    taskId: ctx.task.id,
    phase,
    type: JournalEntryTypes.phase_change,
    summary: `Entered ${phase}`,
    tags: ["phase_enter"],
  });
}

function emitSubPhaseStart(ctx: Ctx, phase: Phase, subPhase: string): void {
  ctx.observer.debug("Sub-phase starting", { taskId: ctx.task.id, phase, subPhase });
  ctx.observer.observe(
    ObservationTypes.phase_transition,
    "sub_phase_started",
    { phase, subPhase },
    traceScope(ctx, phase),
  );
}

function emitSubPhaseResult(ctx: Ctx, phase: Phase, subPhase: string, result: SubPhaseResult): void {
  // Carry the sub-phase's typed `data` (refine's verdict, verify's gate result, the merge disposition)
  // into the observation so the dashboard sees the structured outcome, not only the prose summary.
  const data = result.outcome === "ok" ? result.data : undefined;
  ctx.observer.info("Sub-phase result", { taskId: ctx.task.id, phase, subPhase, outcome: result.outcome });
  ctx.observer.observe(
    ObservationTypes.phase_transition,
    "sub_phase_result",
    { phase, subPhase, outcome: result.outcome, summary: result.summary, ...(data ? { data } : {}) },
    traceScope(ctx, phase),
  );
}

const SKIP_OPTIONS = [
  { id: "run", description: "Run this sub-phase" },
  { id: "skip", description: "Skip this sub-phase entirely" },
] as const;

function emitSkip(ctx: Ctx, phase: Phase, subPhase: string, reason: string): void {
  ctx.observer.recordDecision(
    `skip:${subPhase}`,
    `${phase}/${subPhase}`,
    SKIP_OPTIONS,
    "skip",
    reason,
    1,
    traceScope(ctx, phase),
  );
  ctx.sessionMemory.journal.addEntry({
    sessionId: ctx.sessionId,
    taskId: ctx.task.id,
    phase,
    type: JournalEntryTypes.phase_change,
    summary: `Skipped ${subPhase}: ${reason}`,
    tags: ["skip", subPhase],
  });
}

const ROUTE_OPTIONS = [
  { id: "advance", description: "Move to the next sub-phase or phase" },
  { id: "repeat", description: "Loop this phase from its start" },
  { id: "jump", description: "Hand control back to an earlier phase" },
  { id: "block", description: "Stop, loud and operator-recoverable" },
  { id: "done", description: "Complete the task" },
] as const;

function emitRouteDecision(ctx: Ctx, phase: Phase, subPhase: string, result: RoutableResult, route: Route): void {
  ctx.observer.recordDecision(
    `route:${subPhase}`,
    `${phase}/${subPhase} reported "${result.outcome}"`,
    ROUTE_OPTIONS,
    route.go,
    result.summary,
    1,
    traceScope(ctx, phase),
  );
  ctx.sessionMemory.journal.addEntry({
    sessionId: ctx.sessionId,
    taskId: ctx.task.id,
    phase,
    type: JournalEntryTypes.phase_change,
    summary: `${subPhase} → ${route.go}`,
    detail: result.summary,
    tags: ["route", route.go],
  });
}

function emitLoop(ctx: Ctx, phase: Phase, kind: "repeat" | "jump", count: number): void {
  ctx.observer.info("Pipeline loop", { taskId: ctx.task.id, phase, kind, count });
  ctx.observer.observe(ObservationTypes.decision_point, `loop_${kind}`, { phase, count }, traceScope(ctx, phase));
  ctx.sessionMemory.journal.addEntry({
    sessionId: ctx.sessionId,
    taskId: ctx.task.id,
    phase,
    type: JournalEntryTypes.phase_change,
    summary: `${kind} (count ${String(count)})`,
    tags: ["loop", kind],
  });
}

/**
 * The severity a block deserves, from its cause. Expected waits (a person, a PR event) are lifecycle
 * `info` — not a problem, just paused; an over-cap loop is a `warn` red flag worth a look; an actual
 * failure (no result, invalid details, agent failed/unavailable, an orchestrator throw) is an `error`
 * the owner must act on. Mirrors the schema's failure-vs-wait split and the §12 level rules, so a PR
 * sitting in review never false-alarms and a real failure is never buried at warn.
 */
function blockLogLevel(category: BlockCategory): "info" | "warn" | "error" {
  if (
    category === BlockCategories.awaiting_human ||
    category === BlockCategories.awaiting_human_decision ||
    category === BlockCategories.awaiting_pr_review
  ) {
    return "info";
  }
  if (category === BlockCategories.iteration_cap_hit || category === BlockCategories.pr_rework_cap_hit) {
    return "warn";
  }
  return "error";
}

function emitBlock(ctx: Ctx, phase: Phase, detail: BlockDetail): RunnerOutcome {
  const level = blockLogLevel(detail.category);
  const logData = { taskId: ctx.task.id, ...detail };
  if (level === "info") {
    ctx.observer.info("Task blocked", logData);
  } else if (level === "warn") {
    ctx.observer.warn("Task blocked", logData);
  } else {
    ctx.observer.error("Task blocked", logData);
  }
  ctx.observer.observe(
    ObservationTypes.state_transition,
    "task_blocked",
    { ...detail },
    { ...traceScope(ctx, phase), level },
  );
  ctx.sessionMemory.journal.addEntry({
    sessionId: ctx.sessionId,
    taskId: ctx.task.id,
    phase,
    type: JournalEntryTypes.checkpoint_marker,
    summary: `Blocked at ${detail.sub_phase}: ${detail.category}`,
    detail: detail.needed,
    tags: ["block", detail.category],
  });
  return { kind: "blocked", detail };
}

function emitCompleted(ctx: Ctx, phase: Phase): RunnerOutcome {
  ctx.observer.info("Pipeline completed", { taskId: ctx.task.id, phase });
  ctx.observer.observe(ObservationTypes.lifecycle, "pipeline_completed", { phase }, traceScope(ctx, phase));
  ctx.sessionMemory.journal.addEntry({
    sessionId: ctx.sessionId,
    taskId: ctx.task.id,
    phase,
    type: JournalEntryTypes.phase_change,
    summary: "Pipeline completed",
    tags: ["complete"],
  });
  return { kind: "completed" };
}
