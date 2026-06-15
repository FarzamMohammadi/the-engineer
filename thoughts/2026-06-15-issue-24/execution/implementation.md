# Execution — Issue #24: PR presentation (title + body) isn't updated after rework

_Source: github_issue FarzamMohammadi/the-engineer#24_
_Execution run: 2026-06-15_

Implemented Approach S from the plan (`planning/plan.md`), including the planning-run-2 correction
(build note #1: the substance digest must exclude the engine's own `thoughts/` deliverables).
All product/design decisions were owner-settled or owner-delegated — no open questions remain.

## What the change does

On every re-push to an existing PR, the rework path now regenerates the PR's **title and body** from
the full diff against base and pushes them to the host — but **only when the PR's substance actually
changed**. Substance change is detected via a sha256 digest of the diff-against-base (excluding
`thoughts/`), stored on the task; an unchanged re-push (e.g. a CI-only fix that doesn't alter merged
code) is a clean no-op. The title is no longer frozen to the original task title: it is a diff-derived
deliverable, sourced identically at PR creation and on rework.

## Files changed

1. **`src/schemas/task.ts`** — added `presented_diff_digest: z.string().nullable().optional()` to
   `ReviewStateSchema`. `.optional()` (not `.default`) keeps the parse output unchanged for existing
   `ReviewState` literals and the schema test's parse-based `toEqual` assertions. Persisted in the
   existing `review` JSON column → purely additive, no SQL migration.

2. **`src/core/interfaces/workspace-manager.interface.ts`** — added
   `diffDigestAgainstBase(taskId: string): string | null` to `IWorkspaceManager`.

3. **`src/core/workspace-manager/index.ts`** — implemented `diffDigestAgainstBase`:
   `git diff origin/<base>...HEAD -- . ":(exclude)thoughts/"` via the existing private `gitExec`,
   hashed with `createHash("sha256")…digest("hex")` (mirroring `observer/blob-store.ts`). Returns
   `null` on missing record or git error (best-effort, never throws). The `thoughts/` exclusion mirrors
   `exclude_thoughts_on_merge` / `removeThoughtsAndPush` — **critical**: `push` runs before `create-pr`
   and `git add -A` commits the regenerated `pr-title.md`/`pr-description.md` every round, so a
   whole-tree digest would change every round and re-trigger the very spurious push the digest exists
   to prevent. Three-dot range so a conflict-resolution merge of base into the branch (new HEAD sha,
   same diff) correctly reads as no substance change. Added imports: `createHash` (node:crypto),
   `sanitizeErrorMessage`.

4. **`src/core/orchestrator/pipeline/delivery/pr-description.ts`** — the sub-phase now instructs the
   agent to also write a single-line, imperative, whole-PR title to `pr-title.md` alongside the body.
   Widened `ROLE` to "title and body". `buildInstructions` now takes the directory so it can reference
   the title file path.

5. **`src/core/orchestrator/pipeline/delivery/create-pr.ts`** — the core wiring:
   - Added `TITLE_DELIVERABLE = "pr-title.md"` and `readPrTitle(ctx)` (first non-empty line, leading
     `# ` stripped, `null` when absent — falls back to the task title).
   - `openNewPr`: title now sourced via `composePrTitle(readPrTitle(ctx) ?? ctx.task.title, …)`; stores
     the creation-time digest on `review.presented_diff_digest` so the first rework only re-pushes when
     substance changed.
   - `reworkExistingPr`: added `refreshPrPresentation(...)` — computes the current digest, compares to
     `review.presented_diff_digest`, and (only when changed) composes title+body and calls
     `hosting.updatePR(...)` inside an `update_pr_presentation` `tool_execution` span. Best-effort and
     non-blocking, mirroring `dismissStaleApproval`: a failed update warns + returns without throwing
     and does **not** advance the stored digest, so the next round retries. The digest is folded into
     the single existing `review` write. Records `description_updated` + `description_refresh_reason`
     in result `data`.
   - `updatePR` runs **before** the digest is persisted, so a crash between them costs at most one
     redundant idempotent re-push — never a missed update.

## Deviations from the plan (noted, minor)

- The plan's literal `composePrTitle(sanitizeSecrets(readPrTitle(ctx) ?? …), …)` would double-sanitize,
  since `composePrTitle` already calls `sanitizeSecrets` internally (and the existing body path
  sanitizes the description once at read time). I pass the raw read value to `composePrTitle`, keeping
  a single sanitization pass — same security guarantee, no double-wrap.
- Used `createHash` from `node:crypto` directly (as the plan's §5.2 endorsed) rather than importing
  `computeHash` from `observer/blob-store`, avoiding a cross-module dependency. Same algorithm.

## Tests added

- **`tests/unit/core/workspace-manager/index.test.ts`** — `describe("diffDigestAgainstBase")`:
  baseline digest on a fresh worktree; a non-`thoughts/` code commit **changes** the digest; a
  `thoughts/.../pr-title.md` commit leaves it **unchanged** (the exclusion regression guard from
  planning-run-2 build note #1); `null` for an unknown task.
- **`tests/unit/core/orchestrator/pipeline/delivery/create-pr.test.ts`** — extended `mockCtx` with
  `updatePR` on hosting and `diffDigestAgainstBase` on workspaceManager (+ a `diffDigest` option and a
  `reworkReview` helper). New cases: rework substance-changed (updatePR called with title+body, new
  digest stored, `description_updated: true`); substance-unchanged (no updatePR, digest preserved,
  `description_updated: false`, approval still dismissed + feedback applied); digest unavailable (no
  updatePR, stored digest preserved); updatePR rejects (delivery still `ok`, span errored, digest not
  advanced). Updated the new-PR test to assert the creation digest is stored.
- **`tests/unit/schemas/task.test.ts`** — `presented_diff_digest` is omitted when absent and
  round-trips a recorded value.

## Verification

- `pnpm run typecheck` — clean (both tsconfig + tsconfig.test).
- `pnpm exec biome check .` — clean (497 files).
- `pnpm exec madge --circular` — no circular dependency.
- `pnpm test` — all 2617 unit tests pass (2620 after the 3 new test groups; full suite green).
- `pnpm run lint` — the ONLY failure is `knip` flagging `lefthook` as an unused devDependency. This is
  **pre-existing and unrelated**: it fails identically on the base branch with my changes stashed, and
  my diff does not touch `package.json`. `lefthook` is genuinely used via `lefthook.yml` (a knip
  false-positive / missing knip config). Left as-is per the boy-scout boundary — outside issue #24's
  surface.

## Out-of-scope observations (noted, not fixed)

- `github-hosting.ts:doUpdatePR` logs `hasTitle`/`hasDraft` but not `hasBody`; this change makes
  body-updates a real path, so a one-line `hasBody` log add would be reasonable, but it is a
  plugin-internal log detail.
- The `"Pushed rework addressing review feedback."` notification text is still inaccurate for
  CI-fix/conflict re-pushes (pre-existing).
- `knip` does not recognize `lefthook.yml`'s use of the `lefthook` devDependency (pre-existing lint
  noise on the base branch).

---

# Execution run 2 — 2026-06-15 (resolve the failing `lint` gate)

The issue #24 feature change (commit `c1f1b95`) was already complete and committed. The prior pass
left **one** gate red: `pnpm run lint` failed on `knip`:

```
Unused devDependencies (1)
lefthook  package.json:100:6
```

## Root cause (diagnosed, not guessed)

`lefthook` **is** a genuinely-used devDependency — it powers the repo's git hooks via the tracked
`lefthook.yml` (`pre-commit` biome-check, `pre-push` typecheck/knip/madge/test). The failure is a
quirk of knip's bundled **lefthook plugin** (`node_modules/knip/dist/plugins/lefthook/index.js`):

```js
const lefthook = process.env.CI
    ? enablers.filter(...).map(id => toDependency(id))   // CI → lefthook counted as used
    : [];                                                // local → NOT counted → flagged "unused"
```

So knip only marks `lefthook` itself as used when `process.env.CI` is set. Verified empirically on
this branch:
- `env -u CI pnpm exec knip` → reports `lefthook` unused (non-zero exit) → **lint fails**.
- `CI=true pnpm exec knip` → clean (exit 0) → **lint passes**.

The verification harness runs `lint` **without** `CI`, so it hit the failure. This is pre-existing
(`package.json`, `lefthook.yml`, and `knip.json` are byte-identical to `origin/main`) and entirely
unrelated to the issue #24 surface — but the gate still has to be green for the change to land, and
this re-run was explicitly asked to resolve it.

## Fix (one line, matching the project's own established convention)

The repo already has a `knip.json` whose `ignoreDependencies` array lists 21 dependencies knip can't
trace through their config files (UI deps, `mermaid`, `tailwindcss`, …). `lefthook` is the same
class — used via `lefthook.yml`, undetectable to knip outside CI — it was simply missing from the
list. Added `"lefthook"` to that existing array:

```json
  "ignoreDependencies": [
    "lefthook",
    "pino-roll",
    ...
```

This is the canonical, intention-revealing knip mechanism ("this dependency is used but knip can't
see it"), follows the file's own established pattern, and makes the gate **deterministic** — it now
passes both with and without `CI`.

## Files changed (run 2)

- **`knip.json`** — one entry added to `ignoreDependencies` (`"lefthook"`). No other change.

## Verification (run 2)

- `env -u CI pnpm run lint` → **exit 0** (biome clean, tsc ×2 clean, knip clean, madge no circular).
- `CI=true pnpm run lint` → **exit 0** — confirms the fix is environment-independent.
- No source or test files were touched, so the typecheck and test gates (green in run 1, and tsc runs
  twice inside `lint`) are unaffected.

## Note on scope

This is a build-tooling config fix outside issue #24's feature surface, made only because the gate
demanded it and the harness runs `lint` without `CI`. It is not surfaced as an open `decisions` entry:
the in-file `ignoreDependencies` convention (21 prior entries for exactly this situation) already
settles the choice — there was no genuinely-open judgment call to ask the owner about.

---

# Execution run 3 — 2026-06-15 (verify the open PR's CI; no fix needed)

This pass was handed a carry-over instruction: *"The open pull request's CI checks are failing.
Reproduce the failures by running the project's own gates, fix the root cause, and let delivery
re-push the branch."* I did not take that at face value — I reproduced every CI gate locally **and**
queried the live PR status. **Both agree: CI is green.** The failure the instruction refers to was
already fixed by run 2 (the knip/`lefthook` fix, commit `e203901`) and has since been pushed.

## What the CI actually runs (`.github/workflows/ci.yml`)

Three jobs, all on `CI=true` (GitHub Actions sets it):
1. **lint** — `pnpm lint` (biome + tsc ×2 + knip + madge), then a docs-sync step: `pnpm run
   docs:bundle` followed by `git diff --exit-code src/cli/bundled/plugin-docs.ts`.
2. **test** — `pnpm test` (vitest).
3. **build** — `pnpm build` (tsdown lib bundle + vite dashboard bundle).

Runs 1–2 verified lint/typecheck/test but never exercised **`pnpm build`** or the **docs:bundle
sync** step. This pass closed both gaps.

## Reproduction — every gate, run as CI runs it

- **build** (`CI=true pnpm build`): ✓ lib bundle (`dist/index.mjs`) + dashboard bundle built, exit 0.
- **docs:bundle sync** (`CI=true pnpm run docs:bundle` → `git diff --exit-code
  src/cli/bundled/plugin-docs.ts`): regenerated 12 docs, **no diff** — bundled docs already in sync.
- **lint** (`CI=true pnpm lint`): exit 0 (biome 500 files clean, tsc ×2 clean, knip clean, madge no
  circular).
- **test** (`CI=true pnpm test`): **2618 tests / 139 files pass**, exit 0.

## Cross-check against the live PR

`gh pr view` (PR #28) reports `headRefOid` = `b79b137e…`, identical to local `HEAD` and to
`origin/<branch>`. The `statusCheckRollup` shows **lint, test, build all `SUCCESS`** (CI run completed
2026-06-15T20:36 UTC). The dashboard and the local reproduction match.

## Why the carry-over said "failing" — and why it no longer is

The original red gate was `knip` flagging `lefthook` as an unused devDependency (run 2's diagnosis).
Run 2 fixed it by adding `"lefthook"` to `knip.json`'s `ignoreDependencies`; that fix is present at
HEAD (`knip.json:13`, confirmed via `git show HEAD:knip.json`) and was pushed with the branch. The
"CI failing" instruction was a stale snapshot from **before** that fix landed on the remote. Commit
graph (`origin/main..HEAD`): feature code `c1f1b95` → knip fix `e203901` → notes `3d691c0` → delivery
thoughts `b79b137` (HEAD). Source tree is fully committed; the working tree held only this phase's own
deliverable files.

## One observed wart (left as-is, deliberately)

Under `CI=true`, knip's bundled lefthook plugin **does** count `lefthook` as used, so it emits a
non-fatal *configuration hint* — "lefthook in knip.json — Remove from ignoreDependencies". It is a
hint, not an error: `knip` and `pnpm lint` still **exit 0**. Removing the entry would re-break lint in
the **non-CI** environment (where the plugin does *not* count lefthook, and the verification harness
runs `lint` without `CI`). Keeping the entry is what makes lint pass deterministically in **both**
environments — exactly run 2's intent. So the hint is the correct trade-off, not a regression; no
change made.

## Net change this run

No source, test, or config change — there was nothing to fix. The only working-tree changes are this
phase's own deliverables: this `implementation.md` accumulation, the real `session-result.json`
(replacing the harness placeholder), and the harness's `.bak` backup of run 2's result (committed to
match the established convention — the planning/requirements `.bak` backups are already tracked at
HEAD). After committing, `git status` is clean.

## Outcome

`ok` — CI is verified green by both local reproduction (all three jobs + docs-sync) and the live PR
status; the root cause of the earlier failure was already resolved and pushed. No open questions.

---

# Execution — Run 3: the three review-rework asks (2026-06-15)

_Implements Planning Run 3 (`plan.md` §§R3.x). The feature shipped (`c1f1b95` + `9ca225b`); the
owner then left three concrete asks on his own PR. This run addresses exactly those three, nothing
more — the settled scope (unified rewrite of title+body, regenerate-from-diff, push-only-when-changed
via the digest gate) is untouched._

## What changed and why

**Ask #3 — cause-neutral rework notification.** `reworkExistingPr` is reached by CI-fix and
merge-conflict re-pushes too, not just review feedback, so the fixed string "Pushed rework addressing
review feedback." mislabeled those causes. Changed the `ticket_comment` to the owner's suggested
neutral text **"Pushed rework to the PR."** (`create-pr.ts`). One literal; no test asserted the old
string, so nothing else broke.

**Ask #2 — a rework must not degrade a good published body.** In `refreshPrPresentation`, when the
diff digest changed but the `pr-description.md` deliverable is absent/empty, the code used to compose
the `PR for: <task title>` stub and push it via `updatePR`, overwriting whatever rich body was already
live on the PR. Fixed by reading the description once and carrying **`body: null`** when it is absent —
the published `PRUpdates` contract treats `null` as "leave the host body unchanged" (the GitHub plugin
applies `body` only when non-null). The title path is unchanged: its fallback (`readPrTitle(ctx) ??
ctx.task.title`) reproduces the live title when the deliverable is absent, so the title is never
degraded. The digest still advances and `updatePR` is still called (the title may legitimately have
moved) — per plan decision D6, no short-circuit. Creation (`openNewPr`) keeps its stub fallback:
there is nothing live to degrade when first opening a PR.

  - No schema/adapter/plugin change was needed — `body: null` is the existing mechanism. Confirmed
    `PR for:` now appears only on the creation path (grep: `create-pr.ts:229` only).

**Ask #1 — the tests must exercise the feature, not its fallback.** The old `mockCtx` pointed
`worktreePath` at a non-existent dir, so `readPrTitle`/`readPrDescription` always returned `null` and
every assertion checked the task-title / stub fallback. Added a real-temp-worktree fixture
(`worktreeWithDeliverables`: `mkdtempSync` + writes `pr-title.md`/`pr-description.md` under
`<dir>/thoughts/x/delivery/`, with `afterEach` `rmSync` cleanup) and a `worktreePath` override on
`mockCtx`. New/changed tests:
  - **Creation, real deliverables:** `createPR` receives the diff-derived title
    ("Refresh PR presentation on rework", distinct from `ctx.task.title` "Add feature") and a body
    containing the unique narrative sentinel "Regenerated from the full diff." (not the shared footer).
  - **Rework changed-substance, real deliverables:** `updatePR` receives that diff-derived title and
    narrative body; digest advances; `description_updated: true`.
  - **Rework changed-substance, absent deliverable (#2 path):** the old `:209` test was converted —
    `updatePR` is called with `body: null` and `title: "Add feature"`, the digest advances, and the
    `notify` message is pinned to "Pushed rework to the PR." (#3). Proves the stub is no longer pushed.

  - **Owner's bar verified empirically:** temporarily stubbing `readPrTitle`/`readPrDescription` to
    return `null` (simulating the feature deleted) makes both new feature-pinning tests **fail** — they
    pin the feature, not the fallback. Source restored afterward; `git diff --stat src/` shows only the
    intended 10/5 line change to `create-pr.ts`.

## Docs (same unit of work)

`docs/user-flows/pr-management/overview.md`: updated the "Rework pushed" notification row to the new
text, and brought the two stale prose spots current — the `create-pr` sub-phase bullet and the
"rework loop" paragraph now note that `create-pr` also **refreshes the PR title and body** on rework
(regenerated from the full diff, pushed only when the diff changed; best-effort, non-blocking). The
shipped feature had left these omitting the refresh. `docs/archived/**` left untouched (historical).

## Verification

- `pnpm run typecheck` — clean.
- `pnpm run lint` (biome + tsc + knip + madge) — clean (the 3 knip warnings are the pre-existing
  lefthook hint documented in the prior run; no new findings; no circular deps).
- `pnpm test` — **2620 passed (139 files)**; `create-pr.test.ts` 19/19.
- Feature-pinning bar confirmed by the stub-and-fail experiment above.
- `grep "addressing review feedback"` → no hits in `src/` (except the new explanatory comment) or
  non-archived `docs/`.

## Decisions recorded (carried from plan, surfaced for autonomy-policy review)

- **D6 (`code_style`):** on a body-skipped rework, pass `body: null` and keep the title + `updatePR`
  call rather than short-circuiting the whole host call. The plugin already no-ops all-null updates and
  the title may legitimately refresh; simplest path satisfying "leave the existing body."
- **D7 (`doc_wording`):** also brought the rework-loop prose current (not just the notification row),
  because the shipped feature left it stale and I was editing that exact section.
- **D8 (`test_coverage`):** pinned the neutral #3 message and kept both the feature path (real
  deliverables) and the absent/fallback path (`body: null`) covered.

## Outcome

`ok` — all three asks implemented, docs updated in the same unit, gates green, the owner's
feature-pinning bar verified. Committed; no open questions.
