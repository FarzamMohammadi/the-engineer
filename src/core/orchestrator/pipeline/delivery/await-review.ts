import { BlockCategories, type Route, type SubPhase, type SubPhaseResult } from "../types.js";
import { skipWhenPushOnly } from "./deliverable.js";

// ── The Sub-Phase ────────────────────────────────────────────────────────────
//
// await-review is where a PR-mode task waits. Its run reports that the PR is open
// and waiting; its next parks the task in the awaiting_pr_review block and exits
// the pipeline. The task resumes when an external review event re-enters it (a
// later session wires that re-entry). Skipped in push-only mode.

/** Delivery: park the task on its open PR until an external review event resumes it. Skipped in push-only mode. */
export const awaitReview: SubPhase = {
  name: "await-review",
  skip: skipWhenPushOnly,
  run: runAwaitReview,
  next: awaitReviewNext,
};

/**
 * await-review hands the task into the waiting state and exits the pipeline. This is a `block`,
 * not a failure — `awaiting_pr_review` is an expected wait that an external event (approval, new
 * feedback, CI result) resolves by re-entering the task on a fresh dispatch.
 */
export function awaitReviewNext(): Route {
  return {
    go: "block",
    category: BlockCategories.awaiting_pr_review,
    needed: "Waiting on the open PR — an approval with CI green and mergeable, or new feedback, resumes the task",
  };
}

// TODO(farzam): external review events (GitHostingAdapter.detectPrEvents) re-enter the task via
// entryFor at the external re-entry session; this shell only routes the task into the wait.
function runAwaitReview(): Promise<SubPhaseResult> {
  return Promise.resolve({ outcome: "ok", summary: "Pull request open; awaiting an external review event" });
}
