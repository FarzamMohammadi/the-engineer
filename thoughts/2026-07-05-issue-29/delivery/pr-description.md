# Treat a transient CI-status lookup error as `unknown`, not `failing`

## What & why

When the PR-event poller asks the git host for a PR's CI/check status and that **lookup itself**
fails transiently — a network blip, a dropped connection (`read ECONNRESET`), a rate-limit hiccup —
the engine reported the CI as **`failing`** and re-entered the task into a full rework cycle
(execution → review → delivery → re-push). But the checks may well have passed; it was the *lookup*
that failed, not the CI. This was observed live on PR #28: a green CI run, then ~27 minutes later a
single transient error, then a phantom `pr_ci_failure` that dismissed review state and burned a full
rework pass on noise.

The engine conflated "we checked and CI is red" with "we couldn't check CI." This change separates
them: a lookup error now resolves to a distinct **`unknown`** state, on which the engine takes **no
action** — it neither reworks nor merges, just leaves the task waiting and re-checks on the next
poll. The original safety property (never auto-merge on unverified status) is fully preserved.

## How

- **New `checks_state` value: `unknown`.** Added to the contract (`PRStatusSchema` in
  `src/schemas/adapters.ts`) alongside `passing | failing | pending | none`, and to the local
  `ChecksState` type in `github-hosting.ts`. It means "the lookup errored, so the CI state is
  genuinely undetermined" — deliberately *not* `failing`.
- **The lookup's `catch` now returns `unknown` instead of `failing`.** `getChecksState` awaits the
  Status API and Checks API together; any throw from either (the real transient modes — ECONNRESET,
  dropped connection, rate-limit 403/429 — all throw in Octokit) lands in this one `catch` and
  returns `unknown` directly. It never salvages a partial answer and never reports `failing`. The
  warning log was reworded so an operator can still distinguish a real CI failure from a lookup
  outage.
- **Every existing `checks_state` consumer already gates safely on `unknown`, with one fix.**
  `derivePrEvents` only emits `pr_ci_failure` on `failing` (so no phantom rework) and only promotes
  `pr_ready_to_merge` on `passing` (so `unknown` never auto-merges); the poller's `/approve`
  promotion likewise requires `passing`. The one gap — `auto-merge.ts`'s `decideReadiness`
  fall-through would have let `unknown` reach the terminal `merge` path — is fixed with an explicit
  `unknown → retry_wait` branch, mirroring the existing `merge_state === "unknown"` twin.
- **Confirmation policy (decided during design).** Only the *lookup error* becomes `unknown`; a
  genuinely completed red check still drives rework immediately, with no extra re-check or retry.
  This satisfies "a single transient/flaky reading never triggers a rework" because the flaky modes
  throw and become `unknown` rather than `failing` — so no confirmation delay is added to real
  failures. The load-bearing distinction is documented in the code comments at the `catch` site.
- **Docs updated and bundle regenerated.** `docs/plugins/git-hosting/README.md` and
  `github-hosting.md` now document `unknown`, and the generated `src/cli/bundled/plugin-docs.ts` was
  regenerated via `pnpm run docs:bundle` (CI fails on drift).

Net effect on `unknown`: no `pr_ci_failure`, no rework, no approval dismissal, no re-push, no
notification — the task stays blocked on `pr_review_pending` and is re-checked next poll. Genuine
`failing` still routes to rework; a genuine green + approved + mergeable PR still merges.

## Verification

- **Regression test** (`github-hosting.test.ts`): drives the real `catch` path via
  `mockRejectedValueOnce`, asserts `checks_state` is `unknown` and `not.toBe("failing")`, covers both
  API-error branches, and verifies the end-to-end `detectPrEvents` yields no event. It fails if the
  fallback ever reverts to `failing`.
- **Consumer tests**: `auto-merge.test.ts` asserts `unknown → retry_wait` (no merge);
  `pr-event-poller.test.ts` asserts the `/approve` path withholds promotion on `unknown`;
  `adapters.test.ts` asserts the schema accepts `unknown` and still rejects unknown values.
- **Project gates (re-run on this tree):** `pnpm run typecheck` pass · `pnpm run lint` exit 0 ·
  `pnpm test` 2817/2817 pass · `pnpm run test:integration` 67/67 pass · `pnpm run docs:bundle` no
  drift.

## Risks & follow-ups

- **Low blast radius.** The only behavioral change is the value returned when a lookup throws
  (`failing → unknown`); the passing and failing paths are untouched.
- **A persistently unreachable host now waits instead of reworking.** This is the intended trade —
  the task re-checks each poll rather than churning — and remains bounded by the daemon's existing
  stuck-task and per-task time limits, so it cannot wait forever unnoticed.
- **No confirmation/retry was added to genuine failures.** By design a real red check still reworks
  on the first reading; the fix targets only the lookup-error case, which is where the flakiness
  actually lived. Worth a second look only if a future host surfaces flaky *completed* readings that
  don't throw.
- **`combineCheckStates` carries an `unknown: 0` entry** that is never reached at runtime (the
  `catch` returns `unknown` directly). It exists only to keep the `Record<ChecksState, number>`
  exhaustive; the comment says so. Not dead defensiveness — the type requires it.
