# Self-review — Maintainer-triggered SemVer release pipeline (issue #31)

_Run 1 · 2026-06-15 · reviewer lens: holistic last look (correct / complete / as-simple-as-it-can-be)_

## Verdict

The product change is **clean and ships-ready**. The release workflow is correct on a careful
step-by-step trace, faithfully mirrors the existing CI gate, is appropriately minimal (no wrappers,
no dead abstraction, comments only where a choice is non-obvious), and covers every behavioral
requirement and acceptance criterion. Documentation is terse and consistent with the README.

I found **no correctness defects in the workflow or docs.** The only findings are about **what
ships alongside the change** (stray backup files in the committed audit trail) and one already-
surfaced decision worth keeping visible. Details below.

## What I reviewed

- `git diff 1a658a0..HEAD` — full change set.
- Product files, read in full: `.github/workflows/release.yml`, `docs/contribution-docs/how-tos/release.md`,
  and the one-line edits to `README.md`, `docs/.vitepress/config.ts`, `docs/contribution-docs/README.md`, `knip.json`.
- `.github/workflows/ci.yml` — to confirm the release gate mirrors CI exactly.
- Requirements, research, plan, and execution artifacts for intent and trace.
- Verified: workflow YAML parses (14 steps, valid); lefthook is genuinely in use
  (`lefthook.yml` + `package.json` `onlyBuiltDependencies`); commit `66ff148` that the knip
  change reverses; the `.bak` files are duplicates of the live `session-result.json` files.

## Correctness trace (workflow) — all pass

