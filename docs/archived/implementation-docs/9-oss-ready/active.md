# Active — Phase 9: OSS Ready

> **ALWAYS READ BEFORE PROCEEDING.** Then read [approach.md](approach.md) and the current slice file.
> These references are permanent. Never remove them.

## Key Files

- [vision.md](vision.md) — why we're doing this, what done looks like
- [approach.md](approach.md) — strategy, lenses, co-founder rules, 16-slice roadmap, session protocol
- Current slice: `slices/05-trigger.md` (not yet created — write during requirements gathering)

## How This File Works

This file answers one question: **where are we right now?** Nothing more.

- **Current** holds the active slice — its state, plan, and the immediate next step.
- When a slice finishes, recap it as **one line** under **Completed Slices**, then advance
  **Current** to the next slice.
- Depth lives elsewhere: per-session detail in `sessions/N.md`, per-slice decisions in that
  slice's file. Do not duplicate that depth here.

## Current

**Slice:** 05-trigger — Trigger & Requirements Flow
**State:** Not yet started. No slice file written yet. Begin with `/requirements-gathering`.
**Plan:** Will be created during the planning phase, after requirements + research.

**Where slice 4 left us:**
Slice 4 (Startup & Configuration) is fully complete. Phases 1–5 all done:
- Phase 1 (Session 10): simplification & removals
- Phase 2 (Session 11): getting-started path, `pnpm run setup`, seed sanitization
- Phase 3 (Session 12): OS detection gate, setup UX polish
- Phase 4 (Session 13): CLI restructure (Screaming Architecture)
- Phase 4 (Session 14): expanded coding standards (§4, §5, §7, §12–§15) added to `docs/coding-standards.md`
- Session 15: closed 6 infrastructure gaps the new standards exposed in post-bootstrap code (retryable flag, cause chains, trace_id correlation, floating promises, span/log correlation, graceful degradation logs)
- Phase 5 (Session 16): swept the slice 4 in-scope files (`src/cli/`, `src/config/`, `src/plugins/loader.ts`, `src/plugins/builtin.ts`) against the new standards. Added `readonly` to ~30 interfaces/types, threaded observer + adapterType into `loadPluginConfig` for richer degradation logs, wrapped `loadBuiltinPlugins` in a lifecycle span, fixed missing cause chain in `ensureDirectories`, added a doctor warn for category 9 skip on config failure. Codified "Apply with judgment, never mechanically" as a callout in coding-standards.md after a readability incident with conditional spreads.

Build status at slice 4 close: typecheck clean, lint clean (only pre-existing warnings), 2463/2463 tests pass.

**Next step — Slice 5 kickoff:**
Begin with `/requirements-gathering`. Probe scope: which trigger plugin behaviors need rework, the dedup story end-to-end (idempotency keys, watermarks, what happens on plugin crash mid-poll), how requirements gathering hands off to research, how the contacts/people directory feeds into outreach. No assumptions — every question one at a time. Once requirements feel solid, write `slices/05-trigger.md` capturing them, then `/research`, then `/create-plan`, then implement.

## Completed Slices

- **Slice 1 — Standards Alignment:** `docs/coding-standards.md` written — 10 categories decided via deep Q&A.
- **Slice 2 — Repo Readiness:** Biome aligned, lint split, CI parallelized, tests restructured (`tests/unit/` mirrors `src/`), migrations consolidated, hardcoded paths fixed.
- **Slice 3 — Dashboard:** 5-page React SPA rewrite (Overview, Tasks, Activity, Metrics, Errors), all features working, coding standards audited. Sessions 4–8 — detail in `slices/03-dashboard.md`.
- **Slice 4 — Startup & Configuration:** Getting-started path (`pnpm run setup` → `engineer start`), OS detection gate, seed-example sanitization + dogfooding, removals (checkCliArtifacts, config-version machinery, Output.table, quiet mode), CLI restructure (Screaming Architecture), original coding standards audit (1–11), new coding standards added (§4 expanded, §5 expanded, §7 framing, §12–§15), six post-bootstrap infrastructure gaps closed (retryable flag, cause chains, trace_id correlation, floating promises, span/log correlation, graceful degradation logs), and new standards applied across slice 4 in-scope files. "Apply with judgment, never mechanically" principle codified. Sessions 9–16 — detail in `slices/04-startup.md`.
