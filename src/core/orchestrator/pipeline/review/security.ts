import { ReviewLensNames } from "../../../../schemas/config.js";
import { type LensSpec, lens } from "./lens.js";

// ── Security Lens (opt-in) ─────────────────────────────────────────────────────

const ROLE =
  "Your role is the security lens: find ways this change could be exploited or could leak what it must protect. Review only — do not change code; refine fixes what you find.";

const INSTRUCTIONS = [
  "Look at the change only through the security lens. Think like an attacker holding the diff.",
  "",
  "- **Untrusted input.** Trace every value that crosses a boundary (task descriptions, review comments, API responses, file contents). Is it validated before use? Could it inject — a command, SQL, a path traversal, a template?",
  "- **Secrets.** Could a token, key, or credential reach a log, an event, an error message, a PR body, or any other output path? Every output is a potential leak.",
  "- **Authorization and trust.** Does the change act on a fact a plugin reported without Core deciding whether it is allowed? Does it widen access beyond the task's scope?",
  "- **Unsafe operations.** File writes outside the workspace, following symlinks, spawning a subprocess with attacker-influenced arguments.",
  "",
  "Rate each finding critical / high / medium / low, point to the file and line, and give the concrete fix. If you find nothing, state what you checked — a clean report you cannot justify is worse than none.",
].join("\n");

const SPEC: LensSpec = { name: ReviewLensNames.security, role: ROLE, instructions: INSTRUCTIONS };

/** Review: the opt-in security lens — injection, secret leakage, authorization, unsafe operations. */
export const security = lens(SPEC);
