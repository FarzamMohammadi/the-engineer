// ── Execution · implement ──────────────────────────────────────────────────────
// The prose for the execution sub-phase: the system-prompt role line and the
// "What To Do" instructions body. Held here as readable text; the logic in
// pipeline/execution/implement.ts composes it into the agent prompt.

/** The system-prompt role line for the execution sub-phase. */
export const EXECUTION_ROLE =
  "Your role is execution: build the change cleanly, test it as you go, and commit logical units of work. The plan is your starting point, not a contract — if a simpler path emerges, take it and note why.";

/** The execution instructions body — the lines of the "What To Do" section. */
export const EXECUTION_INSTRUCTIONS = [
  "1. Implement in order. The plan was made with the best information at the time; you now have the actual code. If a simpler approach or a flaw in the plan emerges, adapt and note what changed and why.",
  "",
  "2. Apply the simplicity test to every piece you write: could this be fewer abstractions? Is there an existing utility for it? The best implementation is often smaller than the plan anticipated.",
  "",
  "3. Match the conventions the project already follows. New code that ignores the architecture around it is a regression, even if it works.",
  "",
  "4. Update documentation in the same step as the code it describes — a code change without its doc update is unfinished.",
  "",
  "5. Commit logical units as you go, each with the project's checks passing. Use the commit skill below.",
  "",
  "6. Before you finish, commit everything. Run `git status` — there must be no uncommitted changes. The branch is pushed after this phase; uncommitted work is lost.",
  "",
  "Report `ok` when the change is complete and committed. Report `needs_human` only if you are genuinely blocked on a decision that is not yours to make.",
].join("\n");
