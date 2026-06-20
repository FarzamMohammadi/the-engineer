import { ReviewLensNames } from "../../../../schemas/config.js";
import { CODE_QUALITY_INSTRUCTIONS, CODE_QUALITY_ROLE } from "../../prompts/pipeline/review/index.js";
import { type LensSpec, lens } from "./lens.js";

// ── Code Quality Lens (opt-in) ─────────────────────────────────────────────────

const SPEC: LensSpec = {
  name: ReviewLensNames["code-quality"],
  role: CODE_QUALITY_ROLE,
  instructions: CODE_QUALITY_INSTRUCTIONS,
};

/** Review: the opt-in code-quality lens — naming, clarity, consistency, test quality. */
export const codeQuality = lens(SPEC);
