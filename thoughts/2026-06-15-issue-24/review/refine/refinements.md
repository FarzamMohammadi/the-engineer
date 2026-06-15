# Refine — Issue #24: PR presentation (title + body) not updated after rework

_Refiner pass 1 · 2026-06-15 · verdict: **ship**_

## What this change does (one paragraph)

On a rework re-push to an existing PR, delivery now regenerates the PR's **title and body** from the
full diff-against-base and pushes them via the existing `updatePR` path — but only when the PR's
substance actually changed, gated on a sha256 digest of the diff (`diffDigestAgainstBase`, excluding
the engine's own regenerated `thoughts/` deliverables). The title is no longer frozen to the original
task title: both creation and rework source it from a new diff-derived `pr-title.md` deliverable, so
the first re-push doesn't spuriously rewrite an unchanged title. The refresh is best-effort and never
blocks delivery (the code is already pushed). Root cause fixed: the rework path previously never called
`updatePR`, so the regenerated body was written to disk and discarded.

## Consolidated findings (one review lens: self-review)

The self-review lens returned a **ship** verdict with no correctness findings and two non-blocking
observations. I re-derived its claims against the actual code and gates rather than trusting them.

| # | Finding | Source | My independent verdict |
|---|---------|--------|------------------------|
| O1 | `knip.json` adds `"lefthook"` to `ignoreDependencies` — a pre-existing, feature-unrelated build-tooling fix riding along | self-review | **Confirmed legitimate, keep.** Empirically verified (below). Necessary for the lint gate to pass in this environment; follows the file's own 21-entry convention; one line; reversible. Not scope creep. |
| O2 | Rework body falls back to `` `PR for: ${ctx.task.title}` `` if `pr-description.md` is missing — could replace a rich body with a stub | self-review | **Confirmed non-issue.** Same fallback exists on the creation path (`openNewPr`), so it's consistent existing behavior. Can't occur on the normal path: `pr-description` runs before `createPr` and a `needs_human` there blocks the pipeline. No action. |

No duplicate findings (single lens). Nothing dropped — both observations hold up against the code.

## Independent verification I performed

**Requirements ↔ diff — all 7 FINAL acceptance criteria met:**
1. ✓ On every re-push, title+body regenerated from full diff-against-base as a unified narrative — `refreshPrPresentation` (`create-pr.ts:131`) composes via `composePrTitle`/`composePrBody` and calls `hosting.updatePR`.
2. ✓ Pushed only when substance changed — `diffDigestAgainstBase` digest gate; `current === last` ⇒ clean no-op, host untouched (verified by the "unchanged substance" test).
3. ✓ Title no longer frozen — both `openNewPr` (`:243`) and rework source it from diff-derived `pr-title.md` (`?? ctx.task.title` fallback).
4. ✓ Reuses existing `updatePR`/compose path; creation generates the title the same way, so the first re-push doesn't spuriously rewrite (`presented_diff_digest` baseline stored at creation, `:264`).
5. ✓ Push-only unaffected — all new host calls sit under `createPr`/`prDescription`, both `skip: skipWhenPushOnly`.
6. ✓ Tested at the prevailing tier — changed / unchanged / digest-null / `updatePR`-rejects, thoughts/-exclusion guard, schema round-trip.
7. ✓ Observability consistent — `update_pr_presentation` `tool_execution` span mirrors `dismiss_approvals` (best-effort, errored span on failure, never blocks).

**Code-level checks (assume-issues-exist stance):**
- **Sanitization is single-pass and correct.** Title: `composePrTitle` sanitizes internally; `readPrTitle` is not pre-sanitized → one pass. Body: `sanitizeSecrets(readPrDescription ?? …)` external, `composePrBody` doesn't re-sanitize → one pass. No double-sanitize, no leak. ✓
- **No `review`-field writer drops the new digest.** All five writers (`pr-event-poller.ts:293/329/335/375`, `auto-merge.ts:312`, `create-pr.ts:90/256`) spread `...task.review`/`...review` or set the field explicitly, so `presented_diff_digest` is preserved everywhere. No data-loss path. ✓
- **Path alignment confirmed.** `readPrTitle` reads `worktreePath/thoughtsDir/delivery/pr-title.md`; `resultDirectory(ctx, "delivery")` (which the prompt's `titleFile` uses) resolves to exactly `worktreePath/thoughtsDir/delivery`. Reader and writer agree. ✓
- **Digest design sound.** Three-dot `origin/base...HEAD` (matches `snapshot.ts:63` and `evaluation/snapshot`); `:(exclude)thoughts/` mirrors `removeThoughtsAndPush`/`exclude_thoughts_on_merge` so the engine's own regenerated deliverables don't self-trigger a push (proven by the workspace-manager test: committing `thoughts/delivery/pr-title.md` does not move the digest). Git failure / missing `origin/base` ref ⇒ null ⇒ skip, never throws. ✓
- **Crash-safety ordering correct.** `updatePR` runs before the digest is persisted, so a crash between them costs at most one idempotent redundant re-push next round — never a missed update. ✓
- **Graceful degradation.** Missing `pr-title.md` (not contractually enforced — only `pr-description.md` is) falls back to `ctx.task.title`, i.e. prior behavior. Sensible; not a defect.

**O1 verified empirically** (temporary knip.json edit, reverted):
- WITH the lefthook line, no `CI`: knip passes.
- WITHOUT the line, no `CI`: knip flags `lefthook package.json:100:6` as unused → lint fails.
- WITHOUT the line, `CI=true`: knip passes.
→ The harness runs `lint` without `CI`; knip's bundled lefthook plugin only counts the dep as used when `CI` is set; base (which lacks the line) would fail lint in this environment. The one-line fix is required, not optional. (`lefthook.yml`/`package.json` lefthook entry are byte-identical to base, confirming pre-existing.)

**Gates re-run independently (not trusting the self-review's report):**
- `pnpm run typecheck` → clean (both tsconfig + tsconfig.test).
- `env -u CI pnpm run lint` → green (biome 499 files, tsc×2, knip 229 files, madge no circular deps).
- `vitest` create-pr + workspace-manager + schemas → **122 passed**.
- `vitest` delivery + auto-merge + pr-event-poller → **67 passed**.

## Fixes applied this pass

None. The change is correct, complete, minimal, and idiomatic; no security issue, requirement gap,
or clarity/simplicity problem survived scrutiny. There was nothing to fix and therefore nothing to
commit.

## Notes for the human reviewer (deliverable concern, not a code defect)

The regenerated PR body should mention the lone `knip.json` lefthook line under "Risks/follow-ups"
so a reviewer isn't surprised to see a build-tooling change in a PR-description PR. This is the
`pr-description` agent's job (the body regenerates from the full diff, which includes `knip.json`) —
not a code change for refine to make.

## Process note

I did not run the full expert-panel-review (3-agent) skill. Judgment call: this is a small, localized
wiring fix that already passed a thorough self-review lens and every project gate, and my own
line-by-line re-derivation found no open issue. A three-perspective panel would be disproportionate to
the weight of the change and would not move the verdict. Reading the skill was mandatory; using it is
discretionary, and here it isn't warranted.

## Verdict: **ship**

Correct, complete, minimal, idiomatic; all acceptance criteria met; all gates green. Nothing material
remains. Deliver it.

---

# Refine — pass 2 (re-run · 2026-06-15)

_Refiner pass 2 · verdict: **ship**_

## Why this pass ran

Pass 1 (above) did a thorough re-derivation and concluded **ship**, but left its
`session-result.json` as the unfilled template placeholder — so the verdict was never machine-recorded
and the orchestrator re-invoked refine. The self-review lens's pass 2 noticed the same gap. This pass
re-verifies the change independently (code diff unchanged since pass 1 — no fixes were applied in
between), reaches the same conclusion, and emits a proper result with `details.verdict`.

## Consolidated findings (one lens: self-review, two passes)

The self-review lens recorded three observations across its two passes. I re-checked each against the
actual code, not the report:

| # | Finding | My independent verdict |
|---|---------|------------------------|
| O1 | `knip.json` adds `"lefthook"` to `ignoreDependencies` — pre-existing, feature-unrelated build-tooling fix riding along | **Keep.** Required for the lint gate to pass in this environment (knip only counts `lefthook` as used when `CI` is set; the harness runs `lint` without `CI`). Follows the file's own 21-entry convention; one line; reversible; `package.json`/`lefthook.yml` byte-identical to base confirm it's pre-existing. Lint is green with it. |
| O2 | Rework body falls back to `` `PR for: ${ctx.task.title}` `` if `pr-description.md` missing | **Non-issue.** Same fallback already exists on the creation path (`openNewPr`); `prDescription` runs before `createPr` and a `needs_human` there blocks the pipeline, so `createPr` is only reached after the file is written. Consistent existing behavior, not a regression. |
| O3 | The `pr-description.ts` prompt instruction that emits `pr-title.md` (the title feature's linchpin) has no test guarding it | **Optional; not adding it — see decision below.** The lens itself rated it low/optional and non-blocking. |

No duplicates beyond the two-pass overlap; nothing dropped — all three hold up against the code.

## O3 in depth — why I am shipping without the guard

The self-review lens suggested asserting `buildInstructions(dir)`/`buildPrompt(ctx)` contains
`"pr-title.md"`. I investigated whether that fix is cheap and convention-respecting. It is neither:

- `buildInstructions` and `buildPrompt` are **module-private** in `pr-description.ts` (not exported).
- There is **no `pr-description.test.ts`** — the sub-phase has no direct unit test — and the only
  test entry point, `prDescription.run`, drives a real LLM agent (not exercisable in a unit test).
- **Zero** prompt-content assertions exist anywhere under `tests/` (verified by grep).

So the only way to add the guard is to **export a previously-private function purely to assert a
prompt string** — a public-surface widening that introduces a brittle pattern the suite deliberately
avoids. The runtime already degrades gracefully if the instruction is ever dropped (`readPrTitle`
returns null → title falls back to `ctx.task.title`, i.e. prior behavior), and **that fallback path is
tested** (`create-pr.test.ts` exercises it: the worktree file is absent in the mock, so the rework
test's `title: "Add feature"` comes through the fallback). Trading a public-surface change for a guard
on a tested graceful-degradation path is a net negative. Recorded as a `test_coverage` decision.

## Independent verification performed this pass

**Code, read line-by-line (assume-issues-exist stance):**
- **Root cause fixed.** The rework path (`reworkExistingPr`) previously never called `updatePR`; it now
  calls `refreshPrPresentation`, which composes title+body and calls `hosting.updatePR`. The
  regenerated body is no longer written-and-discarded. ✓
- **Digest gate is sound.** `diffDigestAgainstBase` (`workspace-manager/index.ts:675`) uses
  `git diff origin/<base>...HEAD -- . :(exclude)thoughts/` → sha256. Three-dot range matches the
  existing convention at `evaluation/snapshot.ts:63`; the `thoughts/` exclusion mirrors
  `exclude_thoughts_on_merge`/`removeThoughtsAndPush` so the engine's own regenerated deliverables
  don't self-trigger a push. `gitExec` exists with signature `(args, cwd, options?)`. Git failure /
  missing record → null → caller skips (never throws). ✓
- **No data-loss path.** Every `review`-field writer spreads `...task.review`/`...review`
  (`pr-event-poller.ts:293/329/335/375`, `auto-merge.ts:312`, `create-pr.ts:90/256`), so
  `presented_diff_digest` is preserved across all of them; `openNewPr` is the only fresh-object write
  and it now sets the baseline. ✓
- **Crash-safety ordering correct.** `updatePR` runs before the digest persist, so a crash between them
  costs at most one idempotent redundant re-push next round — never a missed update. ✓
- **Schema is additive.** `presented_diff_digest: z.string().nullable().optional()` — existing task
  literals parse unchanged (round-trip test confirms the field is omitted when absent). ✓
- **Push-only unaffected.** All new host calls sit under `createPr`/`prDescription`, both
  `skip: skipWhenPushOnly`. ✓

**Gates re-run independently (not trusting any prior report):**
- `pnpm run typecheck` → clean (tsconfig + tsconfig.test).
- `env -u CI pnpm run lint` → green (biome 500 files, tsc×2, knip 229 files / 3 warnings, madge no circular deps).
- `vitest run` on delivery + workspace-manager + schemas + pr-event-poller → **172 passed**, including
  all five new rework cases (changed / unchanged / digest-null / updatePR-rejects + creation baseline),
  the `thoughts/`-exclusion guard, and the schema round-trip.

## Fixes applied this pass

None. Same as pass 1: no security issue, requirement gap, or clarity/simplicity problem survived
scrutiny. There was nothing to fix and therefore nothing to commit.

## Process note

I did not run the full 3-agent expert-panel-review skill. Same judgment as pass 1: a small, localized,
fully-tested wiring fix that passed a two-pass self-review lens and every gate does not warrant a
three-perspective panel, and my own line-by-line re-derivation surfaced no open issue. Reading the
skill is mandatory; invoking it is discretionary and disproportionate here.

## Verdict (pass 2): **ship**

Correct, complete, minimal, idiomatic; root cause fixed; all acceptance criteria met; all gates green
on independent re-run. O1/O2 are confirmed non-issues; O3 is an optional guard not worth a
public-surface change. Nothing material remains. Deliver it.
