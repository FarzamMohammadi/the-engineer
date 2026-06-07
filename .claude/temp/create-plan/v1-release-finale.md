# Plan: Phase 9 Finale — v1.0.0 Release (Docs Site + Polish)

**Date**: 2026-06-06 | **Stakes**: Standard (high-importance milestone, moderate technical risk)
**Upstream**: `.claude/temp/research/v1-release-finale.md` | `.claude/temp/requirements-gathering/v1-release-finale.md`
**Status**: Approved (decisions aligned with owner; stress-tested inline)

## Intent
Ship a polished, working **v1.0.0 as a GitHub release**: a VitePress docs site on GitHub Pages
presenting the existing `docs/` + a hero landing page, plus the version/posture reconcile. Everything
**except the `v1.0.0` tag and the demo video**, which are the deliberate final step.

## Decisions

### D1: GitHub release, not npm
**Choice**: Ship v1.0.0 as a tagged GitHub release; defer npm publish.
**Context**: CLI-only + in-tree plugin model ⇒ an npm package serves only the narrow exact-stack,
zero-customization audience; everyone else needs the source. Pre-v1 "don't depend on it yet" makes
inviting `npm i -g` contradictory. The repo is the product.
**Rejected**: Publishing a preview to npm (dead config: files allowlist / trusted publishing only pay
off if publishing); the importable SDK (no consumer today — additive later, non-breaking).
**Consequence**: No `files`/`exports`/publish-workflow work. `package.json` stays publish-capable
(reversible) but gains no publish machinery.

### D2: VitePress, `docs/` as root, internal planning excluded
**Choice**: VitePress with `docs/.vitepress/`; the existing `docs/` markdown is the content (no
rewrite); `docs/archived/implementation-docs/**` excluded via `srcExclude`; the build journal is a
single outbound link.
**Rejected**: A separate `site/` dir mirroring docs (duplication/drift); rewriting content (scope creep).
**Consequence**: One source of truth; the site presents what already exists.

### D3: CI-green wiring (the real engineering)
**Choice**: (a) a `docs/.vitepress/**` biome override turning off `noDefaultExport` — the sanctioned
deviation for config files, mirroring the existing `src/dashboard/client/vite.config.ts` override;
(b) add `vitepress` to `knip.json` `ignoreDependencies`; (c) `.gitignore` `docs/.vitepress/{dist,cache}`
(biome honors `.gitignore`, so it skips them too).
**Context**: research proved green CI would fail otherwise — biome `all:true` + `noDefaultExport:error`
on the config's default export, and knip flagging `vitepress` as an unused devDep (knip scope is
`src/**`). tsc + madge are scoped to `src/` — unaffected.
**Consequence**: `pnpm lint` stays green with the site in place.

### D4: Separate Pages deploy workflow
**Choice**: a new `.github/workflows/docs.yml` — pnpm + Node 22 (matching ci.yml), `base: '/the-engineer/'`,
build → `docs/.vitepress/dist` → `actions/upload-pages-artifact@v3` → `actions/deploy-pages@v4`,
`github-pages` environment, perms `contents:read` + `pages:write` + `id-token:write`.
**Context**: official VitePress deploy method; the project page needs the `base` or assets 404.
**Consequence**: The live deploy fires **only on the owner's push** (no-push rule). We validate the
build locally (`docs:build` + `docs:preview`); the owner's first push + a one-time
Settings→Pages→GitHub Actions click brings the site live.

### D5: Default theme + custom CSS; coded placeholder hero
**Choice**: VitePress default theme + custom CSS tokens (brand color, type); a **coded** landing-page
hero (name + tagline + CTAs + a tasteful CSS/SVG motif) with the demo GIF reserved to drop in later.
The *look* is tuned via live probes with the owner during the build.
**Rejected**: A bespoke theme (overkill, maintenance); a screenshot-first hero (no asset exists; can't
capture headless; the GIF replaces it anyway).
**Consequence**: Themed-not-generic with minimal surface; the landing page is unblocked without an
owner asset.

### D6: v1.0.0 posture reconcile
**Choice**: `package.json` → `1.0.0` (single source — the dashboard reads it via `__APP_VERSION__`,
nothing else hardcodes it); rewrite the README banner + badge and `SECURITY.md` (2 lines) to "v1.0.0 —
young, working, feedback-welcome"; a final bare `grep -rni preview` sweep to confirm nothing stale.
**Consequence**: Honest-and-proud v1 posture; no "preview / interfaces will change" contradictions.

### D7: npm-deferral future-considerations entry
**Choice**: a new "npm Publishing" entry following the file's durability guide, cross-linking the
existing "Monorepo Evolution" entry (which already names the publishable-SDK trigger).
**Consequence**: The deferral is recorded with its "when it becomes worth it" criteria; not duplicated.

### Nav IA (approved)
Home · Guide (Introduction, Get Running, Writing Tickets, CLI) · Architecture · Configuration ·
Plugins · User Flows · Concepts (Philosophy, Constraints, Assumptions, Persona) · Contributing ·
Build Journal (outbound link).

