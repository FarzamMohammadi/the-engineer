import path from "node:path";

import { WorkspaceNotReadyError } from "../errors.js";
import { gatherRepoContextSafe } from "../prompts/context.js";
import { buildRepoOverview, buildTaskBrief, section } from "../prompts/format.js";
import { GROUND_YOURSELF, type ResultContractOptions, buildResultContractBody } from "../prompts/sections/index.js";
import { PERSONA } from "../prompts/self-model/index.js";
import {
  HANDOFF_PRINCIPLE,
  OPERATING_STANDARDS,
  SECURITY_BOUNDARY,
  SURFACE_DECISIONS,
} from "../prompts/standards/index.js";
import { acceptanceCriteria } from "./grounding.js";
import type { Ctx } from "./types.js";

// ── Shared System Prompt ─────────────────────────────────────────────────────
// Identity and operating standards that hold for every agent sub-phase. The
// per-sub-phase role line is appended; the user prompt carries the concrete work.
//
// PERSONA is the agent's identity (who it is + how it works), composed from the
// self-model prose modules in src/core/orchestrator/prompts/self-model/. It is
// static and the same for every phase, so it ships uniformly and is cacheable — no
// per-phase trimming.
// The behavioral standards below (OPERATING_STANDARDS, HANDOFF_PRINCIPLE,
// SURFACE_DECISIONS, SECURITY_BOUNDARY) are complementary to the persona, not a
// duplicate of it; they stay as their own sections. Their prose lives in the
// readable .ts modules under ../prompts/standards/.

/**
 * Build the system prompt for an agent sub-phase: shared identity and standards, this run's live brief,
 * then this step's role line. Cache order runs most-stable to least: the persona and static standards are
 * identical across every phase and task; `brief` is the owner's live setup (the same within a run, varying
 * by config and repo); `roleLine` is per-phase. Keeping the stable text first preserves prompt-prefix
 * caching across phases — only the brief and role line differ run to run.
 */
export function buildSystemPrompt(roleLine: string, brief: string): string {
  return [
    PERSONA,
    "",
    OPERATING_STANDARDS,
    "",
    HANDOFF_PRINCIPLE,
    "",
    SURFACE_DECISIONS,
    "",
    SECURITY_BOUNDARY,
    "",
    brief,
    "",
    roleLine,
  ].join("\n");
}

// ── Shared User-Prompt Sections ──────────────────────────────────────────────

/** The grounding-first discipline, surfaced in the user prompt so the step opens by acclimating to the project. */
export function buildGroundingSection(): string {
  return section("Ground Yourself First", GROUND_YOURSELF);
}

/** The new handoff contract: write the deliverable and a `session-result.json` reporting an outcome, never a phase. */
export function buildResultContract(options: ResultContractOptions): string {
  return section("Where To Put Your Work", buildResultContractBody(options));
}

/** Build the task brief and repository overview, gathering repo context from the worktree. */
export function buildTaskContext(ctx: Ctx): string {
  const repoContext = gatherRepoContextSafe(ctx.worktreePath, ctx.observer);
  const brief = buildTaskBrief({
    title: ctx.task.title,
    description: ctx.task.description,
    external_ref: ctx.task.external_ref,
    acceptance_criteria: resolveAcceptanceCriteria(ctx),
  });
  return [brief, buildRepoOverview(repoContext)].join("\n\n");
}

/**
 * The acceptance criteria to put in front of a later phase. Prefer the grounding handoff requirements
 * wrote to the worktree (current within this dispatch, the moment gather records them), and fall back to
 * the persisted `task.acceptance_criteria` field — the queryable snapshot a fresh re-entry dispatch loads
 * before its worktree handoff is in view. Reads the live source so the review gates on the same criteria
 * the dashboard shows, not a stale dispatch-start copy.
 */
function resolveAcceptanceCriteria(ctx: Ctx): readonly string[] {
  const fromGrounding = acceptanceCriteria(ctx);
  return fromGrounding.length > 0 ? fromGrounding : ctx.task.acceptance_criteria;
}

/** Absolute directory for a phase's deliverable and result file. Fails loud when no worktree exists. */
export function resultDirectory(ctx: Ctx, phase: string): string {
  if (!(ctx.worktreePath && ctx.thoughtsDir)) {
    throw new WorkspaceNotReadyError(ctx.task.id);
  }
  return path.join(ctx.worktreePath, ctx.thoughtsDir, phase);
}

/** Context carried into a re-run, rendered for the prompt when a phase repeats or the pipeline jumps back. */
export function buildCarrySection(ctx: Ctx): string | null {
  if (!ctx.carry) {
    return null;
  }
  return section(
    "Address This From The Last Pass",
    [ctx.carry.summary, "", "Incorporate this and continue — do not restart from scratch."].join("\n"),
  );
}
