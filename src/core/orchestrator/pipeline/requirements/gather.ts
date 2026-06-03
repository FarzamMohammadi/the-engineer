import type { Person } from "../../../../schemas/adapters.js";
import { section } from "../../prompts/format.js";
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
  const parts = [buildGroundingSection()];
  const carry = buildCarrySection(ctx);
  if (carry) {
    parts.push(carry);
  }
  parts.push(
    buildInstructions(directory),
    buildContactsSection(ctx.peopleDirectory.getAll()),
    buildResultContract({ directory, deliverable: DELIVERABLE, detailsHint: DETAILS_HINT }),
    buildTaskContext(ctx),
  );
  return parts.join("\n\n");
}

function buildInstructions(directory: string): string {
  return section(
    "What To Do",
    [
      "1. Open your deliverable with a `## Context Summary` — your understanding of what this task is asking, in your own words, before anything else. A wrong understanding caught at the first artifact is cheap; one caught after implementation is not.",
      "",
      "2. Probe the task to its edges before you decide what you know. A surface reading hides the gaps that become bugs. For each thing the task asks for: break it into its parts, enumerate the complete set of values, outcomes, and actors it implies, and trace what happens next for each — the invalid input, the empty case, the conflict, the boundary. Walk two or three concrete end-to-end scenarios. What this surfaces is exactly what you triage below.",
      "",
      "3. State what done looks like. Under a `## Acceptance Criteria` heading, write the concrete, checkable conditions that must be true for this task to be complete — what a reviewer would actually verify. Draw them from what the task says and what the code shows, not from what you wish it said. If you cannot write them without inventing what the owner wants, you do not yet know what to build: that gap is a question for a person, not a blank to fill in yourself.",
      "",
      "4. Investigate before asking — but identifying the *target* is not the same as knowing the *change*. Sort every unknown, and every gap the probe surfaced, into three kinds:",
      "   - **Researchable** (a library version, what a config does, how the current code behaves) — find it yourself through the code, docs, or a web search.",
      '   - **Inferable** — the obvious reading is the *only* reasonable one: the task already specifies the desired end-state and only one path gets there ("bump lodash to the latest", "fix the typo in the heading"). Proceed and record your reasoning.',
      "   - **Judgment** (intent, preference, scope, architectural direction — any gap with more than one defensible answer) — you cannot supply this from the code. This is the only kind to ask about.",
      "",
      '   Beware the trap that hides here: "update the scenes" names what to touch but not what done looks like — update them to what, and why? A task that names a target with no desired end-state is a judgment call, not an inference. Never turn a guess about intent into a requirement.',
      "",
      "5. If you must ask, write one outreach file per person you need, batching **all** of your questions for that person into that single file:",
      "",
      `   \`${directory}/outreach/{person-id}.txt\``,
      "",
      "   The filename is the person's id from the contacts below. Number your questions. Include enough context that they can answer without reading the codebase. Then report `needs_human`.",
      "",
      "6. Assess complexity honestly and record it in `details.complexity`:",
      "   - **trivial** — obvious scope, minimal change (typo, config value, rename, docs-only). Research and planning are skipped for trivial tasks.",
      "   - **moderate** — clear direction, some exploration (a field, a known bug, one component).",
      "   - **complex** — broad scope, multiple systems, real unknowns. When unsure, choose moderate.",
      "",
      "7. Record how this project verifies work in `details.verification.commands` — the commands you learned while grounding that check correctness (typecheck, lint, test, build). Give each as an executable plus arguments. The Engineer runs these later to verify the implementation, so capture them now while you have the project in view. If the project has none, leave the list empty.",
      "",
      "You run autonomously: the owner is not watching this run, and nothing downstream can recover an intent you guessed wrong — research, planning, and a real PR all inherit it. The orchestrator re-checks that you *did* the job, but it cannot re-derive what the owner meant; only they can. A question, by contrast, costs them one reply whenever they get to it. So report `ok` only when you can state the acceptance criteria and stand behind them; when the desired end-state is not determinable from the task plus what you could research, report `needs_human` instead of guessing. One question too many beats one wrong build.",
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
