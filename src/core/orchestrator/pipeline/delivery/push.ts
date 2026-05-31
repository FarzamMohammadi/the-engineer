import type { Route, SubPhase, SubPhaseResult } from "../types.js";

// ── The Sub-Phase ────────────────────────────────────────────────────────────
//
// push runs in both delivery modes — it is the entire deliverable in push-only
// mode and the safety net before the PR in PR mode. Built dark here as a routing
// shell; the live push lands at the delivery wiring session.

/** Delivery: commit any stragglers and push the branch. Runs in both modes. */
export const push: SubPhase = {
  name: "push",
  run: runPush,
  next: pushNext,
};

/** push always advances; the PR-vs-push-only difference is expressed by the downstream skip-gates. */
export function pushNext(): Route {
  return { go: "advance" };
}

// TODO(farzam): the live commit-stragglers + authenticated push (through the workspace manager,
// honoring the abort signal) lands at the delivery wiring session, alongside the finalized task
// state. Shelled here so the delivery shape, routing, and skip-gates are exercisable dark.
function runPush(): Promise<SubPhaseResult> {
  return Promise.resolve({
    outcome: "ok",
    summary: "Branch ready; the authenticated push is wired at delivery cutover",
  });
}
