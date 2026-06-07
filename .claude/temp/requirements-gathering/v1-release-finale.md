# Requirements: Phase 9 Finale — v1.0.0 Release (Docs Site + Polish; npm Deferred; Demo Last)

## Context
The final push of Phase 9 (OSS Ready): take The Engineer to a polished, presentable **v1.0.0
shipped as a GitHub release** — not npm. It began as "Slice 14 — npm Publish Readiness" but was
reshaped through requirements gathering: npm publish is deferred, the remaining Slice 13 polish is
narrowed to a docs site, and a demo video/GIF is planned as the closing flourish.

## True Intent
Wrap up a working, ready v1 and make it look as good and as real as it already is — *without*
inviting premature dependence (no npm) and *without* building anything nobody uses. The repo is the
product; the docs site is the front door; the demo is the proof. The owner keeps applying one lens
throughout: **"who actually uses this?"** — and anything that fails it is cut.

## Scope

### In Scope
- **Docs site (VitePress on GitHub Pages).** A presentation layer over the *existing* `docs/` (no
  content rewrite) plus **one new landing page** with a hero slot for the demo. `docs/` is the
  VitePress root (`docs/.vitepress/`); real docs render in a curated nav; internal planning under
  `docs/archived/implementation-docs/` is excluded; the build journal gets a single "Build Journal"
  link (not nav'd file-by-file). Auto-deployed via a GitHub Action on push to `main`. **No custom
  domain** (free `github.io`). Look/theme decided via **live probes during the build**, not abstract
  Q&A — minimal, legible, themed (not a generic AI-docs template).
- **v1.0.0 release polish (everything *except* the tag).** Bump `package.json` to `1.0.0`; flip the
  README posture from "preview, interfaces will change" → "v1.0.0 — young, working,
  feedback-welcome"; reconcile version/status references repo-wide; record the npm-deferral in
  `docs/future-considerations.md`; CI green.
- **Hero placeholder.** A *strong static hero* now (dashboard screenshot or quick capture) — never
  "coming soon" — structured so the demo GIF/video drops in later without rework.
- **Tracking reconciliation.** Fix the stale `active.md` (the dashboard *was* done via the Dashboard
  Sync tangent; Slice 13's polish was not) and record every decision below.
- **(Two-for-one)** opportunistic doc/link fixes and gaps, folded in and flagged as found.

### Out of Scope / Deferred (all deliberate, all recorded)
- **The git tag / GitHub release itself** — the *last* step, after the demo, when ready. "All actual
  work done first; tag + video last."
- **Demo video → GIF** — produced last (this or another session): a real end-to-end screen recording,
  edited for pace, turned into a GIF for the README hero and a full video on the docs site. Embedding
  it and cutting the `v1.0.0` tag is the finale.
- **npm publish** — deferred until a real consumption story exists (a stable API, an out-of-tree
  plugin SDK, or enough exact-stack users that `npm i -g` is clearly the better path). Recorded in
  `future-considerations`.
- **npm-publish mechanics** — `files` allowlist, prepublish guard, trusted-publishing workflow,
  README-on-npm link fix (all moot without publishing).
- **Importable plugin SDK / `exports`** — CLI-only for v1; additive (non-breaking) later if needed.
- **Demo-as-code** (`pnpm demo`, a `demo/` directory, mock plugins) — cut; nobody would run it.
- **Design-history archive** — cut; already covered by `docs/archived/` (linked from the site).
- **`llms.txt`** — cut; low usage.

## Requirements

### Functional
1. The docs site builds locally (`pnpm docs:*`) and deploys to GitHub Pages on push to `main`.
2. The site presents the real docs (architecture, plugins, configuration, CLI, philosophy,
   contribution guides, user-flows) with a working curated nav; internal planning is excluded; the
   build journal is reachable via a single link.
3. A landing page renders with a strong static hero, a tagline, the what/how/why hooks, and quick
   links (Get Started · Architecture · Plugins). The hero is structured for a later GIF/video swap.
4. `package.json` version is `1.0.0`. The README and its badges read "v1.0.0 / young,
   feedback-welcome"; no stale "preview" / "interfaces will change before v1.0.0" contradictions
   remain anywhere in the repo or the site.
5. `docs/future-considerations.md` has an entry recording the npm-publish deferral and the criteria
   for when it becomes worth doing.
6. Nothing is tagged. The release/tag and the demo are explicitly the final, separate step.

### Non-Functional
- **CLI-only package shape unchanged.** `package.json` stays publish-capable (so npm is reversible)
  but gains *no* publish machinery.
- **One source of truth.** The site reads `docs/` directly — no content duplication, no drift.
- **Universal audience** preserved across all site/doc copy (short sentences, plain language,
  structure-as-interface).
- **Cost-conscious.** Free GitHub Pages, no paid domain, no paid tooling.
- **Design quality.** Minimal, legible, themed; validated with the owner via live probes.

## Edge Cases & Handling
- **Hero before the video exists** → a strong static placeholder, never "coming soon."
- **Build journal is large** → linked, not nav'd file-by-file.
- **Internal planning docs live under `docs/`** → excluded from the site via VitePress config
  (`srcExclude` / nav curation).
- **npm-oriented metadata already in `package.json`** (`bin`, `main`, `keywords`) → kept as-is
  (harmless, keeps deferral reversible), not stripped.

## Open Questions (non-blocking — resolved in planning / build, not requirements)
- Docs-site information architecture, nav grouping, and theme — settled in planning + via design
  probes during the build.
- Demo video specifics (length, capture method, hosting of the full video) — settled when we produce
  it, post-build.

## Affected Systems
- `docs/` + new `docs/.vitepress/` — the site config, theme, landing page.
- `README.md` — posture → v1.0.0; badges; (relative links fine on GitHub).
- `package.json` — version → `1.0.0`; new `docs:dev` / `docs:build` / `docs:preview` scripts.
- `.github/workflows/` — a new GitHub Pages deploy workflow.
- `docs/future-considerations.md` — the npm-deferral entry.
- `docs/archived/implementation-docs/9-oss-ready/active.md` (+ slice/session records) —
  reconciliation.

## Acceptance Criteria
- [ ] `pnpm docs:build` succeeds; the site deploys to GitHub Pages via the Action.
- [ ] The site presents all real docs with a working curated nav; internal planning excluded; Build
      Journal linked.
- [ ] The landing page renders with a strong static hero, tagline, and quick links; the hero is
      structured for a later GIF swap.
- [ ] `package.json` = `1.0.0`; README + badges say "v1.0.0 / young, feedback-welcome"; no stale
      "preview / interfaces will change" contradictions anywhere.
- [ ] `future-considerations` records the npm deferral + its criteria.
- [ ] Full gate green: `pnpm run lint`, `pnpm run typecheck`, `pnpm test` (+ the docs build).
- [ ] `active.md` reflects reality; every decision above is recorded.
- [ ] **NOT tagged.** The demo video → GIF + the `v1.0.0` tag remain the final, deliberate step.

## Working Model
- **R/R/P inline** (owner + agent, full shared context) — requirements done; research + planning next.
- **Build orchestrated** via workflow subagents, with the agent as **orchestrator + independent
  verifier + gap-fixer** (re-run gates, read diffs, hand-check invariants, never trust self-reports).
- **Owner is co-owner + final call.** Two-for-one: fold in doc/link fixes and flag gaps as found.

## Demo Production Plan (capture for when we produce it — the owner's vision)
A real, narration-free end-to-end screen recording (~2–3 min), edited for pace, NOT a recreation
(no Remotion rebuild — at most light overlays/captions/speed-ramps over real footage):

1. `engineer start` (daemon + dashboard up).
2. Owner writes a GitHub issue, **deliberately ambiguous** (e.g. the real "update scenes" / Issue #40
   style).
3. The Engineer picks up the new task; requirements phase reads the repo and **reaches out via
   Telegram** with a calm, thorough, specific clarification (modeled on the real Issue #40 thread —
   "I read the codebase thoroughly… here's what's ambiguous… Q1/Q2/Q3… even a rough answer to Q1
   unlocks the rest").
4. Owner **answers in the dashboard**; the task resumes.
5. It **auto-skips research + planning** because the task is tiny (great "watch it reason about its
   own process" beat) → implement → self-review.
6. **"PR ready" Telegram milestone**; switch the recording to GitHub.
7. Owner leaves a **PR comment requesting more changes** → the **rework loop** re-enters the pipeline.
8. `/approve` → **auto-merge** → **branch deleted** → show the final `main`.

Shows, in one sitting: the full lifecycle, the **live CLI tail**, **human-in-the-loop** (requirements
clarification *and* autonomy escalation), and the **plugin architecture** (real GitHub + Telegram +
coding-agent plugins). Likely a separate branch. The resulting GIF/video upgrades the docs hero, and
**that** is when `v1.0.0` gets tagged.
