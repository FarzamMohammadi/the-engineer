import { type PrEvent, type PrEventType, PrEventTypes } from "../../../schemas/git-hosting-events.js";
import { autoMerge } from "./delivery/auto-merge.js";
import { awaitReview } from "./delivery/await-review.js";
import { createPr } from "./delivery/create-pr.js";
import { prDescription } from "./delivery/pr-description.js";
import { push } from "./delivery/push.js";
import { implement } from "./execution/implement.js";
import { verify } from "./execution/verify.js";
import { design } from "./planning/design.js";
import { gather } from "./requirements/gather.js";
import { investigate } from "./research/investigate.js";
import { architecture } from "./review/architecture.js";
import { codeQuality } from "./review/code-quality.js";
import { refine } from "./review/refine.js";
import { security } from "./review/security.js";
import { selfReview } from "./review/self-review.js";
import { type Entry, type PhaseDefinition, Phases } from "./types.js";

// ── Iteration Caps ───────────────────────────────────────────────────────────

/**
 * Execution's verify gate may bounce back to `implement` this many times before the
 * runner blocks with `iteration_cap_hit`. Four implement attempts to get the project's
 * gates green; if it still cannot, something deeper than the code is wrong.
 */
const EXECUTION_MAX_ITERATIONS = 3;

/**
 * Review's refine loop may `repeat` this many times — fixing in place and re-checking —
 * before the runner blocks with `iteration_cap_hit`. If review cannot converge in three
 * passes, something deeper than the code is wrong and the operator should look.
 */
const REVIEW_MAX_ITERATIONS = 3;

/** Single-pass phases never `repeat` — their cap is inert and set to the minimum. */
const SINGLE_PASS = 1;

// ── The Pipeline ─────────────────────────────────────────────────────────────

/**
 * The phase order and each phase's sub-phases — the map the runner drives. Folders under
 * `pipeline/` mirror these phases; the files within mirror the sub-phases. This is the full
 * upstream-to-delivery shape; the runner drives whatever this map declares.
 *
 * Review lists every lens; the opt-in lenses skip themselves when not enabled in
 * `review.lenses`, so the default run is `self-review → refine`. `refine` consolidates the
 * lenses' findings, fixes in place, and either ships, loops (capped), or hands back.
 *
 * Delivery's shape is config-driven: in PR mode the full sequence runs and parks at
 * `await-review`; in push-only mode every PR-specific sub-phase skips, leaving just `push`.
 * `auto-merge` is entry-only — the advance path blocks at `await-review` before reaching it;
 * it runs only when an external `pr_ready_to_merge` event re-enters the task there.
 */
export const PIPELINE: readonly PhaseDefinition[] = [
  { phase: Phases.requirements, subPhases: [gather], maxIterations: SINGLE_PASS },
  { phase: Phases.research, subPhases: [investigate], maxIterations: SINGLE_PASS },
  { phase: Phases.planning, subPhases: [design], maxIterations: SINGLE_PASS },
  { phase: Phases.execution, subPhases: [implement, verify], maxIterations: EXECUTION_MAX_ITERATIONS },
  {
    phase: Phases.review,
    subPhases: [selfReview, security, codeQuality, architecture, refine],
    maxIterations: REVIEW_MAX_ITERATIONS,
  },
  {
    phase: Phases.delivery,
    subPhases: [prDescription, push, createPr, awaitReview, autoMerge],
    maxIterations: SINGLE_PASS,
  },
];

// ── External Re-entry ──────────────────────────────────────────────────────────
//
// How an external PR event becomes pipeline work. Events never call into the
// orchestrator through a back channel — the daemon arbitrates a single winner,
// writes it onto the task, and re-queues; on re-dispatch the pipeline starts at
// entryFor's target. arbitrate and entryFor are pure Core policy, unit-tested
// directly; the daemon wiring that calls them lands at the external re-entry session.

/**
 * Where each external PR event re-enters the pipeline. Comments may surface new scope, so they
 * re-enter at requirements (the trivial-skip gates forward as needed); CI failures and merge
 * conflicts re-enter at execution to fix; a ready-to-merge or already-merged event re-enters at
 * delivery's entry-only `auto-merge`.
 */
export function entryFor(event: PrEvent): Entry {
  switch (event.type) {
    case PrEventTypes.pr_comments:
      return { phase: Phases.requirements };
    case PrEventTypes.pr_ci_failure:
      return { phase: Phases.execution, sub: implement.name };
    case PrEventTypes.pr_merge_conflict:
      return { phase: Phases.execution, sub: implement.name };
    case PrEventTypes.pr_ready_to_merge:
      return { phase: Phases.delivery, sub: autoMerge.name };
    case PrEventTypes.pr_merged:
      return { phase: Phases.delivery, sub: autoMerge.name };
    default: {
      const exhaustive: never = event.type;
      throw new Error(`Unhandled PR event type "${String(exhaustive)}"`);
    }
  }
}

/**
 * Precedence over PR events that land in the same poll, highest first. A merge is terminal and
 * wins outright; otherwise reviewer feedback and the blockers (conflict, CI) are addressed before
 * a ready-to-merge is acted on, so a simultaneous approval never skips pending feedback.
 */
const PR_EVENT_PRECEDENCE: readonly PrEventType[] = [
  PrEventTypes.pr_merged,
  PrEventTypes.pr_comments,
  PrEventTypes.pr_merge_conflict,
  PrEventTypes.pr_ci_failure,
  PrEventTypes.pr_ready_to_merge,
];

/** Pick the single event to act on when several arrive in one poll, by precedence. Null when none do. */
export function arbitrate(events: readonly PrEvent[]): PrEvent | null {
  for (const type of PR_EVENT_PRECEDENCE) {
    const winner = events.find((event) => event.type === type);
    if (winner) {
      return winner;
    }
  }
  return null;
}
