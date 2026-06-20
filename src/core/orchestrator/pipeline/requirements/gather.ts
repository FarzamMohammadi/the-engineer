import type { Person } from "../../../../schemas/adapters.js";
import { composeBrief } from "../../prompts/brief.js";
import { section } from "../../prompts/format.js";
import { GATHER_ROLE, gatherInstructions } from "../../prompts/pipeline/requirements/index.js";
import {
  buildCarrySection,
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

const DETAILS_HINT =
  '"complexity": "trivial" | "moderate" | "complex", "verification": { "commands": [ { "name": "typecheck", "command": "pnpm", "args": ["run", "typecheck"] } ] }';

/** Absolute directory holding requirements' deliverable, result file, and any `outreach/` questions. */
const dir = (ctx: Ctx): string => resultDirectory(ctx, PHASE_DIR);

/** Requirements: ground in the project, understand the task, batch any human questions, assess complexity. */
export const gather: SubPhase = {
  name: "gather",
  run: agentStep({
    stepName: "gather",
    directory: dir,
    prompt: buildPrompt,
    systemPrompt: (ctx) => buildSystemPrompt(GATHER_ROLE, composeBrief(ctx)),
    detailsSchema: GroundingSchema,
  }),
  next: gatherNext,
  resultDir: dir,
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
//
// The intake-gate instructions are LOAD-BEARING prose; they live in
// ../../prompts/pipeline/requirements/gather.ts (gatherInstructions), where the
// warning against "simplifying" the gate is documented in full.

function buildPrompt(ctx: Ctx): string {
  const directory = resultDirectory(ctx, PHASE_DIR);
  const parts = [buildGroundingSection()];
  const carry = buildCarrySection(ctx);
  if (carry) {
    parts.push(carry);
  }
  parts.push(
    section("What To Do", gatherInstructions(directory)),
    buildContactsSection(ctx.peopleDirectory.getAll()),
    buildResultContract({ directory, deliverable: DELIVERABLE, detailsHint: DETAILS_HINT }),
    buildTaskContext(ctx),
  );
  return parts.join("\n\n");
}

function buildContactsSection(people: readonly Person[]): string {
  if (people.length === 0) {
    return section("Contacts", "No contacts are configured. Resolve what you can yourself; you cannot reach a person.");
  }
  const blocks = people.map((person) => {
    const roles = person.roles.join(", ");
    const header = roles ? `- ${person.name} · ${roles}` : `- ${person.name}`;
    const lines = [header, `  - person-id: \`${person.id}\``];
    for (const contact of person.contacts) {
      lines.push(`  - ${contact.channel}: \`${contact.handle}\``);
    }
    return lines.join("\n");
  });
  return section("Contacts", blocks.join("\n\n"));
}
