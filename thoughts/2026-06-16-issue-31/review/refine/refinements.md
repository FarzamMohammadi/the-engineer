# Refine — Maintainer-triggered SemVer release pipeline (issue #31)

_Run 1 · 2026-06-15 · final quality gate before delivery_

## Verdict: **ship**

The product change is correct, complete, and clean. I consolidated the one review lens's findings,
independently re-traced the workflow, ran every project gate green, and fixed the single actionable
finding in place. Nothing material remains. Details below.

---

## Lenses consolidated

Only one lens ran for this change: **self-review** (`review/self-review/findings.md`). It found no
correctness defects in the workflow or docs and raised three findings, none in the product code. I
verified each against the actual repository rather than taking them on faith.

| ID | Lens finding | My verification | Disposition |
|----|--------------|-----------------|-------------|
| F1 | Two stray `.bak` backup files committed (Medium) | Confirmed: both are stale pre-overwrite snapshots of `session-result.json` (the execution `.bak` is the Run-1 result, before the lefthook fix; the live file is Run-2). Tooling cruft, not deliverables. `.gitignore` had no `*.bak` rule. | **FIXED in place** (commit `e3a6dfc`) |
| F2 | Entire `thoughts/` tree is newly committed (Low) | Confirmed not a defect: `.gitignore` does not ignore `thoughts/`, and every prior phase committed its own artifacts (`Add issue #31 engineer workspace artifacts`, `Record issue #31 execution run 2 artifacts`). This is the orchestrator's intended audit trail. | No action — orchestrator-level, not a product defect |
| F3 | `knip.json` re-adds `lefthook` to `ignoreDependencies`, reversing owner commit `66ff148` (Low, already-surfaced) | Confirmed correct and load-bearing: `lefthook` is genuinely used (`lefthook.yml` + `package.json` `onlyBuiltDependencies`). `pnpm lint` passes **because** of this line; without it knip reports lefthook as unused and the release gate can never go green. Already surfaced as a discretionary decision in execution (`refactoring_local`). | No action — already in front of the owner; re-raising a settled decision would be wrong |

No duplicate findings to drop; only one lens ran.

---

## Fix applied (commit `e3a6dfc`)

**Remove stray `.bak` backups and gitignore them.**

- `git rm` of the two timestamped `session-result.*.json.bak` snapshots in
  `thoughts/2026-06-16-issue-31/execution/` and `.../planning/`.
- Added `*.bak` to `.gitignore` (under a new "Editor / tooling backups" comment, alongside the
  existing `*.swp`/`*.swo` editor-cruft patterns) so future tooling backups are never tracked.
  Verified with `git check-ignore` that a new `*.json.bak` is now ignored.
- Touches only the audit trail and one `.gitignore` line; no product code changed.
- Pre-commit biome hook passed cleanly; the change is inert with respect to lint/typecheck/test/build.

This was a clear-cut cleanup (no reasonable owner wants stale backup duplicates tracked), so it is
not recorded as a discretionary decision needing confirmation.

---

## Independent review of the product change

I did not rely on the self-review's trace alone. I re-read `release.yml`, `ci.yml`, the how-to, and
every one-line edit, and re-traced the workflow against all 10 behavioral requirements and the
acceptance criteria.

**Workflow (`.github/workflows/release.yml`, 14 steps, YAML parses clean):**

- **Trigger / inputs** (req 1–2): `workflow_dispatch` only; `level` choice (default `patch`) plus a
  `dry_run` boolean. Uses typed `inputs.*`, so `${{ !inputs.dry_run }}` is a real boolean.
- **Gate before mutation** (req 3): lint → bundled-docs sync → test → build all run before the first
  mutation (`Compute version`). Mirrors `ci.yml`'s three jobs exactly in scope. Any failure aborts
  with `main` unchanged, no tag, no release.
- **Version compute** (req 3): `npm version "$LEVEL" --no-git-tag-version` — `LEVEL` passed via env
  (injection-safe), no git side effects, skips npm's clean-tree check, does not touch `pnpm-lock.yaml`.
