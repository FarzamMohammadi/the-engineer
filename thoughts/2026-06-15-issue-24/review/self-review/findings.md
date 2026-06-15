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

---

# Self-Review — pass 2 (re-run · 2026-06-15)

_Re-invoked as the self-review lens. The prior pass (above) wrote a thorough verdict but left its
`session-result.json` as the unfilled placeholder template; this pass re-verifies independently,
records the same verdict, and emits a proper result. The code diff is unchanged since pass 1 — `refine`
ran in between and applied no fixes._

## Verdict (unchanged): **ship / `ok`**

I re-derived the change against `git diff origin/main...HEAD` and re-ran the gates rather than trusting
pass 1. Same conclusion: correct, complete, minimal, idiomatic; all 7 final acceptance criteria met.
No new correctness findings. The two prior observations (O1 knip-`lefthook`, O2 body fallback) still
hold exactly as recorded and remain non-blocking.

## Independent re-verification performed this pass

- **Gates (re-run, not trusted):** `pnpm run typecheck` → clean (tsconfig + tsconfig.test).
  `vitest` create-pr + workspace-manager + schemas → **122 passed**, including
  `diffDigestAgainstBase > …excludes the engine's own thoughts/ deliverables` and all four rework
  cases (changed / unchanged / digest-null / updatePR-rejects).
- **Wiring is closed:** `rg` confirms `updatePR` now has exactly one core caller
  (`refreshPrPresentation`), resolving the prior knip "unused export" gap; `diffDigestAgainstBase` and
  `readPrTitle` each have two real callers (creation + rework); `presented_diff_digest` is written on
  both paths and read in the gate. No dead code, no single-use wrapper.
- **`updatePR` payload matches `PRUpdatesSchema`** (`{title, body, draft, labels_add, labels_remove}`,
  all nullable) — verified against `schemas/adapters.ts`.