## Scope Boundary
**Delivering**: the docs site, the deploy workflow, the v1.0.0 posture reconcile, CI green.
**Deferring (the deliberate last step)**: the `v1.0.0` git tag/GitHub release, and the demo video → GIF
(produced from a real run, then embedded, then tagged).
**Owner manual steps**: enable Pages (Settings → Pages → Source: GitHub Actions); optionally a dashboard
screenshot for the hero; every `git push`.

## Task Breakdown

### Chunk A — VitePress scaffold + CI-green wiring (inline; foundation/critical path)
**Goal**: `pnpm docs:build` succeeds and `pnpm lint` stays green with the site scaffolded.
**Where**: `package.json` (devDep + `docs:dev`/`docs:build`/`docs:preview` scripts), `docs/.vitepress/config.ts`
(title, `base:'/the-engineer/'`, nav, sidebar, `srcExclude` internal planning + README content),
`docs/.vitepress/theme/` (default theme + custom CSS skeleton), `biome.json` (override), `knip.json`
(ignoreDependencies), `.gitignore` (`docs/.vitepress/{dist,cache}`). Version read from `package.json`,
never hardcoded.
**Verify**: `pnpm docs:build` green; `pnpm lint` green; `pnpm typecheck` green.
**Commit**: `/commit` (no push).

### Chunk B — Landing page + markdown-compat pass (orchestrate the compat sweep; design via probes)
**Goal**: a home/landing page renders with the coded placeholder hero; all docs render correctly in
VitePress.
**Where**: `docs/index.md` (home frontmatter + hero), a markdown-compat pass across `docs/**`
(GitHub `> [!NOTE]` alerts, relative `.md` links, stray `<!-- TODO -->`).
**Verify**: `pnpm docs:preview` — nav works, pages render, no broken links; design-probe loop with owner.
**Commit**: `/commit` (no push).

### Chunk C — Pages deploy workflow (inline)
**Goal**: a valid `docs.yml` that would deploy on push.
**Where**: `.github/workflows/docs.yml`.
**Verify**: YAML valid; action versions current; mirrors ci.yml's pnpm/Node 22 setup.
**Commit**: `/commit` (no push).

### Chunk D — v1.0.0 posture reconcile (inline; small, owner-voiced)
**Goal**: version + posture say v1.0.0 everywhere; npm deferral recorded.
**Where**: `package.json` (version), `README.md` (badge + banner), `SECURITY.md` (2 lines),
`docs/future-considerations.md` (npm entry).
**Verify**: bare `grep -rni preview` shows only unrelated hits; `pnpm test` green (no test asserts app version).
**Commit**: `/commit` (no push).

### Chunk E — Full-gate verification (inline; the quality gate)
**Goal**: everything green; nothing tagged.
**Verify**: `pnpm run lint && pnpm run typecheck && pnpm test && pnpm run build && pnpm docs:build`;
if any `docs/plugins/**` was touched, `pnpm run docs:bundle` + commit (drift guard).
**Commit**: final `/commit` (no push). **Do NOT tag.**

## Verification Contract
| Check | Type | Command/Observation |
|---|---|---|
| Lint (biome+tsc+knip+madge) | Auto | `pnpm run lint` |
| Types | Auto | `pnpm run typecheck` |
| Tests | Auto | `pnpm test` |
| Prod build | Auto | `pnpm run build` |
| Docs build | Auto | `pnpm docs:build` |
| Site renders | Manual | `pnpm docs:preview` — nav, pages, links, hero |
| Bundled-docs drift | Auto | `pnpm run docs:bundle` + `git diff --exit-code` (only if plugin docs touched) |
| No tag | Manual | `git tag` shows no `v1.0.0` |

## Risks / Pre-mortem
| Risk | If it happens | Mitigation |
|---|---|---|
| CI red after site lands (biome/knip tripwire, or `docs:bundle` drift) | `pnpm lint` fails | Chunk A retires CI-green first; gate every commit on local `pnpm lint`; re-run `docs:bundle` if plugin docs touched |
| Deployed site 404s (wrong `base`, Pages off, wrong dist) | Site broken on first push | `base:'/the-engineer/'`; pinned action versions; verify via `docs:preview`; owner enables Pages + validates first push together |
| Scope creep through 45 docs | Effort balloons | Presentation layer only; edits limited to VitePress-render fixes + the posture reconcile; no rewrites without owner sign-off |
| Version bump breaks a test | `pnpm test` red | Research confirmed app version lives only in `package.json` (tests' `1.0.0` are mock manifests); run full suite after the bump |

## Stress Test
Run **inline** (adversarial self-review + the pre-mortem above), not a delegated expert panel — per
the owner's "planning stays inline" working model. The build itself is orchestrated via workflow
subagents with the agent as orchestrator + independent verifier + gap-fixer.

## References
- Requirements: `.claude/temp/requirements-gathering/v1-release-finale.md`
- Research: `.claude/temp/research/v1-release-finale.md`
