# Refine — Issue #29 (transient PR check-status lookup → `unknown`)

## Pass: 2026-07-09

### Lens findings consolidated
Only one lens ran: **self-review** (`review/self-review/findings.md`). It reported **no code
defects** and a verdict of "ready", with two non-blocking notes (confirmation-policy record lives
in the stripped planning docs; local `main` is stale so `git diff main` is misleading — compare
against `origin/main`).

I did not take the self-review's "no findings" on faith. I re-derived the whole change
independently against `origin/main...HEAD` (12 files; the 2 `thoughts/` execution files are stripped
at merge) and re-audited every `checks_state` consumer myself.

### Independent audit of the change
The fix adds a fifth `checks_state` value, `unknown`, meaning "the lookup itself errored, so we
could not read the checks" — distinct from `failing` ("we read them, they are red").

- **Contract + local type** — `PRStatusSchema` (`src/schemas/adapters.ts:414`) and the local
  `ChecksState` type (`github-hosting.ts:547`) both gain `unknown`. ✓
- **Origin of `unknown`** — only the `catch` in `getChecksState` (`github-hosting.ts:576-589`)
  produces it. Any throw from either the Status API or Checks API call (both awaited in the same
  `Promise.all`) lands here → returns `unknown` directly, never salvaging a partial answer, never
  `failing`. Real transient modes (ECONNRESET, dropped connection, rate-limit 403/429) throw in
  Octokit and reach this catch. ✓
- **Every consumer handles `unknown` safely** (grepped all of `src/`, no consumer missed):
  - `derivePrEvents` `pr_ci_failure` (`github-hosting.ts:488`) — gated on `failing` only; `unknown`
    emits nothing → no phantom rework. ✓
  - `derivePrEvents` `pr_ready_to_merge` (`:504`) — requires `passing`; `unknown` never promotes. ✓
  - `/approve` promotion in the poller (`pr-event-poller.ts:204`) — requires `passing`; `unknown`
    withholds. ✓
  - `auto-merge.decideReadiness` (`auto-merge.ts:198,212,222`) — `failing`→`ci_failure`;
    explicit `unknown`→`retry_wait` **before** the terminal `merge` fall-through; `merge` now
    reachable only for `passing`/`none` + mergeable. The fall-through bug the acceptance criteria
    called out is fixed. ✓
- **Sibling path check** — a transient error on the PR-metadata fetch (`pulls.get`, upstream of
  `getChecksState` in `doGetPRStatus`) throws the whole `doDetectPrEvents`, which the poller catches
  at `pr-event-poller.ts:111` and returns **no event** — also safe, does not reintroduce the bug.
- **Docs** — both `docs/plugins/git-hosting/README.md` and `github-hosting.md` document `unknown`;
  the generated bundle `src/cli/bundled/plugin-docs.ts` was regenerated. I re-ran
  `pnpm run docs:bundle` → **no drift** (the CI-critical criterion). ✓
- **Tests are real, not tautological** — the github-hosting regression drives the actual `catch`
  via `mockRejectedValueOnce` and asserts `not.toBe("failing")`; it fails if the fallback ever
  reverts. Both API-error branches, the end-to-end `detectPrEvents` (→ `[]`), the `derivePrEvents`
  unit, the auto-merge `retry_wait`, the poller `/approve` withhold, and the schema accept/reject
  are all covered. ✓

### Gates (re-run by me on this tree)
- `pnpm run typecheck` → pass
- `pnpm run lint` → exit 0 (3 knip warnings are non-blocking and pre-existing, unrelated to this change)
- `pnpm test` → **2817/2817 pass**
- `pnpm run test:integration` → **67/67 pass**
- `pnpm run docs:bundle` → no drift

### Quality judgment
- `combineCheckStates` `unknown: 0` is **not** defensive noise — `Record<ChecksState, number>`
  forces exhaustive keys, so the entry is compulsory once the type gains `unknown`; the comment
  correctly names it unreachable-but-exhaustive. Keep.
- The `decideReadiness` `unknown` branch deliberately mirrors the `merge_state === "unknown"` twin
  and is well-commented on *why* (never merge on unverified CI). Keep.
- Scope is tight: only the files the behavior touches, plus docs and tests. No stray edits, no debug
  logging, no over-documentation of untouched code.
- Minor, non-defect: the summary comment at `auto-merge.ts:218` mentions `unknown` waits even though
  `unknown` is already handled at `:212` above. Accurate as an overview, not misleading; not worth
  churning a clean diff. Left as-is.

### Confirmation-policy criterion
The chosen policy — treat only the *lookup error* as `unknown` (no rework), while a genuine
completed red check still drives rework immediately with no extra confirmation — satisfies "a single
transient/flaky reading never triggers a rework," because transient failure modes throw and become
`unknown` rather than `failing`. The written record lived in the requirements/planning docs, which
are stripped from the branch before merge (configured behavior), so it is not verifiable from the
merged tree; the behavior itself correctly implements the policy and the code comments document the
load-bearing distinction. Not a code defect.

### Fixes applied this pass
**None.** No code defects survived the audit. The change is correct, complete, minimal, and reads
clearly. Nothing to fix in place; nothing traces to an earlier phase.

### Verdict: **ship**
Every acceptance criterion is met and independently verified; all four project gates pass on this
tree. Deliver it.
