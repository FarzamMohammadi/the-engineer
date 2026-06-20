import { composeBrief } from "../../prompts/brief.js";
import { section } from "../../prompts/format.js";
import { PR_DESCRIPTION_ROLE, prDescriptionInstructions } from "../../prompts/pipeline/delivery/index.js";
import { buildResultContract, buildSystemPrompt, buildTaskContext, resultDirectory } from "../agent-prompt.js";
import { agentStep } from "../agent-step.js";
import { BlockCategories, type Ctx, type RoutableResult, type Route, type SubPhase } from "../types.js";
import { skipWhenPushOnly } from "./deliverable.js";

// ── The Sub-Phase ────────────────────────────────────────────────────────────

const PHASE_DIR = "delivery";
const DELIVERABLE = "pr-description.md";
const TITLE_DELIVERABLE = "pr-title.md";

/** Absolute directory holding delivery's deliverable, result file, and any `outreach/` questions. */
const dir = (ctx: Ctx): string => resultDirectory(ctx, PHASE_DIR);

/** Delivery: write the PR narrative from the task's deliverables. Skipped in push-only mode. */
export const prDescription: SubPhase = {
  name: "pr-description",
  skip: skipWhenPushOnly,
  run: agentStep({
    stepName: "pr-description",
    directory: dir,
    prompt: buildPrompt,
    systemPrompt: (ctx) => buildSystemPrompt(PR_DESCRIPTION_ROLE, composeBrief(ctx)),
  }),
  next: prDescriptionNext,
  resultDir: dir,
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
  const titleFile = `${directory}/${TITLE_DELIVERABLE}`;
  return [
    buildPriorWork(ctx),
    section("What To Do", prDescriptionInstructions(titleFile)),
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
