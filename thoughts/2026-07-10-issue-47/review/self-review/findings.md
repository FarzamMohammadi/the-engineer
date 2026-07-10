# Self-Review — Issue #47: Host-blocked merge loops into rework

Date: 2026-07-09
Reviewer pass: self-review (holistic last look)
Verdict: **Clean — ship it.** No blocking findings.

## What I reviewed

- Full `git diff main` across all 10 non-thoughts files (contract, plugin, two Core files, docs, bundle, 3 tests).
- Requirements, plan, and execution reports, walked against the diff.
- Ran the three affected unit suites live: **121 passed / 121** (pr-event-poller 20, auto-merge 25, github-hosting 76).
- Working tree clean except my own `thoughts/…/review/` folder; commit history is two clean commits (code + thoughts trail). No stray files, no debug logging, no leftover scaffolding.

## Does it do what was asked? — all 8 acceptance criteria walked against the code

1. **Host-won't-complete merge never reworks** — ✔ Three independent guards: `decideReadiness` diverts `blocked → needs_human_merge` *before* any `mergePR` (auto-merge.ts:224); the poller escalates instead of promoting (pr-event-poller.ts:159); `derivePrEvents` withholds both `pr_ready_to_merge` and `pr_merge_conflict` for a blocked PR (test at github-hosting.test.ts:729).
2. **Unhonored `/approve` surfaced with actionable reason** — ✔ `escalateMergeBlocked` blocks under `need_more_info`/`awaiting_human`, records a decision, and sends `alert` + `ticket_comment` with a concrete "approve on the host, then `engineer retry`" message.
3. **Re-entry path bounded** — ✔ Structural, not a counter: the escalation moves the task off the `pr_review_pending` poll set, so the next poll's `getBlockedTasksByReason(pr_review_pending)` no longer returns it. `pending_pr_event` is also cleared defensively. The auto-merge backstop routes to `done`. The dedicated loop-bound test confirms a second poll does nothing.
4. **Real host signal, not just boolean `mergeable`** — ✔ Plugin now reads `pr.mergeable_state` (already on the same `pulls.get` response — no extra API call) and maps the exact `"blocked"` string to the new contract value.
5. **Genuine merge unchanged** — ✔ Ordering in `mapMergeState` preserves `true → mergeable` for `clean`/`unstable`/`has_hooks`/`behind`; regression tests re-assert. Verified by deletion-sensitivity: removing the blocked branch makes the auto-merge test's `mergePR not called` fail, so the test exercises the real path.
6. **Plugin/Core boundary honored** — ✔ `mergeable_state` is read only inside the GitHub plugin; Core switches solely on the contract `merge_state` string. A second hosting plugin inherits the safety by returning `"blocked"`.
7. **Genuine conflict still reworks** — ✔ `mergeable === false → conflicting` is checked before the blocked branch and is unchanged; `conflicting → merge_conflict → execution` rework intact; regression test retained.
8. **Tests + gates** — ✔ New tests at all three seams; the 121 I ran pass; execution reports full `typecheck`/`lint`/`test:all`/`check:exports` green. #46 (CI debounce) correctly left out of scope.

## Does it earn its keep?

Yes. The change is minimal for what it accomplishes.
- The **two escalation sites** (poller front line + auto-merge race backstop) are genuine defense-in-depth, not duplication — different triggers (a live `/approve` vs. a detect→merge race), one shared contract value. The plan justified this (D5) and it holds up.
- No new config knob, no new `BlockCategory`, no new `PrEvent` type, no new counter — the fix reuses the existing `awaiting_human`/`need_more_info` block ladder and the proven `needs_human_merge → done` hand-off. This is the smaller-than-the-first-draft shape.
- `mapMergeState`'s ordering carries real structural meaning (the "blocked reports mergeable === true" trap) and the doc comment names it — cut noise, not this.

## Would it surprise the next reader?

No. Names say what they mean (`resolveApproveDisposition`, `escalate_blocked`, `escalateMergeBlocked`). The tri-state refactor of `shouldPromoteApproval` reads cleanly and is documented. Comments explain the non-obvious ordering and the `false` argument to `notifyHostBlockedMerge` (no cleanup push happened in the readiness path). Consistent with the surrounding `escalateBlockerCap` pattern it mirrors.

## Non-blocking observations (recorded, not defects)

- **Escalation message wording vs. block cause.** The owner-facing message says the block "needs a formal review approval a `/approve` comment cannot provide." `mergeable_state === "blocked"` *can* also arise from a required status check rather than a required review. The `checks_state === "passing"` gate makes the required-review case by far the most likely, and the message's fallback ("or adjust its branch protection") plus the correct routing (escalate, never loop) hold regardless of the precise cause. Not worth widening now; noting for awareness.
- **Formally-approved-but-blocked PR waits silently.** A PR with a *formal* approval that is nonetheless `blocked` emits no events (derivePrEvents → `[]`) and no `/approve` comment, so it neither escalates nor reworks — it simply waits in the poll set. This is correct per the requirements ("waits … or escalates") and is a pre-existing, out-of-scope edge (the ticket is specifically about the `/approve` comment path). No regression.

## Bottom line

Correct, complete against every criterion, appropriately small, well-named, and covered by deletion-sensitive tests. Nothing to send back.