- **Creation/update title parity (AC#4) re-confirmed:** both `openNewPr:243` and
  `refreshPrPresentation:155` use `composePrTitle(readPrTitle(ctx) ?? ctx.task.title, …)` — identical
  sourcing, so the first re-push cannot spuriously rewrite an unchanged title.
- **What ships:** the committed `thoughts/2026-06-15-issue-24/**` tree (incl. `*.bak` result backups)
  is the engine's normal scaffolding — `thoughts/` is not gitignored, is absent from `origin/main`, and
  is stripped at merge via `exclude_thoughts_on_merge`/`removeThoughtsAndPush` (the very boundary the
  digest excludes). Not a stray-file finding. The bundled docs (`plugin-docs.ts`) already describe
  `updatePR` and were reported in-sync by the CI docs:bundle step. No debug logging, no leftover
  scaffolding in `src/`.

## One additional minor observation (non-blocking)

### O3 — The `pr-title.md` prompt instruction (the title feature's linchpin) has no test guarding it
`pr-description.ts:buildInstructions` is what makes the agent emit `pr-title.md`; if a future edit drops
that instruction, the title silently reverts to the raw task title — i.e. a quiet regression of the
exact bug this PR fixes — and **no test would catch it**. `readPrTitle`'s fallback is tested, but the
prompt content is not. The plan's step-3 verify explicitly called for asserting `buildPrompt(ctx)`
mentions `pr-title.md` and the "whole PR" framing; that assertion was not added.
- **Severity: low / optional.** Asserting prompt-string content is *not* an established convention in
  this suite (no `buildPrompt`/`buildInstructions` content assertions exist anywhere in
  `tests/unit/core/orchestrator/pipeline/`), and the runtime degrades gracefully via the tested
  fallback. So this is a cheap regression-guard *suggestion*, not a gap that should block delivery.
- **Concrete fix if refine chooses to act:** in `delivery.test.ts`, add one case asserting
  `buildInstructions(dir)` (or `buildPrompt(ctx)`) contains `"pr-title.md"` and the whole-PR framing.

## Bottom line (pass 2)
No change to the verdict. The implementation is sound, every part earns its keep, and all gates are
green on independent re-run. O1/O2 are documented non-issues; O3 is an optional test-hardening nicety.
Ship it.

---

# Self-Review — pass 3 (review of the review-rework round · 2026-06-15)

_Re-invoked as the self-review lens after a rework round landed on the open PR. The owner left three
scoped asks on his own PR; the rework (commits `9ca225b` + `c165ba0`) implemented them. The diff under
review (`git diff origin/main...HEAD`) is now **larger than passes 1–2 saw** — it includes those three
asks. This pass reviews the new state, re-confirms the original feature still holds, and checks the
three asks against the owner's words. Scope: code/docs only; `thoughts/` is the engine's own audit
trail (stripped at merge), not part of the shipped change._

## Verdict: **ship / `ok`** — clean, and the rework directly closes prior pass's O2.

The three review-rework asks are implemented faithfully and minimally, every new line earns its place,
and the touched suite (`create-pr` 19, `workspace-manager` 47, `schemas/task` 58 = 124) is green on
independent re-run. One new low-severity, owner-scoped observation (O4) and the standing O1/O3; no
correctness findings.

## The three owner asks ↔ diff (all met)

- **Ask #1 — tests exercise the feature, not the fallback.** ✓ New `worktreeWithDeliverables` helper
  (`create-pr.test.ts:88`) writes real `pr-title.md` / `pr-description.md` into a temp worktree with
  `afterEach` cleanup. The new creation test and the rework-changed-substance test assert a title
  **distinct from `ctx.task.title`** ("Refresh PR presentation on rework") and a body carrying a
  **unique narrative sentinel** ("Regenerated from the full diff.", not the shared footer) — so both
  would fail if `readPrTitle`/`readPrDescription` were deleted. This meets the owner's exact bar ("a
  test that passes with the feature deleted isn't testing it"). The old footer-only assertion that
  pinned the *fallback* was correctly removed.
- **Ask #2 — a rework must not degrade a good live body.** ✓ `refreshPrPresentation`
  (`create-pr.ts:155-159`) now reads the description once and sends `body: null` ("leave the host body
  unchanged" per `PRUpdatesSchema`) when the deliverable is absent/empty, instead of overwriting with
  the `PR for: <title>` stub. **This is the fix for prior pass's O2** — that observation is now
  resolved, not outstanding. Creation (`openNewPr:229`) keeps its stub fallback (nothing live to
  degrade). A test pins the absent-deliverable path to `body: null`.
- **Ask #3 — cause-neutral rework notification.** ✓ The `ticket_comment` literal changed from
  "Pushed rework addressing review feedback." to "Pushed rework to the PR." (`create-pr.ts:96-99`),
  with a comment explaining the path is shared by CI-fix/merge-conflict re-pushes. Docs row + the two
  rework-loop prose spots in `overview.md` updated to match; archived docs untouched. A test now pins
  the message (`create-pr.test.ts`).

## Original feature re-confirmed unchanged
The digest gate (`diffDigestAgainstBase`, `:(exclude)thoughts/`, three-dot range), the title+body
unified rewrite, push-only-when-changed, best-effort/non-blocking `updatePR` span, and creation/rework
title parity all still hold exactly as recorded in passes 1–2. The `body: null` change is the only
behavioral edit to the rework path and it is correctly *inside* the changed-substance branch, so the
"unchanged digest ⇒ no-op" and "digest-null ⇒ skip" paths are untouched (their tests stay green).

## New observation (non-blocking)

### O4 — Title degradation in the absent-deliverable rework edge case (the body's fix has no title twin)
With ask #2, the **body** is now protected when the `pr-description.md` deliverable is absent on a
substance-changed rework (`body: null` leaves the live body in place). The **title** is not given the
same protection: `refreshPrPresentation` (`create-pr.ts:155`) still sends
`composePrTitle(readPrTitle(ctx) ?? ctx.task.title, …)`, so if `pr-title.md` is absent at this rework
*but was present (diff-derived) at creation*, the rework overwrites the live diff-derived title with
the plain task title — the same class of degradation ask #2 fixes for the body.
- **Why it's low / likely fine as-is:** (a) the owner **explicitly scoped ask #2 to the body** and left
  the title path as-is; (b) `pr-title.md` and `pr-description.md` are written by the *same*
  `pr-description` sub-phase pass, which runs on every PR-mode rework, so "title absent at rework but
  present at creation" requires the agent to have produced the file once and then not again — a rare,
  degenerate case; (c) when both are genuinely absent at creation *and* rework (the common fallback
  case), the rework title equals the live task-title and it's an idempotent no-op.
- **Disposition:** surface only — consistent with the owner's body-only scoping; no fix requested. If
  the owner later wants symmetry, the body's mechanism mirrors directly:
  `const t = readPrTitle(ctx); const title = t ? composePrTitle(t, ref) : null;` (pass `title: null`
  to leave the live title unchanged). Note the requirements doc's stated rationale ("the title fallback
  reproduces the live title") holds only when the title was *also* the fallback at creation; this edge
  is the gap in that reasoning, recorded for awareness.

## Standing observations from prior passes
- **O1 (knip `lefthook`)** — still ships; still a documented, necessary, convention-following one-liner
  to keep the non-CI `lint` gate green. Non-blocking. Worth a line in the regenerated PR body's
  risks/follow-ups so a reviewer isn't surprised to see `knip.json` here.
- **O2 (body degradation)** — **RESOLVED by this rework** (ask #2). No longer outstanding.
- **O3 (no test guards the `pr-title.md` prompt instruction)** — still true; the rework added
  feature-pinning tests for the *read* side but not for the prompt content that makes the agent emit
  the file. Low/optional, as before (prompt-string assertions aren't a convention in this suite, and
  `readPrTitle` degrades gracefully via its tested fallback).

## Independent verification this pass
- `vitest run` on `create-pr.test.ts` (19) + `workspace-manager/index.test.ts` (47) +
  `schemas/task.test.ts` (58) → **124 passed**.
- Read the full `create-pr.ts` rework/creation paths and `composePrTitle`/`composePrBody`: title is
  sanitized once (inside `composePrTitle`), body once (at read) — no double-sanitization; the `body`
  ternary is the only change to the compose step.
- Confirmed the `PR for: <title>` stub now appears **only** on the creation path (`openNewPr:229`); the
  rework path no longer composes it. Matches ask #2.

## Bottom line (pass 3)
The rework lands the three owner asks correctly and minimally, and resolves the one prior body-fallback
observation. Verdict unchanged: **ship / `ok`**. O4 is a low-severity, owner-scoped edge surfaced for
awareness; O1 and O3 remain optional/non-blocking.
