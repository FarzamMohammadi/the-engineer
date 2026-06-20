import { ReviewLensNames } from "../../../../schemas/config.js";
import { SECURITY_INSTRUCTIONS, SECURITY_ROLE } from "../../prompts/pipeline/review/index.js";
import { type LensSpec, lens } from "./lens.js";

// ── Security Lens (opt-in) ─────────────────────────────────────────────────────

const SPEC: LensSpec = {
  name: ReviewLensNames.security,
  role: SECURITY_ROLE,
  instructions: SECURITY_INSTRUCTIONS,
};

/** Review: the opt-in security lens — injection, secret leakage, authorization, unsafe operations. */
export const security = lens(SPEC);
