# Active — Phase 9: OSS Ready

> **ALWAYS READ BEFORE PROCEEDING.** Then read [approach.md](approach.md) and the current slice file.
> These references are permanent. Never remove them.

## Key Files

- [vision.md](vision.md) — why we're doing this, what done looks like
- [approach.md](approach.md) — strategy, lenses, co-founder rules, 16-slice roadmap, session protocol
- Current slice: `slices/04-startup.md`

## How This File Works

This file answers one question: **where are we right now?** Nothing more.

- **Current** holds the active slice — its state, plan, and the immediate next step.
- When a slice finishes, recap it as **one line** under **Completed Slices**, then advance
  **Current** to the next slice.
- Depth lives elsewhere: per-session detail in `sessions/N.md`, per-slice decisions in that
  slice's file. Do not duplicate that depth here.

## Current

**Slice:** 04-startup — Startup & Configuration
**State:** Phase 1 (Simplification & Removals) complete (Session 10). Phases 2-5 remaining.
**Plan:** `.claude/temp/create-plan/slice-04-startup.md` — 5 phases, panel-reviewed, 11 decisions.

**Next step — Phase 2 (Getting-Started Path).** Read `slices/04-startup.md` and the plan,
then: create `scripts/setup.sh` + wire `pnpm run setup` (confirm → install → build → link),
rework `reset.sh` (no-arg interactive, with-arg seed, cross-platform `PNPM_HOME`), sanitize
`seed-example/` to generic placeholders + add the `seed-example-*` `.gitignore` pattern,
update README + `cli.md` getting-started. Commit cohesively per task; the phase ends green.

**Remaining phases:** 3 OS Detection & Setup UX → 4 CLI Restructure (Screaming Architecture)
→ 5 Coding Standards Audit. One focused session each.

**Slice 4 decisions (Session 9):**
- Getting-started: new `pnpm run setup` → `scripts/setup.sh` (confirm + install + build + link), then `engineer start`
- OS gate: macOS continues, Linux warns+confirms, Windows blocks; macOS/Linux POSIX-compatible, Windows out of scope for v1
- Seed (Option A): sanitize tracked `seed-example/` to generic placeholders; personal seeds in gitignored `seed-example-*`; dogfood the seed feature
- Removals: `checkCliArtifacts` (Plugin Blindness), config-version machinery (verified dead), `Output.table()`, `"quiet"` mode
- CLI restructure (Screaming Architecture) is its own phase, before the audit so the audit sees the final shape
- New coding standards to add: "Single Source of Truth", "Structure Reveals Intent"
- Cross-cutting: nice, actionable error handling across all user flows

## Completed Slices

- **Slice 1 — Standards Alignment:** `docs/coding-standards.md` written — 10 categories decided via deep Q&A.
- **Slice 2 — Repo Readiness:** Biome aligned, lint split, CI parallelized, tests restructured (`tests/unit/` mirrors `src/`), migrations consolidated, hardcoded paths fixed.
- **Slice 3 — Dashboard:** 5-page React SPA rewrite (Overview, Tasks, Activity, Metrics, Errors), all features working, coding standards audited. Sessions 4-8 — detail in `slices/03-dashboard.md`.
