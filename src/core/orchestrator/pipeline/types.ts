import { z } from "zod";

import { BlockCategories, type BlockCategory, type Task } from "../../../schemas/task.js";
import type { OrchestratorContext } from "../types.js";

// Re-exported so the pipeline's internal sub-phases and runner name the block vocabulary through
// `./types.js` while its single source of truth lives in the task schema, next to the coarse BlockReason.
export { BlockCategories, type BlockCategory };

// ── Phases ───────────────────────────────────────────────────────────────────

/**
 * The six pipeline phases, in order. The folders under `pipeline/` mirror these
 * names exactly — the folder tree *is* the pipeline.
 *
 * These are the post-rename names. During the build-dark window they coexist with
 * the legacy `PhaseSchema` (old names) in `schemas/orchestrator.ts`; the legacy enum
 * is deleted at the Session 5 cutover, leaving this as the canonical vocabulary.
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
