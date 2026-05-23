# Active — Phase 9: OSS Ready

> **ALWAYS READ BEFORE PROCEEDING.** Then read [approach.md](approach.md) and the current slice file.
> These references are permanent. Never remove them.

## Key Files

- [vision.md](vision.md) — why we're doing this, what done looks like
- [approach.md](approach.md) — strategy, lenses, co-founder rules, 16-slice roadmap, session protocol
- Current slice: `slices/06-scheduling.md` (not yet created — write during requirements gathering)

## How This File Works

This file answers one question: **where are we right now?** Nothing more.

- **Current** holds the active slice — its state, plan, and the immediate next step.
- When a slice finishes, recap it as **one line** under **Completed Slices**, then advance
  **Current** to the next slice.
- Depth lives elsewhere: per-session detail in `sessions/N.md`, per-slice decisions in that
  slice's file. Do not duplicate that depth here.

## Current

**Starting Slice 6 — Scheduling & Dispatch.** Slice 5 closed; the carried-over e2e breakage was
fixed (commit `f54ad8c`) — tests rewritten as one full-pipeline smoke test + honest dispatch/routing
tests using a bare git repo + a FakeLLM session-result.json side-effect hook. First Slice 6 session
is **requirements gathering** — Q&A to scope what we touch, what we cut, and what stays as-is.

**Gate status going in:** typecheck clean; lint clean (8 **pre-existing** complexity warnings in
opencode/gemini/claude-code/notification-router — predate Slice 5, out of scope); unit **2482 passed**;
integration **40 passed**; e2e **16 passed** (was 11+5).

**Cross-slice handoffs landing in Slice 6's lap:** none currently parked specifically for Slice 6.
Inherited from Slice 5 (still parked for their target slices): #9 reply-token + #10 unblock check →
Slice 12; trivial-skip → Slice 8; review polling → Slice 10.

## Completed Slices

- **Slice 1 — Standards Alignment:** `docs/coding-standards.md` written — 10 categories decided via deep Q&A.
- **Slice 2 — Repo Readiness:** Biome aligned, lint split, CI parallelized, tests restructured (`tests/unit/` mirrors `src/`), migrations consolidated, hardcoded paths fixed.
- **Slice 3 — Dashboard:** 5-page React SPA rewrite (Overview, Tasks, Activity, Metrics, Errors), all features working, coding standards audited. Sessions 4–8 — detail in `slices/03-dashboard.md`.
- **Slice 4 — Startup & Configuration:** Getting-started path (`pnpm run setup` → `engineer start`), OS detection gate, seed-example sanitization + dogfooding, removals (checkCliArtifacts, config-version machinery, Output.table, quiet mode), CLI restructure (Screaming Architecture), original coding standards audit (1–11), new coding standards added (§4 expanded, §5 expanded, §7 framing, §12–§15), six post-bootstrap infrastructure gaps closed (retryable flag, cause chains, trace_id correlation, floating promises, span/log correlation, graceful degradation logs), and new standards applied across slice 4 in-scope files. "Apply with judgment, never mechanically" principle codified. Sessions 9–16 — detail in `slices/04-startup.md`.
- **Slice 5 — Trigger & Requirements (Contacts) Flow:** PluginContext + per-plugin StateStore (the SDK foundation), durable dedup moved to Core on `idempotency_key`, dead `trigger.pr_review` scaffolding removed (issues-only trigger), per-plugin poll cadence + configurable label/assignee work selection + Core-owned backoff, single-user constraint (`docs/constraints.md`, owner assumed-not-required, doctor "People Directory" category). Closing standards sweep (Session 22) closed it: deleted unwired config hot-reload infra, re-synced bundled plugin docs with source, removed dead `max_tokens`, fixed the chronic orchestrator test flake, line-by-line audit of all in-scope files. Sessions 17–22 — detail in `slices/05-trigger.md`.
- **E2E test fix (carried over from Slice 5, Session 23):** the five `task-happy-path` + `crash-recovery` e2e failures were structural — tests used `clone_url: ""` (silently skipping workspace creation → `WorkspaceNotReadyError` → no LLM call), and asserted impossible LLM counts since the FakeLLM doesn't simulate the CLI's `session-result.json` write. Rewrote as one full-pipeline smoke test (bare git repo + FakeLLM side-effect hook) plus honest dispatch/routing/recovery tests. 16/16 e2e passing. Commit `f54ad8c`.
