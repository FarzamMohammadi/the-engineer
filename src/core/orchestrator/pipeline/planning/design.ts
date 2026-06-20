import { composeBrief } from "../../prompts/brief.js";
import { section } from "../../prompts/format.js";
import { PLANNING_INSTRUCTIONS, PLANNING_ROLE } from "../../prompts/pipeline/planning/index.js";
import {
  buildCarrySection,
  buildResultContract,
  buildSystemPrompt,
  buildTaskContext,
  resultDirectory,
} from "../agent-prompt.js";
import { agentStep } from "../agent-step.js";
import { skipIfTrivial } from "../grounding.js";
import { BlockCategories, type Ctx, type RoutableResult, type Route, type SubPhase } from "../types.js";

// ── The Sub-Phase ────────────────────────────────────────────────────────────

const PHASE_DIR = "planning";
const DELIVERABLE = "plan.md";

/** Absolute directory holding planning's deliverable, result file, and any `outreach/` questions. */
const dir = (ctx: Ctx): string => resultDirectory(ctx, PHASE_DIR);

/** Planning: design the approach and stress-test it in one session. Skipped for trivial tasks. */
export const design: SubPhase = {
  name: "design",
  skip: skipIfTrivial("requirements assessed this task as trivial — execution can proceed without a plan"),
  run: agentStep({
    stepName: "design",
    directory: dir,
    prompt: buildPrompt,
    systemPrompt: (ctx) => buildSystemPrompt(PLANNING_ROLE, composeBrief(ctx)),
  }),
  next: designNext,
  resultDir: dir,
};

/** `needs_human` blocks for a decision; otherwise advance to execution. */
export function designNext(result: RoutableResult): Route {
  if (result.outcome === "needs_human") {
    return {
      go: "block",
      category: BlockCategories.awaiting_human,
      needed: "Resolve the open decision the plan depends on so execution can proceed",
    };
  }
  return { go: "advance" };
}

// ── Prompt ───────────────────────────────────────────────────────────────────

function buildPrompt(ctx: Ctx): string {
  const directory = resultDirectory(ctx, PHASE_DIR);
  const parts = [buildPriorWork(ctx)];
  const carry = buildCarrySection(ctx);
  if (carry) {
    parts.push(carry);
  }
  parts.push(
    section("What To Do", PLANNING_INSTRUCTIONS),
    buildResultContract({ directory, deliverable: DELIVERABLE }),
    buildTaskContext(ctx),
  );
  return parts.join("\n\n");
}

function buildPriorWork(ctx: Ctx): string {
  const requirements = resultDirectory(ctx, "requirements");
  const research = resultDirectory(ctx, "research");
  return section(
    "What Came Before",
    [
      "Two phases ran before you. Read both before planning:",
      "",
      `- \`${requirements}/requirements.md\` — task context and the requirements.`,
      `- \`${research}/research.md\` — codebase analysis, relevant files, patterns, the simplest viable approach, and the assumptions research left open.`,
      "",
      "These are inputs, not conclusions.",
    ].join("\n"),
  );
}
