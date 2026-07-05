# Execution — Issue #29: Transient PR check-status lookup errors misread as CI failures

_Phase: execution · Source: github_issue FarzamMohammadi/the-engineer#29 · Date: 2026-07-05_

Implemented Approach A from the plan (add an `unknown` enum member to `checks_state`), end to end.
Every project gate passes. Below: what changed, why, what I verified, and the one place the code
diverged from the plan (and why the divergence was correct).

---

## What changed (by file)

### Production code

1. **`src/schemas/adapters.ts`** — `PRStatusSchema.checks_state` enum gained `"unknown"`:
   `z.enum(["passing", "failing", "pending", "none", "unknown"])`. Added a load-bearing comment above
   the field (mirroring the existing `merge_state` comment) stating `unknown` = the CI lookup itself
   errored, so the state could not be read; it is NOT `failing`; Core treats it as a wait — never
   rework, never merge — while still never claiming `passing` on an unverified lookup.

2. **`src/plugins/git-hosting/github-hosting/github-hosting.ts`**
   - Local `type ChecksState` widened to include `"unknown"`.
   - `getChecksState` `catch` now `return "unknown"` instead of `"failing"`, with a rewritten comment
     (records the P0 rationale: an unverified lookup is `unknown`, never `failing`, so a transient blip
     never reworks) and a rewritten log message: _"CI status lookup failed — reporting checks_state as
     unknown (will re-check next poll)"_. Kept the sanitized `error.message` field. Kept `Promise.all`
     (any error → `unknown`; no `allSettled` salvage — see plan §2 sub-decision).
   - **`combineCheckStates` priority record** gained `unknown: 0` — see "Divergence from the plan" below.

3. **`src/core/orchestrator/pipeline/delivery/auto-merge.ts`** — `decideReadiness` gained a distinct
   `if (status.checks_state === "unknown") return { disposition: "retry_wait", ... }` branch, placed
   right after the symmetric `merge_state === "unknown"` branch and before the `checks_state === "pending"`
   guard / the final `return { disposition: "merge" }`. This closes the latent safety bug: without it,
   `checks_state: "unknown"` fell through to `merge`, merging on unverified CI. Also updated the trailing
   comment so the ladder reads truthfully ("pending" and "unknown" wait). No new disposition was needed —
   `retry_wait` already exists in `MERGE_DISPOSITION_OPTIONS`.

### Docs (+ regenerated bundle)

4. **`docs/plugins/git-hosting/README.md`** — added `unknown` to the `checks_state` type union with a
   comment mirroring the `merge_state` one.
5. **`docs/plugins/git-hosting/github-hosting.md`** — added a sentence to the **PR status** paragraph
   (lookup error → `checks_state: unknown`, never `failing`, no partial salvage) and to the **Event
   detection** paragraph (transient CI-lookup error → `unknown` → no `pr_ci_failure`, task waits).
6. **`src/cli/bundled/plugin-docs.ts`** — regenerated via `pnpm run docs:bundle` (never hand-edited).
   Confirmed idempotent: a second `docs:bundle` produced no further change.

### Tests (the permanent regression guard)

7. **`tests/unit/schemas/adapters.test.ts`** — new case: `PRStatusSchema` accepts all five
   `checks_state` values (incl. `unknown`) and rejects an invalid one. Locks the contract.
8. **`tests/unit/plugins/git-hosting/github-hosting/github-hosting.test.ts`** — three new tests:
   - `getPRStatus()` with `checks.listForRef.mockRejectedValueOnce(new Error("read ECONNRESET"))` →
     `checks_state === "unknown"` (explicitly `not "failing"`). **This is the AC-#10 key regression** —
     it drives the *real* `catch`.
   - `getPRStatus()` with `getCombinedStatusForRef` rejecting → `unknown` (any error, no partial salvage).
   - `detectPrEvents()` end-to-end: a rejected checks lookup on the default approved/mergeable PR yields
     **no events at all** (no `pr_ci_failure`, no `pr_ready_to_merge`) — the task simply waits.
   - `derivePrEvents` unit: `checks_state: "unknown"` → `[]` (no failure event, no readiness).
9. **`tests/unit/core/orchestrator/pipeline/delivery/auto-merge.test.ts`** — new test:
   `checks_state: "unknown"` → `disposition: "retry_wait"`, `mergePR` **not** called. Locks the safety fix.
10. **`tests/unit/core/daemon/pr-event-poller.test.ts`** — new test: an authorized `/approve` on a PR
    whose re-check reports `checks_state: "unknown"` does **not** promote (`requestTransition` not called);
    the task keeps waiting.

---

## Divergence from the plan (recorded honestly)

**`combineCheckStates` priority record needed `unknown: 0` — not called out in the plan.**
Widening the local `type ChecksState` to include `"unknown"` broke the exhaustive
`Record<ChecksState, number>` literal in `combineCheckStates` (TypeScript: property `unknown` missing).
This is a pure typecheck consequence, not a behavior change: `combineCheckStates` is never actually
called with `unknown` — the `catch` returns `unknown` directly and never routes through the combiner,
and the two `resolve*ApiState` helpers only ever yield failing/pending/passing/none. I added
`unknown: 0` with a comment explaining exactly that (it keeps the record exhaustive; priority 0 means
it could never win were it ever combined). This is the minimal, faithful fix — no logic change.

Everything else matched the plan. The confirmation-before-rework policy was resolved to **P0 (no
confirmation)** in planning; execution honored it (a genuine successfully-read `failing` still reworks
immediately; only the *lookup error* becomes `unknown`). The P0 rationale is recorded in the `catch`
comment and the docs so a reviewer sees what was decided and why.

---

## Verification performed

- **`pnpm run typecheck`** — green (both `tsconfig` and `tsconfig.test.json`).
- **`pnpm run lint`** — green (biome check + tsc ×2 + knip + madge; no circular deps). One biome
  format wrap on the new schema test was applied via `biome format --write`.
- **`pnpm test`** (unit) — **2817 passed**, including `plugin-docs.test.ts` (the bundle-drift guard).
- **`pnpm run test:integration`** — **67 passed** (8 files), incl. `pipeline-review-delivery`.
- **Mutation check (the "test proves the fix" guard):** temporarily reverted the `catch` to
  `return "failing"` and ran the github-hosting suite filtered to `unknown` — both `getPRStatus`
  catch-path tests **failed** (`expected 'failing' to be 'unknown'`), proving they exercise the real
  error path and would catch a regression. Restored the fix immediately after.

---

## Status

`ok` — the change is complete, every gate is green, and the fix is proven by a regression test that
drives the real error path. Committed in logical units (feature change; then the thoughts trail).
