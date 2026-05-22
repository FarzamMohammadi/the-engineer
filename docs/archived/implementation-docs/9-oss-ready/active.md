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

**Between slices.** Slice 5 is **closed** (see Completed Slices). The next focused session is a
**pre-existing e2e investigation** (below), then **Slice 6 — Scheduling & Dispatch**.

**TOP PRIORITY NEXT — e2e suite is broken (pre-existing, predates Slice 5).** All five `task-happy-path`
+ `crash-recovery` e2e tests fail: the daemon's happy path never reaches the LLM (`fake-llm.getCallCount()`
returns 0, `tasksCompleted` is 0). **Verified identical at `ad7b400`** (Slice 5's start), so this is an
older defect, not a sweep regression. It stayed invisible because `test:all` chains with `&&` and the
chronic unit flake (now fixed) short-circuited the run before e2e executed. The fake LLM never being
called means the task is created but never dispatched/executed, or fails before the first phase — start
in the daemon scheduling/dispatch path and `tests/helpers/integration-context.ts` + `fake-plugins/fake-llm`.
Integration tests (40) pass with the same harness, so the harness itself works. **This is its own focused
session** — a deeper daemon/orchestrator issue, unrelated to trigger/contacts.

**Gate status at close:** typecheck clean; lint clean (8 **pre-existing** complexity warnings in
opencode/gemini/claude-code/notification-router — predate Slice 5, out of scope); unit **2482 passed
(5× consecutive green — flake fixed)**; integration **40 passed**; e2e **5 pre-existing failures** (above).

**Resolved this session (the carried hot-reload finding):** config hot-reload was unwired dead
scaffolding — deleted `src/config/watcher.ts`, the `updateConfig`/`updateLimits` methods on SafetyLayer/
PolicyEngine/CostTracker/PeopleDirectory, the `health.config_reload_failed` event, and every test that
drove them; corrected all docs to "takes effect on restart." Decision (Farzam): delete over wire.

**Cross-slice handoffs (unchanged):** #9 reply-token + #10 unblock check → Slice 12; trivial-skip → Slice 8;
review polling → Slice 10. (#9's smart-reply-correlation deferral is now captured in `future-considerations.md`.)

## Completed Slices

- **Slice 1 — Standards Alignment:** `docs/coding-standards.md` written — 10 categories decided via deep Q&A.
- **Slice 2 — Repo Readiness:** Biome aligned, lint split, CI parallelized, tests restructured (`tests/unit/` mirrors `src/`), migrations consolidated, hardcoded paths fixed.
- **Slice 3 — Dashboard:** 5-page React SPA rewrite (Overview, Tasks, Activity, Metrics, Errors), all features working, coding standards audited. Sessions 4–8 — detail in `slices/03-dashboard.md`.
- **Slice 4 — Startup & Configuration:** Getting-started path (`pnpm run setup` → `engineer start`), OS detection gate, seed-example sanitization + dogfooding, removals (checkCliArtifacts, config-version machinery, Output.table, quiet mode), CLI restructure (Screaming Architecture), original coding standards audit (1–11), new coding standards added (§4 expanded, §5 expanded, §7 framing, §12–§15), six post-bootstrap infrastructure gaps closed (retryable flag, cause chains, trace_id correlation, floating promises, span/log correlation, graceful degradation logs), and new standards applied across slice 4 in-scope files. "Apply with judgment, never mechanically" principle codified. Sessions 9–16 — detail in `slices/04-startup.md`.
- **Slice 5 — Trigger & Requirements (Contacts) Flow:** PluginContext + per-plugin StateStore (the SDK foundation), durable dedup moved to Core on `idempotency_key`, dead `trigger.pr_review` scaffolding removed (issues-only trigger), per-plugin poll cadence + configurable label/assignee work selection + Core-owned backoff, single-user constraint (`docs/constraints.md`, owner assumed-not-required, doctor "People Directory" category). Closing standards sweep (Session 22) closed it: deleted unwired config hot-reload infra, re-synced bundled plugin docs with source, removed dead `max_tokens`, fixed the chronic orchestrator test flake, line-by-line audit of all in-scope files. Sessions 17–22 — detail in `slices/05-trigger.md`.
