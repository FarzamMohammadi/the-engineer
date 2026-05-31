import { z } from "zod";

// ── PR Event Types ───────────────────────────────────────────────────────────
//
// The discriminant vocabulary for the PR events The Engineer reacts to, split out
// as a dependency-free leaf so both the task schema (which persists the pending
// event's type as a re-entry signal) and the event payloads in
// `git-hosting-events.ts` (which need `PRComment` from the adapters schema) can
// reference it without forming an import cycle. The payload shapes live in
// `git-hosting-events.ts`; only the type key lives here.

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
