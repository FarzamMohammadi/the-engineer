# Self-Review — Issue #29 (transient PR check-status lookup → `unknown`)

## Pass: 2026-07-09 (base-update re-run)

### What I reviewed
The real change under review is the diff of the branch against **`origin/main`**, not local
`main`. Local `main` (`6252bfb`) is stale — the branch merged `origin/main` in, so `git diff main`
is polluted with ~70 unrelated files that belong to `origin/main` (agent-activity, dashboard
vocabulary, task-engine, migrations, premise_conflict, etc.). The issue #29 change is 12 files:

- `src/schemas/adapters.ts` — `checks_state` enum gains `unknown`.
- `src/plugins/git-hosting/github-hosting/github-hosting.ts` — `ChecksState` type, `getChecksState`
  catch, `combineCheckStates` priority record.
- `src/core/orchestrator/pipeline/delivery/auto-merge.ts` — `decideReadiness` routes `unknown` → `retry_wait`.
- Docs: `docs/plugins/git-hosting/README.md`, `github-hosting.md`, regenerated `src/cli/bundled/plugin-docs.ts`.
- Tests: github-hosting, auto-merge, pr-event-poller, adapters.

### Verification I ran
- Regenerated the docs bundle (`pnpm run docs:bundle`) → **no drift** (CI-critical criterion).
- Ran the four affected unit suites → **208/208 pass**, including the new regression tests that
  drive the real `catch` via `mockRejectedValueOnce`.
- Audited every `checks_state` consumer in `src/` by grep:
  - `github-hosting.ts:488` `derivePrEvents` — emits `pr_ci_failure` only on `failing`; `unknown` → nothing. ✓
  - `github-hosting.ts:504` — `pr_ready_to_merge` gated on `passing`; `unknown` never promotes. ✓
  - `pr-event-poller.ts:204` — `/approve` promotion gated on `passing`; `unknown` withholds. ✓
  - `auto-merge.ts:212` — explicit `unknown` → `retry_wait` before the terminal `merge` fall-through. ✓
  No consumer reads `unknown` as passing (merge) or failing (rework).

### Assessment against acceptance criteria
Every criterion I can verify from the tree is met:
- Contract + local type both gain `unknown`. ✓
- Any lookup error (either the Status API or Checks API call) → `unknown`, never `failing`; the
  catch returns directly, never salvaging a partial answer. The real transient modes (ECONNRESET,
  dropped connection, rate-limit 403/429) all throw in Octokit, so they reach the catch. ✓
- No `pr_ci_failure`, no auto-merge, no promotion, no re-push on `unknown` — task stays waiting. ✓
- Genuine `failing`/`passing` behavior preserved (still routes to rework / merges). ✓
- Auto-merge fall-through fixed; regression tests exercise the real error path. ✓
- Docs updated in both files + bundle regenerated with no drift. ✓

### Judgment on "does it earn its keep?"
- The `combineCheckStates` `unknown: 0` entry is **not** defensive noise: `Record<ChecksState, number>`
  requires exhaustive keys, so once `ChecksState` includes `unknown` the entry is compulsory for
  typecheck. The comment correctly names it as unreachable-but-exhaustive. Keep.
- The `decideReadiness` `unknown` branch mirrors the existing `merge_state === "unknown"` twin — a
  deliberate, well-commented failure boundary, not a redundant guard. Keep.
- Comments are proportionate and explain *why* (`unknown` ≠ `failing`, never merge on unverified),
  which is exactly the load-bearing distinction the issue is about. No over-documentation of
  untouched code.
- Scope is tight: only the files the behavior touches, plus their docs and tests. No stray files,
  no debug logging, no leftover scaffolding in the `origin/main...HEAD` diff.

### Findings
**None.** The change is correct, complete, minimal, and reads clearly. Names say what they mean
(`unknown`, `retry_wait`), each new branch is a real distinct state, and the next reader gets the
rationale inline where it matters.

### Non-blocking notes (not code defects, not for `refine`)
1. **Confirmation-policy recording.** The acceptance criteria ask that the owner-delegated
   "confirm a genuine failing before rework?" policy be *recorded*. The chosen policy — treat only
   the *lookup error* as `unknown` (no rework), while a genuine completed red check still drives
   rework immediately with no extra confirmation — is sound and satisfies "a single transient/flaky
   reading never triggers rework," because transient failure modes throw and become `unknown`
   rather than `failing`. The written record lived in the requirements/planning docs, which are
   stripped from the branch before merge (configured behavior), so I could not verify the recording
   from the tree; the execution trail references the decision. Flagging only for traceability, not
   as a defect.
2. **Stale local `main`.** Reviewers/tooling comparing against local `main` will see a misleading
   70-file diff. The branch itself is correct (merged `origin/main` cleanly); this is purely a
   local-ref staleness artifact worth being aware of when the PR is examined.

**Verdict: ready.** No code changes needed.
