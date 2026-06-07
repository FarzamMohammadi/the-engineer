# Research: Phase 9 Finale — v1.0.0 Release (Docs Site + Polish)

**Date**: 2026-06-06 | **Repo**: the-engineer | **Branch**: main | **Commit**: 99be4d6

Investigates the confirmed scope in
`.claude/temp/requirements-gathering/v1-release-finale.md`: a VitePress docs site on GitHub Pages,
v1.0.0 release polish, a static hero placeholder. Facts first; implications at the end.

## What I Found

### Docs content (the site's source material)
**Files**: `docs/**` (≈45 non-archived markdown files)

A well-organized, already-public doc set that maps cleanly onto a VitePress nav:
- **Standalone**: `philosophy.md`, `constraints.md`, `assumptions.md`, `cli.md`,
  `coding-standards.md`, `anti-patterns.md`, `the-engineer-persona.md`
- **architecture/**: overview, three-tier-model, pipeline, scheduling-dispatch, observability
- **configuration/**: README, daemon, orchestrator, safety, workspace, people
- **plugins/**: plugin-context + README/per-plugin pages under agent/, communication/,
  git-hosting/, trigger/
- **contribution-docs/**: README + how-tos (observability, zod-schemas, plugins/authoring,
  setup/operator-setup)
- **usage-guide/**: README, writing-tickets
- **user-flows/**: task-intake, pr-management, post-execution-review, communication overviews

`docs/archived/` holds the **build journal** (`implementation-docs/` + a README). Per requirements it
is **linked once, not nav'd** — and crucially `docs/archived/implementation-docs/` contains internal
planning (active.md, slices, sessions) that must be **excluded** from the public site.

### Version is single-sourced
**Files**: `package.json` (`"version": "0.8.0-preview"`), `src/dashboard/client/vite.config.ts`

The app version lives in exactly one place: `package.json`. The dashboard reads it at build time
(`vite.config.ts` → `define: __APP_VERSION__ = pkg.version`), so it never hardcodes a version. The
many `version: "1.0.0"` hits in `tests/**` are **mock plugin manifest versions**, unrelated to the
app version. ⇒ Bumping `package.json` to `1.0.0` propagates to the dashboard automatically; no other
code change needed for the version itself.

### Status / "preview" reconcile surface (the manual prose edits)
**Files**: `README.md`, `SECURITY.md`, `package.json`

Every place that asserts "preview" / pre-v1 posture:
- `package.json:3` — `0.8.0-preview` → `1.0.0`
- `README.md:5` — `status-preview-orange` shields badge
- `README.md:13` — "**Status: Preview — refinement toward `v1.0.0`.**"
- `README.md:14` — "Every preview tag is a working checkpoint… Interfaces… **will change** before
  `v1.0.0`… just don't depend on it for production yet."
- `SECURITY.md:3` — "The security surface is real, even at **preview** stage."
- `SECURITY.md:37` — "This project is in **preview**, maintained by a single developer in their spare
  time. There is no formal SLA."

Unrelated false positives to leave alone: `src/core/agent-activity/mapping.ts` ("inline-preview
ceiling" — a field-truncation concept) and `pnpm-lock.yaml` (`@typescript/native-preview` dep).
`CONTRIBUTING.md` has **no** preview/status claim. (A final bare `grep -rni preview` sweep at build
time keeps this airtight.)

### CI + the lint toolchain (the real integration surface)
**Files**: `.github/workflows/ci.yml`, `biome.json`, `knip.json`, `tsconfig.json`, `package.json`

- **CI** = 3 jobs (`lint`, `test`, `build`) on **Node 22** + pnpm, `--frozen-lockfile`. `.node-version`
  is `22`.
- The **lint** job also runs a **bundled-docs drift guard**: it regenerates `pnpm run docs:bundle`
  and `git diff --exit-code src/cli/bundled/plugin-docs.ts`. ⇒ Any edit to `docs/plugins/**/*.md`
  requires re-running `docs:bundle` and committing, or CI fails. (`CONTRIBUTING.md:108` documents
  this.)
- **`pnpm lint`** = `biome check . && tsc --noEmit && tsc --noEmit -p tsconfig.test.json && knip &&
  madge --circular --extensions ts src/`.
- **tsc** scope: `tsconfig.json` is `include:["src"]`, `exclude:["src/dashboard/client"]`,
  `rootDir:"src"`. ⇒ `docs/.vitepress/**` is **outside tsc** — not typechecked by the repo. ✅
- **madge** scope: `src/` only. ⇒ docs untouched. ✅
- **knip** scope: `project:["src/**/*.ts"]`, entries in `src/`. ⇒ knip does **not** traverse
  `docs/.vitepress/config.ts`, so it will not see `vitepress` imported, and with
  `rules.devDependencies:"error"` it will flag `vitepress` as an **unused devDependency**. ⚠️
