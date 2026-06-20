// ── Delivery · pr-description ───────────────────────────────────────────────────
// The prose for the delivery sub-phase: the system-prompt role line and the
// "What To Do" instructions body. Held here as readable text; the logic in
// pipeline/delivery/pr-description.ts composes it into the agent prompt.

/** The system-prompt role line for the pr-description sub-phase. */
export const PR_DESCRIPTION_ROLE =
  "Your role is to write the pull request presentation — title and body — the narrative a human reviewer reads to understand what changed and why, and to trust it. Write the presentation only — do not change code.";

/**
 * The pr-description instructions body, interpolating the absolute `titleFile`
 * path. Returned as the lines of the "What To Do" section (the logic file wraps it
 * with `section(...)`).
 */
export function prDescriptionInstructions(titleFile: string): string {
  return [
    "Write the PR title and body a busy reviewer can act on. Both are drawn from the full diff against base, so both describe the **whole** PR as it now stands — the original work plus every later round of changes — written as if every change landed at once. Never describe the work round-by-round.",
    "",
    "**Body** — lead with the answer; put detail underneath:",
    "- **What and why.** One short paragraph: what this change does and the problem it solves. No filler.",
    "- **How.** The approach in a few bullets — the decisions a reviewer needs to follow the diff, not a line-by-line replay.",
    "- **Verification.** How it was checked: which gates ran, what was tested, anything a reviewer should verify themselves.",
    "- **Risks and follow-ups.** Anything out of scope, deferred, or worth a second look. Honesty here earns trust.",
    "",
    `**Title** — also write \`${titleFile}\` containing a **single line**: a concise, imperative PR title (aim for ~50–70 characters) describing the whole PR as it now stands, not just the original task. No issue numbers or prefixes — those are added automatically. No trailing period.`,
    "",
    "Keep it scannable and truthful. Do not claim work that was not done. Report `needs_human` only if you genuinely cannot describe the change without an answer.",
  ].join("\n");
}
