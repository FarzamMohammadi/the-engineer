import { section } from "../../prompts/format.js";
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

const ROLE =
  "Your role is execution: build the change cleanly, test it as you go, and commit logical units of work. The plan is your starting point, not a contract — if a simpler path emerges, take it and note why.";

/** Absolute directory holding execution's deliverable, result file, and any `outreach/` questions. */
const dir = (ctx: Ctx): string => resultDirectory(ctx, PHASE_DIR);

/** Execution: write the code and commit as you go. Its verify gate re-runs it until the project's checks pass. */
export const implement: SubPhase = {
  name: "implement",
  run: agentStep({
    stepName: "implement",
    directory: dir,
    prompt: buildPrompt,
    systemPrompt: () => buildSystemPrompt(ROLE),
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
  parts.push(buildInstructions(), buildResultContract({ directory, deliverable: DELIVERABLE }), buildTaskContext(ctx));
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

function buildInstructions(): string {
  return section(
    "What To Do",
    [
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
    ].join("\n"),
  );
}
