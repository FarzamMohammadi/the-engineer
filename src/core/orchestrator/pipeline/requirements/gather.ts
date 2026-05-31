import type { Person } from "../../../../schemas/adapters.js";
import { section } from "../../prompts/format.js";
import {
  buildGroundingSection,
  buildResultContract,
  buildSystemPrompt,
  buildTaskContext,
  resultDirectory,
} from "../agent-prompt.js";
import { agentStep } from "../agent-step.js";
import { GroundingSchema } from "../grounding.js";
import { BlockCategories, type Ctx, type RoutableResult, type Route, type SubPhase } from "../types.js";

// ── The Sub-Phase ────────────────────────────────────────────────────────────

const PHASE_DIR = "requirements";
const DELIVERABLE = "requirements.md";

const ROLE =
  "Your role is requirements: understand this task deeply enough to build the right thing, and decide whether you can proceed or genuinely need a person. Do not design the solution or write code — later phases do that.";

const DETAILS_HINT =
  '"complexity": "trivial" | "moderate" | "complex", "verification": { "commands": [ { "name": "typecheck", "command": "pnpm", "args": ["run", "typecheck"] } ] }';

/** Requirements: ground in the project, understand the task, batch any human questions, assess complexity. */
export const gather: SubPhase = {
  name: "gather",
  run: agentStep({
    stepName: "gather",
    directory: (ctx) => resultDirectory(ctx, PHASE_DIR),
    prompt: buildPrompt,
    systemPrompt: () => buildSystemPrompt(ROLE),
    detailsSchema: GroundingSchema,
  }),
  next: gatherNext,
};

/** `needs_human` blocks the task for an answer; otherwise advance to the next phase. */
export function gatherNext(result: RoutableResult): Route {
  if (result.outcome === "needs_human") {
    return {
      go: "block",
      category: BlockCategories.awaiting_human,
      needed: "Answer the open questions in the requirements so the task can proceed",
    };
  }
  return { go: "advance" };
}

// ── Prompt ───────────────────────────────────────────────────────────────────

function buildPrompt(ctx: Ctx): string {
  const directory = resultDirectory(ctx, PHASE_DIR);
  return [
    buildGroundingSection(),
    buildInstructions(directory),
    buildContactsSection(ctx.peopleDirectory.getAll()),
    buildResultContract({ directory, deliverable: DELIVERABLE, detailsHint: DETAILS_HINT }),
    buildTaskContext(ctx),
  ].join("\n\n");
}

function buildInstructions(directory: string): string {
  return section(
    "What To Do",
    [
      "1. Open your deliverable with a `## Context Summary` — your understanding of what this task is asking, in your own words, before anything else. A wrong understanding caught at the first artifact is cheap; one caught after implementation is not.",
      "",
      "2. Investigate before asking. Not every unknown needs a person:",
      "   - **Researchable** (a library version, what a config does, current behavior) — find it yourself through the code, docs, or a web search.",
      '   - **Inferable** (the task says "update X" and one X exists) — proceed with the obvious reading and record your reasoning.',
      "   - **Judgment** (intent, preference, architectural direction, an ambiguity with several valid readings you cannot resolve) — this is the only kind to ask about.",
      "",
      "3. If you must ask, write one outreach file per person you need, batching **all** of your questions for that person into that single file:",
      "",
      `   \`${directory}/outreach/{person-id}.txt\``,
      "",
      "   The filename is the person's id from the contacts below. Number your questions. Include enough context that they can answer without reading the codebase. Then report `needs_human`.",
      "",
      "4. Assess complexity honestly and record it in `details.complexity`:",
      "   - **trivial** — obvious scope, minimal change (typo, config value, rename, docs-only). Research and planning are skipped for trivial tasks.",
      "   - **moderate** — clear direction, some exploration (a field, a known bug, one component).",
      "   - **complex** — broad scope, multiple systems, real unknowns. When unsure, choose moderate.",
      "",
      "5. Record how this project verifies work in `details.verification.commands` — the commands you learned while grounding that check correctness (typecheck, lint, test, build). Give each as an executable plus arguments. The Engineer runs these later to verify the implementation, so capture them now while you have the project in view. If the project has none, leave the list empty.",
      "",
      "Report `ok` when you know what to build — through statement, research, or reasonable inference. Report `needs_human` only when a genuine judgment call remains.",
    ].join("\n"),
  );
}

function buildContactsSection(people: readonly Person[]): string {
  if (people.length === 0) {
    return section("Contacts", "No contacts are configured. Resolve what you can yourself; you cannot reach a person.");
  }
  const lines = people.map((person) => {
    const roles = person.roles.join(", ");
    const contacts = person.contacts.map((c) => `${c.channel}: ${c.handle}`).join(", ");
    return contacts
      ? `- **${person.id}** — ${person.name} (${roles}) — ${contacts}`
      : `- **${person.id}** — ${person.name} (${roles})`;
  });
  return section("Contacts", lines.join("\n"));
}
