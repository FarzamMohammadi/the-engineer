import { z } from "zod";

import { BlockCategories, type BlockCategory, type Task } from "../../../schemas/task.js";
import type { OrchestratorContext } from "../types.js";

// Re-exported so the pipeline's internal sub-phases and runner name the block vocabulary through
// `./types.js` while its single source of truth lives in the task schema, next to the coarse BlockReason.
export { BlockCategories, type BlockCategory };

// ── Phases ───────────────────────────────────────────────────────────────────

/**
 * The six pipeline phases, in order — the canonical phase vocabulary. The folders under
 * `pipeline/` mirror these names exactly, so the folder tree *is* the pipeline.
 */
export const PipelinePhaseSchema = z.enum(["requirements", "research", "planning", "execution", "review", "delivery"]);
export type Phase = z.infer<typeof PipelinePhaseSchema>;

/** Constant values for the pipeline phases. Use instead of raw strings. */
export const Phases = PipelinePhaseSchema.enum;

// ── Block Vocabulary ─────────────────────────────────────────────────────────
// BlockCategory (the complete cause enum) and BlockCategories live in the task schema and are
// re-exported above. What stays here are the pipeline-internal derivations of it.

/**
 * The subset of {@link BlockCategory} a sub-phase's own `run` can report as a failure.
 * The remaining categories are synthesized by the runner (a thrown orchestrator step, an
 * over-cap repeat) or by routing (the waits), never returned by a sub-phase directly.
 */
export type FailureCause = Extract<
  BlockCategory,
  "no_result" | "details_invalid" | "agent_failed" | "agent_unavailable"
>;

/**
 * The typed payload describing why a task blocked. Assembled by the runner — every field
 * is always meaningful. `sub_phase` is stamped from the runner's cursor; `needed` is the
 * operator-facing next step.
 */
export type BlockDetail = {
  readonly category: BlockCategory;
  readonly sub_phase: string;
  readonly needed: string;
};

// ── Surfaced Decisions (autonomy escalation) ──────────────────────────────────

/**
 * One discretionary decision the agent made and surfaced for the autonomy policy to judge.
 * Generic across every phase — `category` keys the owner's `safety.yaml` autonomy policy
 * (free-form, e.g. `code_style`, `architecture`), and `details` carries any metric a
 * threshold rule reads (e.g. `{ files: 7 }`). The runner consults the policy per decision
 * after the sub-phase reports, so an `always_ask` category (or an exceeded threshold) turns
 * the agent's quiet "I decided X" into a stop-and-ask before the work proceeds.
 */
export const SurfacedDecisionSchema = z.object({
  category: z.string().min(1),
  summary: z.string().min(1),
  chosen: z.string().min(1),
  reasoning: z.string().min(1),
  details: z.record(z.unknown()).optional(),
});
export type SurfacedDecision = z.infer<typeof SurfacedDecisionSchema>;

/** The contract for the `details.decisions` array any agent sub-phase may surface. */
export const DecisionsSchema = z.array(SurfacedDecisionSchema);

// ── Results & Routing ────────────────────────────────────────────────────────

/**
 * What a sub-phase's `run` reports: it did the job (`ok`), it needs a person
 * (`needs_human`), or it could not finish (`failed`). The agent reports an *outcome*;
 * the route is the orchestrator's to decide. A `failed` result is the only one the
 * runner blocks on automatically.
 */
export type SubPhaseResult =
  | { readonly outcome: "ok"; readonly summary: string; readonly data?: Record<string, unknown> }
  | { readonly outcome: "needs_human"; readonly summary: string }
  | { readonly outcome: "failed"; readonly summary: string; readonly category: FailureCause; readonly detail: string };

/**
 * The results `next` routes. A `failed` result is auto-blocked by the runner and never
 * reaches `next`, so a routing function only ever reasons about `ok` and `needs_human`.
 */
export type RoutableResult = Exclude<SubPhaseResult, { readonly outcome: "failed" }>;

/** Context carried into a re-run when a phase repeats or the pipeline jumps back to it. */
export type Carry = {
  readonly summary: string;
  readonly data?: Record<string, unknown>;
};

/**
 * Where to go after a sub-phase. Returned by a sub-phase's `next`; interpreted by the
 * runner. `advance` moves to the next sub-phase (or next phase if last); `repeat` loops
 * this phase from its start (intra-phase, capped); `jump` hands back to an earlier phase
 * (inter-phase rework); `block` stops loud and operator-recoverable; `done` completes.
 */
export type Route =
  | { readonly go: "advance" }
  | { readonly go: "repeat"; readonly carry: Carry }
  | { readonly go: "jump"; readonly to: Phase; readonly carry: Carry }
  | { readonly go: "block"; readonly category: BlockCategory; readonly needed: string }
  | { readonly go: "done" };

// ── Context & SubPhase ───────────────────────────────────────────────────────

/** Why a sub-phase was skipped. Surfaced verbatim in the runner's skip observability. */
export type SkipReason = string;

/**
 * Everything a sub-phase needs: the shared orchestrator infrastructure plus this
 * dispatch's state. Grows as sub-phases land in later sessions; the runner and `agentStep`
 * read only a handful of fields (observer, session memory, registry, config, the signal).
 */
