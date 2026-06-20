import { composeBrief } from "../../prompts/brief.js";
import { section } from "../../prompts/format.js";
import { buildResultContract, buildSystemPrompt, buildTaskContext, resultDirectory } from "../agent-prompt.js";
import { agentStep } from "../agent-step.js";
import { skipIfTrivial } from "../grounding.js";
import { BlockCategories, type Ctx, type RoutableResult, type Route, type SubPhase } from "../types.js";

// ── The Sub-Phase ────────────────────────────────────────────────────────────

const PHASE_DIR = "research";
const DELIVERABLE = "research.md";

const ROLE =
  "Your role is research: study the code until you understand what this task touches and how it works. Investigate only — do not design a solution or change code. Later phases do that.";

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
    systemPrompt: (ctx) => buildSystemPrompt(ROLE, composeBrief(ctx)),
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
    buildInstructions(),
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

function buildInstructions(): string {
  return section(
    "What To Do",
    [
      "Map what this task touches and how it actually works, the way a senior engineer studies code before writing a line.",
      "",
      "- Find every file that must change, plus the files that give critical context — interfaces, types, tests, configs.",
      "- Read wider than the task names. Every change has a blast radius: what else references this domain, routes to it, competes with it, or assumes it does not exist today? The dangerous gaps live in code nobody mentioned. Treat earlier phases' conclusions as claims to verify, not facts to inherit — if requirements marked something out of scope, confirm it by reading it rather than taking it on faith.",
      "- Trace the real execution path end to end. Read what the code does at runtime; do not infer behavior from type signatures alone.",
      "- Identify the conventions and the architecture of the files you will touch — how they organize logic, what they extract vs inline. New code that ignores them is a regression.",
      "- When the task changes instances of something, count every instance. The inventory is the contract for execution and review.",
      "",
      "Keep observations and inferences separate, and label them:",
      "- **Observations** are facts you verified by reading the code. ",
      "- **Inferences** are what you conclude from them. Never present an inference as a fact.",
      "",
      "Then challenge what you found: What is the genuinely simplest approach? Are these patterns actually good, or legacy you should not copy? Which assumptions have you not verified? Is there an existing mechanism that already solves part of this? The best code is the code you do not write.",
      "",
      "Do not change code and do not plan the solution. Report `needs_human` only if you uncover something only a person can answer.",
    ].join("\n"),
  );
}
