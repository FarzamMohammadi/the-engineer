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
