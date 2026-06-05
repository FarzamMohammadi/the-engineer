import path from "node:path";
import { z } from "zod";

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

const ROLE =
  "Your role is refine: the last hands on the change before it ships. Consolidate the review lenses' findings, fix what you can directly in the code, and judge honestly whether the result is ready or whether the real problem lives in an earlier phase.";

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
    systemPrompt: () => buildSystemPrompt(ROLE),
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
    buildInstructions(),
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

function buildInstructions(): string {
  return section(
    "What To Do",
    [
      "You are the final quality gate before delivery. Assume issues exist until you have proven otherwise.",
      "",
      "1. Consolidate the lenses' findings. Group them; drop duplicates and anything that does not hold up when you look at the actual code.",
      "2. Fix what you can directly in the code — security issues without exception, requirement gaps, clarity and simplicity problems. Commit your fixes with the project's checks passing, using the commit skill below.",
      "3. Run the project's gates again after fixing. A fix that breaks a gate is not a fix.",
      "4. Then judge the result honestly and record one verdict in `details.verdict`:",
      "",
      "   - **ship** — the change is correct, complete, and clean; nothing material remains. Deliver it.",
      "   - **revise** — you fixed issues in place and want the lenses to look again at the changed code. The review re-runs (this is capped — if it cannot converge in a few passes, the task is escalated to a person).",
      "   - **rework_execution** — the change needs a substantial re-implementation that is better done fresh in execution than patched here.",
      "   - **rework_planning** — the approach itself is wrong; the plan needs rethinking before more code is written.",
      "   - **rework_requirements** — the requirements are unclear or wrong, and no amount of code fixes that until a person resolves them.",
      "",
      "Prefer fixing in place and shipping. Reach for a rework verdict only when the root cause genuinely lives in an earlier phase — not to avoid the work.",
      "Report `needs_human` only if a question blocks you that is not yours to answer.",
    ].join("\n"),
  );
}
