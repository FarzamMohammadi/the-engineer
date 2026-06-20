import { ReviewLensNames } from "../../../../schemas/config.js";
import { SELF_REVIEW_INSTRUCTIONS, SELF_REVIEW_ROLE } from "../../prompts/pipeline/review/index.js";
import { type LensSpec, lens } from "./lens.js";

// ── The Default Lens ───────────────────────────────────────────────────────────
//
// The one lens that always runs. It reviews the change the way the author should
// have before opening a PR: does every line earn its keep, does it meet the
// requirement, would it surprise the next reader. The opt-in lenses (security,
// code-quality, architecture) narrow onto one concern; this one stays holistic.

const SPEC: LensSpec = {
  name: ReviewLensNames["self-review"],
  role: SELF_REVIEW_ROLE,
  instructions: SELF_REVIEW_INSTRUCTIONS,
};

/** Review: the always-on holistic lens — does the change earn its keep, meet the requirement, surprise no one. */
export const selfReview = lens(SPEC);
