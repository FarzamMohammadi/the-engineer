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
import { type PhaseDefinition, Phases } from "./types.js";

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
 * `pipeline/` mirror these phases; the files within mirror the sub-phases. Delivery joins
 * the map in the next session.
 *
 * Review lists every lens; the opt-in lenses skip themselves when not enabled in
 * `review.lenses`, so the default run is `self-review → refine`. `refine` consolidates the
 * lenses' findings, fixes in place, and either ships, loops (capped), or hands back.
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
];
