# Research — Maintainer-triggered SemVer release pipeline (issue #31)

_Run 1 · 2026-06-16 · status: ok (proceed)_

This builds on `requirements/requirements.md`. I re-verified its claims against the live repo
rather than inheriting them, and surfaced new facts the requirements phase flagged as open (chiefly
the **branch-protection / token** question, now answered with data). Labels: **[OBS]** = verified by
reading code/running a command; **[INF]** = my conclusion from those facts.

---

## 1. The single most important finding (read this first)

The task requires the workflow to **commit the version bump back to `main`** (req #4) and **push an
annotated tag** (req #5), in one click with no further input (req #1, acceptance criterion 2). The
live repo's settings make the *commit-to-main* push the central engineering risk:

**[OBS] `main` is a protected branch.** From `gh api .../branches/main/protection`:
- `required_pull_request_reviews`: `required_approving_review_count: 1`, `dismiss_stale_reviews: true`,
  `require_last_push_approval: true`, `require_code_owner_reviews: false`.
- `required_status_checks`: contexts `["lint", "test"]`, `strict: false` (build is **not** a required
  check; "up to date" not required).
- `enforce_admins`: **false** → repository admins are **not** bound by the rules (they can bypass).
- `allow_force_pushes`: false, `allow_deletions`: false, `required_conversation_resolution`: true,
  `required_signatures`: false.
- No repo **rulesets** (`gh api .../rulesets` → `[]`).
- No **tag protection** rules (`gh api .../tags/protection` → 404). So pushing a `v*` tag is **not**
  blocked.

**[OBS] The default `GITHUB_TOKEN` is read-only in this repo.**
`gh api .../actions/permissions/workflow` → `default_workflow_permissions: "read"`,
`can_approve_pull_request_reviews: false`. Confirmed by the existing workflows: `docs.yml` declares an
explicit `permissions:` block (it needs `pages: write`), while `ci.yml` declares none (it only reads).
**[INF]** The new release workflow **must** declare `permissions: contents: write` (plus whatever the
release step needs) or every write will fail.

**[OBS] The owner/viewer is an admin** (`gh api repos/... --jq .permissions` → `admin: true`).

**[INF] The crux:** "Require a pull request before merging" blocks *all direct pushes* to `main` for
any actor not in a bypass list. `enforce_admins: false` lets the human admin (owner) push directly
from their laptop, but the `github-actions[bot]` identity behind the default `GITHUB_TOKEN` is **not**
an admin and is **not** in any bypass list. Therefore a `git push origin main` of the bump commit
using the default `GITHUB_TOKEN` will very likely be **rejected** by branch protection, even with
`contents: write`. The tag push itself is fine (no tag protection); it is the *commit on `main`* that
is gated.

**[INF] A PR-based bump flow does not satisfy the spec here.** A PR into `main` needs 1 approval, and
`require_last_push_approval: true` + Actions' `can_approve_pull_request_reviews: false` means the bot
cannot self-approve and a single maintainer cannot approve their own authored PR. That breaks "one
click, no further input." So the bump must be a *direct push by a privileged identity*, not a PR.

**Resolution space for Planning (all verified-feasible, each with a cost):**
1. **Owner-provided PAT** (classic or fine-grained with `contents: write`) stored as an Actions
   secret; `actions/checkout` uses `token: ${{ secrets.RELEASE_PAT }}` so pushes act as the owner
   (an admin → bypasses protection because `enforce_admins: false`). Cost: a managed long-lived
   secret; fine-grained PATs expire. **Most common, simplest to reason about.**
2. **Add a bypass allowance** to the `main` protection ("Allow specified actors to bypass required
   pull requests") for `github-actions[bot]` (or a GitHub App). Cost: an owner setting change outside
   the repo; default `GITHUB_TOKEN` then works.
3. **GitHub App installation token** with `contents: write` and bypass. Cost: more setup (app + secret
   for app id/private key), but no human PAT to rotate.

> **This requires an owner action outside the code** (create a PAT secret, or change a branch setting,
> or install an app) regardless of which option Planning picks. The requirements phase explicitly
> delegated the *mechanism* to Planning and kept the *intent* ("commit it back to main") fixed, so
> this is not a research blocker — but it is the one place the pipeline cannot be made to work by
> committing files alone. **Flag prominently for Planning; the owner will need to provision one
> credential/setting.** (See §8 for why I did not raise `needs_human`.)

---

## 2. What exists today (verified inventory)

**[OBS] Workflows** (`.github/workflows/`):
- `ci.yml` — triggers on `push` + `pull_request` to `main`. Three independent jobs, each does
  `actions/checkout@v4` → `pnpm/action-setup@v4` → `actions/setup-node@v4` (node 22, `cache: pnpm`) →
  `pnpm install --frozen-lockfile`:
  - **lint**: `pnpm lint`, then an extra step that runs `pnpm run docs:bundle` and
    `git diff --exit-code src/cli/bundled/plugin-docs.ts` (fails if bundled plugin docs are stale).
  - **test**: `pnpm test` (vitest unit only).
  - **build**: `pnpm build`.
  - No `permissions:` block (read-only default suffices).
- `docs.yml` — `push` to `main` + `workflow_dispatch`; VitePress → GitHub Pages. **This is the local
  pattern to copy**: explicit `permissions:` block, a `concurrency:` group, `workflow_dispatch`, and
  `gh`-free deploy via official actions.

**[OBS] No release tooling exists.** `.github/` has only `ci.yml`, `docs.yml`, issue/PR templates.
`scripts/` has `setup.sh`, `reset.sh`, `lib.sh`, `e2e-run.ts`, `gen-bundled-docs.ts` — **no release
script**. No `.github/release.yml` (release-notes category config) anywhere. This is net-new; nothing
to extend.

**[OBS] No GitHub Releases published yet** (`gh release list` → empty), despite tags existing. So the
first run's auto-notes will compute "since previous tag" from the tag, not a prior Release.

**[OBS] Tags present** (`git tag -l`): `v0.1.0-preview` … `v0.8.0-preview`, `v1.0.0`, `v1.0.1`. Both
`v1.0.0` and `v1.0.1` are **annotated** tags (`git cat-file -t` → `tag`; tagger "Farzam Mohammadi").
**[INF]** req #5's "annotated tag `vX.Y.Z`" matches the established convention exactly.

**[OBS] Version state confirms the requirements reconciliation.** `package.json` `version` = `1.0.1`.
`main` is 3 commits ahead of `v1.0.1`: `4e9405a`, `66ff148`, `1a658a0`. Latest manual bump was
`2d799fd "Bump version to 1.0.1"`. **[INF]** Next clean patch = **`v1.0.2`** (acceptance criterion 10,
2nd branch). The task's "v1.0.0 + two patch commits" narrative is stale; code wins.

**[OBS] `package.json` essentials:** `"packageManager": "pnpm@10.32.0"`, `"engines.node": ">=22.0.0"`,
`.node-version` = `22`. Scripts that matter:
- `lint` = `biome check . && tsc --noEmit && tsc --noEmit -p tsconfig.test.json && knip && madge --circular --extensions ts src/`
- `typecheck` = the two `tsc --noEmit` runs.
- `test` = `vitest run` (unit). `test:all` = unit + integration + e2e.
- `build` = `tsdown src/index.ts --format esm && cp -r src/db/migrations dist/migrations && pnpm run build:dashboard` (the dashboard build is `vite build`). **[INF]** Build is hermetic — no
  secrets/network beyond the already-installed deps; it already runs green in `ci.yml`'s build job.
- No `tsdown.config.*` file — build config is inline CLI flags.

**[OBS] Commit convention** (`CONTRIBUTING.md` §"Commit Conventions"): title = one imperative
sentence, capitalized, ≤72 chars, **no** Conventional-Commit prefixes; description = bullets. The task
additionally pins the bump commit to "one succinct sentence, no `feat:`/`fix:` prefixes, no em-dashes."
Established precedent: `"Bump version to 1.0.1"`. **[INF]** Bump message format: `Bump version to X.Y.Z`.

**[OBS] Local hooks** (`lefthook.yml`): pre-commit Biome (staged); pre-push typecheck + knip + madge +
`vitest run`. **[INF]** These run on a developer machine via lefthook, **not** inside Actions unless
invoked. A CI bump commit pushed with the GITHUB_TOKEN/PAT does **not** trigger lefthook — irrelevant
to the workflow, but means the workflow can't lean on hooks for safety; the gate must be explicit.

---

## 3. The documentation surface (req #10) — verified locations

The task requires documenting the process and keeping the README versioning section consistent. The
exact files and the consistency target:

- **[OBS] `README.md` §"Versioning"** (lines 232–234): states releases "ship as GitHub releases (npm
  publish is deferred)"; breaking schema/config changes "do not migrate" → "[reset](docs/cli.md#upgrading)
  is the upgrade path." **[INF]** The new process is *consistent by construction* (it produces GitHub
  Releases, defers npm). What's missing is a pointer to *how to cut* a release. Edits should be
  additive and must not contradict the npm-deferred / reset-is-the-upgrade-path narrative.
- **[OBS] Version badge** (README line 5) is `shields.io/github/package-json/v/...` — auto-reads
  `package.json`. **[INF]** No manual badge edit on release.
- **[OBS] `docs/cli.md` §"Upgrading"** (~line 277+): the reset-is-the-upgrade-path narrative lives here
  too. **[INF]** Keep intact; it is the link target from the README.
- **[OBS] Contributor how-tos** live in `docs/contribution-docs/how-tos/` (existing:
  `setup/operator-setup.md`, `plugins/authoring.md`, `observability.md`, `zod-schemas.md`), indexed by
  `docs/contribution-docs/README.md`. **[INF]** A "Cutting a Release" how-to slots here (its README
  guidance: "Add a how-to when a system has non-obvious conventions"). The bump-selection rules
  (patch/minor/major table from the task) belong in that how-to.
- **[OBS] VitePress sidebar** (`docs/.vitepress/config.ts`, ~lines 96–104, "Contributing" group)
  lists each how-to explicitly. **[INF]** A new how-to must be added here too, or it won't appear in
  the docs site nav (the sidebar is hand-maintained, not glob-generated).
- **[OBS] `CONTRIBUTING.md`** has a §"Commit Conventions" and §"Pull Request Process" but no release
  section. **[INF]** Optional: a short "Cutting a Release" pointer in CONTRIBUTING linking to the
  how-to keeps it discoverable. The single-maintainer constraint is documented in `docs/constraints.md`
  §"Single-User" (confirms req #9 "only the owner").

---

## 4. End-to-end execution path the workflow must implement (traced against the spec)

Mapping each behavioral requirement to a concrete, verified mechanism (tool choices remain Planning's;
these are the natural fits given what's installed):

1. **Trigger (req #1):** `on: workflow_dispatch`. **[OBS]** Triggering `workflow_dispatch` requires
   write access → single-maintainer repo means only the owner can run it; an explicit actor check is
   optional hardening (the requirements called it optional). No `push`/`schedule` trigger.
2. **Bump input (req #2):** `inputs.level` with `type: choice`, options `patch`/`minor`/`major`,
   default `patch` (the spec says PATCH is the default lane).
3. **Gate first (req #3):** install + `pnpm lint` + `pnpm test` + `pnpm build` **before** any mutating
   step. **[INF]** This mirrors `ci.yml` (the requirements' settled gate-scope reading: lint + unit
   test + build, **not** `test:all`). Open nuance: `ci.yml`'s lint job also runs the **bundled-docs
   sync check** (`docs:bundle` + `git diff --exit-code`). It is a separate CI step, not part of
   `pnpm lint`. On `main` it should already be in sync (CI enforces it per-push), so omitting it is
   low-risk; Planning decides whether to include it for fidelity.
4. **Version compute + bump + commit (req #4):** compute new version from current `package.json` per
   `level`. Natural tool: `npm version <level> --no-git-tag-version` (or `pnpm version <level>
   --no-git-tag-version`), which rewrites `package.json` and emits the new version; then commit
   `package.json` with message `Bump version to X.Y.Z`, configured git user/email. **[INF]** This is
   the push that hits branch protection (§1).
5. **Tag (req #5):** `git tag -a vX.Y.Z -m "vX.Y.Z"` at the bump commit, then push. No tag protection
   (§1) so this push is unblocked once auth is sorted.
6. **Notes (req #6):** must not depend on Conventional Commits. **[OBS]** GitHub's native
   auto-generated notes (`gh release create --generate-notes`, or the REST `generate_release_notes`
   flag, or `softprops/action-gh-release` with `generate_release_notes: true`) group by PR/author/label
   — **not** by commit prefix. **[INF]** This is the prose-safe fit; optionally tunable via
   `.github/release.yml`. With no prior Release, the notes diff against the previous tag (`v1.0.1`).
7. **Publish (req #7):** create a GitHub Release for the new tag carrying the notes (`gh release
   create vX.Y.Z --generate-notes`, or the action above). `gh` is preinstalled on `ubuntu-latest` and
   uses `GITHUB_TOKEN` (needs `contents: write`).
8. **Verified build (req #8):** the `pnpm build` from step 3 already proves the tagged state builds.
   No requirement to attach `dist` to the Release (npm publish out of scope). **[INF]** Build-as-gate,
   not artifact.
9. **Safety/idempotency (req #9):** before tagging, fail if `vX.Y.Z` already exists locally or
   upstream (`git rev-parse -q --verify` / `git ls-remote --tags`) and/or a Release exists. Fail if the
   dispatch ref is not `main`. **[OBS]** `v1.0.1` already existing is the live reason this guard
   matters — re-running with the wrong level or a stale tree must not clobber.
10. **Docs (req #10):** §3 above.

**Ordering for safety [INF]:** gate → compute version → idempotency guard (tag/release absent) →
commit bump to `main` (the protected push; abort cleanly if it fails) → tag the bump commit → push tag
→ create Release. Doing the protected `main` push *before* tagging avoids leaving a tag that points at
a commit that never landed on `main`. Nothing irreversible happens before the gate passes.

---

## 5. Blast radius — what else this touches or could disturb

- **[OBS] Push to `main` re-triggers `ci.yml` (push) and `docs.yml` (push).** The bump commit landing
  on `main` will kick off CI and a docs redeploy. **[INF]** Expected and harmless (the bump commit is
  green by construction), but worth a one-line note in the how-to so the owner isn't surprised by two
  extra runs after a release. No feedback *loop* — the release workflow isn't `push`-triggered.
- **[OBS] Required status checks on `main` are `lint` + `test`.** **[INF]** A *direct push* of the bump
  is not gated by required status checks (those gate PR merges, not pushes). So the only protection
  obstacle is the required-PR rule (§1), not the checks.
- **[INF] No source/runtime code is touched.** This is CI/CD + docs. The adapter contracts
  (`TriggerAdapter` / `CommunicationAdapter` / `AgentAdapter` / `GitHostingAdapter`) the task names as
  the "primary public API" are referenced only to *explain the MAJOR-bump rule in docs* — the pipeline
  does not read or change them. The versioning policy table is human-facing doc content.
- **[OBS] `knip`/`madge` run inside `pnpm lint`.** **[INF]** Since no TS source changes, they are
  unaffected by this task; they only matter as gate steps that must stay green.
- **[INF] Secrets hygiene:** if Planning chooses a PAT/app token, it must live in Actions secrets and
  never be echoed. `actions/checkout`'s `persist-credentials` and `gh`'s token handling keep it out of
  logs by default; the workflow must avoid printing it.

---

## 6. Conventions to honor (so the new files don't read as foreign)

- **[OBS] Workflow style:** copy `docs.yml`'s shape — explicit `permissions:` block, `concurrency:`
  group (a release should not run concurrently with itself), pinned action majors (`@v4`/`@v5`),
  `pnpm/action-setup@v4` + `actions/setup-node@v4` with `node-version: 22` + `cache: pnpm`,
  `pnpm install --frozen-lockfile`. Match this exactly rather than inventing a new setup block.
- **[OBS] Prose commits:** the bump commit and any doc commits follow CONTRIBUTING (imperative,
  capitalized, ≤72 chars, no `feat:`/`fix:`), and the task's "no em-dashes" rule for the bump message.
- **[OBS] Docs style:** how-tos are task-oriented runbooks indexed in `contribution-docs/README.md` and
  the VitePress sidebar; mirror that structure and register the new page in both.

---

## 7. Challenge — the simplest thing that works, and what to question

- **Simplest viable shape [INF]:** a *single* workflow file, `.github/workflows/release.yml`, ~one
  job, using the **gh CLI** (preinstalled) for both notes and the Release —
  `gh release create vX.Y.Z --generate-notes --title vX.Y.Z` — plus `npm version --no-git-tag-version`
  for the bump and plain `git` for commit/tag/push. No new dependencies, no bespoke version-math
  script (let `npm version` do SemVer), no extra action beyond the setup trio already proven in
  `ci.yml`/`docs.yml`. This satisfies the "dependency-light, prefer widely-used actions over bespoke
  scripting" constraint. `softprops/action-gh-release` is a reasonable alternative for the publish
  step but adds a third-party action where `gh` already suffices.
- **Is a separate "dry-run" path worth building? [INF]** Acceptance criterion 10 is satisfied by
  *either* a dry-run path *or* letting the first real run produce `v1.0.2`. The cheapest honest option
  is a `dry_run` boolean input that runs the gate + version compute + notes preview and **skips**
  commit/tag/publish — small, and it lets the owner validate the protected-push auth wiring without
  burning a public Release. Planning's call; flagged because it materially de-risks the very first run
  (the auth question in §1 is exactly what a dry run can't fully prove, though — a dry run that skips
  the push won't reveal whether the push is allowed).
- **Patterns I checked and would NOT copy:** none of `ci.yml`/`docs.yml` is legacy-bad; they're clean
  and worth mirroring. The one anti-pattern to avoid is a *PR-based bump* (§1) — it reads as "safer"
  but is actively broken by `require_last_push_approval` + bot-can't-approve.
- **Assumptions I did NOT fully verify (left for Planning to nail):**
  - Whether the default `GITHUB_TOKEN` is *truly* rejected by the required-PR rule, or whether GitHub
    silently allows the `github-actions[bot]` in some edge case. The settings (§1) strongly imply
    rejection; the only fully conclusive test is an actual run. This is the #1 thing a dry run can't
    settle and the strongest argument for choosing the PAT/app/bypass mechanism *before* the first
    real run, not after a failed one.
  - Exact `npm version` vs `pnpm version` behavior under this pnpm setup (both write `package.json`;
    `pnpm version` may attempt a git commit/tag unless flagged). Trivial to pin in Planning.
  - Whether to include the `docs:bundle` sync step in the gate (§4.3).
- **Existing mechanism that already solves part of this [OBS]:** GitHub's native release-notes
  generation removes any need to parse prose commits ourselves — the hardest-sounding requirement
  (#6) is a one-flag feature, not custom code.

---

## 8. Why status = ok (not needs_human)

The one genuinely human decision the spec preserves — *is this release a fix / feature / break?* — is
the bump dropdown, by design, not a research question. Every other open item (token mechanism, notes
tool, dry-run, gate nuance, "unexpected state" definition) was **explicitly delegated to Planning** by
the owner and is answerable from the verified facts above. The branch-protection/token issue (§1) is
the only item needing an owner *action* (provision one credential or toggle one setting), but its
*decision space is technical and bounded*, and the owner pre-authorized Planning to choose the
mechanism. So I surface it as the headline risk rather than blocking. If, during Planning, the owner
must be told "you need to create secret X / change setting Y," that surfaces there as a setup step —
not a requirements ambiguity. → **ok / proceed.**

## 9. Files the implementation will create or touch (the contract for execution/review)

**Create:**
- `.github/workflows/release.yml` — the pipeline (the core deliverable).
- `docs/contribution-docs/how-tos/release.md` (or similar name) — "Cutting a Release" runbook +
  patch/minor/major selection rules.
- Optional: `.github/release.yml` — auto-notes category config (only if Planning wants tuned notes).

**Edit:**
- `docs/.vitepress/config.ts` — add the new how-to to the "Contributing" sidebar group (~lines 96–104).
- `docs/contribution-docs/README.md` — add the new how-to to the How-Tos index.
- `README.md` §"Versioning" — add a pointer to the how-to; keep the npm-deferred / reset narrative
  intact (additive only).
- Optional: `CONTRIBUTING.md` — a short "Cutting a Release" pointer.

**Will be auto-modified by a successful run (not authored by us):**
- `package.json` `version` (bumped + committed to `main` by the workflow).

**Read-only context (do NOT change):** `.github/workflows/ci.yml`, `.github/workflows/docs.yml`,
`lefthook.yml`, `docs/cli.md` §"Upgrading", `docs/constraints.md`, `package.json` scripts.

**Owner action outside the repo (Planning to specify, owner to execute):** provision the push
credential/setting for the protected-`main` push (§1) — one of: a `RELEASE_PAT` Actions secret, a
branch-protection bypass allowance for `github-actions[bot]`, or a GitHub App token.
