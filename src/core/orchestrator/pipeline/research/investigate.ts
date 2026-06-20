import { composeBrief } from "../../prompts/brief.js";
import { section } from "../../prompts/format.js";
import { RESEARCH_INSTRUCTIONS, RESEARCH_ROLE } from "../../prompts/pipeline/research/index.js";
import { buildResultContract, buildSystemPrompt, buildTaskContext, resultDirectory } from "../agent-prompt.js";
import { agentStep } from "../agent-step.js";
import { skipIfTrivial } from "../grounding.js";
import { BlockCategories, type Ctx, type RoutableResult, type Route, type SubPhase } from "../types.js";

// ── The Sub-Phase ────────────────────────────────────────────────────────────

const PHASE_DIR = "research";
const DELIVERABLE = "research.md";

/** Absolute directory holding research's deliverable, result file, and any `outreach/` questions. */
const dir = (ctx: Ctx): string => resultDirectory(ctx, PHASE_DIR);

/** Research: study the codebase with observations-vs-inferences discipline. Skipped for trivial tasks. */
export const investigate: SubPhase = {
  name: "investigate",
  skip: skipIfTrivial("requirements assessed this task as trivial — research adds nothing"),
  run: agentStep({
    stepName: "investigate",
    directory: dir,
    prompt: buildPrompt,
    systemPrompt: (ctx) => buildSystemPrompt(RESEARCH_ROLE, composeBrief(ctx)),
  }),
  next: investigateNext,
  resultDir: dir,
};

/** `needs_human` blocks for the missing information; otherwise advance to planning. */
export function investigateNext(result: RoutableResult): Route {
  if (result.outcome === "needs_human") {
    return {
      go: "block",
      category: BlockCategories.awaiting_human,
      needed: "Provide the information research surfaced as missing so the task can proceed",
    };
  }
  return { go: "advance" };
}

// ── Prompt ───────────────────────────────────────────────────────────────────

function buildPrompt(ctx: Ctx): string {
  const directory = resultDirectory(ctx, PHASE_DIR);
  return [
    buildPriorWork(ctx),
    section("What To Do", RESEARCH_INSTRUCTIONS),
    buildResultContract({ directory, deliverable: DELIVERABLE }),
    buildTaskContext(ctx),
  ].join("\n\n");
}

function buildPriorWork(ctx: Ctx): string {
  const requirements = resultDirectory(ctx, "requirements");
  return section(
    "What Came Before",
    `Requirements were gathered. Read \`${requirements}/requirements.md\` first — it holds the task context, what was learned, and the assessment. Build on it.`,
  );
}
