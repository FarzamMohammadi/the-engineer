# PR Description — Maintainer-triggered SemVer release pipeline (issue #31)

_Run 1 · 2026-06-15_

---

## Title

Add maintainer-triggered SemVer GitHub release workflow

## Body

### What and why

Cutting a release was fully manual: hand-edit the version in `package.json`, hand-create a git
tag, no GitHub Release, no release notes. That is error-prone, easy to forget, and inconsistent.
This adds a single GitHub Actions workflow the repository owner runs on demand: open the Actions
tab, pick a SemVer bump level (`patch` / `minor` / `major`), and everything mechanical happens
automatically and safely — gate, bump, commit, tag, notes, Release. A release is never cut from a
red build, and the one judgment a machine can't make from our prose commits (is this a fix, a
feature, or a break?) stays human as the bump dropdown.

### How

- **`.github/workflows/release.yml`** — a `workflow_dispatch` workflow with a `level` choice
  (`patch`/`minor`/`major`, default `patch`) and a `dry_run` boolean. Nothing auto-triggers it on
  push or per commit.
- **Gate first, mutate never-before-green.** The run executes the project's existing CI checks —
  `pnpm lint` + the bundled-plugin-docs sync check + `pnpm test` + `pnpm build`, mirroring `ci.yml`
  exactly — before any mutation. If anything fails the run aborts with `main` unchanged and no tag
  or release.
- **Version + bump.** `npm version <level> --no-git-tag-version` computes the new version from the
  current `package.json` (no git side effects, lockfile untouched). The bump is committed with the
  prose message `Bump version to X.Y.Z` (no Conventional Commit prefix, no em-dash — matches the
  existing `Bump version to 1.0.1`), an annotated `vX.Y.Z` tag is created, and commit + tag are
  pushed to `main` with `git push --atomic` so they land together or not at all.
- **Prose-safe notes.** `gh release create --generate-notes` (with `--notes-start-tag <prev>` when a
  previous tag exists) lets GitHub group notes by PR/author — no Conventional Commit prefixes
  required anywhere.
- **Safety / idempotency.** A ref-must-be-`main` guard fails fast; the run refuses if the computed
  tag exists locally or on `origin`, or if a Release for it already exists; a `concurrency` group
  serializes runs so two dispatches can't race the push.
- **Verified build, not published artifact.** `pnpm build` runs in the gate to prove the tagged
  state builds cleanly (requirement #8). The bump is a version-only edit that cannot change
  `tsdown`/Vite output, so building the pre-bump tree is equivalent to building the tagged commit.
  Publishing to npm is out of scope.
- **Protected-`main` auth.** The default `GITHUB_TOKEN` cannot push to protected `main`, so the
  workflow checks out and pushes using a `RELEASE_PAT` secret (the owner's fine-grained token). A
  one-time setup is documented.
- **`dry_run` path.** Ticking `dry_run` runs the gate, computes the version, and previews the
  generated notes in the run summary — creating no commit, tag, or release.
- **Docs.** New how-to `docs/contribution-docs/how-tos/release.md` (how to cut a release, the
  patch/minor/major selection rules, `RELEASE_PAT` setup, the `dry_run` path, and recovery if a run
  dies mid-publish), wired into the VitePress sidebar and the contribution-docs index, plus a
  pointer from the README "Versioning" section. The existing versioning narrative (GitHub releases,
  npm deferred, reset-is-the-upgrade-path) is left intact and consistent.
- **Supporting one-liners.** `knip.json` adds `lefthook` to `ignoreDependencies` so the release
  gate's `pnpm lint` stays green (lefthook is genuinely used via `lefthook.yml`); `.gitignore` adds
  `*.bak` for editor/tooling backups.

### Verification

- All project gates run green on the current tree (the workflow's own premise is that this gate must
  be green to cut a release):
  - `pnpm lint` (biome + `tsc --noEmit` ×2 + knip + madge) — pass
  - `pnpm test` — pass, **139 files, 2624 tests**
  - `pnpm build` — pass
  - `pnpm check:exports` — pass
  - `release.yml` parses as valid YAML (14 steps)
- The workflow was re-traced against all 10 behavioral requirements and the acceptance criteria —
  trigger/inputs, gate-before-mutation ordering, version increments, idempotency guards, atomic
  push, prose-safe notes, and the build-as-gate rationale.
- **What a reviewer should verify themselves:** the workflow can only be fully exercised by running
  it in GitHub Actions, which this PR cannot do. Before the first real run, create the `RELEASE_PAT`
  secret per the how-to. The `dry_run` input validates the gate + version computation + notes
  preview without publishing anything.

### Risks and follow-ups

- **One-time `RELEASE_PAT` setup is required** before the first real run (fine-grained PAT, this repo
  only, Contents: Read and write). `dry_run` does **not** exercise the protected-`main` push, so the
  first real run is what proves the PAT wiring; a release that fails with an auth/permission error
  means the PAT has lapsed or is missing.
- **Repo-state drift vs. the spec.** The issue was written at `v1.0.0`; since then a *manual* bump
  landed, so `package.json` is now `1.0.1` and a `v1.0.1` tag exists. The acceptance line "first real
  run produces `v1.0.1`" is therefore moot — the next patch run computes `v1.0.2`, which the workflow
  handles correctly. That criterion is an OR; its other branch (validate via a dry-run path) is
  satisfied by the `dry_run` input.
- **Past tags may lack Releases.** The pre-existing `v1.0.0`/`v1.0.1` tags were cut by the old manual
  process and likely have no corresponding GitHub Release. Backfilling past Releases is out of scope;
  the pipeline produces Releases from its next run forward.
- **Partial-failure window.** If a run dies after the tag is pushed but before the Release is created,
  finish it with `gh release create <tag> --verify-tag --generate-notes` rather than re-running (a
  re-run would compute the next version). This recovery is documented in the how-to.
- **Expected side effects.** The bump commit landing on `main` harmlessly re-triggers CI and the docs
  deploy.
- **Out of scope (unchanged):** npm publishing, per-commit/automatic releases, Conventional Commits,
  pre-release channels, and the existing PR CI workflow's purpose.

### Note on the diff

This branch also carries the orchestrator's `thoughts/` audit trail for the task. Whether that ships
in the final PR or is squashed out is an owner/orchestrator call, not part of the product change
(the workflow + docs). The product change is the seven files outside `thoughts/`.
