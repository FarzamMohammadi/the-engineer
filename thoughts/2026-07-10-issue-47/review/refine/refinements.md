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

---
---

# Refine — re-run pass, 2026-07-11: the reconciliation (criteria 9–13)

Date: 2026-07-11
Role: refine (final quality gate before delivery)
Verdict: **ship** — two test-quality defects found by the lens, **both fixed in place by me**, gates green.

## Lenses consolidated

- **self-review** (re-run pass) — verdict "correct, complete, earns its keep"; **2 findings**, both
  test-quality, no behavior defects. No duplicates to merge. I re-derived both against the actual
  code rather than trusting the write-up, and **both hold**. Nothing dropped.

Both findings are instances of one anti-pattern the standards call out by name: *a test that still
passes when the code it covers is deleted*. Both sat on the issue's headline invariant (the loop
bound). I fixed both, and then **proved the fixes bite by mutation-testing them** — I will not
replace one dead guard with another.

## Fix 1 — the loop-bound test was vacuous (confirmed, fixed)

`tests/unit/core/daemon/pr-event-poller.test.ts` — "cannot re-form the loop…".

**Confirmed the mechanism myself.** `setup()` stubs `getBlockedTasksByReason` as
`vi.fn().mockReturnValue([task])`; the test then called `.mockReturnValueOnce([])` and polled
**once**. `poll()` opens with `const tasks = prefetched ?? getBlockedTasksByReason(...)` and returns
at `if (tasks.length === 0)` (pr-event-poller.ts:63–66). So the single poll saw an **empty list and
exited before reaching any escalation code** — the `/approve` and `merge_state: "blocked"` fixtures
were never consulted. Both assertions were trivially true over nothing. There was no "first poll"
and no "later poll". It was the **only** test guarding acceptance criterion 3 (the previously
unbounded `pr_ready_to_merge` re-entry path — the headline of #47), and it would have stayed green
with the entire escalation deleted.

**Fix.** Rewrote it as a genuine two-poll test whose poll set is *derived from what the poller
actually wrote*, rather than stubbed by fiat: `getBlockedTasksByReason` is now a `mockImplementation`
that returns the task only while its written `blocked.reason` is still `pr_review_pending`. That makes
the test prove *the escalation's own write is the bound* — which is the actual claim.

## Fix 2 — the coherence chain's one unasserted link (confirmed, fixed)

`tests/unit/core/host-blocked-merge-contract.test.ts` — `expect(HOST_BLOCKED_MERGE_CATEGORY).toBe(BlockCategories.awaiting_human)`.

**Confirmed.** That restated the constant's own one-line definition — unfailable. Meanwhile the
comment claimed it proved `awaiting_human ⇒ need_more_info ⇒ off the poll set`, and that `⇒
need_more_info` link is **the entire loop-safety argument on the auto-merge path**: unlike the poller
(which writes `reason: need_more_info` literally), auto-merge returns only a *category*, and the reason
is derived by `toBlockReason()` (orchestrator/index.ts) — which **no test in this change touched**. Had
`toBlockReason` ever mapped `awaiting_human → pr_review_pending`, the auto-merge path would silently
rejoin the PR-event poll set — #47's loop returns — with every test still green.

**Fix.** Exported `toBlockReason` (a pure category→reason mapper) and replaced the tautology with the
behavioral assertion the comment already promised:
`toBlockReason(HOST_BLOCKED_MERGE_CATEGORY) === need_more_info` and `!== pr_review_pending`.
Also deleted the same tautology duplicated in the poller test (and its now-unused import) — the poller
test already asserts the category and reason on the real block write.

**On the export:** knip is satisfied (`ignoreExportsUsedInFile: true`, and it *is* used in-file); no
`exports` field in package.json, so this is an internal core module, not a published API surface — not
a public-API decision. Documented at the definition *why* it is exported: the mapping is load-bearing
for loop safety, not an internal detail.

## I proved the fixes bite (mutation testing)

A guard that cannot fail is the defect I was removing, so I did not take "green" on faith:

| Mutation | Old test | New test |
|---|---|---|
| `resolveApproveDisposition` never returns `escalate_blocked` (escalation deleted) | **passed** ✗ | **fails** ✓ |
| `toBlockReason(awaiting_human)` → `pr_review_pending` (loop silently returns) | **passed** ✗ | **fails** ✓ |

Both mutations reverted; `git diff` confirms only the intended `toBlockReason` export remains in `src/`.

## My own independent pass on the reconciliation (assume issues until proven otherwise)

I did not stop at the lens's findings. I re-derived the load-bearing claims and chased two risks of
my own that no lens raised:

- **`draft` → `blocked` (new, from the optional allowlist).** Reachable, and *routing-safe*: a draft PR
  is now handed off **before** any merge attempt, strictly better than the old behavior (attempt →
  405 → failure path). Recorded as a known limitation below, not a defect.
- **`behind` is allowlisted → `mergeable`, but the host refuses it when protection requires an
  up-to-date branch — can that loop like #47?** **No — proved it cannot.** GitHub answers a refused
  merge with **405**, which `classifyMergeError` maps to `not_mergeable` → `needs_human_merge` → the
  *same shared host-blocked contract* (blocked, off the poll set, resumable). The backstop catches it.
  And 409 → `conflict` → rework, so **genuine conflicts still rework** (AC 7 preserved). This is exactly
  the detect→merge race the two-site design exists for; it holds.
- Re-verified criteria 9–13 against the code: one contract on both paths (identical category *and*
  identical message string), `case "needs_human_merge" → {go:"block"}` before `default → done` (no false
  "completed" on an unmerged PR), and the conditional message ("if the host lets me" / "merge it
  yourself") that is honest whether or not the Engineer can ever complete the merge.

## Gates (run by me, on the final tree)

`typecheck` **PASS** · `lint` **PASS** (biome + tsc + tsc-test + knip + madge, exit 0) ·
`test:unit` **2837 passed** · `test:integration` **67** · `test:e2e` **16**. All green *after* the fixes.

## Known limitation (recorded, deliberately not fixed — not a defect)

**The hand-off message names branch protection as the cause, but `mergeable_state: "blocked"` is a
catch-all.** With the new allowlist, a `draft` PR (or any future GitHub state) also maps to `blocked`,
and would receive a message about "a formal review approval". The **routing is correct and safe in every
case** (hand off, never rework, never loop, stays resumable) and the *promise* stays honest — only the
diagnosed cause can be imprecise on a rare state the Engineer never creates itself. Diagnosing every
`mergeable_state` precisely would mean widening the contract past what #47 asked for, so I left it and
named it here instead. The common case — the one the issue is actually about — is worded exactly right.

## Bottom line

The two findings were real, both were mine to fix, and both are fixed and mutation-proven rather than
merely green. The shipped behavior already satisfied criteria 1–13; what was missing was a *live* guard
on the invariant that matters most. It is live now. Nothing remains that belongs to an earlier phase —
no requirement is unclear, no plan is wrong, no re-implementation is needed. **Ship.**
