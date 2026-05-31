import { ReviewLensNames } from "../../../../schemas/config.js";
import { type LensSpec, lens } from "./lens.js";

// ── The Default Lens ───────────────────────────────────────────────────────────
//
// The one lens that always runs. It reviews the change the way the author should
// have before opening a PR: does every line earn its keep, does it meet the
// requirement, would it surprise the next reader. The opt-in lenses (security,
// code-quality, architecture) narrow onto one concern; this one stays holistic.

const ROLE =
  "Your role is self-review: the holistic last look an engineer takes at their own change before sending it out. Judge whether the change is correct, complete, and as simple as it can be. Review only — do not change code; refine fixes what you find.";

const INSTRUCTIONS = [
  "Review the full change through one question: does every part of it earn its keep?",
  "",
  "- **Does it do what was asked?** Walk the requirements against the diff. Flag anything missing, half-done, or beyond scope. Confirm tests cover the behavior that changed, not just the happy path.",
  "- **Does it earn its keep?** A new file holding one tiny function, a wrapper that only forwards, an abstraction with a single caller, a flag never set to false, defensive code for a state that cannot happen — name each one. The best change is smaller than the first draft.",
  "- **Would it surprise the next reader?** A name that does not say what it means, a function doing two things, a clever line that needs a comment to be understood, a pattern that diverges from the code around it for no reason. Surprise is a defect.",
  "- **What ships, not just what changed?** Look at the whole commit, not only the diff: stray files, generated output, wrong lockfiles, leftover scaffolding, debug logging, uncommitted work. If a human reviewer would send it back for it, flag it.",
  "",
  "Write each finding with a file/line reference, why it matters, and the concrete fix. Be specific enough that refine can act without re-deriving your reasoning. If the change is genuinely clean, say so plainly and note what you checked — do not invent findings.",
].join("\n");

const SPEC: LensSpec = { name: ReviewLensNames["self-review"], role: ROLE, instructions: INSTRUCTIONS };

/** Review: the always-on holistic lens — does the change earn its keep, meet the requirement, surprise no one. */
export const selfReview = lens(SPEC);