- **Idempotency** (req 9): guards local tag / remote tag / existing release; `set -e` is correctly
  not tripped by the checks inside `if` conditions. Runs for dry runs too.
- **Commit + tag + push** (req 4–5): commits only `package.json` with the prose message
  `Bump version to X.Y.Z` (no prefix, no em-dash — matches existing `2d799fd`); annotated tag;
  `git push --atomic` lands commit and tag together or neither.
- **Publish** (req 6–7): `gh release create --verify-tag --generate-notes` (plus `--notes-start-tag`
  when a previous tag exists) — prose-safe notes, no Conventional Commits, reuses the pushed
  annotated tag. `--notes-start-tag` is valid alongside `--generate-notes`.
- **Verified build** (req 8): build runs in the gate on the pre-bump tree; the only delta to the
  tagged tree is the version string, which cannot change `tsdown`/Vite output. Reasonable, documented.
- **Safety** (req 9): ref-is-`main` guard fails fast before checkout; `concurrency` group serializes;
  `RELEASE_PAT` only ever used as the checkout token / `GH_TOKEN`, never echoed.
- **Docs** (req 10): new how-to + sidebar + contribution-index + additive README pointer; README
  versioning narrative untouched and consistent (npm deferred / GitHub releases / reset-is-the-upgrade).

I looked specifically for real defects (input typing, `set -e` interactions in the guards, atomic
push behavior on a moved `main`, `gh` flag compatibility, notes-without-Conventional-Commits, the
partial-failure window between push and publish) and found none. The partial-failure window is
covered by documented recovery in the how-to.

---

## Gates run (all green)

Run on the current tree; the release workflow's premise is that this gate must be green to cut a
release, so a red gate here would itself be a defect.

| Gate | Command | Result |
|------|---------|--------|
| Lint | `pnpm lint` (biome + tsc + tsc test + knip + madge) | pass (3 knip warn-level notices, not errors) |
| Exports | `pnpm check:exports` (knip) | pass |
| Build | `pnpm build` | pass (vite chunk-size note is informational, exit 0) |
| Test | `pnpm test` | pass — **139 files, 2624 tests** |
| YAML | parse `release.yml` | valid, 14 steps |

The green lint run also confirms F3: the knip/lefthook line is load-bearing.

---

## Observation for the PR reviewer (not a blocker, not mine to resolve)

The spec was written when the project was at `v1.0.0` with two patch commits on `main`. Since then a
**manual** bump landed: `package.json` is now `1.0.1` and a `v1.0.1` git tag exists (commit `2d799fd`
"Bump version to 1.0.1"), reachable from `HEAD`. Consequences:

- The acceptance line "its first real run cleanly produces `v1.0.1`" is now moot — the next patch run
  computes `v1.0.2`. The workflow handles this correctly (`git describe` finds `v1.0.1`, notes start
  there). The acceptance criterion is an **OR**, and its other branch — "validated without publishing
  a throwaway public release (e.g. a dry-run path)" — is satisfied by the `dry_run` input. So the
  criterion is met.
- A `v1.0.1` git tag exists but (per the manual process) likely has no corresponding GitHub Release.
  That is pre-existing manual state, outside this change's scope; the workflow neither depends on nor
  repairs it.

No code change is warranted. Flagging only so the picture is complete for whoever opens the PR.

Separately, F2 (whether the `thoughts/` audit trail should ship in the final PR vs. be squashed) is an
orchestrator/owner call, not a product defect. The repo's `.gitignore` currently tracks `thoughts/`,
so the intent reads as "keep it." Noting for visibility; nothing for me to do.

---

## Why ship (not revise / rework)

- The only actionable finding (F1) is fixed in place; F2/F3 are non-defects / already-surfaced.
- My fix touched only audit-trail files and one `.gitignore` line — the product code (workflow + docs)
  is unchanged, so re-running the lenses (`revise`) would have nothing new to review.
- Requirements are clear, the plan was sound, execution was clean and gates are green. No root cause
  lives in an earlier phase, so no `rework_*` verdict applies.