export interface Ctx extends OrchestratorContext {
  readonly task: Task;
  readonly sessionId: string;
  readonly traceId: string;
  /** Absolute worktree path for the task, or null when no workspace was created. */
  readonly worktreePath: string | null;
  /** thoughts/ directory (relative to the worktree), or null. Agent sub-phases write deliverables here. */
  readonly thoughtsDir: string | null;
  /** Abort signal for the whole dispatch. `agentStep` hands it to the agent spawn so termination is honored. */
  readonly signal?: AbortSignal;
  /** Present only when this step was reached by a `repeat` or `jump`: the context to address on the re-run. */
  readonly carry?: Carry;
  /**
   * The phase currently executing, injected by the runner before each sub-phase `run`. A sub-phase that
   * records its own observations reads this through {@link traceScope} so they correlate to the right phase
   * on the dashboard. Absent only when a sub-phase runs outside the runner (it has no live phase then).
   */
  readonly currentPhase?: Phase;
  /**
   * The id of the dispatch's root `task_execution` span, set by the orchestrator. The parent of the
   * spine observations only — each `sub_phase_started` and the bare `phase_entered` (via {@link traceScope}
   * when no run is open) — so they hang directly off the root. Absent when a sub-phase runs outside a
   * dispatch (e.g. a unit test driving it directly).
   */
  readonly rootObservationId?: string;
  /**
   * The id of the CURRENT sub-phase run's `sub_phase_started` observation — the per-run correlation id this
   * fix introduces. The runner stamps it the instant a sub-phase starts (the id `emitSubPhaseStart` returns)
   * and clears it the instant the next one does, so {@link traceScope} can parent every observation a run
   * emits afterward (the agent_call, the verify gates and verdict, the route:/loop_ decisions, the
   * sub_phase_result, an autonomy_policy verdict, the block) on that run's id. The result is a clean two-level
   * tree — dispatch root → each sub_phase_started → that run's observations — so the dashboard LOOKS UP a
   * run's enrichments by parentage instead of inferring ownership from a (phase, trace, time-window) guess.
   * Mutable (the one mutable field on Ctx) because it changes per sub-phase within a single dispatch context;
   * `undefined` before the first run starts and between runs (the runner clears it so the spine parents on the
   * root). Typed `string | undefined` rather than optional so the runner can assign `undefined` to reset it
   * under `exactOptionalPropertyTypes`.
   */
  subPhaseRunObsId: string | undefined;
}

/**
 * One step in a phase: how to do its work (`run`) and where to go next (`next`). An agent
 * sub-phase builds `run` from `agentStep(...)`; an orchestrator sub-phase writes a plain
 * async function. `next` is pure — it reads the result and returns a Route, nothing else.
 */
export interface SubPhase {
  readonly name: string;
  /** Optional: return a reason to skip this sub-phase entirely (config-disabled, trivial complexity, push-only mode). */
  readonly skip?: (ctx: Ctx) => SkipReason | null;
  /** Do the work. Agent sub-phases use the `agentStep` helper; orchestrator sub-phases write a plain async fn. */
  readonly run: (ctx: Ctx) => Promise<SubPhaseResult>;
  /** Read the result and return where to go. Pure, no effects. Only consulted for `ok`/`needs_human`. */
  readonly next: (result: RoutableResult, ctx: Ctx) => Route;
  /**
   * Where this sub-phase writes its deliverable and `session-result.json` — the same directory its
   * `agentStep` runs in. Set on every agent sub-phase; absent on orchestrator sub-phases (verify,
   * the delivery git/PR steps) that write no agent deliverable. The orchestrator resolves a blocking
   * sub-phase's `outreach/` directory from this when it blocks on a human, so a `needs_human` from ANY
   * phase delivers its questions — not just requirements (the one source of truth for "where its work lives").
   */
  readonly resultDir?: (ctx: Ctx) => string;
}

/**
 * A phase: an ordered list of sub-phases plus the cap on how many times it may `repeat`
 * before the runner converts an over-cap repeat into a `block`. The runner drives whatever
 * the pipeline declares — it never names a specific phase itself.
 */
export interface PhaseDefinition {
  readonly phase: Phase;
  readonly subPhases: readonly SubPhase[];
  /** Maximum `repeat` iterations for this phase before an over-cap repeat becomes a block. */
  readonly maxIterations: number;
  /**
   * Whether the runner consults the owner's autonomy policy on the discretionary decisions this
   * phase's sub-phases surface. Absent means yes — gating is the conservative default. Intent-forming
   * phases (requirements, research) set this `false`: there the agent is still understanding the task,
   * not making the implementation call the policy governs, so a decision it surfaces is premature — it
   * is recorded for the trail but never gated. The real call is consulted later, in the phase that
   * actually makes it. This is what stops requirements' deliberately ask-biased intake from re-surfacing
   * a settled choice on every resume and looping the owner.
   */
  readonly consultsDecisions?: boolean;
}

/**
 * Where an external PR event re-enters the pipeline: a phase, and optionally a specific
 * sub-phase within it. Produced by `entryFor`; the daemon re-entry wiring (a later session)
 * resolves it to a starting cursor and re-dispatches. `sub` omitted means "the phase's first
 * sub-phase".
 */
export interface Entry {
  readonly phase: Phase;
  readonly sub?: string;
}
