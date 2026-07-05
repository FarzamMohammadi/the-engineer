# Self-Review — Issue #29: Transient PR check-status lookup errors misread as CI failures

_Phase: review · self-review lens · Date: 2026-07-05_

## Verdict

**Clean — ship it.** No findings. The change does exactly what was asked, every part earns its
keep, nothing would surprise the next reader, and what ships is scoped and drift-free. Details of
what I checked below, so a re-run or another lens does not re-derive it.

---

## What ships (the real PR diff)

⚠️ **Heads-up for anyone else reviewing (not a code defect):** the local `main` ref in this worktree
is **stale** — it points at `6252bfb`, seven commits behind `origin/main` (`ccb7e56`). So
`git diff main...HEAD` shows a *misleading* ~89-file diff that includes seven commits already merged
to origin/main (issues #38/#39/#41, the `requirements_gathering` retirement, etc.). The PR targets
**origin/main**, so the true shipping diff is `git diff ccb7e56..HEAD` — **18 files, exactly the
issue-29 scope**:

- Production: `src/schemas/adapters.ts`, `src/plugins/git-hosting/github-hosting/github-hosting.ts`,
  `src/core/orchestrator/pipeline/delivery/auto-merge.ts`
- Docs + generated bundle: `docs/plugins/git-hosting/README.md`,
  `docs/plugins/git-hosting/github-hosting.md`, `src/cli/bundled/plugin-docs.ts`
- Tests: the four unit files (adapters, github-hosting, auto-merge, pr-event-poller)
- The `thoughts/2026-07-05-issue-29/` trail (expected deliverable; stripped before the branch lands)

No stray files, no debug logging, no generated-output drift, no leftover scaffolding.

## Correctness & completeness (walked every acceptance criterion)

- **AC 1** — `checks_state` enum gains `"unknown"` (`adapters.ts:414`); local `ChecksState`
  widened (`github-hosting.ts:547`). ✔
- **AC 2** — `getChecksState` catch returns `"unknown"`, never `"failing"` (`github-hosting.ts`
  catch block). The regression test drives the **real** catch via
  `mockRejectedValueOnce(new Error("read ECONNRESET"))`, not a stubbed default. ✔
- **AC 3** — `derivePrEvents` red-check branch is `=== "failing"`; `unknown` falls through → no
  `pr_ci_failure`. Locked by a unit test and an end-to-end `detectPrEvents → []` test. ✔
- **AC 4** — Never auto-merged/promoted on `unknown`: new `decideReadiness` branch routes `unknown`
  to `retry_wait` **before** the `merge` fall-through (`auto-merge.ts:212`); poller
  `shouldPromoteApproval` is `=== "passing"` so `unknown` doesn't promote (`pr-event-poller.ts:204`).
  Both tested. ✔
- **AC 5** — On `unknown` the task simply waits: `detectPrEvents` emits `[]` (no rework notice, no
  dismissal, no re-push, no phantom notification). ✔
- **AC 6** — Genuine `failing`/`passing` untouched: the `=== "failing"` and `=== "passing"` branches
  are unchanged; P0 (immediate rework on a *real* red check) is the resolved policy. ✔
- **AC 7 — consumer audit independently re-verified.** I re-grepped `checks_state|checksState|
  ChecksState` across `src` (excluding the generated bundle). Every reader is accounted for: poller
  `=== "passing"` (fall-through, safe), auto-merge ladder `failing`/`unknown`(new)/`pending`/merge,
  derivePrEvents `failing` + `passing` (fall-through, safe), plus log-only interpolations and the
  value producers. **No exhaustive `switch` on `checks_state` exists**, so the enum widening breaks
  nothing silently, and no missed consumer treats `unknown` as pass or fail. ✔
- **AC 8** — Confirmation policy resolved to **P0 (no confirmation)** and recorded in plan §2, the
  `catch` comment, and the docs, with reasoning (poller is deliberately stateless; residual Mode-2
  risk is bounded by existing `max_blocker_reentries`). ✔
- **AC 9** — Both docs updated; bundle regenerated. **I re-ran `pnpm run docs:bundle` and confirmed
  zero drift** (working tree clean except my own `review/` dir). ✔
- **AC 10** — Regression test exercises the real error path and asserts `unknown` + no event + no
  merge. Execution also reports a mutation check (reverting to `"failing"` reddened the tests). ✔
- **AC 11 — gates independently re-run:** `pnpm run typecheck` green; the four touched test files
  pass (208 tests). Execution reported full unit (2817) + integration (67) green. ✔

## Does it earn its keep? (simplicity scrutiny)

- **Zero new files, zero new abstractions, zero new state.** The fix is one enum member, one changed
  return value, one new readiness branch, plus docs + tests. This is the minimal shape and it mirrors
  the already-shipped `merge_state.unknown` precedent — idiomatic, not foreign.
- **`combineCheckStates` gained `unknown: 0`** (`github-hosting.ts:639`). I verified this is
  *structure, not noise*: `resolveStatusApiState` and `resolveChecksApiState` only ever return
  `none/passing/pending/failing` (confirmed by reading both, lines 592–632), and the `catch` returns
  `unknown` directly without routing through the combiner — so `unknown` never actually reaches here.
  The entry is **required** to keep `Record<ChecksState, number>` exhaustive (TS won't compile
  without it), and the comment states exactly that. Correct to keep; do not "simplify" it away.
- **`Promise.all` kept (no `allSettled` salvage)** — deliberate and documented: on a partial API
  failure we cannot know what the failed source would have reported, so returning `unknown` preserves
  "never claim `passing` on unverified data." A real failure that coincides with a partial lookup
  error is merely deferred one poll, never masked as passing. Sound trade-off, clearly reasoned.

## Would it surprise the next reader?

No. Names say what they mean; the `unknown` semantics are spelled out in load-bearing comments that
match the surrounding `merge_state` convention. The comments are on the verbose side, but that is the
house style here (the sibling `merge_state` field carries the same weight of explanation) and each
one names a real safety constraint (P0 rationale, no-partial-salvage, why `unknown:0` exists). Nitpick
considered and dismissed: the comment at `auto-merge.ts:218` re-names `unknown` as a wait state even
though `unknown` already returned above — this is accurate and aids the reader's mental model of the
full ladder, not a defect.

## What I checked, concretely

- Read the full production + docs diff (`ccb7e56..HEAD`) and every touched source region.
- Independently re-grepped all `checks_state` consumers; confirmed the audit is complete and no
  exhaustive switch exists.
- Read `resolveStatusApiState` / `resolveChecksApiState` / `combineCheckStates` to validate the
  "`unknown` never reaches the combiner" claim.
- Read the full `decideReadiness` ladder to confirm `unknown → retry_wait` precedes the `merge`
  fall-through.
- Read all four test diffs; confirmed they drive real paths (real Octokit rejection), cover every
  fall-through consumer, and assert the *absence* of the harmful action.
- Ran `pnpm run typecheck` (green), the four touched test files (208 pass), and
  `pnpm run docs:bundle` (no drift).
