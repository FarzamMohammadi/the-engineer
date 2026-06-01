import path from "node:path";

import type { ReviewLens } from "../../../../schemas/config.js";
import { section } from "../../prompts/format.js";
import {
  buildCarrySection,
  buildResultContract,
  buildSystemPrompt,
  buildTaskContext,
  resultDirectory,
} from "../agent-prompt.js";
import { agentStep } from "../agent-step.js";
import {
  BlockCategories,
  type Ctx,
  type RoutableResult,
  type Route,
  type SkipReason,
  type SubPhase,
} from "../types.js";

// ── Review Lenses ──────────────────────────────────────────────────────────────
//
// A lens is a focused review pass: one agent session that looks at the change
// through a single concern (correctness, security, code quality, architecture),
// writes its findings, and advances. It never fixes — `refine` consolidates the
// lenses' findings and fixes in place. Every lens shares this plumbing; a lens
// file only declares its name, its role, and what to look for. Each lens reports
// into its own subdirectory so the lenses' results never collide.

const REVIEW_DIR = "review";
const FINDINGS_FILE = "findings.md";

/** What a lens declares: its identity, its system-prompt role line, and what it hunts for. */
export interface LensSpec {
  /** The lens name — a `ReviewLens` value, matching its sub-phase file and its config enable value. */
  readonly name: ReviewLens;
  /** The system-prompt role line describing this lens's single concern. */
  readonly role: string;
  /** The lens's focused instructions: what to look for and how to report it. */
  readonly instructions: string;
}

/** Build a review-lens sub-phase from its spec. Skips when the lens is not enabled in config. */
export function lens(spec: LensSpec): SubPhase {
  return {
    name: spec.name,
    skip: (ctx) => skipWhenDisabled(spec.name, ctx),
    run: agentStep({
      stepName: spec.name,
      directory: (ctx) => lensDirectory(ctx, spec.name),
      prompt: (ctx) => buildLensPrompt(ctx, spec),
      systemPrompt: () => buildSystemPrompt(spec.role),
    }),
    next: lensNext,
  };
}

/** A lens runs only when listed in `review.lenses`; otherwise it skips with a config reason. */
export function skipWhenDisabled(name: ReviewLens, ctx: Ctx): SkipReason | null {
  return ctx.config.review.lenses.includes(name) ? null : `${name} lens is not enabled in review.lenses`;
}

/** A lens writes findings and advances; it blocks only if it genuinely needs a person. */
export function lensNext(result: RoutableResult): Route {
  if (result.outcome === "needs_human") {
    return {
      go: "block",
      category: BlockCategories.awaiting_human,
      needed: "Answer what the review lens flagged as a question only a person can resolve",
    };
  }
  return { go: "advance" };
}

/** Absolute directory holding a lens's findings and result file — one subdirectory per lens. */
function lensDirectory(ctx: Ctx, name: ReviewLens): string {
  return resultDirectory(ctx, path.join(REVIEW_DIR, name));
}

// ── Prompt ───────────────────────────────────────────────────────────────────

function buildLensPrompt(ctx: Ctx, spec: LensSpec): string {
  const directory = lensDirectory(ctx, spec.name);
  const parts = [buildPriorWork(ctx)];
  const carry = buildCarrySection(ctx);
  if (carry) {
    parts.push(carry);
  }
  parts.push(
    section("What To Review", spec.instructions),
    buildResultContract({ directory, deliverable: FINDINGS_FILE }),
    buildTaskContext(ctx),
  );
  return parts.join("\n\n");
}

function buildPriorWork(ctx: Ctx): string {
  const requirements = resultDirectory(ctx, "requirements");
  const planning = resultDirectory(ctx, "planning");
  const execution = resultDirectory(ctx, "execution");
  return section(
    "What Came Before",
    [
      "The change is implemented and its gates pass. You are one lens in the review — review only, do not change code; `refine` fixes what the lenses find.",
      "",
      "- Run `git diff` against the base branch to see everything that changed. That diff is what you review.",
      `- \`${requirements}/requirements.md\` — what the task asked for, to judge the change against.`,
      `- \`${planning}/plan.md\` — the intended approach (absent for a trivial task).`,
      `- \`${execution}/implementation.md\` — what execution reported building.`,
    ].join("\n"),
  );
}
