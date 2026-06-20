import { composeBrief } from "../../prompts/brief.js";
import { section } from "../../prompts/format.js";
import { EXECUTION_INSTRUCTIONS, EXECUTION_ROLE } from "../../prompts/pipeline/execution/index.js";
import { buildSkillsSection } from "../../prompts/skills.js";
import {
  buildCarrySection,
  buildResultContract,
  buildSystemPrompt,
  buildTaskContext,
  resultDirectory,
} from "../agent-prompt.js";
import { agentStep } from "../agent-step.js";
import { isTrivial } from "../grounding.js";
import { BlockCategories, type Ctx, Phases, type RoutableResult, type Route, type SubPhase } from "../types.js";

// ── The Sub-Phase ────────────────────────────────────────────────────────────

const PHASE_DIR = "execution";
const DELIVERABLE = "implementation.md";

/** Absolute directory holding execution's deliverable, result file, and any `outreach/` questions. */
const dir = (ctx: Ctx): string => resultDirectory(ctx, PHASE_DIR);

/** Execution: write the code and commit as you go. Its verify gate re-runs it until the project's checks pass. */
export const implement: SubPhase = {
  name: "implement",
  run: agentStep({
    stepName: "implement",
    directory: dir,
    prompt: buildPrompt,
    systemPrompt: (ctx) => buildSystemPrompt(EXECUTION_ROLE, composeBrief(ctx)),
  }),
  next: implementNext,
  resultDir: dir,
};

/** `needs_human` blocks for input; otherwise advance to verify, which runs the project's gates. */
export function implementNext(result: RoutableResult): Route {
  if (result.outcome === "needs_human") {
    return {
      go: "block",
      category: BlockCategories.awaiting_human,
      needed: "Resolve what execution got stuck on so the implementation can continue",
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
    section("What To Do", EXECUTION_INSTRUCTIONS),
    buildResultContract({ directory, deliverable: DELIVERABLE }),
    buildTaskContext(ctx),
  );
  const skills = buildSkillsSection(Phases.execution, ctx.skillsManager.getDir());
  if (skills) {
    parts.push(skills);
  }
  return parts.join("\n\n");
}

function buildPriorWork(ctx: Ctx): string {
  const requirements = resultDirectory(ctx, "requirements");
  if (isTrivial(ctx)) {
    return section(
      "What Came Before",
      `This is a trivial task — research and planning were skipped. Read \`${requirements}/requirements.md\` for the full context, then implement directly.`,
    );
  }
  const planning = resultDirectory(ctx, "planning");
  const research = resultDirectory(ctx, "research");
  return section(
    "What Came Before",
    [
      "Three phases ran before you. Read the plan first — it is your guide:",
      "",
      `- \`${planning}/plan.md\` — the implementation plan: phases, checkboxes, risks, test strategy.`,
      `- \`${research}/research.md\` — conventions and patterns to follow.`,
      `- \`${requirements}/requirements.md\` — full task context if you need it.`,
    ].join("\n"),
  );
}
