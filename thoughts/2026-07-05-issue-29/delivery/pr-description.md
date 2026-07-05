# PR Presentation — Issue #29

_Phase: delivery · Date: 2026-07-05 · Base: `origin/main` (ccb7e56)_

## Title

```
Treat transient CI-status lookup errors as unknown, not failing
```

## Body

```markdown
## What & why

When The Engineer polls an open PR, the GitHub hosting plugin resolves the PR's CI/check
status. If that **lookup itself** failed transiently — a network blip, `ECONNRESET`, a dropped
connection, a rate-limit hiccup — the plugin reported `checks_state: "failing"`. That derived a
`pr_ci_failure` event and re-entered the task into a full rework cycle (dismiss review →
re-execute → review → re-push → notify) to "fix" a failure that never existed. The checks may
have been green; it was the *lookup* that failed, not the CI. Observed live on PR #28: a
successful CI run, then ~27 minutes later one poll hit `read ECONNRESET` and burned a phantom
rework pass on noise.

The root cause is that the code conflated two different things — **"CI failed"** (we checked, the
checks are red) and **"we couldn't check CI"** (the lookup errored, so the state is *unknown*) —
collapsing both to `failing`. This change separates them: a lookup error is now a distinct
`unknown` state on which the engine takes no action, while still never claiming CI is `passing`
on unverified data.

## How

- **New `unknown` checks state.** `PRStatusSchema.checks_state` (`src/schemas/adapters.ts`) gains
  a fifth value, `unknown`, mirroring the established `merge_state: "unknown"` precedent ("not yet
  known — wait, don't act"). The local `ChecksState` type in the GitHub plugin is widened to match.
- **Lookup error → `unknown`, never `failing`.** `getChecksState`'s `catch` now returns `unknown`
  instead of `failing`. Any error in either underlying call (Status API or Checks API) maps to
  `unknown` — a partial failure never salvages the other source's answer, so the plugin never
  reports `passing` on an unverified lookup.
- **No action on `unknown`.** `unknown` matches neither the `=== "failing"` branch (so **no**
  `pr_ci_failure` → no rework) nor the `=== "passing"` branch (so **no** `pr_ready_to_merge` and
  no `/approve` promotion) in event derivation. The task simply stays waiting and re-checks next
  poll.
- **Latent auto-merge safety bug fixed.** `decideReadiness` (`auto-merge.ts`) previously fell
  through to `disposition: "merge"` for any non-`failing`/`pending` CI state — so once `unknown`
  existed, the live re-check hitting the same blip would have **merged unverified code**. Added an
  `unknown → retry_wait` branch (the twin of the existing `merge_state === "unknown"` branch),
  preserving "never auto-merge on unverified status."
- **Confirmation policy (owner-delegated) resolved to "no confirmation."** A genuine red check
  still routes to rework immediately, unchanged. The "a single flaky reading never triggers
  rework" property is delivered *structurally* — lookup errors map to `unknown`, never `failing`,
  so it holds regardless of confirmation policy. Rationale recorded in the `catch` comment and the
  planning trail.
- **Docs + generated bundle.** Updated `docs/plugins/git-hosting/README.md` and
  `github-hosting.md`, and regenerated `src/cli/bundled/plugin-docs.ts` via `pnpm run docs:bundle`
  (CI fails on drift).

## Verification

- **Gates (all green):** `pnpm run typecheck`, `pnpm run lint` (biome + tsc + knip + madge, no
  circular deps), `pnpm run test` (unit — 2817 passed), and `pnpm run test:integration`
  (67 passed). `pnpm run docs:bundle` produces zero drift.
- **Regression tests drive the real error path**, not a stubbed default:
  `mockRejectedValueOnce(new Error("read ECONNRESET"))` on the Checks API *and* independently on
  the Status API, asserting `checks_state === "unknown"` (never `"failing"`). Reverting the
  fallback to `"failing"` would redden them.
- **End-to-end** coverage asserts a transient lookup error yields `detectPrEvents → []` (no
  `pr_ci_failure`, no `pr_ready_to_merge`), plus dedicated cases for `decideReadiness → retry_wait`
  (auto-merge waits rather than merges) and `/approve` withholding promotion on `unknown`. The
  schema test accepts all five values and rejects an invalid one.
- **Worth a reviewer's eye:** the consumer audit — every reader of `checks_state` is an `if`
  comparison (no exhaustive `switch`), so widening the enum breaks nothing silently, and each
  reader was checked to treat `unknown` as neither pass nor fail.

## Risks & follow-ups

- **Persistent `unknown` = indefinite wait-and-recheck.** If the lookup keeps failing, the task
  waits and re-checks every poll with no escalation. This is the spec's prescribed behavior
  ("leave the task waiting and re-check on the next poll"), so it is accepted, not a gap — but it
  is the one behavioral edge to be aware of. No escalation-on-persistent-unknown was added.
- **Side effect (desirable):** a checks-lookup blip no longer ticks the poller's outer failure
  window, since `getChecksState` now returns `unknown` instead of throwing. A momentary check-read
  error no longer pauses all polling.
- **Out of scope:** a genuinely flaky *check conclusion* flipping red/green (as opposed to a
  *lookup* error) still routes to rework and is bounded only by the existing
  `max_blocker_reentries` cap. Not part of #29.
- **Contract surface:** `checks_state` is part of the `GitHostingAdapter` contract other hosting
  plugins implement. The change is purely additive (one new enum member); the sole in-repo
  implementer is `GitHubHostingPlugin`.
```

---

## Notes (delivery trail, not part of the PR body)

- Base for the shipping diff is `origin/main` (ccb7e56); local `main` was stale (7 commits behind),
  so `git diff main...HEAD` overstates the scope. True production change is 3 source files
  (`schemas/adapters.ts`, `github-hosting.ts`, `auto-merge.ts`), 2 docs + the regenerated bundle,
  and 4 test files. The `thoughts/` trail is stripped from the branch before merge.
- All gate results above are quoted from the refine phase's independent re-run
  (`review/refine/refinements.md`), which re-ran every gate rather than taking self-review on faith.
