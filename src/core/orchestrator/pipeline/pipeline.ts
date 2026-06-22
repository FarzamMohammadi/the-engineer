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
import { PREMISE_CONFLICT_CATEGORY, type PhaseDefinition, Phases } from "./types.js";

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
  // Requirements and research form intent — they understand the task rather than make the discretionary
  // implementation calls the autonomy policy governs. So they do NOT gate on surfaced decisions: a
  // decision raised here is premature (the work it concerns has not happened yet) and is recorded for
  // the trail, not asked. The call is consulted later, in the phase that actually makes it. Without this,
  // requirements' deliberately ask-biased intake re-surfaces a settled choice every resume and loops the owner.
  //
  // The single exception is a `premise_conflict` (escalatedCategories below): when intake's own
  // investigation finds the task's premise wrong or already satisfied elsewhere, no later phase recovers
  // it — so the owner is asked proceed/redirect/drop once, before any build, rather than the agent
  // silently narrowing scope. The runner suppresses it on the answered resume, so it stays a one-time ask.
  {
    phase: Phases.requirements,
    subPhases: [gather],
    maxIterations: SINGLE_PASS,
    consultsDecisions: false,
    escalatedCategories: [PREMISE_CONFLICT_CATEGORY],
  },
  {
    phase: Phases.research,
    subPhases: [investigate],
    maxIterations: SINGLE_PASS,
    consultsDecisions: false,
    escalatedCategories: [PREMISE_CONFLICT_CATEGORY],
  },
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
