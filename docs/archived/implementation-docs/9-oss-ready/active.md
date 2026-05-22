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

**Slice:** 05-trigger — Trigger & Requirements (Contacts) Flow
**State:** Session 20 complete. **Plan Session 3 COMPLETE** — trigger plugin refinement (D6 + D7 + D8) shipped, plus the config-path gap D7 exposed and a dashboard path-bug fix. All gates green (typecheck, lint, 2481 tests). Next: Plan Session 4 (Contacts: single-user constraint, D9).
**Plan:** `.claude/temp/create-plan/slice-05-trigger.md` — Status: **Panel-Reviewed**. 9 decisions, 4-session task breakdown.

**What Session 20 shipped (Plan Session 3 — trigger plugin refinement, D6 + D7 + D8):**
- **D6 — per-plugin poll cadence:** added typed optional `poll_interval_ms` to `PluginManifestSchema`; `trigger-poller` honors `trigger.manifest.poll_interval_ms` as the per-plugin base with global `trigger_poll_interval_ms` as fallback; backoff multiplies the per-plugin base. Set `poll_interval_ms: 30_000` on github-trigger's manifest; deleted the dead Zod `poll_interval_ms` from its config.
- **D7 — configurable work selection:** added `assignee` to github-trigger config; **`labels` defaults to `["engineer"]`** (the refinement — see below); passed `assignee` to the GitHub API; renamed `event_type` from the misnomer `"issue_assigned"` → static `"issue"`.
- **D8 — Core-owned backoff:** removed the plugin's `retryAfterUntil` field + its silent-suppress guard; 429s now throw `AdapterMethodError` with `retry_after_ms` set. `trigger-poller` reads `retry_after_ms` off the caught error, sets a per-plugin `triggerRateLimitUntil`, and does **not** count rate-limits toward consecutive failures; clears the deadline on success; falls back to exponential backoff for errors without `retry_after_ms`.
- **Config-path gap (D7 fallout):** the original "reject if neither labels nor assignee" broke bootstrap for every criterion-less config (seeds, setup template, interactive prompt). Closed by making `labels` default to `["engineer"]` — frictionless default over fail-loud wall. Kept a guard that only fires on *explicit* `labels: []` + no assignee (the deliberate match-everything footgun). Reverted the prompt to repo-only; templates/seeds show the default + assignee/`labels: []` paths. Verified all parse cases via tsx.
- **Dashboard path bug:** `dashboard/server.ts:90` used `../../dist/dashboard` (calibrated for source location), which resolved *outside the repo* when bundled into `dist/index.mjs` → "Dashboard not built" at `localhost:3847`. Fixed to `resolve(import.meta.dirname, "dashboard")`, matching the migrations convention (`db/database.ts:42`). Verified post-build: resolves to `dist/dashboard`, `index.html` present.
- **Docs:** github-trigger.md (default behavior, work-selection paragraph, examples), trigger README (manifest poll interval + Core backoff), daemon.md (global = fallback), plugin-docs.ts (`event_type` example), slice 05 decision #6 (records the default-over-reject refinement).
- ~14 new tests across trigger-poller + github-trigger; all green.

**Key decisions:** `labels` defaults to `["engineer"]` (overrides the planned "reject neither" — frictionless defaults beat fail-loud); `event_type` is the static `"issue"` (match criteria is config, not classification); rate-limits don't count as failures; dashboard SPA path follows the migrations convention. **NOT committed yet** at session-log time — committing as part of this wrap.

**Cross-slice handoffs (unchanged):** #9 reply-token + #10 unblock check → Slice 12; trivial-skip → Slice 8; review polling → Slice 10.

**Next step — Plan Session 4 (Contacts: single-user constraint, D9):**
- **T4.1** — `docs/constraints.md` (single-user, two non-relaxations, until-modified) + references in README, AGENT-README (always-read), philosophy.md.
- **T4.2** — PeopleDirectory load-warn (>1 person; no owner) — owner-typo becomes fail-loud.
- **T4.3** — `engineer doctor` owner-channel validation category (validate owner's channels against installed comm plugins).
- **T4.4** — people-directory + contacts flow docs. Each task: code + tests + docs + standards pass.

**Known issue:** `orchestrator/index.test.ts > resolveStartState — feedback rework` is flaky (passes on isolated rerun — confirmed again this session, 49/49). Pre-existing, unrelated. Worth a separate look.

## Completed Slices

- **Slice 1 — Standards Alignment:** `docs/coding-standards.md` written — 10 categories decided via deep Q&A.
- **Slice 2 — Repo Readiness:** Biome aligned, lint split, CI parallelized, tests restructured (`tests/unit/` mirrors `src/`), migrations consolidated, hardcoded paths fixed.
- **Slice 3 — Dashboard:** 5-page React SPA rewrite (Overview, Tasks, Activity, Metrics, Errors), all features working, coding standards audited. Sessions 4–8 — detail in `slices/03-dashboard.md`.
- **Slice 4 — Startup & Configuration:** Getting-started path (`pnpm run setup` → `engineer start`), OS detection gate, seed-example sanitization + dogfooding, removals (checkCliArtifacts, config-version machinery, Output.table, quiet mode), CLI restructure (Screaming Architecture), original coding standards audit (1–11), new coding standards added (§4 expanded, §5 expanded, §7 framing, §12–§15), six post-bootstrap infrastructure gaps closed (retryable flag, cause chains, trace_id correlation, floating promises, span/log correlation, graceful degradation logs), and new standards applied across slice 4 in-scope files. "Apply with judgment, never mechanically" principle codified. Sessions 9–16 — detail in `slices/04-startup.md`.
