# Plan — Maintainer-triggered SemVer release pipeline (issue #31)

_Run 1 · 2026-06-15 · status: ok (proceed)_

Builds on `requirements/requirements.md` and `research/research.md`. I re-verified the load-bearing
facts against the live repo before planning (branch protection, default token scope, version state,
tag/release state, doc surfaces) — see "Verification done during planning" at the end. Their central
conclusions hold.

---

## 1. What this plan commits to (one paragraph)

One net-new GitHub Actions workflow, `.github/workflows/release.yml`, triggered only by
`workflow_dispatch`, with a `patch`/`minor`/`major` choice input (default `patch`) and an optional
`dry_run` boolean. It runs the project's existing CI gate first (lint incl. bundled-docs sync, unit
tests, build); only if green does it compute the new SemVer from `package.json`, commit the bump to
`main`, push an annotated `vX.Y.Z` tag (commit + tag pushed atomically), and publish a GitHub Release
with GitHub-native auto-generated notes (prose-safe, no Conventional Commits). Plus documentation: a
new "Cutting a Release" how-to and pointers from the README/contrib index/sidebar. **The pipeline
requires exactly one owner action it cannot self-provision: a `RELEASE_PAT` Actions secret** to push
the bump commit past `main`'s required-PR protection (see §5). No source/runtime code is touched.

---

## 2. Approaches evaluated

### Approach A — Simplest: single workflow, `gh` CLI + `npm version` + plain git (CHOSEN)

