## What & why

When a PR is approved through The Engineer's `/approve` comment convention but the git host's **branch protection** refuses the merge (GitHub reports `MERGEABLE` yet `mergeStateStatus: BLOCKED` / `reviewDecision: REVIEW_REQUIRED` — it wants a *formal* review a comment does not provide), the engine fell into an **infinite rework loop**: the poller re-promoted the same `/approve` to `pr_ready_to_merge` every poll → auto-merge attempted the merge → the host refused → the failure routed into `execution/implement` for a full rework cycle → the re-push re-blocked at await-review → the poller saw the same `/approve` again → forever. Each lap burned an agent cycle, re-pushed the branch, and climbed the cost with no counter ever stopping it (`max_blocker_reentries` doesn't classify `pr_ready_to_merge` as a blocker, so the cap never applied). It only ended when the owner force-merged.

This change makes the rule explicit: **a merge the host will not complete never drives rework.** Such a PR waits and re-checks, or escalates to the owner with an actionable reason — it never re-enters execution.

## How

The root cause was two conflations, fixed at their sources across the plugin/contract/Core boundary:

- **Contract gains a `blocked` state.** `PRStatus.merge_state` was `mergeable | conflicting | unknown` — it could not represent "mergeable in shape, but the host won't merge it." Added `blocked` (host-agnostic), distinct from `conflicting` (a textual conflict that *does* rework).
- **GitHub plugin reads the real signal.** `mapMergeState` now consults `mergeable_state` alongside the boolean `mergeable`. Ordering matters: `null → unknown`, `false → conflicting`, then `mergeable_state === "blocked" → blocked` **before** collapsing `true → mergeable` (a blocked PR reports `mergeable === true`, so a naive "true → mergeable" would mask the block). `behind` deliberately stays `mergeable` — an out-of-date branch is not a block. Host-specific detection stays entirely inside the plugin.
- **Auto-merge diverts `blocked` before attempting the merge.** `decideReadiness` maps `blocked → needs_human_merge` and hands off to the owner *before* any `mergePR` call — so there's no doomed attempt, no thoughts-cleanup re-push, no rework. `conflicting → merge_conflict → execution` is unchanged and checked first, so genuine conflicts still rework as today.
- **Poller escalates a `/approve` the host won't honor instead of re-promoting.** `shouldPromoteApproval` became `resolveApproveDisposition` returning `promote | escalate_blocked | wait`. On green-but-`blocked`, it escalates: blocks the task under `need_more_info` / `awaiting_human` (which moves it off the `pr_review_pending` poll set — **structurally bounding the loop to a single escalation**), clears `pending_pr_event` defensively, records the decision, and notifies the owner with the fix ("approve the PR on the host, or adjust branch protection, then `engineer retry`"). The `blocked` check is gated on `checks_state === "passing"`, symmetric with `promote`, so a red-CI blocked PR still falls through to the normal CI-rework path. A green + mergeable `/approve` still promotes unchanged.

Net effect: the "will this actually merge?" decision now uses the host's real signal, and every non-actionable outcome waits or escalates — only a confirmed, host-will-merge PR merges automatically.

## Verification

- Gates green: `typecheck` clean, `lint` clean (biome + tsc + tsc-test + knip + madge, no circular deps), `test:unit` **2823/2823** across 147 files.
- New unit tests at all three seams: poller escalation + loop-bound behavior, auto-merge blocked hand-off (no `mergePR` call), plugin `blocked`/`behind` mapping, and `derivePrEvents` withholding `pr_ready_to_merge`/`pr_merge_conflict` for a blocked PR.
- The auto-merge test is deletion-sensitive: removing the `blocked` branch from `decideReadiness` makes a blocked PR fall through to `merge`, so "`mergePR` not called" fails — the test exercises the real path, not a fallback.
- Docs regenerated for the git-hosting adapter contract (`merge_state` now includes `blocked`).
- Worth a reviewer's eye: the ordering in `mapMergeState` (the `blocked` check must precede the `true → mergeable` collapse) and the `checks_state === "passing"` gate on the escalation.

## Risks & follow-ups

- **Escalation wording vs. exact block cause.** `mergeable_state === "blocked"` can also arise from a required *status check* (not just a required review); the message names the required-review case. The `checks_state === "passing"` gate makes required-review by far the likely cause, and the "or adjust branch protection" fallback plus the routing hold regardless. Widening the message was out of scope.
- **Formally-approved-but-blocked PR waits silently.** A PR with a *formal* approval that is nonetheless `blocked` emits no event and no `/approve`, so it waits in the poll set rather than escalating — correct per the requirement ("waits … or escalates"), pre-existing, and outside this ticket's `/approve`-comment scope.
- **`done` vs `block` asymmetry.** The poller `/approve` path escalates to a resumable `block` (`engineer retry`); the auto-merge race/failure path routes to `done` with an owner notification (a narrow race backstop: mergeable at detection → blocked at merge). Both are valid "hand off, never loop" responses and match existing conventions.
- **Out of scope:** the CI non-final / re-running-checks debounce — sibling issue **#46**, which lives in different code and lands separately.
