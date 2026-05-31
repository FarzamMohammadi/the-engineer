import type { Route, SubPhase, SubPhaseResult } from "../types.js";
import { skipWhenPushOnly } from "./deliverable.js";

// ── The Sub-Phase ────────────────────────────────────────────────────────────
//
// auto-merge merges the approved PR. It is entry-only: the normal advance path
// blocks at await-review and never reaches it. It is reached only when an
// external `pr_ready_to_merge` event re-enters the task at this sub-phase (a
// later session wires that). Built dark here as a routing shell. Skipped in
// push-only mode, which has no PR to merge.

/** Delivery: merge the approved PR. Entry-only — reached by an external event, not by advance. Skipped in push-only. */
export const autoMerge: SubPhase = {
  name: "auto-merge",
  skip: skipWhenPushOnly,
  run: runAutoMerge,
  next: autoMergeNext,
};

/** A completed merge is terminal: the deliverable — a merged pull request — now exists, so the task is done. */
export function autoMergeNext(): Route {
  return { go: "done" };
}

// TODO(farzam): the live merge (git-hosting mergePR, safety-gated, branch-introduced thoughts
// removed first) lands at the external re-entry session, where auto-merge is reached via entryFor
// on a pr_ready_to_merge event. Shelled here so its routing is exercisable dark.
function runAutoMerge(): Promise<SubPhaseResult> {
  return Promise.resolve({
    outcome: "ok",
    summary: "PR ready to merge; the merge is wired at the external re-entry session",
  });
}