One file (`release.yml`), one job. Bump with `npm version <level> --no-git-tag-version` (no git side
effects, never touches `pnpm-lock.yaml`). Tag with `git tag -a`. Publish with the preinstalled `gh`
CLI: `gh release create --generate-notes` (GitHub's native notes group by PR/author/label, not commit
prefix — exactly the prose-safe requirement #6, as a one-flag feature). Reuse the proven setup trio
from `ci.yml`/`docs.yml` (`pnpm/action-setup@v4` + `actions/setup-node@v4` node 22 + `cache: pnpm`).
**Zero new dependencies, zero bespoke version math, zero third-party actions.**

### Approach B — Alternative: dedicated marketplace actions

Use a bump action + `softprops/action-gh-release` (or `release-drafter`) for publishing.

| | A (gh CLI + npm version) | B (marketplace actions) |
|---|---|---|
| New deps | none (`gh`, `git`, `npm` all preinstalled) | 1–2 third-party actions to pin/trust/maintain |
| Notes | `--generate-notes` (native, prose-safe) | action-specific config; release-drafter wants labels/templates |
| Supply chain | minimal | each action is a new trust + update surface |
| Fits repo constraint | "dependency-light, prefer widely-used actions over bespoke scripting" | adds actions where none are needed |
| Bespoke scripting | almost none | similar |

**Decision: A.** B buys nothing concrete here. The hardest-sounding requirement (prose-safe notes) is
already a built-in flag; pulling in a notes action would *add* config (labels/templates) to reproduce
what `--generate-notes` does for free. `gh` is preinstalled on `ubuntu-latest`. The spec's own
"keep it simple and dependency-light, prefer widely-used actions over bespoke scripting" points at A:
we use first-party actions only for setup (already the repo's pattern) and the preinstalled `gh`/`git`
for the release itself — no bespoke version arithmetic (let `npm version` do SemVer), no third-party
release action. Complexity did not earn its place.

**Rejected outright (per the issue's own "considered and rejected"):** `semantic-release`,
`release-please` (require Conventional Commits — violates the prose-commit constraint), `changesets`
(per-PR changeset files; built for npm + multi-contributor). Not revisited.

---

## 3. Stress-test of the chosen plan

- **Plugin Opacity — PASS.** This is CI/CD + docs only. It does not import, read, or change Core, any
  adapter contract, or any plugin. The adapter contracts (`TriggerAdapter` / `CommunicationAdapter` /
  `AgentAdapter` / `GitHostingAdapter`) appear only as *human-facing prose* in the how-to (the
  MAJOR-bump examples). Core compiles with every plugin deleted exactly as before — nothing in this
  change sits on that boundary.
- **Isolation — PASS.** No shared mutable state added to the codebase. The workflow runs on a fresh
  ephemeral runner per dispatch; its only persistent effects are the intended ones (a version commit,
  a tag, a release). The `concurrency: group: release` guard (see §6) prevents two release runs from
  racing. This is repo-level release infra, entirely outside the orchestrator's per-task runtime — no
  task-boundary bleed.
- **Boundaries — PASS.** Works through public contracts only: GitHub Actions, the `gh` CLI, `git`,
  `npm version`, the project's own `pnpm` scripts. It reaches into no module internals.
- **Reversibility — named.** Hard-to-undo or owner-visible decisions:
  1. **The `RELEASE_PAT` secret requirement** (§5) — an owner action, but fully revocable (delete the
     secret / rotate the PAT). Locked-in only as "the first run needs it."
  2. **A published GitHub Release is publicly visible** the moment it's created. A release and its tag
     are deletable, but a release may notify watchers. Mitigation: the `dry_run` path lets the owner
     validate version compute + notes preview *without* publishing (acceptance criterion 10, branch 1).
  3. **The bump commit on `main`** is a normal commit — revertable. Not a real irreversibility.
  No new interfaces, no schema changes, no DB migrations. Reversibility risk is low and contained.

All four checks pass; no redesign needed.

---

## 4. Pre-mortem — assume a subtle flaw shipped

**Failure mode 1 — the protected-`main` push is rejected (most likely).**
The default `GITHUB_TOKEN` is read-only here and, even with `contents: write`, acts as
`github-actions[bot]`, which is not an admin and not in any bypass list, so a direct push to `main` is
blocked by the "require a pull request" rule (`enforce_admins: false` exempts the human admin, not the
bot). *Mitigation (designed-in):* check out with `token: ${{ secrets.RELEASE_PAT }}` so pushes
authenticate as the owner (admin → bypasses protection). *Fail-safe ordering:* the gate runs first and
the protected push happens **before** any tag/release, so if auth is wrong the run aborts with `main`
unchanged, **no tag, no release**. A dry-run cannot prove this push (it skips it); the first real run
is the auth proof. This is the single most important thing for execution to get right and for the
owner to provision (§5).

**Failure mode 2 — partial completion / crash recovery (bump lands, tag or release fails).**
If the bump commit pushes but a later step dies (transient network, rate limit), `main` advances to
the new version with no matching tag; a naive re-run would compute the *next* version (e.g. 1.0.2 →
1.0.3), orphaning 1.0.2 forever. *Mitigations:*
  - **Atomic commit+tag push:** `git push --atomic origin HEAD:main "refs/tags/$TAG"` — both refs land
    together or neither does, collapsing the commit→tag window to zero.
  - That leaves only `gh release create` after the atomic push. If *that* fails, the tag+commit exist
    but no release. A re-run hits the **idempotency guard** (tag exists → abort with a clear message)
    rather than double-bumping. Recovery is a one-liner the how-to documents:
    `gh release create <tag> --verify-tag --generate-notes` (finish), **or** delete the tag and
    re-run. *Accepted residual:* a failure strictly between the atomic push and the release-create
    needs one manual recovery step — acceptable for a single-maintainer, infrequent release, and the
    window is one command wide.

**Failure mode 3 — double-trigger / concurrent runs.**
Two dispatches at once could both compute 1.0.2 and race the push. *Mitigation:* a `concurrency:`
group (mirrors `docs.yml`) with `cancel-in-progress: false` serializes release runs. The idempotency
guard is the backstop if a stale tag already exists.

**Failure mode 4 — wrong-ref dispatch.**
`workflow_dispatch` can be launched against any ref via the UI ref picker or API. *Mitigation:* an
early guard fails the run if `github.ref != refs/heads/main`, so a release is only ever cut from `main`
(requirement #9 "fail clearly if `main` is in an unexpected state").

**Non-issues (checked):** unbounded growth — none (tags/releases grow naturally, no accumulating
state). CI feedback *loop* — none: the PAT push re-triggers `ci.yml`/`docs.yml` (PAT = user token, so
it does trigger workflows), but that is two expected, harmless green runs, not a loop (release.yml is
`workflow_dispatch`-only). Documented in the how-to so the owner isn't surprised.

---

## 5. The one owner action this pipeline needs (provision before first run)

**Decision (recorded, category `security`): use an owner-scoped `RELEASE_PAT` Actions secret** for the
checkout/push identity. This is a discretionary mechanism choice the owner pre-delegated to Planning
("the specific tool choices are the pipeline's call"); I make the call here and record it so the
owner's autonomy policy can confirm if it wishes. **It is not a planning blocker** — execution writes
the entire workflow + docs now; the secret is a setup step the owner performs before the first run.

**Why a PAT over the alternatives:**

| Option | Cost | Verdict |
|---|---|---|
| **Owner PAT secret (`RELEASE_PAT`)** — fine-grained, this repo, *Contents: Read & write*; `checkout` uses it. Acts as owner (admin) → bypasses `main` protection because `enforce_admins:false`. | One managed secret; fine-grained PATs expire (≤1yr) → rotate. Narrow scope; does **not** loosen protection for other bot workflows. | **CHOSEN** — simplest, most widely used, narrowest blast radius, no branch-setting change. |
| Bypass allowance for `github-actions[bot]` in `main` protection | No secret, uses ephemeral `GITHUB_TOKEN`; but **loosens** protection so *any* `contents:write` workflow can push to `main` as the bot; an out-of-repo setting change. | Rejected for now — broader, less obvious blast radius. |
| GitHub App installation token | No human PAT to rotate; robust for orgs. | Overkill for a single-maintainer repo; more setup (app + id/key secrets). |

**Exact owner steps (put these in the how-to and surface at handoff):**
1. Create a **fine-grained PAT**: GitHub → Settings → Developer settings → Fine-grained tokens →
   *Resource owner* = `FarzamMohammadi`, *Repository access* = only `the-engineer`, *Permissions* →
   *Repository* → **Contents: Read and write**. (No "Administration" scope needed — admin bypass comes
   from the user identity, not a token scope.)
2. Repo → Settings → Secrets and variables → Actions → New repository secret named **`RELEASE_PAT`**,
   value = the token.
3. (Rotation reminder in the doc: regenerate before expiry.)

Tag push and release creation themselves work with `GITHUB_TOKEN` + `permissions: contents: write`
(no tag protection); only the *commit on protected `main`* needs the PAT. For one consistent identity
and the fewest moving parts, the workflow uses `RELEASE_PAT` for both the git pushes and `gh release
create`, and still declares least-privilege `permissions: contents: write` as defense/intent.

---

## 6. Implementation plan (ordered, checkboxed, with per-part verification)

### Part 1 — The release workflow

- [ ] **Create `.github/workflows/release.yml`** with this exact shape and ordering:
  - `name: Release`
  - `on: workflow_dispatch` with inputs:
    - `level`: `type: choice`, `options: [patch, minor, major]`, `default: patch`, `required: true`,
      `description: "SemVer bump level"`.
    - `dry_run`: `type: boolean`, `default: false`,
      `description: "Gate + version/notes preview only; no commit, tag, or release"`.
  - `permissions: { contents: write }` (least privilege; explicit intent).
  - `concurrency: { group: release, cancel-in-progress: false }` (serialize releases — failure mode 3).
  - Single job `release` on `ubuntu-latest`, steps in this order:
    1. **Guard — ref is `main`:** `if: github.ref != 'refs/heads/main'` → `echo "::error::..."; exit 1`
       (failure mode 4).
    2. `actions/checkout@v4` with `ref: main`, `fetch-depth: 0` (full history + tags for notes and
       prev-tag detection), `token: ${{ secrets.RELEASE_PAT }}` (owner identity — failure mode 1).
    3. `pnpm/action-setup@v4` → `actions/setup-node@v4` (`node-version: 22`, `cache: pnpm`) →
       `pnpm install --frozen-lockfile`. (Copy `ci.yml`/`docs.yml` exactly.)
    4. **Gate (before any mutation):** `pnpm lint`; then the **bundled-docs sync check**
       (`pnpm run docs:bundle` + `git diff --exit-code src/cli/bundled/plugin-docs.ts` with the same
       error message as `ci.yml`); then `pnpm test`; then `pnpm build`. This mirrors `ci.yml`'s three
       jobs exactly (the settled gate scope: lint + unit test + build — **not** `test:all`).
    5. **Compute version** (id `ver`): capture `PREV_TAG="$(git describe --tags --abbrev=0)"` **before**
       bumping; `npm version "${{ inputs.level }}" --no-git-tag-version`;
       `NEW_VERSION="$(node -p "require('./package.json').version")"`; `TAG="v$NEW_VERSION"`; export
       `prev_tag`, `new_version`, `tag` to `$GITHUB_OUTPUT`.
    6. **Idempotency guard:** abort if the tag exists locally (`git rev-parse -q --verify
       refs/tags/$TAG`), upstream (`git ls-remote --exit-code --tags origin refs/tags/$TAG`), or as a
       release (`gh release view $TAG`). Each with a clear `::error::` message (requirement #9).
    7. **Dry-run exit:** `if: ${{ inputs.dry_run }}` — print the computed `prev_tag → tag` and a notes
       **preview** via `gh api repos/${{ github.repository }}/releases/generate-notes -f
       tag_name=$TAG -f previous_tag_name=$PREV_TAG -f target_commitish=main --jq .body`; the job ends
       here (no commit/tag/release). Satisfies acceptance criterion 10 branch 1.
    8. **Commit + tag + atomic push:** `if: ${{ !inputs.dry_run }}` —
       `git config user.name "github-actions[bot]"` and
       `user.email "41898282+github-actions[bot]@users.noreply.github.com"` (keeps personal email out
       of YAML; pusher is still the PAT owner). Commit **only** `package.json`:
       `git commit -m "Bump version to $NEW_VERSION" package.json` (deliberate — not `-am`, so the
       commit contains exactly the version change). `git tag -a "$TAG" -m "$TAG"` (annotated, matching
       the repo convention). `git push --atomic origin HEAD:main "refs/tags/$TAG"` (failure mode 2).
    9. **Publish release:** `if: ${{ !inputs.dry_run }}` — `env: GH_TOKEN: ${{ secrets.RELEASE_PAT }}`;
       `gh release create "$TAG" --title "$TAG" --verify-tag --notes-start-tag "$PREV_TAG"
       --generate-notes`. `--verify-tag` makes `gh` use the tag we already pushed (don't auto-create a
       lightweight one); `--notes-start-tag "$PREV_TAG"` makes the notes range deterministic
       (since `v1.0.1`).
  - Use `set -euo pipefail` at the top of every multi-line `run:` block so any failed sub-command
    aborts the step (and thus the run).
  - **Decision note for the file:** build runs on the pre-bump tree; the bump is a version-only edit
    to `package.json` that cannot affect `tsdown`/Vite output, so the tagged state builds cleanly by
    construction — no need to re-run build after the bump (requirement #8 satisfied without the extra
    cost).
- [ ] **Verify Part 1:**
  - YAML parses: `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/release.yml'))"`.
  - Manual trace against requirements #1–#9 and acceptance criteria 1–8, 10 (table in §7 below).
  - Confirm no step echoes `secrets.RELEASE_PAT`; checkout `persist-credentials` default + `gh`'s
    token handling keep it out of logs (secrets hygiene).

### Part 2 — "Cutting a Release" how-to

- [ ] **Create `docs/contribution-docs/how-tos/release.md`** (mirror the task-oriented runbook style of
  `observability.md`: `# Cutting a Release`, a one-line intro, `---`, then sections). Contents:
  - **Prerequisite (owner, one-time):** create the `RELEASE_PAT` secret — the exact steps from §5.
  - **How to cut a release:** Actions tab → *Release* → *Run workflow* → choose `level` (and optionally
    `dry_run`) → *Run*. One deliberate action; everything after is automatic.
  - **Choosing the bump level:** reproduce the spec's PATCH / MINOR / MAJOR table verbatim (incl. the
    "adapter contracts are the primary public API → contract break = MAJOR" guidance). PATCH is the
    default lane.
  - **What the pipeline does:** gate → compute → idempotency guard → commit bump to `main` → annotated
    tag → GitHub Release with auto notes. Note prose-safe notes (no Conventional Commits).
  - **Expected side effects:** the bump push re-triggers CI and the docs deploy (two extra green runs).
  - **Dry run:** what it validates (gate + version + notes preview) and what it can't (the protected
    push / auth — proven only by the first real run).
  - **Recovery:** gate fail → nothing happened; push fail → nothing tagged, fix auth and re-run;
    release-step fail after the tag is pushed → run `gh release create <tag> --verify-tag
    --generate-notes` to finish, or delete the tag and re-run.
  - **Consistency:** restate that releases ship as GitHub releases, npm is deferred, and breaking
    schema/config changes don't migrate (reset is the upgrade path) — matching the README.
- [ ] **Verify Part 2:** file renders under `pnpm docs:build`; bump table matches the issue; recovery
  steps match the workflow's actual behavior.

### Part 3 — Wire the doc into nav + index + README

- [ ] **Edit `docs/.vitepress/config.ts`** (Contributing sidebar, after line 102 "Zod Schemas"): add
  `{ text: "Cutting a Release", link: "/contribution-docs/how-tos/release" }`.
- [ ] **Edit `docs/contribution-docs/README.md`** How-Tos list: add a
  `- **[Cutting a Release](how-tos/release.md)** — ...` bullet in the same voice as the others.
- [ ] **Edit `README.md` §"Versioning"** (line 234): append an **additive** pointer sentence linking to
  the how-to (e.g. "Maintainers cut releases with the
  [release workflow](docs/contribution-docs/how-tos/release.md)."). Do **not** alter the existing
  npm-deferred / reset-is-the-upgrade-path / GitHub-releases narrative — it is already consistent.
- [ ] **Edit `CONTRIBUTING.md`** (optional but recommended): add a short `## Cutting a Release` pointer
  (one or two lines) linking to the how-to, placed near "Pull Request Process", for discoverability.
  Additive only.
- [ ] **Leave untouched:** `docs/cli.md#upgrading` (link target — narrative stays intact); the README
  version badge (auto-reads `package.json`, no manual edit on release); `ci.yml`/`docs.yml`;
  `lefthook.yml`; `package.json` version (the *workflow* bumps it at run time, not this change set).
- [ ] **Verify Part 3:** `pnpm docs:build` succeeds with the new sidebar entry and no dead links;
  the new page appears in the Contributing group.

### Part 4 — Whole-change gates

- [ ] Run the project's gates on the change set (workflow + docs + the one `.ts` config edit):
  - `pnpm lint` (biome checks `docs/.vitepress/config.ts`; knip/madge on `src/` unaffected).
  - `pnpm typecheck`.
  - `pnpm test`.
  - `pnpm build`.
  - `pnpm docs:build`.
  All must exit zero. (No source/runtime code changes, so these should pass cleanly; a non-zero exit is
  a real failure to fix, not a pre-existing wave-off.)
- [ ] **End-to-end validation (owner-gated, post-merge):** because the pipeline writes to the live repo
  and needs `RELEASE_PAT`, the true E2E proof is the owner provisioning the secret and either (a)
  running with `dry_run: true` to confirm gate + computed `v1.0.2` + notes preview, then (b) running
  `level: patch` to cut **`v1.0.2`** from the three commits now on `main`. This satisfies acceptance
  criterion 10 (either branch). Flag this as the handoff step; it cannot be done from code alone.

---

## 7. Requirement → mechanism trace (the contract for review)

| Req | Mechanism in this plan |
|---|---|
| #1 manual trigger | `on: workflow_dispatch` only; no `push`/`schedule` |
| #2 bump selection | `inputs.level` choice patch/minor/major, default patch |
| #3 gate first | lint (+ bundled-docs sync) + test + build before any mutation; abort = no tag/release |
| #4 bump + commit to main | `npm version --no-git-tag-version`; `git commit -m "Bump version to X.Y.Z" package.json`; atomic push as owner PAT |
| #5 annotated tag | `git tag -a vX.Y.Z -m vX.Y.Z`; pushed atomically with the commit |
| #6 prose-safe notes | `gh release create --generate-notes` (groups by PR/author/label, not commit prefix) |
| #7 publish release | `gh release create` with the generated notes |
| #8 verified build | `pnpm build` in the gate; version-only bump can't change build output |
| #9 safety/idempotency | ref-is-main guard; tag/release existence guard; `concurrency` group; single-maintainer = only owner can dispatch |
| #10 document | new how-to + README/index/sidebar pointers; bump table; consistency restated |
| AC10 validate w/o throwaway | `dry_run` input (preview), and/or first real run cuts `v1.0.2` |

---

## 8. Decisions recorded (what was chosen, what it locks in)

1. **`RELEASE_PAT` (owner PAT) for the protected-`main` push** — over bot-bypass or a GitHub App.
   Locks in: one managed secret the owner must create/rotate; narrowest blast radius; no branch-setting
   change. (Category: `security`; the one owner action — surfaced in §5.)
2. **Approach A (gh CLI + `npm version` + git), single workflow file** — over marketplace actions.
   Locks in: no new dependencies; native prose-safe notes; `gh`-based publish.
3. **Gate scope = lint (incl. bundled-docs sync) + unit test + build, mirroring `ci.yml`** — not
   `test:all`. Inherited from requirements' settled reading; I additionally include the bundled-docs
   sync step for exact fidelity with CI's `lint` job (cheap, already proven). Locks in: integration/e2e
   are out of the release gate unless the owner later asks.
4. **Include a `dry_run` input** — cheap, satisfies AC10 branch 1, previews version + notes without a
   public release. Locks in: a small `if:` branch in the workflow. (Honest caveat documented: dry-run
   can't prove the protected push.)
5. **Atomic commit+tag push (`git push --atomic`), and commit only `package.json`** — for crash-safety
   and a clean, minimal bump commit. Locks in: commit+tag are all-or-nothing; only the final
   release-create is a separate (recoverable) step.
6. **Bump commit authored as `github-actions[bot]`, pushed as the PAT owner** — keeps personal email
   out of the YAML while the owner identity provides the protection bypass.
7. **Notes baseline pinned with `--notes-start-tag $PREV_TAG` (`git describe --tags --abbrev=0`)** —
   deterministic notes range (since `v1.0.1`) given no prior GitHub Release exists.

---

## 9. Status & open items

**Status: ok (proceed).** No planning blocker. The single human decision the spec preserves (is this
release a fix/feature/break?) is the bump dropdown, by design. Every other open item from
requirements/research is resolved above: token mechanism (PAT, §5), notes tool (`--generate-notes`),
dry-run (included), gate nuance (bundled-docs check included), "unexpected state" (ref-is-main + tag
existence guards).

**One thing the owner must do before the first run (not a blocker to writing the code):** provision the
`RELEASE_PAT` secret per §5. Execution writes the full workflow + docs regardless; this is a documented
handoff step, surfaced in `details.decisions` so the owner's autonomy policy can confirm the credential
strategy if it chooses.

---

## Verification done during planning (so execution can trust the basis)

- `main` branch protection (live `gh api`): `required_pull_request_reviews` = 1 approval,
  `require_last_push_approval: true`, `dismiss_stale_reviews: true`; `enforce_admins: false`;
  `required_status_checks` contexts `[lint, test]`, `strict:false`; `allow_force_pushes:false`. → the
  bump push needs an admin-identity PAT.
- `actions/permissions/workflow` → `default_workflow_permissions: "read"` → the workflow must declare
  `contents: write`.
- Tag protection → 404 (none); rulesets → `[]`; `gh release list` → empty (no releases yet).
- `package.json` version = `1.0.1`; `main` is 3 commits ahead of `v1.0.1`
  (`4e9405a`, `66ff148`, `1a658a0`); both `v1.0.0` and `v1.0.1` exist → next patch = **`v1.0.2`**.
- `ci.yml` jobs = lint (+ `docs:bundle` sync check) / test (`pnpm test` unit) / build; `docs.yml`
  pattern = explicit `permissions:` + `concurrency:` + `workflow_dispatch` (the shape to copy).
- Doc surfaces confirmed: `README.md` §Versioning (line 234), `docs/.vitepress/config.ts` Contributing
  sidebar (lines 95–106), `docs/contribution-docs/README.md` How-Tos list, `CONTRIBUTING.md` section
  layout, `docs/cli.md#upgrading` anchor (line 277).
- Tooling: `npm version --no-git-tag-version` flag present; `git push --atomic` supported; `gh` is
  preinstalled on `ubuntu-latest`.

---
---

# Run 2 — incorporating the owner's authoritative answer

_Run 2 · 2026-06-16 · status: ok (proceed)_

The owner answered the question Run 1 raised. **Their answer is authoritative and defines scope.**
This run does not restart: Run 1's analysis, approach choice, workflow shape, ordering, pre-mortem,
and requirement trace all **stand unchanged** except where the owner narrowed scope below. I
re-verified the load-bearing live facts this run — `package.json` = `1.0.1`; `main` protection
(`required_approving_review_count: 1`, `require_last_push_approval: true`, `enforce_admins: false`,
required checks `[lint, test]`); default `GITHUB_TOKEN` = `read`; no Releases yet; CI lint job
includes the bundled-docs sync check — all match Run 1. The basis holds.

## A. What the owner settled (now authoritative — no longer open)

1. **`RELEASE_PAT` — approved exactly as Run 1 proposed, with tighter scope pinned by the owner:**
   - **fine-grained** PAT, **this repository only**, **Contents: Read & write — nothing more**,
     **90-day expiry**, stored as the `RELEASE_PAT` Actions secret. The owner creates it before the
     first run. The rejected alternatives (bot-bypass allowance, GitHub App) stay rejected — the owner
     confirmed they were "correctly rejected."
   - **Change from Run 1:** the PAT is no longer a *discretionary decision to surface* (Run 1 logged it
     under `security`); it is now an owner-confirmed requirement. Pin the expiry at **90 days** (Run 1
     §5 said "≤1yr / rotate" — supersede with the owner's 90-day figure) and update the how-to's setup
     steps and rotation reminder to say 90 days.
2. **`dry_run` — approved as specified:** default `false`; when `true`, the run **ends after computing
   the version and previewing notes** (no commit, tag, or release). This matches Run 1's design exactly.
   Now settled — not a decision to surface.
3. **Documentation — narrowed to "keep it minimal: exactly one short doc."** The owner specified the
   guide's contents tightly (key details only, no padding):
   - how to cut a release (Actions → Release → pick patch/minor/major);
   - the patch / minor / major rules — **one line each**;
   - the one-time `RELEASE_PAT` setup (scopes + 90-day expiry);
   - the `dry_run` option.
   - **No other new docs. README gets at most a one-line pointer "if one's actually needed."**

## B. What changes from Run 1 (documentation scope only)

The workflow plan (Run 1 §6 Part 1, the YAML shape, ordering, guards, atomic push, gate scope) is
**unchanged**. Only the documentation parts (Run 1 §6 Parts 2–3) are tightened to the owner's "exactly
one doc" instruction:

- [ ] **DROP the `CONTRIBUTING.md` "Cutting a Release" section** that Run 1 Part 3 listed as "optional
  but recommended." The owner's "keep it minimal / no other new docs" overrides it. Do not touch
  `CONTRIBUTING.md`.
- [ ] **The single doc is `docs/contribution-docs/how-tos/release.md`** (name unchanged from Run 1).
  Tighten its contents to **exactly the owner's four items**, in this order, terse:
  1. **How to cut a release** — Actions tab → run **Release** → pick `level` (`patch`/`minor`/`major`),
     optionally tick `dry_run` → Run.
  2. **Bump rules, one line each** — PATCH = backward-compatible fix/polish; MINOR = new
     backward-compatible capability; MAJOR = breaking change (adapter-contract / config-schema breaks,
     removed/renamed CLI, anything needing re-setup). PATCH is the default lane.
  3. **One-time `RELEASE_PAT` setup** — fine-grained PAT, this repo only, Contents: Read & write,
     90-day expiry, saved as the `RELEASE_PAT` secret; renew it every 90 days (a release failing with an
     auth/permission error means the PAT lapsed).
  4. **`dry_run`** — previews the computed version + notes and stops, creating nothing; note it does
     **not** prove the protected push (only the first real run does).
  - **Trim** Run 1's extra subsections ("what the pipeline does," "expected side effects,"
    "consistency restated," separate "recovery") to honor "no padding." Keep at most one terse line: the
    bump commit lands on `main` and harmlessly re-triggers CI + docs deploy; if a run dies after the
    push, re-create only the Release for the existing tag (`gh release create <tag> --verify-tag
    --generate-notes`) rather than re-running.
- [ ] **Keep the doc registered** in the VitePress "Contributing" sidebar (`docs/.vitepress/config.ts`,
  one `{ text: "Cutting a Release", link: "/contribution-docs/how-tos/release" }` entry after "Zod
  Schemas") and in the `docs/contribution-docs/README.md` How-Tos list (one bullet). These are
  one-line edits to **existing** files, not new docs — they keep the single guide from being an
  orphaned page, consistent with how every other how-to is listed. (Decision D2.)
- [ ] **Keep one additive README pointer** in the "Versioning" section (line ~234), a single sentence
  linking to the guide; leave the npm-deferred / reset-is-the-upgrade-path / GitHub-releases narrative
  intact. The owner permitted "a one-line pointer if one's actually needed"; I judge it needed for
  discoverability from the most-read doc and for acceptance-criterion-9 consistency. (Decision D3.)
- [ ] **Verify (unchanged):** `pnpm docs:build` succeeds with no dead links; the new page + both
  registrations resolve; `git diff README.md` shows only an additive one-line pointer.

## C. What stands from Run 1 (re-affirmed, do not re-derive)

- **Approach A** (single `release.yml`; `gh` CLI + `npm version --no-git-tag-version` + plain git; zero
  new deps) over marketplace actions — unchanged.
- **The full workflow shape, step ordering, and guards** in Run 1 §6 Part 1 — unchanged: ref-is-`main`
  guard → PAT-authenticated checkout (`fetch-depth: 0`) → setup trio → gate (lint + bundled-docs sync +
  test + build) → compute version → idempotency guard (tag local/remote/release) → dry-run preview-and-
  stop → commit-only-`package.json` + annotated tag + `git push --atomic` → `gh release create
  --generate-notes --verify-tag` → summary. `permissions: contents: write`; `concurrency: group:
  release, cancel-in-progress: false`.
- **The pre-mortem and mitigations** (Run 1 §4) — unchanged and still apply: protected-push rejection
  (PAT + fail-safe ordering + early guard), partial completion (atomic push + idempotency guard +
  documented one-command recovery), concurrent runs (concurrency group), wrong-ref dispatch (ref
  guard). The 90-day expiry sharpens failure-mode 1's rotation note.
- **Gate scope** = lint (incl. bundled-docs sync) + unit `pnpm test` + `pnpm build`, mirroring `ci.yml`
  — **not** `test:all`. (Decision D1, carried from Run 1.)
- **The requirement → mechanism trace** (Run 1 §7) and **the next real version = `v1.0.2`** —
  unchanged.

## D. Decisions surfaced this run (for the owner's autonomy policy)

The PAT (scope + 90-day expiry) and `dry_run` are now **owner-settled** and are deliberately **not**
re-surfaced as decisions. The three genuinely-open discretionary calls this run makes:

- **D1 (test_coverage):** the release gate mirrors CI's `lint` job **including the bundled-docs sync
  check**, not just bare `pnpm lint`. Faithful CI parity at negligible cost; research left this open.
- **D2 (doc_wording):** the single guide is **registered** in the VitePress sidebar and the
  contribution-docs index (two one-line edits to existing files) so it isn't an orphaned page. Not new
  docs; discoverability only.
- **D3 (doc_wording):** **one additive README pointer** sentence in the Versioning section. The owner
  permitted this "if actually needed"; I judged it needed. Reversible; trivially removable if unwanted.

## E. Status

**ok (proceed).** The owner's answer settles every previously-open question (auth = `RELEASE_PAT` with
exact scope + 90-day expiry; `dry_run` default false; one minimal doc). No planning blocker remains.
Execution writes the workflow + the single guide + the two one-line registrations + the one-line README
pointer, and drops the Run-1 `CONTRIBUTING.md` edit. The owner's one prerequisite action — creating the
`RELEASE_PAT` secret — is documented in the guide and is a setup step, not a blocker to writing the code.
