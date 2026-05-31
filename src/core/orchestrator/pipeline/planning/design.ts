import { section } from "../../prompts/format.js";
import {
  buildCarrySection,
  buildResultContract,
  buildSystemPrompt,
  buildTaskContext,
  resultDirectory,
} from "../agent-prompt.js";
import { agentStep } from "../agent-step.js";
import { isTrivial } from "../grounding.js";
import {
  BlockCategories,
  type Ctx,
  type RoutableResult,
  type Route,
  type SkipReason,
  type SubPhase,
} from "../types.js";

// ── The Sub-Phase ────────────────────────────────────────────────────────────

const PHASE_DIR = "planning";
const DELIVERABLE = "plan.md";

const ROLE =
  "Your role is planning: choose the simplest approach that fully meets the requirements, then stress-test it yourself before committing. Do not write code — produce the plan execution will follow.";

/** Planning: design the approach and stress-test it in one session. Skipped for trivial tasks. */
export const design: SubPhase = {
  name: "design",
  skip: skipWhenTrivial,
  run: agentStep({
    stepName: "design",
    directory: (ctx) => resultDirectory(ctx, PHASE_DIR),
    prompt: buildPrompt,
    systemPrompt: () => buildSystemPrompt(ROLE),
  }),
  next: designNext,
};

/** Trivial tasks skip planning — requirements judged the scope small enough to execute directly. */
export function skipWhenTrivial(ctx: Ctx): SkipReason | null {
  return isTrivial(ctx) ? "requirements assessed this task as trivial — execution can proceed without a plan" : null;
}

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
  parts.push(buildInstructions(), buildResultContract({ directory, deliverable: DELIVERABLE }), buildTaskContext(ctx));
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

function buildInstructions(): string {
  return section(
    "What To Do",
    [
      "You own this plan. Earlier phases did their best, but you are the last check before code is written — verify their conclusions, fill the gaps they missed, and resolve every open question now. A plan that defers an ambiguity into implementation is not finished. Its value is the decisions it records, not its length.",
      "",
      "1. Evaluate at least two approaches before committing:",
      "   - **Simplest** — the minimum change that fully meets the requirements. Fewest new files and abstractions. This is your baseline.",
      "   - **Alternative** — a different path worth considering only if it buys something concrete the simplest lacks.",
      "   Choose one and justify it. Complexity must earn its place; if the simplest path works, take it.",
      "",
      "2. Stress-test your chosen plan before detailing it — this is the same session, no separate review:",
      "   - **Plugin Opacity:** if it touches Core or an adapter boundary, would Core still compile with every plugin deleted?",
      "   - **Isolation:** does it add shared mutable state or bleed across task boundaries?",
      "   - **Boundaries:** are you working through contracts, not reaching into a module's internals?",
      "   - **Reversibility:** which decisions are hard to undo (new interfaces, schema changes)? Name them.",
      "   If a check fails, redesign before going further.",
      "",
      "3. Pre-mortem: assume the implementation ships with a subtle flaw. Name the two or three most likely failure modes — concurrency, crash recovery, unbounded growth, stale state. Mitigate each in the plan, or say why it is acceptable.",
      "",
      "4. Write a precise, ordered plan with concrete file paths and a verification step per part. Use checkboxes so execution can track progress. Record each meaningful decision — what you chose, what you rejected, and what it locks in — so execution inherits the reasoning, not just the result. Do not write code.",
      "",
      "Report `needs_human` only if a decision the plan genuinely depends on is not yours to make.",
    ].join("\n"),
  );
}
