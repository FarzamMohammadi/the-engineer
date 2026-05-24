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

**Slice 6 — Scheduling & Dispatch — implementation Session 3 complete (global Session 27).**
The centerpiece landed in a single coherent commit (`c5ba7ec`). New
`src/core/dispatch-tracker/` module owns in-flight dispatch lifecycle: per-dispatch
ULID identity for idempotent late callbacks, one `AbortController` per dispatch
(signal lives on the `Dispatch` contract; honoring lands in Slice 8), single
`terminate(taskId, reason)` path, shared-timeout drain that synthesizes the late
callback for stragglers so the daemon shuts down cleanly even without Slice 8's
signal honoring. New `Outcomes.terminated` discriminated variant with typed reason
collapses `Outcomes.preempted` and routes preemption/hard-cap/cost-limit/shutdown
through one switch. Scheduler, preemption-manager, cost-limit-queue, and
`drainForShutdown` all adopt the primitive in lockstep — `removeActiveDispatch`,
`abandonPending`, and the dead `preemption.ready` event deleted (zero production
callers). `priority` bounded `[1, 100]` in `TaskSchema` to match the DB CHECK.

Design notes from this session:
- `isTaskEligible` extracted as a pure top-level function in `task-scheduler.ts`
  (signature `(task: {id, not_before}, now: number)`). Scheduler and
  preemption-manager both consume it; preemption-manager now filters ineligible
  candidates before picking so it can't waste an eviction.
- `Dispatch` split: `DispatchSchema` keeps the serializable shape (still
  Zod-parsed by tests); the runtime `Dispatch` type extends it with
  `signal: AbortSignal`. `AbortSignal` is runtime infrastructure, not parsed
  input — Parse-Don't-Validate honored.
- `dispatch-tracker.drain` synthesizes the late callback for stragglers after the
  shared timeout — v1 best-effort: until Slice 8 plumbs the signal, in-flight
  LLM calls won't honor abort, but the daemon must shut down anyway.

Verification gate after Session 3: typecheck clean; lint clean (8 pre-existing
complexity warnings + 3 new ones flagged by the pre-commit hook on the new module —
drain at complexity 20 and an `Array<T>` syntax in the test; all fair candidates
for the Session 5 closing sweep). Unit **2436 passed**; integration **39 passed**;
e2e **16 passed**. Grep contract holds: `Outcomes.preempted`, `removeActiveDispatch`,
`abandonPending`, `preemption.ready` all return zero matches in `src/`.

Tangents parked for the Session 5 closing sweep:
- `docs/architecture/overview.md`'s state-machine table still lists `supervising` /
  `integrating` as active sub-states (stale post-Session 1 decomposition delete).
- `dispatch-tracker.drain` cognitive complexity 20 > 15 (lint warning, not error).
- `Array<T>` syntax in the dispatch-tracker test should be `T[]`.

Gap noted (still): Slice 6 Session 1 (commit `6024492`) was committed without a
`sessions/25.md` log file. Optional backfill from commit message if desired.

Next: **Session 4 — hard-cap enforcement + `engineer retry` per-category reset +
`failed → queued` transition + final docs** (~200k budget, smallest session). Strict
task ordering from the plan: T4.1 (`failed → queued` ValidTransitions edge) → T4.2
(`engineer retry` per-category reset + failed-state support) → T4.3 (hard-cap
subscriber wired to `health.stuck_detected` → `dispatchTracker.terminate("hard_cap_exceeded")`)
→ T4.4 (eligibility doc paragraph) → T4.5 (final doc sweep) → T4.6 (hard-cap alert
wording) → T4.7 (commit). Start by reading `.claude/temp/create-plan/slice-06-scheduling.md`
§ Session 4.

**Slice shape locked (13 decisions):**

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
1. ✅ Decomposition consumer delete (~250k) — commit `6024492`
2. ✅ retry-policy + phase-runner adoption + crash recovery unification (~250k) — commit `ba0fae4`
3. ✅ dispatch-tracker primitive + Outcomes.terminated + preemption + drain + cost-limit (~350k, the centerpiece) — commit `c5ba7ec`
4. Hard-cap enforcement + engineer retry + failed→queued + docs (~200k)
5. Closing standards sweep (variable, mirrors Slice 5 Session 22 pattern)

**Gate status after Session 3:** typecheck clean; lint clean of errors (8 pre-existing
complexity warnings predate Slice 5; 3 new warnings on the dispatch-tracker module to
clean up in Session 5); unit **2436 passed**; integration **39 passed**; e2e **16 passed**.

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
