import { z } from "zod";

// ── PR Events ──────────────────────────────────────────────────────────────────
//
// The small typed vocabulary of pull-request events The Engineer reacts to. A git
// hosting plugin aggregates platform-specific state (reviewer statuses, check
// runs, mergeability) into these events; Core routes and arbitrates on them
// without knowing the platform behind them.
//
// The producer — GitHostingAdapter.detectPrEvents — and the per-variant payloads
// land in a later session. What is defined here is the routing vocabulary the
// orchestrator's entryFor and arbitrate consume: the event's type.

/** The kinds of PR event Core reacts to. The plugin computes which ones currently hold. */
export const PrEventTypeSchema = z.enum([
  "pr_comments", // actionable reviewer feedback
  "pr_ci_failure", // checks are red
  "pr_merge_conflict", // the base moved and the branch no longer merges
  "pr_ready_to_merge", // approved AND CI green AND mergeable, all at once
  "pr_merged", // merged, by us or externally
]);
export type PrEventType = z.infer<typeof PrEventTypeSchema>;

/** Constant enum values for PrEventType. Use instead of raw strings. */
export const PrEventTypes = PrEventTypeSchema.enum;

/**
 * One PR event. It carries its type — the discriminant the orchestrator routes and arbitrates
 * on. The plugin that produces these (a later session) enriches each variant with its payload;
 * the type is the stable routing key.
 */
export interface PrEvent {
  readonly type: PrEventType;
}
