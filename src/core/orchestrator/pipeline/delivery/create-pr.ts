import type { Route, SubPhase, SubPhaseResult } from "../types.js";
import { skipWhenPushOnly } from "./deliverable.js";

// ── The Sub-Phase ────────────────────────────────────────────────────────────
//
// create-pr opens the pull request. PR mode only — it skips in push-only mode.
// Built dark here as a routing shell; the live createPR call lands at the
// delivery wiring session.

/** Delivery: open the pull request. Skipped in push-only mode. */
export const createPr: SubPhase = {
  name: "create-pr",
  skip: skipWhenPushOnly,
  run: runCreatePr,
  next: createPrNext,
};

/** Once the PR is open, advance to await-review, which parks the task until a review event arrives. */
export function createPrNext(): Route {
  return { go: "advance" };
}

// TODO(farzam): the live PR creation (git-hosting createPR with the composed body, recording the
// PR number on the task) lands at the delivery wiring session, where the git-hosting plugin and
// the finalized review state are in place. Shelled here so delivery's routing is exercisable dark.
function runCreatePr(): Promise<SubPhaseResult> {
  return Promise.resolve({ outcome: "ok", summary: "Pull request opening is wired at delivery cutover" });
}
