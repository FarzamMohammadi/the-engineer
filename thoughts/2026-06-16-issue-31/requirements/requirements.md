# Requirements — Maintainer-triggered SemVer release pipeline (issue #31)

_Run 1 · 2026-06-16 · status: ok (proceed)_

## Context Summary

**What the task asks (in my words):** Replace today's fully-manual release ritual (hand-edit
`package.json`, hand-create a git tag, no GitHub Release, no notes) with a single GitHub Actions
workflow the repository owner triggers on demand. The owner opens the Actions tab, runs the
workflow, and picks a SemVer bump level — `patch` / `minor` / `major`. From that one click,
everything mechanical happens automatically and safely: run the project's quality gate first; if it
passes, compute the new version from the current `package.json`, bump it and commit the bump back to
`main`, create and push an annotated `vX.Y.Z` tag, auto-generate release notes from the
commits/PRs since the last tag (without relying on Conventional Commit prefixes), publish a GitHub
Release with those notes, and produce a `dist` build so the tagged state is known to build cleanly.
If any check fails the run aborts and creates no tag and no release. Plus: document the process for
contributors and keep the README versioning section consistent.

**How much of this did the owner actually state vs. reconstruct:** Almost entirely **owner-stated**.
The task (issue #31) is an unusually complete behavior spec: it gives the problem, the "done" outcome,
the single user, the versioning policy table, ten numbered behavioral requirements, explicit
constraints, an explicit out-of-scope list, acceptance criteria, and the reasoning behind the design.
The spec **deliberately delegates** the *how to build it* (which actions, exact workflow YAML, which
CLI bumps the version, which tool generates notes) to the later Research/Planning phases — this is
stated intent, not a gap. I reconstructed almost nothing about *what done means*; I did reconcile the
spec against the current repository state (see "Reconciliation" below) and resolved one internally
divergent phrase about gate scope from the task's own words.

**Sufficiency judgment:** Legitimate, sufficient owner intent is present. The one genuinely human
decision (is a given release a fix / feature / break?) is *by design* kept human — it is the bump
dropdown. Every mechanical step after that is specified. The acceptance criteria are concrete and
checkable. I would stake the build on them. → **ok / proceed.**

## Repository grounding (what I verified)

- **Current version state (differs from the task narrative):** `package.json` is already at
  `1.0.1`, and a `v1.0.1` annotated-or-lightweight tag already exists. The task describes the repo as
  being at `v1.0.0` with "two patch commits on `main` above `v1.0.0`." Reality: `v1.0.1` was already
  cut **manually** (commit `2d799fd` "Bump version to 1.0.1", a one-line `package.json` edit — exactly
  the error-prone manual process this task replaces), and there are now **3** commits on `main` above
  `v1.0.1` (`4e9405a`, `66ff148`, `1a658a0`). See "Reconciliation."
- **CI today** (`.github/workflows/ci.yml`, on push + PR to `main`): three jobs — `lint`
  (`pnpm lint` + a bundled-plugin-docs sync check), `test` (`pnpm test`, unit only), and `build`
  (`pnpm build`). Uses `pnpm/action-setup@v4` + `actions/setup-node@v4` (node 22, pnpm cache),
  `pnpm install --frozen-lockfile`.
- **Docs deploy** (`.github/workflows/docs.yml`): VitePress → GitHub Pages on push to `main` and
  `workflow_dispatch`. Uses `permissions:` block + `concurrency` — a useful local pattern for the new
  workflow to follow.
- **No release tooling exists yet** — only `ci.yml` and `docs.yml`; no release script in `scripts/`;
  the only "release" references in-repo are docs/journal prose. Nothing to reuse or extend; this is net-new.
- **Verification commands** (npm scripts): `pnpm lint` = `biome check . && tsc --noEmit && tsc --noEmit -p tsconfig.test.json && knip && madge --circular`; `pnpm typecheck` = the two `tsc --noEmit` runs; `pnpm test` = `vitest run` (unit); `pnpm test:all` = unit + integration + e2e; `pnpm build` = `tsdown` ESM + copy migrations + Vite dashboard build.
- **Commit convention** (CONTRIBUTING "Commit Conventions"): title = one imperative sentence, capitalized, ≤72 chars, no Conventional-Commit prefixes; description = bullets. The task additionally pins the bump commit to "one succinct sentence, no `feat:`/`fix:` prefixes, no em-dashes." Precedent for the bump commit message: `"Bump version to 1.0.1"`.
- **Single-maintainer constraint is a documented, deliberate v1 constraint** (`docs/constraints.md`, "Single-User"): the owner is the whole human side. Confirms requirement #9's "only the maintainer."
- **Versioning narrative to keep consistent** lives in two places, both already aligned with the spec:
  - `README.md` "Versioning" (lines 232–234): ships as GitHub releases, npm deferred, breaking schema/config changes don't migrate — reset is the upgrade path.
  - `docs/cli.md` (~line 286, "Upgrading"): same reset-is-the-upgrade-path narrative.
  - README version badge is `shields.io/github/package-json/v/...` — it auto-reads `package.json`, so it needs no manual edit on release.
- **Contributor-doc structure** for the new how-to: `docs/contribution-docs/` (README index + `how-tos/`), surfaced in `docs/.vitepress/config.ts` sidebar under "Contributing." A new release how-to would slot here and into that sidebar, and/or as a CONTRIBUTING section.
- **Local commit hooks** (`lefthook.yml`): pre-commit Biome, pre-push typecheck/knip/madge/test. These run on a developer's machine via lefthook; they do **not** run inside GitHub Actions unless explicitly invoked — relevant to how the workflow commits the bump back to `main`.

## Probing the task to its edges (scenarios)

1. **Happy path, patch.** Owner runs workflow, selects `patch`. Gate (lint + unit test + build)
   passes. Current `1.0.1` → `1.0.2`. `package.json` updated, committed to `main` ("Bump version to
   1.0.2"), annotated tag `v1.0.2` pushed at that commit, notes auto-generated from commits/PRs since
   `v1.0.1`, GitHub Release `v1.0.2` published with notes, `dist` built green. ✅
2. **Gate fails.** A lint or unit-test failure must abort *before* any bump/commit/tag/release. End
   state: `main` unchanged, no new tag, no Release, a clear failure surfaced in the Actions run. The
   ordering "quality gate first" makes this clean — nothing irreversible happens before the gate
   passes.
3. **Minor / major increments.** `minor`: `1.0.1` → `1.1.0`. `major`: `1.0.1` → `2.0.0`. The
   selection maps to the standard SemVer increment of the *current* `package.json` version.
4. **Duplicate-tag / idempotency.** If the computed tag already exists (e.g., a half-finished prior
   run, or a hand-cut tag), the run must fail clearly rather than overwrite/duplicate. (`v1.0.1`
   already existing is the live example of why this guard matters.)
5. **`main` in an unexpected state.** Workflow must fail clearly if it isn't operating on the expected
   `main` state. The spec gives the concrete cases: duplicate tag, non-maintainer actor. Implied
   reasonable additions (left to Planning): the dispatch ref isn't `main`; the tag-to-be already
   exists upstream.
6. **Non-maintainer triggers.** On a single-maintainer repo, only the owner has write access, so
   `workflow_dispatch` is already owner-gated by repo permissions; an explicit actor check is optional
   hardening.
7. **Prose commits → notes.** Because commits are prose (no `feat:`/`fix:`), note generation must not
   depend on Conventional-Commit parsing. GitHub's native release-notes generation (groups by PR /
   author / label, not commit prefix) satisfies this — exact tool is a Planning choice.
8. **Build-as-gate, not as artifact.** `dist` is produced to prove the tagged state builds cleanly;
   publishing that build (npm) is explicitly out of scope. No requirement to attach `dist` to the
   Release — only the notes are attached.
9. **Commit-back-to-`main` mechanics.** The workflow pushes a commit and a tag to `main`. If `main`
   has branch protection requiring PRs/reviews/status checks, a direct push from the Action can be
   rejected — a real operational consideration for Planning (token strategy / protection exemption).
   The *intent* ("commit it back to `main`") is unambiguous; the *mechanism* is delegated.

## Acceptance Criteria

A reviewer should be able to verify all of the following:

1. A `workflow_dispatch` GitHub Actions workflow exists that the owner can run from the **Actions**
   tab, presenting a bump-level choice of `patch` / `minor` / `major` (and nothing auto-triggers it on
   push or per commit).
2. On a successful run, the workflow, with no further human input, computes the new version from the
   current `package.json` per the selected level, and produces: (a) a bumped `package.json` committed
   to `main`, (b) an annotated `vX.Y.Z` tag at that commit, and (c) a published GitHub Release for that
   tag carrying auto-generated notes.
3. The new version is the correct SemVer increment of the current version for each level
   (`patch`→Z+1, `minor`→Y+1 & Z=0, `major`→X+1 & Y=Z=0). From the current `1.0.1`: patch→`1.0.2`,
   minor→`1.1.0`, major→`2.0.0`.
4. The quality gate runs **before** any publish step. If it fails, the run aborts with a clear error
   and creates **no** tag and **no** Release, leaving `main` unchanged. The gate is the project's
   existing CI suite — **`pnpm lint` + `pnpm test` (unit) + `pnpm build`** (see source note in §gate-scope).
5. Release notes are generated from the commits/PRs since the previous tag and require **no**
   Conventional-Commit prefixes anywhere.
6. The bump commit message follows the project convention: one succinct sentence, no `feat:`/`fix:`
   prefixes, no em-dashes.
7. A `dist` build is produced as part of the release run (proving the tagged state builds); the build
   is **not** published to npm.
8. Safety/idempotency: the run does not create duplicate tags and fails clearly if `main` is in an
   unexpected state; only the maintainer can run it.
9. The release process (how to cut a release + the patch/minor/major selection rules) is documented in
   the contributor docs, and the README "Versioning" section remains consistent with the new process
   (GitHub releases, npm deferred, reset-is-the-upgrade-path narrative intact).
10. The mechanism can be validated without publishing a throwaway public release (e.g. a dry-run
    path), **or** its first real run cleanly produces the next patch — **`v1.0.2`** from the commits
    currently on `main` (originally written as `v1.0.1`; see "Reconciliation").

## Source of each requirement (the intake decision)

Every acceptance criterion above traces to **owner-expressed intent** or **established fact** — none
rests on an inference about intent that a different reading could overturn.

- **Owner expressed it** — Criteria 1, 2, 3, 5, 6, 7, 8, 9, and the core of 4 and 10 are stated almost
  verbatim in the issue's "Behavioral requirements," "Constraints," "Out of scope," and "Acceptance
  criteria." The versioning policy table, the single-user actor, and the prose-commit constraint are
  all explicit. The fix/feature/break decision is *intentionally* a human dropdown — the owner stated
  this is the one decision a machine can't make from prose commits.
- **Researchable fact (settled, not asked):**
  - _Current version / next increment._ `package.json` = `1.0.1`, tag `v1.0.1` exists → next patch is
    `v1.0.2`. Verified from the repo and git tags. (Code wins over the task's `v1.0.0` narrative.)
  - _What the existing CI checks are._ `lint` + unit `test` + `build`, from `ci.yml`. Verified.
  - _Where the versioning narrative lives and that it's already consistent._ `README.md` Versioning +
    `docs/cli.md` Upgrading. Verified.
  - _Where contributor how-tos live + the sidebar that lists them._ `docs/contribution-docs/` +
    `docs/.vitepress/config.ts`. Verified.
  - _No prior release tooling exists._ Only `ci.yml`/`docs.yml`; no release script. Verified.
- **Inferred — and tested for an equally-defensible alternative:**
  - <a id="gate-scope"></a>**Quality-gate scope = `pnpm lint` + unit `pnpm test` + `pnpm build`
    (mirror CI), NOT `test:all`.** The spec's phrase is "the project's full verification (the existing
    test + lint/typecheck suite)" and the out-of-scope clause says "the release may reuse the same
    checks [as PR CI]." Reading the controlling, more-specific text: the parenthetical *enumerates the
    existing scripts* — `test`, `lint`, `typecheck` — and `pnpm test` is unit-only; the owner did not
    write `test:all`. "Reuse the same checks" points at PR CI, which runs exactly lint + unit test +
    build. "Keep it simple, dependency-light" pulls the same way. The only pull toward "all tiers
    (incl. integration/e2e)" is the umbrella adjective "full," which the parenthetical immediately
    defines. **Is there an equally-defensible alternative?** A "run all tiers" reading is *defensible*
    but **not equally** so — it's contradicted by the explicit enumeration and by "reuse the same
    checks," with no text anywhere naming integration/e2e. Under the "name a different, equally-
    defensible meaning" test, none survives, so I proceed on the mirror-CI reading and record it.
    _Flag for Planning:_ gate on lint + unit test + build; do **not** silently add integration/e2e. If
    a stricter release gate is ever wanted, that's a deliberate owner extension, not part of this task.

**The trap I explicitly checked for:** is this a "named target, no end-state" task ("set up
releases")? No. The owner specified the end-state in ten behavioral requirements plus acceptance
criteria — the *what done looks like* is fully present; only the *how to build it* is (deliberately)
open. This is the opposite of the forbidden pattern.

## Reconciliation: task narrative vs. current repo state

The issue was written when the repo was at `v1.0.0` with two patch commits on `main`. Since then,
`v1.0.1` was cut **manually** and `main` has advanced by 3 commits. This does **not** change the
owner's intent — it changes only the numbers and removes the literal "first real run produces
`v1.0.1`" escape hatch:

- The pipeline is still needed and is unaffected; it simply starts from `1.0.1`.
- Acceptance criterion 10's second branch now resolves to **`v1.0.2`** (the next clean patch from the
  commits on `main`), not `v1.0.1`. The first branch (a dry-run validation path) is unaffected. The
  requirement — "validate without publishing a throwaway public release, OR let the first real run be
  the validation" — remains satisfiable, and the owner explicitly pre-authorized **either** path, so
  the dry-run-vs-first-real-run choice is left open for Planning as the owner intended.
- Observation (noted, not in scope to fix per the boy-scout rule): the existing `v1.0.0`/`v1.0.1` tags
  may have no corresponding GitHub *Release* (the old manual process published none). Backfilling past
  Releases is not part of this task; the pipeline produces Releases from its next run forward.

## Complexity

**complex.** Net-new CI/CD spanning multiple systems and real unknowns: a `workflow_dispatch`
workflow with inputs; version computation; a privileged commit-and-tag push back to `main` (token /
branch-protection strategy is a genuine unknown); annotated tagging; prose-safe release-notes
generation; a build gate; idempotency/safety guards; plus coordinated documentation across README,
CONTRIBUTING / contribution-docs, and the VitePress sidebar.

## Verification commands (the project's gates, for The Engineer to run later)

These are the project's enforced gates (CI runs lint + test + build; CONTRIBUTING also recommends
`pnpm test:all` for PRs). For this task the change set is mostly a workflow + docs, but the standard
gates must still pass:

- **lint** — `pnpm run lint`
- **typecheck** — `pnpm run typecheck`
- **test** — `pnpm test`
- **build** — `pnpm build`

(`pnpm test:all` adds integration + e2e; available but not part of the CI-enforced gate.)

## Notes carried forward for Research / Planning (delegated by the owner — not blockers)

- **Token / branch-protection strategy** for pushing the bump commit + tag to `main` from Actions
  (default `GITHUB_TOKEN` with `contents: write` vs. a PAT; interaction with any `main` protection
  rules). Intent ("commit it back to `main`") is fixed; mechanism is open. Verify the repo's actual
  `main` protection during Research.
- **Which action/CLI bumps the version** (e.g. `npm version --no-git-tag-version` vs. a dedicated
  action) and **which mechanism generates notes** (GitHub's native generate-release-notes is the
  natural prose-safe fit). Both explicitly delegated.
- **Definition of "unexpected state"** beyond the spec's named cases (duplicate tag, non-maintainer):
  reasonable additions are "dispatch ref is `main`" and "computed tag absent upstream." Planning to
  finalize.
- **Avoid a CI feedback loop:** the bump commit pushed to `main` will trigger `ci.yml` (push) and
  `docs.yml`; that's expected and harmless, but Planning should be aware.
- **Doc placement:** a release how-to fits `docs/contribution-docs/how-tos/` (+ the VitePress sidebar
  in `docs/.vitepress/config.ts`) and/or a CONTRIBUTING section; follow existing structure. Keep the
  README "Versioning" + `docs/cli.md` "Upgrading" narrative intact.
- **README version badge** auto-reads `package.json`; no manual edit needed on release.
