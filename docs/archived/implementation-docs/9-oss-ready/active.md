# Active — Phase 9: OSS Ready

> **ALWAYS READ BEFORE PROCEEDING.** Then read [approach.md](approach.md) and the current slice file.
> These references are permanent. Never remove them.

## Key Files

- [vision.md](vision.md) — why we're doing this, what done looks like
- [approach.md](approach.md) — strategy, lenses, co-founder rules, 16-slice roadmap, session protocol
- Current slice: `slices/06-scheduling.md` — requirements + research + plan all complete; ready to implement

## How This File Works

This file answers one question: **where are we right now?** Nothing more.

- **Current** holds the active slice — its state, plan, and the immediate next step.
- When a slice finishes, recap it as **one line** under **Completed Slices**, then advance
  **Current** to the next slice.
- Depth lives elsewhere: per-session detail in `sessions/N.md`, per-slice decisions in that
  slice's file. Do not duplicate that depth here.

## Current

**Slice 6 — Scheduling & Dispatch — pre-implementation phase complete (Session 24).** All
three RRPIR upstream deliverables landed in one focused session: thirteen decisions locked
through Q&A, deep research saved to `.claude/temp/research/slice-06-scheduling.md` (two
grounding rounds), multi-session implementation plan saved to
`.claude/temp/create-plan/slice-06-scheduling.md`. Slice file `slices/06-scheduling.md`
captures decisions and points at both artifacts. Next: **Session 1 — decomposition consumer
delete**. Start by reading the plan file's Session 1 task list.

**Slice shape locked (13 decisions):**
- D1: Delete the operationally-dead decomposition consumer in full (schema, sub-states,
  ValidTransitions, permission table, event, scheduler/daemon logic, data-lifecycle reference,
  bundled config, dashboard client `SubState` type). Cross-slice handoffs to Slice 8
  (orchestrator-side deletion, integration phase re-evaluation) and Slice 15 (dashboard UI).
- D2: New `src/core/retry-policy/` module — per-category (`crash`, `llm_unavailable`),
  config-driven backoffs, per-category counter fields, single API.
- D3: New `src/core/dispatch-tracker/` module — AbortController per dispatch, per-dispatch
  identity for idempotent late callbacks, `terminate(taskId, reason)`, new
  `Outcomes.terminated` with typed reason routing. Signal honoring through orchestrator
  handed to Slice 8.
- D4: `max_active_duration_ms` enforcement — subscribe to existing health event, terminate
  → failed + alert. Wall-clock time accounting.
- D5: Crash recovery unification — both boot recovery and per-task crash through retry-policy.
  Closes the boot-loop hole.
- D6: Preemption tightened — eligible filter before picking, priority bounded `[1, 100]`
  (research correction matching DB CHECK), one-per-tick documented as deliberate, dead
  `preemption.ready` event deleted, dead `abandonPending` deleted.
- D7: Eligibility surfacing — minimal cleanup, doc paragraph, no new plumbing.
- D8: Phase-runner adopts retry-policy in Slice 6 (avoids two writers in interim).
- D9: Cost-limit-queue adopts terminate primitive in Slice 6 (notifications stay immediate).
- D10: `drainForShutdown` adopts terminate primitive in Slice 6 (single shared timeout).
- D11: Collapse `Outcomes.preempted` into `Outcomes.terminated`.
- D12: `engineer retry` resets both per-category counters.
- D13: Add `failed → queued` ValidTransitions edge so hard-cap victims have a recovery path
  via `engineer retry` (research refinement to D4 + D12).

**Five-session implementation breakdown (in plan file, full detail):**
1. Decomposition consumer delete (~250k)
2. retry-policy + phase-runner adoption + crash recovery unification (~250k)
3. dispatch-tracker primitive + Outcomes.terminated + preemption + drain + cost-limit (~350k, the centerpiece)
4. Hard-cap enforcement + engineer retry + failed→queued + docs (~200k)
5. Closing standards sweep (variable, mirrors Slice 5 Session 22 pattern)

**Gate status going into implementation (unchanged from Slice 5 close):** typecheck clean;
lint clean (8 pre-existing complexity warnings noted, predate Slice 5); unit **2482 passed**;
integration **40 passed**; e2e **16 passed**.

**Cross-slice handoffs landing in Slice 6's lap:** none currently parked specifically for
Slice 6. Inherited from Slice 5 (still parked for their target slices): #9 reply-token +
#10 unblock check → Slice 12; trivial-skip → Slice 8; review polling → Slice 10.

**New cross-slice handoffs Slice 6 emits:**
- → Slice 8: decomposition-handler.ts deletion + planning prompt instruction removal +
  decomposition schemas deletion + integration phase re-evaluation + signal honoring through
  phase-runner → llm-caller → LLM plugins.
- → Slice 12: notification-kind enumeration audit when they own routing.
- → Slice 15: dashboard UI cleanup for the simplified state machine (visual treatment).

## Completed Slices

- **Slice 1 — Standards Alignment:** `docs/coding-standards.md` written — 10 categories decided via deep Q&A.
- **Slice 2 — Repo Readiness:** Biome aligned, lint split, CI parallelized, tests restructured (`tests/unit/` mirrors `src/`), migrations consolidated, hardcoded paths fixed.
- **Slice 3 — Dashboard:** 5-page React SPA rewrite (Overview, Tasks, Activity, Metrics, Errors), all features working, coding standards audited. Sessions 4–8 — detail in `slices/03-dashboard.md`.
- **Slice 4 — Startup & Configuration:** Getting-started path (`pnpm run setup` → `engineer start`), OS detection gate, seed-example sanitization + dogfooding, removals (checkCliArtifacts, config-version machinery, Output.table, quiet mode), CLI restructure (Screaming Architecture), original coding standards audit (1–11), new coding standards added (§4 expanded, §5 expanded, §7 framing, §12–§15), six post-bootstrap infrastructure gaps closed (retryable flag, cause chains, trace_id correlation, floating promises, span/log correlation, graceful degradation logs), and new standards applied across slice 4 in-scope files. "Apply with judgment, never mechanically" principle codified. Sessions 9–16 — detail in `slices/04-startup.md`.
- **Slice 5 — Trigger & Requirements (Contacts) Flow:** PluginContext + per-plugin StateStore (the SDK foundation), durable dedup moved to Core on `idempotency_key`, dead `trigger.pr_review` scaffolding removed (issues-only trigger), per-plugin poll cadence + configurable label/assignee work selection + Core-owned backoff, single-user constraint (`docs/constraints.md`, owner assumed-not-required, doctor "People Directory" category). Closing standards sweep (Session 22) closed it: deleted unwired config hot-reload infra, re-synced bundled plugin docs with source, removed dead `max_tokens`, fixed the chronic orchestrator test flake, line-by-line audit of all in-scope files. Sessions 17–22 — detail in `slices/05-trigger.md`.
- **E2E test fix (carried over from Slice 5, Session 23):** the five `task-happy-path` + `crash-recovery` e2e failures were structural — tests used `clone_url: ""` (silently skipping workspace creation → `WorkspaceNotReadyError` → no LLM call), and asserted impossible LLM counts since the FakeLLM doesn't simulate the CLI's `session-result.json` write. Rewrote as one full-pipeline smoke test (bare git repo + FakeLLM side-effect hook) plus honest dispatch/routing/recovery tests. 16/16 e2e passing. Commit `f54ad8c`.
