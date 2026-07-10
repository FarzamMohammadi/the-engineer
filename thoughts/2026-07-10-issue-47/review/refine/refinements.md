# Refinement — Issue #47: Host-blocked merge loops into rework

Date: 2026-07-09
Role: refine (final quality gate before delivery)
Verdict: **ship** — no code changes needed.

## Lenses consolidated

- **self-review** — one lens, "Clean — ship it," no blocking findings; two non-blocking
  observations. I re-checked both against the code and agree they are out-of-scope and
  correctly handled (see below). No duplicates to merge, nothing to drop.

## My independent pass (assume issues until proven otherwise)

I did not take the lens's word for it. I read every non-thoughts file in `git diff main`
and walked all three seams and all eight acceptance criteria against the actual code.

### Seam 1 — Poller `/approve` path (`src/core/daemon/pr-event-poller.ts`)
- `resolveApproveDisposition` returns `escalate_blocked` on `merge_state === "blocked"`,
  gated on `checks_state === "passing"` symmetric with `promote` (a red-CI blocked PR
  falls through to the normal CI-rework path).
- `escalateMergeBlocked` re-blocks under `need_more_info` / `awaiting_human` — which moves
  the task off the `pr_review_pending` poll set (the structural loop bound), clears
  `pending_pr_event` defensively, records the decision, and sends an actionable `alert` +
  `ticket_comment`. Mirrors the proven `escalateBlockerCap` shape. **AC 2, 3 met.**

### Seam 2 — Auto-merge readiness (`.../delivery/auto-merge.ts`)
- `decideReadiness` diverts `blocked → needs_human_merge` *before* any `mergePR` call, so no
  doomed merge and no branch re-push. Routes to `done` (default in `autoMergeNext`), terminal.
  **AC 1 met.**
- `conflicting → merge_conflict → execution` is checked first and unchanged; the merge-failure
  classifier keeps `conflict → merge_conflict` (rework) and `not_mergeable → needs_human_merge`
  (hand-off). **AC 7 met — real conflicts still rework.**

### Seam 3 — Plugin + contract (`github-hosting.ts`, `schemas/adapters.ts`)
- `mapMergeState(mergeable, mergeable_state)` now reads the real host signal, ordered so
  `null → unknown`, `false → conflicting`, `"blocked" → blocked`, else `mergeable`. The
  `blocked` check precedes the `true → mergeable` collapse (a blocked PR reports
  `mergeable === true`); `behind` deliberately stays `mergeable`. **AC 4 met.**
- `derivePrEvents` withholds both `pr_ready_to_merge` and `pr_merge_conflict` for a blocked PR,
  and still emits `pr_ready_to_merge` for approved + green + `mergeable`. **AC 5 met.**
- Host-specific detection is confined to the plugin; Core switches solely on the contract
  `merge_state` string. **AC 6 met — a second plugin inherits the safety by returning `blocked`.**

### Tests (**AC 8 met**)
- New tests at all three seams: poller escalation + loop-bound (2), auto-merge blocked hand-off
  (1), plugin `blocked`/`behind` mapping (2), `derivePrEvents` blocked withholding (1).
- Deletion-sensitive: removing the `blocked` branch from `decideReadiness` makes a blocked PR
  fall through to `merge`, so `mergePR not called` would fail — the test exercises the real path.

## Non-blocking observations (verified, not defects)

1. **Escalation wording vs. exact block cause.** `mergeable_state === "blocked"` can arise from a
   required status check as well as a required review; the message names the required-review case.
   The `checks_state === "passing"` gate makes required-review by far the likely cause, and the
   message's "or adjust its branch protection" fallback plus the correct routing hold regardless.
   Widening now would be scope the ticket did not ask for. Left as-is.
2. **Formally-approved-but-blocked PR waits silently.** A PR with a *formal* approval that is
   nonetheless `blocked` emits no event and no `/approve`, so it waits in the poll set rather than
   escalating. This is correct per the requirement ("waits … or escalates"), pre-existing, and
   outside the ticket's `/approve`-comment scope. No regression.
3. **`done` vs `block` asymmetry for host-blocked hand-off.** The poller `/approve` path escalates
   to a `block` (awaiting_human, resumable via `engineer retry`); the auto-merge race/failure path
   routes to `done` with an owner notification. Both are valid "hand off to owner, never loop"
   responses; the auto-merge path is a narrow race backstop (mergeable at detection → blocked at
   merge) and matches the existing `auto_merge_disabled → done` convention. Not a defect.

## Gates (re-run at refine)
- `npm run typecheck` — clean.
- `npm run lint` (biome + tsc + tsc test + knip + madge) — clean, no circular deps.
- `npm run test:unit` — 147 files, **2823 / 2823 passed**.

## Decision
No code fix was required — the change is correct, complete against every criterion, minimal,
well-named, well-documented, and covered by deletion-sensitive tests at all three seams. No
commit made (no code change). **Ship.**
