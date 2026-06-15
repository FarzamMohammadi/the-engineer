# Refresh PR title and body on rework when the diff changes

Closes #24.

## What & why

When The Engineer reworks an already-open PR — most often to address review feedback — the
PR's presentation on the host was frozen to the original task. The rework path dismissed the
stale approval and marked feedback applied, but it **never called `updatePR`**, so the body
that delivery regenerates every round was written to disk and then discarded. The title was
worse off: it was hard-coded to the original task title and nothing ever regenerated it. A
reviewer reading the PR couldn't see what changed in response to their own feedback without
diffing the code themselves.

This change wires the rework path to push a refreshed **title and body** so the open PR always
describes the whole PR as it now stands — the original work plus every later round — written as
one unified narrative, not round-by-round. The refresh fires only when the PR's substance
actually changed, so a re-push that doesn't alter the merged code is a clean no-op.

## How

- **Delivery now produces a title as well as a body.** The `pr-description` sub-phase writes a
  single-line, imperative, whole-PR title to a new `pr-title.md` alongside `pr-description.md`,
  and its instructions make explicit that both are drawn from the full diff against base and
  describe the whole PR "as if every change landed at once."
- **The rework path refreshes the host presentation.** `reworkExistingPr` now calls a new
  `refreshPrPresentation`, which composes the title + body (reusing the existing
  `composePrTitle` / `composePrBody` helpers) and pushes them through the existing `updatePR`
  adapter — the capability already existed and simply had no caller.
- **Change-detection is keyed on the diff, not the prose.** The LLM-generated narrative churns
  every round even when nothing merge-relevant changed, so keying on it would push a spurious
  update each no-op round. Instead a new `WorkspaceManager.diffDigestAgainstBase` computes a
  sha256 of `git diff origin/<base>...HEAD` **excluding `thoughts/`** (the engine's own
  regenerated deliverables, which would otherwise move the digest every round). The digest is
  stored on the task's review state as `presented_diff_digest`; when it matches the last-shown
  presentation, the host is left untouched. The three-dot range means a conflict-resolution
  merge of base into the branch (new HEAD sha, same diff) correctly reads as no change.
- **The title is no longer frozen, and the first re-push won't spuriously rewrite it.** Both PR
  creation (`openNewPr`) and rework source the title from the same diff-derived `pr-title.md`
  (falling back to the task title when absent), and creation stores a baseline
  `presented_diff_digest`. Because creation and update generate the title the same way, the
  first rework only re-pushes when substance actually changed.
- **Best-effort, never blocks delivery.** The refresh runs inside an `update_pr_presentation`
  `tool_execution` span, mirroring the existing approval-dismissal step: a failed host update
  warns and returns without throwing, and does **not** advance the stored digest, so the next
  round retries. `updatePR` runs before the digest is persisted, so a crash between them costs
  at most one idempotent redundant re-push — never a missed update. Push-only mode is unaffected
  (the sub-phases already `skipWhenPushOnly`).

## Verification

- **Gates (re-run independently during refine):** `pnpm run typecheck` clean (both tsconfig +
  tsconfig.test); `env -u CI pnpm run lint` green (biome, tsc ×2, knip, madge — no circular
  deps); `vitest` over create-pr + workspace-manager + schemas → 122 passed; over delivery +
  auto-merge + pr-event-poller → 67 passed. Full unit suite green.
- **Tests added:**
  - `diffDigestAgainstBase` — a real (non-`thoughts/`) commit **moves** the digest; a
    `thoughts/.../pr-title.md` commit leaves it **unchanged** (the exclusion regression guard);
    `null` for an unknown task.
  - `create-pr` rework path — substance changed (`updatePR` called with title + body, new digest
    stored); substance unchanged (no `updatePR`, digest preserved, approval still dismissed and
    feedback still marked applied); digest unavailable (no `updatePR`, prior digest preserved);
    `updatePR` rejects (delivery still `ok`, span errored, digest not advanced).
  - `task` schema — `presented_diff_digest` is omitted when absent and round-trips a value.
- **Reviewer may want to confirm:** the digest's `thoughts/` exclusion matches the
  `exclude_thoughts_on_merge` / `removeThoughtsAndPush` convention used elsewhere, and the
  `presented_diff_digest` schema addition is additive (`.optional()`, persisted in the existing
  `review` JSON column — no migration).

## Risks & follow-ups

- **`knip.json` carries one unrelated line.** `lefthook` was added to `ignoreDependencies`. This
  is a pre-existing build-tooling fix, not part of the feature: the harness runs `lint` without
  `CI`, and knip's bundled lefthook plugin only counts the dependency as used when `CI` is set,
  so the base branch already fails `lint` in this environment. `lefthook` is genuinely used via
  the tracked `lefthook.yml`; the one-line entry follows the file's existing 21-entry convention
  and makes the gate deterministic with and without `CI`. Called out so the build-tooling change
  in a PR-description PR isn't a surprise.
- **Noted, intentionally not fixed (out of scope):**
  - The rework notification text still reads "Pushed rework addressing review feedback" even
    though the path now also runs for CI-fix and merge-conflict re-pushes (pre-existing).
  - The GitHub hosting plugin's `doUpdatePR` logs `hasTitle`/`hasDraft` but not `hasBody`; body
    updates are now a real path, so a one-line log add would be reasonable later.
- **Graceful degradation:** a missing `pr-title.md` (only `pr-description.md` is contractually
  enforced) falls back to the task title — prior behavior, not a defect.
