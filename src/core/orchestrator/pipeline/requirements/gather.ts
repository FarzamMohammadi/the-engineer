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
import {
  BlockCategories,
  type Ctx,
  type RoutableResult,
  type Route,
  type SubPhase,
  type SubPhaseResult,
} from "../types.js";

// ── The Sub-Phase ────────────────────────────────────────────────────────────

const PHASE_DIR = "requirements";
const DELIVERABLE = "requirements.md";

const DETAILS_HINT =
  '"complexity": "trivial" | "moderate" | "complex", "acceptance_criteria": ["each checkable condition that means done"], "verification": { "commands": [ { "name": "typecheck", "command": "pnpm", "args": ["run", "typecheck"] } ] }';

/** Absolute directory holding requirements' deliverable, result file, and any `outreach/` questions. */
const dir = (ctx: Ctx): string => resultDirectory(ctx, PHASE_DIR);

const runGather = agentStep({
  stepName: "gather",
  directory: dir,
  prompt: buildPrompt,
  systemPrompt: (ctx) => buildSystemPrompt(GATHER_ROLE, composeBrief(ctx)),
  detailsSchema: GroundingSchema,
});

/** Requirements: ground in the project, understand the task, settle and persist acceptance criteria, batch any human questions, assess complexity. */
export const gather: SubPhase = {
  name: "gather",
  run: runWithCriteriaPersisted,
  next: gatherNext,
  resultDir: dir,
};

/**
 * Run the gather agent step, then persist the acceptance criteria it recorded onto the task row.
 * The agent writes the criteria into `details.acceptance_criteria` (already validated against
 * GroundingSchema by agentStep); this is the one place that promotes them from the session-result
 * handoff into the queryable `task.acceptance_criteria` field — so the review gates on a structured
 * field and the dashboard can show the exact conditions the task is judged against. Persisted only
 * on an `ok` result: a `needs_human` or `failed` run has not settled the end-state yet.
 */
async function runWithCriteriaPersisted(ctx: Ctx): Promise<SubPhaseResult> {
  const result = await runGather(ctx);
  if (result.outcome === "ok") {
    persistAcceptanceCriteria(ctx, result.data);
  }
  return result;
}

/**
 * Mirror the acceptance criteria from gather's validated `details` onto `task.acceptance_criteria`.
 * Reads the field back through GroundingSchema so it honors the same default (an empty list) the
 * handoff does — a gather run that recorded none leaves the task's criteria empty rather than throwing.
 */
function persistAcceptanceCriteria(ctx: Ctx, data: Record<string, unknown> | undefined): void {
  const grounding = GroundingSchema.safeParse(data ?? {});
  if (!grounding.success) {
    return;
  }
  const criteria = grounding.data.acceptance_criteria;
  ctx.taskEngine.updateTaskField(ctx.task.id, "acceptance_criteria", criteria);
  ctx.observer.info("Persisted acceptance criteria from requirements", {
    taskId: ctx.task.id,
    count: criteria.length,
  });
}

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
