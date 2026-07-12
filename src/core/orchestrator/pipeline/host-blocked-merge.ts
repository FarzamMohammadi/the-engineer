import { BlockCategories } from "../../../schemas/task.js";

// ── The Host-Blocked Merge Contract ──────────────────────────────────────────
//
// What a host reports as protection-`blocked` is a verdict on its own rules (a required review is
// missing), not on whether the merge can be completed: a token with admin rights on a repo that
// permits a bypass merges such a PR normally. So a `blocked` PR is never refused up front — the
// poller promotes an authorized `/approve` on it, and delivery's auto-merge calls the host and lets
// the host decide.
//
// This module is the other half: what a REFUSED merge resolves to. It is reached from auto-merge's
// merge-failure path, and it defines that resolution once — one block category, one owner-facing
// message — so no second, contradictory hand-off can grow up beside it.
//
// Why blocked-resumable, and NOT `done`:
//   - `done` marks the task `completed` and posts "Task completed successfully." on a PR that
//     is NOT merged — a false completion, on the owner's own PR thread.
//   - `completed` is not a retryable state and the worktree is destroyed on completion, so the
//     outcome the message promises (clear the block on the host, retry, and the merge finishes)
//     becomes *impossible*.
//   - `awaiting_human` collapses to the `need_more_info` block reason, which takes the task OFF
//     the `pr_review_pending` poll set — so a refused merge cannot be re-promoted and re-attempted
//     on the next poll — and puts it ON the health monitor's blocked-escalation ladder: the owner is
//     nudged, a self-unblock is attempted once, and a task that never delivers ends `failed` rather
//     than falsely `completed`.
//
// Do not "simplify" this back into a completion.

/**
 * The lifecycle target for a merge the host refused. `awaiting_human` ⇒ `need_more_info` ⇒ off the
 * PR-review poll set (which is what stops a refused merge from being re-attempted every poll) and onto
 * the blocked-escalation ladder (the honest terminal). The task stays resumable: once the owner clears
 * the block on the host, `engineer retry` re-checks and merges.
 */
export const HOST_BLOCKED_MERGE_CATEGORY = BlockCategories.awaiting_human;

/**
 * The one owner-facing message for a merge the host refused — used verbatim as the block's `needed`,
 * so the hand-off reads the same wherever it is raised.
 *
 * It is deliberately conditional ("if the host lets me"). `mergeable_state === "blocked"` is a
 * catch-all: it cannot tell a required review the owner CAN add (the Engineer merges on retry) from a
 * merge restriction the Engineer can NEVER satisfy (only the owner can merge). Rather than pay a
 * GraphQL `reviewDecision` call plus engine-identity matching to guess — and risk a confidently wrong
 * promise — the message is worded to hold true in both worlds. It must never promise an unconditional
 * "I'll merge it".
 *
 * @param prNumber The PR the host blocked, or `null` when the caller has none on record.
 * @param approvalDismissed Whether the pre-merge thoughts-cleanup push dismissed a *formal* approval
 *   (`dismiss_stale_reviews`) — reachable only from auto-merge's merge-failure backstop. The owner must
 *   then re-approve, not approve, so the message says so.
 */
export function hostBlockedMergeNeeded(prNumber: number | null, approvalDismissed: boolean): string {
  const pr = prNumber === null ? "The pull request" : `PR #${String(prNumber)}`;
  const cause = approvalDismissed
    ? `${pr} is ready, but my thoughts-cleanup commit dismissed your earlier approval, and the host's branch protection now blocks the merge. Re-approve the PR on the host`
    : `${pr} is approved and green, but the host's branch protection won't let me complete the merge — it needs a formal review approval that a "/approve" comment cannot provide. Approve the PR on the host (or adjust its branch protection)`;
  return `${cause}, then run "engineer retry": I'll re-check and merge it if the host lets me. If it still refuses (for example, I don't have permission to merge), merge it yourself — the branch and the PR are ready.`;
}
