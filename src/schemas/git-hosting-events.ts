import { z } from "zod";
import { PRCommentSchema } from "./adapters.js";
import { type PrEventType, PrEventTypeSchema, PrEventTypes } from "./git-hosting-event-types.js";

// ── PR Events ──────────────────────────────────────────────────────────────────
//
// The small typed vocabulary of pull-request events The Engineer reacts to. A git
// hosting plugin aggregates platform-specific state (reviewer statuses, check
// runs, mergeability) into these events; Core routes and arbitrates on them
// without knowing the platform behind them.
//
// Payloads stay deliberately thin. The event's type is the stable routing key the
// orchestrator's entryFor and arbitrate consume; only `pr_comments` carries data,
// because Core needs the comments to dedup against already-accommodated feedback
// and to find an authorized `/approve`. When a re-entered phase needs richer
// platform detail (which checks failed, which files conflict), the agent fetches
// it live through the plugin's query methods — it is not persisted on the task.
//
// The discriminant enum (`PrEventType`) lives in the dependency-free
// `git-hosting-event-types.ts` leaf so the task schema can persist a pending
// event's type without importing this file (which would cycle through the adapters
// schema). It is re-exported here so this stays the one place to import the vocabulary.

export { type PrEventType, PrEventTypeSchema, PrEventTypes };

/** Reviewer feedback to address — carries the comments so Core can dedup and find an authorized `/approve`. */
export const PrCommentsEventSchema = z.object({
  type: z.literal(PrEventTypes.pr_comments),
  comments: z.array(PRCommentSchema),
});
export type PrCommentsEvent = z.infer<typeof PrCommentsEventSchema>;

/** Checks are red. The re-entered phase fetches which checks failed live through the plugin. */
export const PrCiFailureEventSchema = z.object({ type: z.literal(PrEventTypes.pr_ci_failure) });

/** The base moved and the branch no longer merges cleanly. */
export const PrMergeConflictEventSchema = z.object({ type: z.literal(PrEventTypes.pr_merge_conflict) });

/** Approved, CI green, and mergeable all hold at once — the only state from which a merge proceeds. */
export const PrReadyToMergeEventSchema = z.object({ type: z.literal(PrEventTypes.pr_ready_to_merge) });

/** Merged, by us or externally. Terminal. */
export const PrMergedEventSchema = z.object({ type: z.literal(PrEventTypes.pr_merged) });

/**
 * One PR event. A discriminated union on `type` — the discriminant the orchestrator routes and
 * arbitrates on. Payloads are thin by design (see the module note); only `pr_comments` carries data.
 */
export const PrEventSchema = z.discriminatedUnion("type", [
  PrCommentsEventSchema,
  PrCiFailureEventSchema,
  PrMergeConflictEventSchema,
  PrReadyToMergeEventSchema,
  PrMergedEventSchema,
]);
export type PrEvent = z.infer<typeof PrEventSchema>;
