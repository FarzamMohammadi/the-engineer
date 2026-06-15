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
actually changed, so a re-push that doesn't alter the merged code is a clean no-op; it never
degrades a good published body; and it never blocks delivery if the host call fails.

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
- **A rework never degrades a good live body.** When the substance changed but the body
  deliverable is absent or empty, the refresh sends `body: null` ("leave the host body
  unchanged") rather than overwriting the live body — which may be the rich body written at
  creation — with the `PR for: <title>` stub. The title still refreshes (its fallback reproduces
  the live title), and PR creation keeps the stub fallback (there is nothing live to degrade when
  first opening).
- **The title is no longer frozen, and the first re-push won't spuriously rewrite it.** Both PR
  creation (`openNewPr`) and rework source the title from the same diff-derived `pr-title.md`
  (falling back to the task title when absent), and creation stores a baseline
  `presented_diff_digest`. Because creation and update generate the title the same way, the
  first rework only re-pushes when substance actually changed.
- **The rework notification is cause-neutral.** `reworkExistingPr` is also reached by CI-fix and
  merge-conflict re-pushes, so the ticket comment now reads "Pushed rework to the PR." rather than
  claiming it addresses review feedback.
- **Best-effort, never blocks delivery.** The refresh runs inside an `update_pr_presentation`
  `tool_execution` span, mirroring the existing approval-dismissal step: a failed host update
  warns and returns without throwing, and does **not** advance the stored digest, so the next
  round retries. `updatePR` runs before the digest is persisted, so a crash between them costs
  at most one idempotent redundant re-push — never a missed update. Push-only mode is unaffected
  (the sub-phases already `skipWhenPushOnly`).

## Verification

- **Gates (re-run independently during refine):** `pnpm run typecheck` clean (both tsconfig +
  tsconfig.test); `env -u CI pnpm run lint` green (biome, tsc ×2, knip, madge — no circular
  deps); `vitest` over delivery + workspace-manager + schemas/task → 157 passed. Full unit suite
  green.
- **Tests added / strengthened:**
  - `create-pr` creation and rework now run against **real temp worktrees** holding real
    `pr-title.md` / `pr-description.md`, so they assert the diff-derived title (distinct from the
    task title) and the composed narrative body — coverage that would fail if the deliverable
    reads were deleted, rather than silently passing on the absent-file fallback.
  - `create-pr` rework cases: substance changed (`updatePR` called with title + body, new digest
    stored); absent deliverable (body sent as `null`, live body preserved, title still refreshed,
    cause-neutral notification); substance unchanged (no `updatePR`, digest preserved, approval
    still dismissed and feedback marked applied); digest unavailable (no `updatePR`, prior digest
    preserved); `updatePR` rejects (delivery still `ok`, span errored, digest not advanced).
  - `diffDigestAgainstBase` — a real (non-`thoughts/`) commit **moves** the digest; a
    `thoughts/.../pr-title.md` commit leaves it **unchanged** (the exclusion regression guard);
    `null` for an unknown task.
  - `task` schema — `presented_diff_digest` is omitted when absent and round-trips a value.
- **Reviewer may want to confirm:** the digest's `thoughts/` exclusion matches the
  `exclude_thoughts_on_merge` / `removeThoughtsAndPush` convention used elsewhere; the
  `presented_diff_digest` schema addition is additive (`.optional()`, persisted in the existing
  `review` JSON column — no migration); and the docs in
  `docs/user-flows/pr-management/overview.md` (the create-pr / rework-loop prose and the
  notification table) were updated to match the new behavior.

## Risks & follow-ups

- **`knip.json` carries one unrelated line.** `lefthook` was added to `ignoreDependencies`. This
  is a pre-existing build-tooling fix, not part of the feature: the harness runs `lint` without
  `CI`, and knip's bundled lefthook plugin only counts the dependency as used when `CI` is set,
  so the base branch already fails `lint` in this environment. `lefthook` is genuinely used via
  the tracked `lefthook.yml`; the one-line entry follows the file's existing 21-entry convention
  and makes the gate deterministic with and without `CI`. Called out so the build-tooling change
  in a PR-description PR isn't a surprise.
- **Title-degradation edge (surfaced, intentionally not fixed).** The body's "don't degrade"
  guard (`body: null`) has no title twin: if `pr-title.md` is absent on a substance-changed
  rework but was present at creation, the refresh rewrites the live diff-derived title back to the
  plain task title. The owner explicitly scoped the guard to the body; the trigger is degenerate
  (both deliverables are written by the same sub-phase pass, so one rarely appears without the
  other), it self-corrects the next round, and the fallback is an accurate task title, not an
  obvious stub. Recorded for awareness.
- **Minor follow-up:** the GitHub hosting plugin's `doUpdatePR` logs `hasTitle` / `hasDraft` but
  not `hasBody`; body updates are now a real path, so a one-line log add would be reasonable
  later.
- **Graceful degradation:** a missing `pr-title.md` (only `pr-description.md` is contractually
  enforced) falls back to the task title — prior behavior, not a defect.

---

## Re-run verification — 2026-06-15

This phase ran again. The description above is preserved (not rewritten) because I independently
re-derived it against the shipped diff and it still holds. What I checked this pass:

- **Diff against base re-read** (`git diff a07cc9d..HEAD`, base `origin/main`). Code is unchanged
  since the prior run — refine pass 2 applied no fixes — so the narrative above still describes
  exactly what ships. Files: `create-pr.ts` (+135/-17: `refreshPrPresentation`, digest gate, title
  from `pr-title.md`, creation baseline), `pr-description.ts` (title deliverable + reworded prompt),
  `workspace-manager/index.ts` (+`diffDigestAgainstBase`), `workspace-manager.interface.ts` (method
  decl), `schemas/task.ts` (+`presented_diff_digest`), `knip.json` (+`lefthook` line), and the three
  test files (`create-pr.test.ts`, `workspace-manager/index.test.ts`, `schemas/task.test.ts`).
- **Every claim in the body cross-checked against the diff** — `composePrTitle`/`composePrBody`
  reuse, `updatePR` wiring, the three-dot `origin/<base>...HEAD` range with `:(exclude)thoughts/`,
  the best-effort `update_pr_presentation` span mirroring `dismissStaleApproval`, and the additive
  `.optional()` schema field. All match the source as written above.

No correction needed; the description is accurate and complete for the change as it stands.

---

## Re-run verification — 2026-06-15 (review-rework round landed; description brought current)

Since the prior re-run note above, a review-rework round landed on this PR (commits `9ca225b`
"fix: address review feedback" and `c165ba0` "Preserve the live PR body and neutralize the rework
notification", recorded in `c13119a`). The owner left three scoped asks on his own PR and the
rework implemented all three — so the shipped diff is now **larger** than the prior note saw, and
the top narrative had genuinely gone stale (fittingly, the exact failure mode this issue is about:
a description frozen to an earlier state). I re-derived the full diff against base
(`git diff a07cc9d..HEAD`) and updated the authoritative description above to reflect the whole PR
as it now stands. The prior context is preserved below the dividers, not overwritten.

What changed in the description this pass, each verified against the shipped diff:

- **Body-preservation is now a shipped behavior, not an open risk.** Earlier, the rework path
  could overwrite a rich live body with the `PR for: <title>` stub. The rework now sends
  `body: null` when the deliverable is absent/empty (`create-pr.ts:155-159`); GitHub's
  `doUpdatePR` treats a null field as "leave unchanged." Moved from "Risks" into "How" and added a
  dedicated test (`updatePR` receives `body: null`, title still refreshes).
- **The rework notification is now cause-neutral.** The literal changed from "Pushed rework
  addressing review feedback." to "Pushed rework to the PR." (`create-pr.ts:96-99`), with matching
  updates to `docs/user-flows/pr-management/overview.md` (prose + notification table). The prior
  "still reads 'addressing review feedback'" risk is removed because it is fixed.
- **Tests now pin the feature, not the fallback.** New `worktreeWithDeliverables` helper stands up
  real temp worktrees with real `pr-title.md` / `pr-description.md`; creation and rework-changed
  tests assert a diff-derived title distinct from `ctx.task.title` and a unique body sentinel.
  Verification section updated; gate count refreshed to the refine pass-3 figure (157 passed across
  delivery + workspace-manager + schemas/task).
- **One new edge surfaced and left as a documented follow-up:** the body's `body: null` guard has
  no title twin (title can fall back to the task title on a substance-changed rework where
  `pr-title.md` is absent). The owner explicitly scoped the guard to the body; the trigger is
  degenerate and self-correcting. Added under "Risks & follow-ups."

Net: the description is once again a complete, accurate, unified narrative of everything this PR
does — original feature plus all three review-driven changes.
