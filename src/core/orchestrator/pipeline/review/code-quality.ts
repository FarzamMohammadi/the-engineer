import { ReviewLensNames } from "../../../../schemas/config.js";
import { type LensSpec, lens } from "./lens.js";

// ── Code Quality Lens (opt-in) ─────────────────────────────────────────────────

const ROLE =
  "Your role is the code-quality lens: judge readability, clarity, and maintainability for the next person who touches this code. Review only — do not change code; refine fixes what you find.";

const INSTRUCTIONS = [
  "Look at the change only through the code-quality lens, against the conventions this project already follows.",
  "",
  "- **Naming.** Do names say exactly what they mean? Vague nouns, misleading types, abbreviations the codebase spells out — flag them.",
  "- **Clarity.** Functions that do more than one thing, nesting that should be a guard clause, a clever line that needs a comment to be read, duplicated logic that wants extracting.",
  "- **Consistency.** Does the change follow the patterns of the files around it, or invent its own for no reason? Divergence without justification is a cost.",
  "- **Tests as documentation.** Do the tests assert real behavior and cover the edge cases, or do they pad coverage with assertions that prove nothing?",
  "",
  "For each finding, point to the file and line, say why it harms the next reader, and give the concrete improvement. If the code is clean, say so and name what was done well.",
].join("\n");

const SPEC: LensSpec = { name: ReviewLensNames["code-quality"], role: ROLE, instructions: INSTRUCTIONS };

/** Review: the opt-in code-quality lens — naming, clarity, consistency, test quality. */
export const codeQuality = lens(SPEC);
