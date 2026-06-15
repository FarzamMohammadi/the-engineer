# Self-Review — Issue #24: PR presentation (title + body) not updated after rework

_Reviewer: self-review lens · 2026-06-15_
_Scope: `git diff origin/main...HEAD` (code only; `thoughts/` excluded from review of shipped change)_

## Verdict

**The change is clean and ships as-is.** It does exactly what the (owner-finalized) requirements
ask, every new part earns its place, and it reads the way the surrounding delivery code reads. No
correctness findings. Two minor observations are recorded below — neither blocks.

## What I checked

**Requirements ↔ diff (all 7 final acceptance criteria met):**
1. On rework, title **and** body are regenerated from the full diff-against-base and pushed — new
   `refreshPrPresentation` in `create-pr.ts:131` reads `pr-title.md` + `pr-description.md`, composes
   via the existing `composePrTitle`/`composePrBody`, calls `hosting.updatePR`. ✓
2. Pushed **only when substance changed** — gated on a `sha256` digest of the diff-against-base
   (`diffDigestAgainstBase`, `workspace-manager/index.ts:678`); `current === last` ⇒ clean no-op, host
   untouched. ✓ Verified by the "unchanged substance" test.
3. Title is no longer frozen to the task title — `openNewPr` (`create-pr.ts:243`) and the rework path
   both source it from the diff-derived `pr-title.md` (fallback `?? ctx.task.title`). ✓
4. First re-push doesn't spuriously rewrite an unchanged title — creation stores the baseline digest
   (`create-pr.ts:264`); both paths generate the title identically, so a no-code-change first rework
   matches the stored digest and skips. ✓
5. Push-only mode unaffected — all new host calls sit inside `createPr`/`prDescription`, both
   `skip: skipWhenPushOnly`. ✓ (delivery skip-gate tests stay green.)
6. Tested at the prevailing tier — rework changed / unchanged / digest-null / `updatePR`-rejects, the
   `thoughts/`-exclusion regression guard, schema round-trip. ✓
7. Observability consistent — `update_pr_presentation` `tool_execution` span mirrors
   `dismissStaleApproval` exactly (best-effort, span errored on failure, never blocks delivery). ✓

**Earns its keep:** every new symbol has ≥1 real caller and a clear job —
`presented_diff_digest` (the change-detection baseline), `diffDigestAgainstBase` (2 callers),
`readPrTitle` (2 callers), `refreshPrPresentation`, the prompt's title instruction. Nothing is a
single-use wrapper or dead defensive branch. The `if (ctx.task.review)` guard in `reworkExistingPr`
is pre-existing and still required for TS narrowing on the spread write.

**No surprises / correctness:**
- Digest design is sound: three-dot range (matches `snapshot.ts:63`) so a base-merge conflict-fix
  (new HEAD sha, same diff) reads as no change; `:(exclude)thoughts/` mirrors `exclude_thoughts_on_merge`
  so the engine's own regenerated deliverables don't self-trigger a push (verified by the
  `pr-title.md`-commit-doesn't-move-digest test — this is the bug the first plan pass would have shipped
  without the exclusion).
- Path alignment confirmed: `readPrTitle` reads `worktreePath/thoughtsDir/delivery/pr-title.md`, which
  is exactly `resultDirectory(ctx, "delivery")` where `pr-description.ts` instructs the agent to write.
- Sanitization is single-pass and consistent with the existing body path (title sanitized once inside
  `composePrTitle`; body sanitized once at read) — execution's deviation note is accurate.
- Crash-safety ordering is correct: `updatePR` runs before the digest is persisted, so a crash between
  them costs at most one idempotent redundant re-push, never a missed update.

**Gates re-run independently (not trusting the report):**
- `pnpm run typecheck` → clean.
- `vitest` create-pr + workspace-manager + schemas → 122 passed; delivery + auto-merge +
  pr-event-poller → 67 passed.
- `env -u CI pnpm run lint` → green (biome, tsc×2, knip, madge). The `lefthook` knip fix works
  without the `CI` env var.
- Other `review`-field writers all use `...task.review` spread, so the new field is preserved
  everywhere; the only fresh-object write (`openNewPr`) now sets it. No data-loss path.

## Observations (non-blocking)

### O1 — `knip.json` adds `lefthook`: a pre-existing, feature-unrelated build-tooling fix ships here
`knip.json:13` adds `"lefthook"` to `ignoreDependencies`. This is unrelated to issue #24 — it fixes a
pre-existing knip false-positive (knip's bundled lefthook plugin only counts `lefthook` as used when
`process.env.CI` is set; the harness runs `lint` without `CI`). `package.json`/`lefthook.yml` are
byte-identical to base, confirming it's pre-existing, not introduced by this change.
- **Why it's acceptable to keep:** the project's lint gate must be green for the change to land, the
  fix follows the file's own established convention (21 prior `ignoreDependencies` entries for exactly
  this "used but knip can't trace it" situation), is one line, reversible, and makes the gate
  deterministic across CI/local.
- **Concrete ask for refine:** none required. Worth ensuring the regenerated PR body's
  "Risks/follow-ups" mentions this unrelated config line so a human reviewer isn't surprised to see
  `knip.json` in a PR-description PR. (Body wording is an agent/deliverable concern, not a code change.)

### O2 — Rework body fallback could replace a good body with a degraded one (defensive, low-risk)
In `refreshPrPresentation` (`create-pr.ts:157`) the body falls back to `` `PR for: ${ctx.task.title}` ``
when `pr-description.md` is absent. If a rework reached `create-pr` with substance changed but the
deliverable missing, it would overwrite a rich existing body with the stub. In practice this can't
happen on the normal path: `prDescription` runs before `createPr` and a `needs_human` there blocks the
pipeline, so reaching `createPr` implies the file was written. The same fallback already exists on the
creation path (`openNewPr`), so this is consistent existing behavior, not a regression. No action
needed; recorded for completeness.

## Bottom line
Correct, complete, minimal, and idiomatic. Ship it. The only thing a human reviewer might
double-take on is the lone `knip.json` line (O1) — surfacing it in the PR body resolves that.