- **Trigger / inputs** (req #1, #2): `workflow_dispatch` only; `level` choice (default `patch`) +
  `dry_run` boolean. Uses the typed `inputs.*` context (not the stringly-typed `github.event.inputs.*`),
  so `${{ !inputs.dry_run }}` evaluates as a real boolean — correct.
- **Gate-before-mutation** (req #3): lint → bundled-docs sync → test → build all run before
  `Compute version`; any failure fails the job before the first mutation. `main` unchanged, no tag,
  no release. Mirrors `ci.yml`'s three jobs exactly (including the bundled-docs sync check). Correct.
- **Version compute** (req #3 increments): `npm version "$LEVEL" --no-git-tag-version` — does not
  touch `pnpm-lock.yaml`, makes no git side effects, and skips npm's clean-tree check. `LEVEL` passed
  via env, not inline interpolation (injection-safe). Correct.
- **Idempotency** (req #9): guards tag-local / tag-remote / release-exists, and runs for dry runs
  too. `set -e` is correctly not tripped by the `git ls-remote --exit-code` inside the `if`. Correct.
- **Dry run** (AC10): previews computed tag + notes to the step summary; creates nothing; honestly
  notes it cannot exercise the protected push. Correct.
- **Commit + tag + atomic push** (req #4, #5): commits only `package.json` with the prose message
  `Bump version to X.Y.Z` (no prefix, no em-dash); annotated tag; `git push --atomic` lands commit
  and tag together or neither. Correct.
- **Publish** (req #6, #7): `gh release create --verify-tag --generate-notes` (+ `--notes-start-tag`
  when a prev tag exists) — prose-safe notes, no Conventional Commits, uses the already-pushed
  annotated tag. Correct.
- **Verified build** (req #8): build runs in the gate on the pre-bump tree. The only delta to the
  tagged tree is the version string in `package.json`, which cannot break a `tsdown`/Vite build, so
  the tagged state is known to build cleanly. The workflow comment documents this reasoning. A
  reasonable, well-justified choice — not a defect.
- **Safety** (req #9): ref-is-`main` guard fails fast (step 1, before checkout); `concurrency` group
  serializes runs; `RELEASE_PAT` never echoed. Correct.
- **Docs** (req #10 / AC9): new how-to + sidebar + index registrations + one additive README pointer;
  README versioning narrative untouched and consistent. Correct.

## Findings

### F1 — [Medium · what-ships] Two stray `.bak` backup files are committed

- **Files:**
  - `thoughts/2026-06-16-issue-31/execution/session-result.2026-06-16T01-51-21-219Z.json.bak`
  - `thoughts/2026-06-16-issue-31/planning/session-result.2026-06-16T01-28-21-566Z.json.bak`
- **Why it matters:** Each is a timestamped backup duplicate of the live `session-result.json`
  sitting next to it (the `.bak` is the larger, earlier copy — a pre-overwrite snapshot the tooling
  left behind). These are not deliverables; they are tooling backups that slipped into the commit.
  There is no `*.bak` entry in `.gitignore`, so they are tracked and will ship. A human reviewer
  would send these back as stray files.
- **Fix:** `git rm` both `.bak` files from the change set (and consider adding `*.bak` to
  `.gitignore` so future runs don't recommit them). This touches only the audit trail, not the
  product code.

### F2 — [Low · confirm-intended] The entire `thoughts/` tree is newly committed

- **Scope:** The base branch (`1a658a0`) has **zero** `thoughts/` files; this branch adds ~1,500
  lines of engineer process artifacts (requirements / research / plan / implementation / multiple
  `session-result.json`).
- **Why it matters:** This is almost certainly the orchestrator's intended audit trail (it is how
  this very review reads prior phases), so it is **not** a defect in the feature. But a reviewer
  opening a PR titled "Add a release pipeline" will be surprised to find the process artifacts
  shipping with it. Flagging only so the orchestrator confirms these are meant to be in the final
  PR rather than stripped/squashed before merge. No action needed from `refine` on the product code.

### F3 — [Low · already-surfaced] `knip.json` reverses a deliberately-messaged owner commit

- **File:** `knip.json` (re-adds `lefthook` to `ignoreDependencies`).
- **What it is:** The change is **correct and load-bearing** — `lefthook` is genuinely in use
  (`lefthook.yml` + `onlyBuiltDependencies`), knip can't see config-file usage, so the "unused"
  report is a false positive; and the release gate runs `pnpm lint`, so lint must be green for the
  pipeline to ever cut a release. The fix is one line, fully reversible, and was properly surfaced as
  a discretionary decision (execution `details.decisions`, category `refactoring_local`).
- **The one nuance to keep visible:** it reverses commit `66ff148` whose message —
  "Remove lefthook from knip's ignoreDependencies" — states the removal was *intentional*, while the
  execution note characterizes it as "accidental." The reading is reasonable (66ff148 touched only
  `knip.json` and left the dependency + config intact, and main's lint is currently red because of
  it), but the owner is the only one who knows whether they meant to drop lefthook entirely. Since
  this is **already surfaced** to the owner's autonomy policy, no new action is needed — noted so the
  full picture stays visible during review. Not actionable by `refine`.

## What I explicitly checked and found clean

- No code-level bug in the workflow (input typing, `set -e` interactions, atomic push, `npm version`
  lockfile behavior, gate ordering, `gh` flag compatibility all verified by trace).
- Release gate is byte-for-byte equivalent in scope to `ci.yml` (lint + bundled-docs sync + test +
  build) — the settled gate scope, not `test:all`.
- No secrets echoed; `RELEASE_PAT` used only as checkout token and `GH_TOKEN`.
- Doc links resolve: README → how-to (relative repo path, valid on GitHub); how-to → README anchor
  (absolute URL, deliberately, because the root README is not a built VitePress page); sidebar +
  index entries match the new file.
- README versioning narrative unchanged (npm deferred / GitHub releases / reset-is-the-upgrade-path
  intact); the added sentence is purely additive.
- No test gap: a GitHub Actions workflow cannot be unit-tested in this repo (no harness exists), and
  the `dry_run` path is the intended pre-merge validation. Standard and acceptable.
- Documentation is appropriately terse (the owner asked for exactly one minimal doc); no padding.
</content>
</invoke>
