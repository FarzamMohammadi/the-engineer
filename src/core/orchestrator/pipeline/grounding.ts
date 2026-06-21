import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

import { ComplexitySchema } from "../../../schemas/orchestrator.js";
import type { Ctx, SkipReason } from "./types.js";

// ── The Grounding Handoff ────────────────────────────────────────────────────
//
// What requirements learns by acclimating to the project — how complex the task
// is, the concrete conditions that mean it is done, and how the project verifies
// work — recorded in its session-result details and consumed downstream:
// complexity gates research/planning skip, the acceptance criteria are the
// queryable end-state the review gates on (and are mirrored onto the task row so
// the dashboard can show them), and the verification commands are what `verify`
// runs. Grounding happens once, up front, in the always-present first phase;
// later steps read it rather than re-deriving.

const REQUIREMENTS_DIR = "requirements";
const RESULT_FILE = "session-result.json";

/** One command the project uses to verify correctness — typecheck, lint, test, or build. */
export const GateCommandSchema = z.object({
  /** Human label for the gate, e.g. "typecheck". */
  name: z.string(),
  /** Executable to run, e.g. "pnpm". */
  command: z.string(),
  /** Arguments passed to the executable, e.g. ["run", "typecheck"]. */
  args: z.array(z.string()).default([]),
});
export type GateCommand = z.infer<typeof GateCommandSchema>;

/** The project knowledge requirements records by grounding — the contract its `details` payload satisfies. */
export const GroundingSchema = z.object({
  complexity: ComplexitySchema.default("moderate"),
  /** The concrete, checkable conditions that mean the task is done — the end-state the review gates on. */
  acceptance_criteria: z.array(z.string()).default([]),
  verification: z.object({ commands: z.array(GateCommandSchema).default([]) }).default({ commands: [] }),
});
export type Grounding = z.infer<typeof GroundingSchema>;

// ── Reading Grounding Downstream ─────────────────────────────────────────────

/**
 * Read the grounding requirements recorded, from its `session-result.json` details. Returns
 * null when there is no workspace, no requirements result yet, or the details do not parse —
 * every caller treats null as "fall back to the safe default" (don't skip, no gates).
 */
export function readGrounding(ctx: Ctx): Grounding | null {
  if (!(ctx.worktreePath && ctx.thoughtsDir)) {
    return null;
  }
  const file = path.join(ctx.worktreePath, ctx.thoughtsDir, REQUIREMENTS_DIR, RESULT_FILE);
  if (!existsSync(file)) {
    return null;
  }
  try {
    const raw = JSON.parse(readFileSync(file, "utf-8")) as { details?: unknown };
    const parsed = GroundingSchema.safeParse(raw.details ?? {});
    if (!parsed.success) {
      ctx.observer.debug("Requirements grounding details did not parse — using safe defaults (no skip, no gates)", {
        taskId: ctx.task.id,
        error: parsed.error.message,
      });
      return null;
    }
    return parsed.data;
  } catch (error) {
    ctx.observer.debug("Requirements session-result is unreadable or not JSON — using safe grounding defaults", {
      taskId: ctx.task.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** Whether requirements assessed the task as trivial — the signal research and planning skip on. */
export function isTrivial(ctx: Ctx): boolean {
  return readGrounding(ctx)?.complexity === "trivial";
}

/** Build a sub-phase `skip` predicate that fires on a trivial task, carrying the phase's own reason. */
export function skipIfTrivial(reason: string): (ctx: Ctx) => SkipReason | null {
  return (ctx) => (isTrivial(ctx) ? reason : null);
}

/** The verification commands requirements learned, or an empty list when none were recorded. */
export function verificationCommands(ctx: Ctx): readonly GateCommand[] {
  return readGrounding(ctx)?.verification.commands ?? [];
}

/** The acceptance criteria requirements recorded — the end-state the review gates on, or an empty list when none. */
export function acceptanceCriteria(ctx: Ctx): readonly string[] {
  return readGrounding(ctx)?.acceptance_criteria ?? [];
}
