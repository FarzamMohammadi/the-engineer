import { ReviewLensNames } from "../../../../schemas/config.js";
import { ARCHITECTURE_INSTRUCTIONS, ARCHITECTURE_ROLE } from "../../prompts/pipeline/review/index.js";
import { type LensSpec, lens } from "./lens.js";

// ── Architecture Lens (opt-in) ─────────────────────────────────────────────────

const SPEC: LensSpec = {
  name: ReviewLensNames.architecture,
  role: ARCHITECTURE_ROLE,
  instructions: ARCHITECTURE_INSTRUCTIONS,
};

/** Review: the opt-in architecture lens — Plugin Opacity, boundaries, fail-loud, isolation, one-way doors. */
export const architecture = lens(SPEC);
