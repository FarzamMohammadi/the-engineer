import { implement } from "./execution/implement.js";
import { verify } from "./execution/verify.js";
import { design } from "./planning/design.js";
import { gather } from "./requirements/gather.js";
import { investigate } from "./research/investigate.js";
import { type PhaseDefinition, PipelinePhaseSchema } from "./types.js";

// ── Phase Vocabulary ─────────────────────────────────────────────────────────

/** Constant values for the pipeline phases. Use instead of raw strings. */
export const Phases = PipelinePhaseSchema.enum;

// ── Iteration Caps ───────────────────────────────────────────────────────────

/**
 * Execution's verify gate may bounce back to `implement` this many times before the
 * runner blocks with `iteration_cap_hit`. Four implement attempts to get the project's
 * gates green; if it still cannot, something deeper than the code is wrong.
 */
const EXECUTION_MAX_ITERATIONS = 3;

/** Single-pass phases never `repeat` — their cap is inert and set to the minimum. */
const SINGLE_PASS = 1;

// ── The Pipeline ─────────────────────────────────────────────────────────────

/**
 * The phase order and each phase's sub-phases — the map the runner drives. Folders under
 * `pipeline/` mirror these phases; the files within mirror the sub-phases. This is the
 * upstream of the pipeline; review and delivery join in the next session.
 */
export const PIPELINE: readonly PhaseDefinition[] = [
  { phase: Phases.requirements, subPhases: [gather], maxIterations: SINGLE_PASS },
  { phase: Phases.research, subPhases: [investigate], maxIterations: SINGLE_PASS },
  { phase: Phases.planning, subPhases: [design], maxIterations: SINGLE_PASS },
  { phase: Phases.execution, subPhases: [implement, verify], maxIterations: EXECUTION_MAX_ITERATIONS },
];