- **biome** scope: `files.ignore` = `["dist","coverage","node_modules","~",".claude"]` — **docs/ is
  NOT ignored**, and `vcs.useIgnoreFile:true` (biome respects `.gitignore`). Linter is `all:true`
  with `style.noDefaultExport:"error"`. ⇒ biome **will lint** `docs/.vitepress/**/*.ts`, and a
  VitePress `export default defineConfig({…})` is a **default export → biome error**. ⚠️ (The repo
  already carries targeted overrides turning `noDefaultExport` off for `vitest.*.ts` and
  `src/dashboard/client/vite.config.ts` — the same pattern applies here.)

### VitePress + GitHub Pages deploy mechanics (verified, 2026)
**Source**: VitePress official deploy guide

- A **separate GitHub Actions workflow** (not the existing ci.yml): trigger on push to `main` (+
  `workflow_dispatch`); permissions `contents:read`, `pages:write`, `id-token:write`; build to
  `docs/.vitepress/dist`; `actions/upload-pages-artifact@v3` → `actions/deploy-pages@v4`; the
  `github-pages` environment. Adapt the official example from `npm` to **pnpm** + Node 22 to match
  ci.yml.
- **Base path**: a project page served at `farzammohammadi.github.io/the-engineer/` needs
  `base: '/the-engineer/'` in the VitePress config, or assets 404.
- **One-time manual step (owner-only)**: repo **Settings → Pages → Source: GitHub Actions**. Until
  set, the workflow can't deploy.
- No `gh-pages` branch and no `CNAME` exist today (consistent with the Actions-deploy method + no
  custom domain).

### future-considerations format + an already-related entry
**Files**: `docs/future-considerations.md`

Has a "How to Write an Entry" guide (durability over precision; Current state / Why deferred / When
it becomes relevant / What it enables / Key context / Migration path). It **already contains a
"Monorepo Evolution" entry** describing a future **publishable plugin-SDK package** ("when
third-party plugins need a separate, publishable SDK package they can `import`"). ⇒ The npm-deferral
entry should **complement and cross-reference** that one, not duplicate it.

### Visual assets: none exist
**Files**: (none found)

A repo-wide search for `*.png/jpg/jpeg/gif/svg/webp` returns **nothing** — no hero, no logo, no
favicon, no screenshots. The README's `<!-- TODO(visuals) -->` placeholders confirm none were ever
added.

## What It Means

### Patterns to follow
- **Targeted biome overrides** for tool configs: mirror the existing `src/dashboard/client/vite.config.ts`
  override to add a `docs/.vitepress/**` override turning off `noDefaultExport` (and any theme-file
  rules). This keeps the strict default for app code.
- **Single-source the version**: change only `package.json`; let the dashboard inherit it. Do not add
  a version literal anywhere else.
- **Durability-first future-considerations entry**: follow the file's own guide; cross-link
  `[[Monorepo Evolution]]`.
- **pnpm + Node 22 in the new workflow**, matching ci.yml exactly.

### Risks
- **CI green is the real engineering, not the site.** Two concrete tripwires green CI would hit the
  moment the site lands: (1) **knip** flags `vitepress` as an unused devDependency → add it (and any
  VitePress-only devDeps) to `knip.json` `ignoreDependencies`, or register a knip VitePress entry;
  (2) **biome** errors on the config's default export → add a `docs/.vitepress/**` override.
  Mitigation is cheap but must be planned, or `pnpm lint` fails.
- **Generated output must be ignored**: `.gitignore` needs `docs/.vitepress/dist` and
  `docs/.vitepress/cache`; because biome honors `.gitignore`, that also keeps biome off the generated
  files.
- **The hero is a hard dependency on the owner.** No asset exists, and the dashboard screenshot can't
  be captured headlessly (no browser automation in this environment — per the project's dashboard
  verification note). So the "strong static hero" is either an owner-captured screenshot or a
  designed/text hero we build in code. This gates the landing page's final look (placeholder is fine
  to ship; the real shot comes from the owner).
- **Markdown compatibility pass**: docs use GitHub alert syntax (`> [!IMPORTANT]`) and relative
  `.md` links. VitePress supports both in current versions but it needs a verification pass; some
  alerts may need conversion to VitePress containers, and `<!-- TODO -->` comments render as nothing
  (fine).
- **Plugin-doc edits trigger the drift guard.** If any two-for-one fix touches `docs/plugins/**`,
  re-run `pnpm run docs:bundle` and commit, or CI's lint job fails.

### Open questions (for planning + build, not blockers)
- Nav/sidebar grouping and the theme/look — resolved in planning and via live design probes during
  the build (owner's taste).
- Hero approach — owner-captured dashboard screenshot vs. a designed/coded hero — needs an owner
  decision before the landing page is final (placeholder unblocks everything else).
- Whether the README is mirrored as the site home or the site gets a purpose-built landing page
  (requirements lean: purpose-built landing page).
