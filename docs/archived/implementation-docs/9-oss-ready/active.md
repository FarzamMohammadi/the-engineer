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
**State:** Session 18 complete. Expert panel done (findings incorporated, plan → Panel-Reviewed). **Plan Session 1 COMPLETE** — PluginContext + StateStore foundation shipped, all gates green (typecheck, lint, 2459 tests). Next: Plan Session 2 (dedup → Core).
**Plan:** `.claude/temp/create-plan/slice-05-trigger.md` — Status: **Panel-Reviewed**. 9 decisions, 4-session task breakdown. Panel scored core design 8-9/10.

**What Session 18 shipped (Plan Session 1 — the foundation):**
5 commits, all green increments:
- **StateStore foundation** (`72f4fe5`) — `plugin_state` table; adapter-side `StateStore` interface; Core impl (per-plugin namespaced, prepared statements; `get` returns `unknown|null`).
- **Deleted dead HookRegistry** (`193f947`) — fully unwired system (zero producers/consumers), −387 net. Cleared the last `unknown`-typed injected field.
- **PluginContext** (`c1a1897`) — consolidated scattered injected fields into one typed `{ logger, stateStore }`; `manifest` stays separate (identity vs capabilities). `logger` = `observer.childPlugin(id)` auto-binding `plugin_id`; new `"plugin"` ComponentTag. Registry injects via a DB-decoupled `createStateStore` factory.
- **StateStore migration** (`3432fe1`) — github-trigger watermarks + telegram chat-map off hand-rolled file I/O (which ignored `--home` — now fixed); deleted bare `catch {}`; malformed state → typed `warn` + fresh.
- **Docs** (`eccae34`) — new `docs/plugins/plugin-context.md` (canonical contract reference); corrected stale file-persistence docs; per-type READMEs link it.

Panel refinements folded into plan: `findByIdempotencyKey` keyed on key alone; StateStore error contract (throws → lifecycle catches); dedup round-trip test added to verification contract.

**Cross-slice handoffs (unchanged):** #9 reply-token + #10 unblock check → Slice 12; trivial-skip → Slice 8; review polling → Slice 10.

**Next step — Plan Session 2 (dedup → Core + delete review scaffolding, D1 + D4):**
- `idempotency_key` column + **unique** partial index on active tasks (key alone, per panel) in `001_schema.sql`.
- `findByIdempotencyKey` in task-engine queries (mirror `findByExternalRef`); store key on `createTask`.
- Rewire `trigger-poller` dedup to key on `idempotency_key`; demote `external_ref` to descriptive.
- Delete dead `trigger.pr_review` across `events.ts`, `builtin.ts`, JSDoc, `plugin-docs.ts`.
- Trigger-flow doc + dedup round-trip test. Each task: code + tests + docs + standards pass.

**Known issue:** `orchestrator/index.test.ts > resolveStartState — feedback rework` is flaky (returns `blocked` vs `review_pending` intermittently; passes on rerun). Unrelated to Session 18 changes — likely test-ordering/state-leakage. Worth a separate look.

## Completed Slices

- **Slice 1 — Standards Alignment:** `docs/coding-standards.md` written — 10 categories decided via deep Q&A.
- **Slice 2 — Repo Readiness:** Biome aligned, lint split, CI parallelized, tests restructured (`tests/unit/` mirrors `src/`), migrations consolidated, hardcoded paths fixed.
- **Slice 3 — Dashboard:** 5-page React SPA rewrite (Overview, Tasks, Activity, Metrics, Errors), all features working, coding standards audited. Sessions 4–8 — detail in `slices/03-dashboard.md`.
- **Slice 4 — Startup & Configuration:** Getting-started path (`pnpm run setup` → `engineer start`), OS detection gate, seed-example sanitization + dogfooding, removals (checkCliArtifacts, config-version machinery, Output.table, quiet mode), CLI restructure (Screaming Architecture), original coding standards audit (1–11), new coding standards added (§4 expanded, §5 expanded, §7 framing, §12–§15), six post-bootstrap infrastructure gaps closed (retryable flag, cause chains, trace_id correlation, floating promises, span/log correlation, graceful degradation logs), and new standards applied across slice 4 in-scope files. "Apply with judgment, never mechanically" principle codified. Sessions 9–16 — detail in `slices/04-startup.md`.
