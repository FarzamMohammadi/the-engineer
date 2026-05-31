import { section } from "../../prompts/format.js";
import { buildResultContract, buildSystemPrompt, buildTaskContext, resultDirectory } from "../agent-prompt.js";
import { agentStep } from "../agent-step.js";
import { BlockCategories, type Ctx, type RoutableResult, type Route, type SubPhase } from "../types.js";
import { skipWhenPushOnly } from "./deliverable.js";

// ── The Sub-Phase ────────────────────────────────────────────────────────────

const PHASE_DIR = "delivery";
const DELIVERABLE = "pr-description.md";

const ROLE =
  "Your role is to write the pull request description: the narrative a human reviewer reads to understand what changed and why, and to trust it. Write the description only — do not change code.";

/** Delivery: write the PR narrative from the task's deliverables. Skipped in push-only mode. */
export const prDescription: SubPhase = {
  name: "pr-description",
  skip: skipWhenPushOnly,
  run: agentStep({
    stepName: "pr-description",
    directory: (ctx) => resultDirectory(ctx, PHASE_DIR),
    prompt: buildPrompt,
    systemPrompt: () => buildSystemPrompt(ROLE),
  }),
  next: prDescriptionNext,
};

/** `needs_human` blocks for the missing context; otherwise advance to push. */
export function prDescriptionNext(result: RoutableResult): Route {
  if (result.outcome === "needs_human") {
    return {
      go: "block",
      category: BlockCategories.awaiting_human,
      needed: "Provide what the PR description needs so delivery can proceed",
    };
  }
  return { go: "advance" };
}

// ── Prompt ───────────────────────────────────────────────────────────────────

function buildPrompt(ctx: Ctx): string {
  const directory = resultDirectory(ctx, PHASE_DIR);
  return [
    buildPriorWork(ctx),
    buildInstructions(),
    buildResultContract({ directory, deliverable: DELIVERABLE }),
    buildTaskContext(ctx),
  ].join("\n\n");
}

function buildPriorWork(ctx: Ctx): string {
  const requirements = resultDirectory(ctx, "requirements");
  const review = resultDirectory(ctx, "review");
  return section(
    "What Came Before",
    [
      "The change is implemented, reviewed, and refined. Draw the narrative from what the pipeline already produced:",
      "",
      "- Run `git log` and `git diff` against the base branch to see exactly what ships.",
      `- \`${requirements}/requirements.md\` — what the task asked for and why.`,
      `- \`${review}/refine/refinements.md\` — what review found and how it was resolved.`,
    ].join("\n"),
  );
}

function buildInstructions(): string {
  return section(
    "What To Do",
    [
      "Write a PR description a busy reviewer can act on. Lead with the answer; put detail underneath.",
      "",
      "- **What and why.** One short paragraph: what this change does and the problem it solves. No filler.",
      "- **How.** The approach in a few bullets — the decisions a reviewer needs to follow the diff, not a line-by-line replay.",
      "- **Verification.** How it was checked: which gates ran, what was tested, anything a reviewer should verify themselves.",
      "- **Risks and follow-ups.** Anything out of scope, deferred, or worth a second look. Honesty here earns trust.",
      "",
      "Keep it scannable and truthful. Do not claim work that was not done. Report `needs_human` only if you genuinely cannot describe the change without an answer.",
    ].join("\n"),
  );
}
