# Active — Phase 9: OSS Ready

> **ALWAYS READ BEFORE PROCEEDING.** Then read [approach.md](approach.md) and the current slice file.
> These references are permanent. Never remove them.

## Key Files

- [vision.md](vision.md) — why we're doing this, what done looks like
- [approach.md](approach.md) — strategy, lenses, co-founder rules, RRP discipline (what to hunt for, how to present findings), closing sweep principles, 16-slice roadmap, session protocol
- Current slice: `slices/07-workspace-session.md` — RRP complete (Session 31), implementation Session 1 next

## How This File Works

This file answers one question: **where are we right now?** Nothing more.

- **Current** holds the active slice — its state, plan, and the immediate next step.
- When a slice finishes, recap it as **one line** under **Completed Slices**, then advance
  **Current** to the next slice.
- Depth lives elsewhere: per-session detail in `sessions/N.md`, per-slice decisions in that
  slice's file. Do not duplicate that depth here.

## Current

**Slice 7 — Workspace & Session** — RRP complete (Session 31); implementation starts
Session 32 (Slice 7 Session 1: knowledge layer cut + future-considerations
consolidation). Three deliverables landed:

- `slices/07-workspace-session.md` — 6 goals, 13 decisions, Lens Check.
- `.claude/temp/research/slice-07-workspace-session.md` — source-grounded research
  with exact paths + line numbers, resume flow walkthrough, workspace events
  verification, risks/gotchas.
- `.claude/temp/create-plan/slice-07-workspace-session.md` — 9-decision plan with
  rejected alternatives, 5-session breakdown (each green-on-commit, last is closing
  sweep), per-session standards-application items, pre-mortem, panel review.

Methodology refinements (commit `b41aff7`, `adb6f66`): `approach.md` now codifies
"What Each RRP Must Hunt For", "Presenting Findings During RRP", and
"coding-standards alignment is a planning concern, not a sweep concern." Future RRPs
inherit this discipline.

**Cross-slice handoffs inherited from prior slices (still parked for target slices):**
- Slice 5 → Slice 12: #9 reply-token + #10 unblock check.
- Slice 5 → Slice 8: trivial-skip.
- Slice 5 → Slice 10: review polling.
- Slice 6 → Slice 8: decomposition-handler.ts deletion + planning prompt instruction
  removal + decomposition schemas deletion + integration phase re-evaluation + signal
  honoring through phase-runner → llm-caller → LLM plugins.
- Slice 6 → Slice 12: notification-kind enumeration audit.
- Slice 6 → Slice 15: dashboard UI cleanup for the simplified state machine.

## Completed Slices

- **Slice 1 — Standards Alignment:** `docs/coding-standards.md` written — 10 categories decided via deep Q&A.
- **Slice 2 — Repo Readiness:** Biome aligned, lint split, CI parallelized, tests restructured (`tests/unit/` mirrors `src/`), migrations consolidated, hardcoded paths fixed.
- **Slice 3 — Dashboard:** 5-page React SPA rewrite (Overview, Tasks, Activity, Metrics, Errors), all features working, coding standards audited. Sessions 4–8 — detail in `slices/03-dashboard.md`.
- **Slice 4 — Startup & Configuration:** Getting-started path (`pnpm run setup` → `engineer start`), OS detection gate, seed-example sanitization + dogfooding, removals (checkCliArtifacts, config-version machinery, Output.table, quiet mode), CLI restructure (Screaming Architecture), original coding standards audit (1–11), new coding standards added (§4 expanded, §5 expanded, §7 framing, §12–§15), six post-bootstrap infrastructure gaps closed (retryable flag, cause chains, trace_id correlation, floating promises, span/log correlation, graceful degradation logs), and new standards applied across slice 4 in-scope files. "Apply with judgment, never mechanically" principle codified. Sessions 9–16 — detail in `slices/04-startup.md`.
- **Slice 5 — Trigger & Requirements (Contacts) Flow:** PluginContext + per-plugin StateStore (the SDK foundation), durable dedup moved to Core on `idempotency_key`, dead `trigger.pr_review` scaffolding removed (issues-only trigger), per-plugin poll cadence + configurable label/assignee work selection + Core-owned backoff, single-user constraint (`docs/constraints.md`, owner assumed-not-required, doctor "People Directory" category). Closing standards sweep (Session 22) closed it: deleted unwired config hot-reload infra, re-synced bundled plugin docs with source, removed dead `max_tokens`, fixed the chronic orchestrator test flake, line-by-line audit of all in-scope files. Sessions 17–22 — detail in `slices/05-trigger.md`.
- **Slice 6 — Scheduling & Dispatch:** Decomposition consumer deleted in full, single retry-policy module (per-category, config-driven), dispatch-tracker primitive (AbortController, per-dispatch identity, idempotent late callbacks), `Outcomes.terminated` with typed reason routing, preemption tightened (eligible filter, bounded priority, one-per-tick), hard-cap enforcement (`max_active_duration_ms` → terminate → failed + alert), crash recovery unification (boot-loop hole closed), `engineer retry` accepts failed tasks, `failed → queued` transition, dead `preemption.ready` event deleted. Closing standards sweep (Session 29) fixed stale overview States table, dispatch-tracker drain complexity, Array<T> syntax, swallowed DB-open error in retry CLI, stale decomposition JSDoc. Post-sweep refinement (Session 30) collapsed triplicated LLM subprocess helpers (env allowlist + buildLlmEnv + appendStderr) into `src/plugins/llm/subprocess.ts` — surfaced a new sweep principle: duplicated *functions* count under § 11 too, not just literals. Sessions 25–30 — detail in `slices/06-scheduling.md`.
- **E2E test fix (carried over from Slice 5, Session 23):** the five `task-happy-path` + `crash-recovery` e2e failures were structural — tests used `clone_url: ""` (silently skipping workspace creation → `WorkspaceNotReadyError` → no LLM call), and asserted impossible LLM counts since the FakeLLM doesn't simulate the CLI's `session-result.json` write. Rewrote as one full-pipeline smoke test (bare git repo + FakeLLM side-effect hook) plus honest dispatch/routing/recovery tests. 16/16 e2e passing. Commit `f54ad8c`.
