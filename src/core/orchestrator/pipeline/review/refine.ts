import path from "node:path";
import { z } from "zod";

import { composeBrief } from "../../prompts/brief.js";
import { section } from "../../prompts/format.js";
import { REFINE_INSTRUCTIONS, REFINE_ROLE } from "../../prompts/pipeline/review/index.js";
import { buildSkillsSection } from "../../prompts/skills.js";
import {
  buildCarrySection,
  buildResultContract,
  buildSystemPrompt,
  buildTaskContext,
  resultDirectory,
} from "../agent-prompt.js";
import { agentStep } from "../agent-step.js";
import { BlockCategories, type Ctx, Phases, type RoutableResult, type Route, type SubPhase } from "../types.js";

// ── The Sub-Phase ────────────────────────────────────────────────────────────
//
// refine is the one review sub-phase that fixes rather than reports. It reads the
// lenses' findings, fixes what it can in place, and then decides — through a typed
// verdict — whether the change is ready (`ship`), needs another review pass after
// its fixes (`revise`), or has a root cause it cannot fix in place that belongs to
// an earlier phase (`rework_*`). Its verdict is the only place the review needs
// more than the three standard outcomes, so it rides in `details`, validated.

const REVIEW_DIR = "review";
const PHASE_DIR = path.join(REVIEW_DIR, "refine");
const DELIVERABLE = "refinements.md";

/** refine's verdicts — the routing vocabulary it reports in `details.verdict`. */
const VERDICTS = ["ship", "revise", "rework_execution", "rework_planning", "rework_requirements"] as const;
type RefineVerdict = (typeof VERDICTS)[number];

/** The typed `details` refine reports: a single verdict that its `next` maps to a route. */
export const RefineDetailsSchema = z.object({ verdict: z.enum(VERDICTS) });

const DETAILS_HINT = '"verdict": "ship" | "revise" | "rework_execution" | "rework_planning" | "rework_requirements"';

/** Absolute directory holding refine's deliverable, result file, and any `outreach/` questions. */
const dir = (ctx: Ctx): string => resultDirectory(ctx, PHASE_DIR);

/** Review: consolidate the lenses' findings, fix in place, and decide ship / re-check / escalate. */
export const refine: SubPhase = {
  name: "refine",
  run: agentStep({
    stepName: "refine",
    directory: dir,
    prompt: buildPrompt,
    systemPrompt: (ctx) => buildSystemPrompt(REFINE_ROLE, composeBrief(ctx)),
    detailsSchema: RefineDetailsSchema,
  }),
  next: refineNext,
  resultDir: dir,
};

/**
 * Map refine's verdict to a route: `ship` advances to delivery, `revise` loops the review to
 * re-check the in-place fixes (capped), and each `rework_*` hands back to the phase that owns
 * the root cause. `needs_human` blocks for a person; an unreported verdict blocks loudly.
 */
export function refineNext(result: RoutableResult): Route {
  if (result.outcome === "needs_human") {
    return {
      go: "block",
      category: BlockCategories.awaiting_human,
      needed: "Resolve the question refine could not decide so review can finish",
    };
  }
  const carry = { summary: result.summary };
  switch (readVerdict(result.data)) {
    case "ship":
      return { go: "advance" };
    case "revise":
      return { go: "repeat", carry };
    case "rework_execution":
      return { go: "jump", to: Phases.execution, carry };
    case "rework_planning":
      return { go: "jump", to: Phases.planning, carry };
    case "rework_requirements":
      return { go: "jump", to: Phases.requirements, carry };
    default:
      return {
        go: "block",
        category: BlockCategories.orchestrator_error,
        needed: "refine did not report a recognized verdict — inspect its session-result",
      };
  }
}

/** Extract refine's verdict from its validated details, or null if it is somehow absent. */
function readVerdict(data: Record<string, unknown> | undefined): RefineVerdict | null {
  const parsed = RefineDetailsSchema.safeParse(data);
  return parsed.success ? parsed.data.verdict : null;
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
    section("What To Do", REFINE_INSTRUCTIONS),
    buildResultContract({ directory, deliverable: DELIVERABLE, detailsHint: DETAILS_HINT }),
    buildTaskContext(ctx),
  );
  const skills = buildSkillsSection(Phases.review, ctx.skillsManager.getDir());
  if (skills) {
    parts.push(skills);
  }
  return parts.join("\n\n");
}

function buildPriorWork(ctx: Ctx): string {
  const reviewDir = resultDirectory(ctx, REVIEW_DIR);
  const lensFindings = ctx.config.review.lenses.map(
    (name) => `- \`${path.join(reviewDir, name, "findings.md")}\` — the ${name} lens's findings.`,
  );
  return section(
    "What Came Before",
    [
      "The review lenses each examined the change and wrote findings. Read every one, then look at the change yourself:",
      "",
      ...lensFindings,
      "",
      "Run `git diff` against the base branch to see the current state of the change.",
    ].join("\n"),
  );
}
