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
  "Your role is requirements — the pipeline's intake gate. Your job is not to gather what you can and move on; it is to decide whether the owner has given enough to build the right thing, and to stop the line and reach out the moment they have not — anywhere their input would make the work more right, however small, even when you could decide it yourself. Understand the task deeply; do not design the solution or write code, later phases do that.";

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
    systemPrompt: () => buildSystemPrompt(ROLE),
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
// LOAD-BEARING — this is the pipeline's intake gate: the one place that decides
// whether the owner gave enough to build the right thing. Nothing downstream can
// recover an intent guessed wrong here, so the decision below is built to resist
// gaming, on purpose. Do NOT "simplify" it back into a soft self-check like
// "can I state acceptance criteria?" — the agent can always answer that yes by
// anchoring on material it finds in the repo (a spec, a TODO, a sibling PR) and
// promoting it to intent. The provenance split (owner-expressed / researchable-
// fact / inferred-from-found-material) plus the alternate-reading test is what
// stops that, and the bias toward asking is deliberate. Stricter adjectives were
// tried once (c6063cf) and did not hold. If you must change this, keep the
// structure, keep the bias, and confirm a bare task like "update scenes" still
// routes to needs_human.

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
      "1. Open your deliverable with a `## Context Summary` — in your own words, what this task is asking, and plainly how much of that the owner actually stated versus how much you are reconstructing. Sufficiency is not length: a one-line task can tell you everything you need, and pages of detail can still leave the deciding question unanswered. You are testing one thing — whether legitimate, sufficient intent is present to accept and build this — not how many words carry it. A wrong understanding caught at this first artifact is cheap; one caught after implementation is not.",
      "",
      "2. Probe the task to its edges before you decide what you know. A surface reading hides the gaps that become bugs. For each thing the task asks for: break it into its parts, enumerate the complete set of values, outcomes, and actors it implies, and trace what happens next for each — the invalid input, the empty case, the conflict, the boundary. Walk two or three concrete end-to-end scenarios. What this surfaces — the gaps, the forks, the unstated cases — is exactly what you weigh in the decision below.",
      "",
      "3. State what done looks like. Under a `## Acceptance Criteria` heading, write the concrete, checkable conditions a reviewer would verify to call this task complete. Draw them from what the task says and what the code shows — not from what you wish it said. These criteria are the end-state you interrogate in the next step.",
      "",
      "4. Now interrogate where that end-state came from — this is the decision the whole pipeline rests on. For the acceptance criteria you just wrote, and every requirement inside them, name the source of each:",
      '   - **The owner expressed it** — they stated what done looks like, even in a few words ("bump lodash to the latest", "fix the typo in the heading", "rename `getUser` to `fetchUser`"). Trust it; proceed.',
      "   - **It is a researchable fact** — the end-state has one objective answer you can verify, and no one's intent is needed to settle it (a version number, what the code currently does, what a config field means). Find it, record how, proceed.",
      '   - **You inferred it from something you found** — you read a spec, a TODO, a sibling PR, or existing code and concluded "this must be what they want." This feels like fact, but it is a guess about intent: material sitting in a repo can be stale, aspirational, abandoned, or written for a different purpose. The owner did not say it — you decided it.',
      "",
      "   For anything in that third bucket, apply one test before you trust it: **can you name a different, equally-defensible thing the owner might have meant?** If you can, the intent is underdetermined — stop and ask. Proceed on an inference only when no other reading survives, and write down why none does.",
      "",
      '   The trap to refuse outright: a task that names a *target* with no desired *end-state* — "update the scenes", "improve the dashboard", "clean up the config" — is never an inference, however much material you find nearby. Naming what to touch is not knowing what done looks like, and finding a detailed spec in the repo tells you a spec exists, not that this task is asking you to build it. Confirm that link with the owner; never forge it yourself.',
      "",
      '   Weigh your own signals honestly: a prior attempt that already failed, having to dig through the repo to reconstruct what the task "really" means, or reaching for outside material to make a thin task make sense — each is evidence you do not yet hold the intent, not a cue to try harder alone.',
      "",
      "5. If you must ask, write one outreach file per person you need, batching **all** of your questions for that person into that single file:",
      "",
      `   \`${directory}/outreach/{person-id}.txt\``,
      "",
      "   The filename is the `person-id` shown with each contact below (the value after `person-id:`). Number your questions. Include enough context that they can answer without reading the codebase. Then report `needs_human`.",
      "",
      "6. Assess complexity honestly and record it in `details.complexity`:",
      "   - **trivial** — obvious scope, minimal change (typo, config value, rename, docs-only). Research and planning are skipped for trivial tasks.",
      "   - **moderate** — clear direction, some exploration (a field, a known bug, one component).",
      "   - **complex** — broad scope, multiple systems, real unknowns. When unsure, choose moderate.",
      "",
      "7. Record how this project verifies work in `details.verification.commands` — the commands you learned while grounding that check correctness (typecheck, lint, test, build). Give each as an executable plus arguments. The Engineer runs these later to verify the implementation, so capture them now while you have the project in view. If the project has none, leave the list empty.",
      "",
      "This phase is the pipeline's gate; passing it means the owner has given enough to build the right thing. You run autonomously — nothing downstream can recover an intent you guessed wrong, and the orchestrator can re-check that you *did* the work but cannot re-derive what the owner meant; only they can. So hold the bar high and tilt toward reaching out: the test is not whether you could defend a reading if pressed, but whether the owner's input would make the work more right. Anywhere it would — a fork they might want decided differently, a scope edge, even a small detail you could settle but they might settle otherwise — ask, even when you could choose yourself. Facts you can look up are not this; settle those and move on. Report `ok` only when the owner expressed what done means or you established it as fact, no point where their input would help is left unasked, and you would stake the build on your acceptance criteria. Otherwise, `needs_human`. One question too many beats one wrong build — every time.",
    ].join("\n"),
  );
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
