# Requirements: Slice 11 — Background Services (Hardening)

> Gathered through co-owner Q&A (Session 65), grounded in a direct read of the real source for all
> four code areas before a single question. This is a **HARDENING slice and the last of its kind** —
> refine-over-build at its strongest. Owner's governing steer: *"most of this looks good as is —
> refine and strengthen what we have more than change or add features. Focus on strengthening and
> fine-tuning."* That steer governs every requirement below.

## Context

Slice 11 covers The Engineer's three "background services" — **cost tracking**, **data lifecycle**,
and **health monitoring** — all of which already exist and work. After this slice the remaining work
(Agent Readiness, Dashboard polish, npm publish) is inherently new/polish, so this is the **final
pass to lock the existing architecture down tight**: deep, robust, well-architected code a senior
reviewer admires, OSS-showcase quality.

"Background Services" is a *category name*, not a module — the four code areas run on four independent
timing mechanisms and live in three different layers (safety-layer, daemon, registry).

## True Intent

Make what already works **unbreakable, fully observable, and standards-clean** — without changing
behavior, except where the current behavior contradicts its own documented contract. The value is
demonstrating senior-grade refinement: failure isolation, fail-loud, maximal observability through
the dashboard-observer's eyes, single-source-of-truth, dead-surface removal, and tight boundaries.
Net-new features are guilty until proven necessary for correctness.

## Scope

### The four code areas (all in scope, "full pipeline, siblings verify-only")

| Pillar | Core module | Enforcement / consumption path (in scope) | Sibling (verify-only) |
|---|---|---|---|
| Cost tracking | `safety-layer/cost-tracker.ts` | `orchestrator/agent-cost.ts` (emit), `safety-layer/index.ts` Gate-2 deny, `daemon/cost-limit-queue.ts` (terminate in-flight at 100%) | — |
| Data lifecycle | `core/data-lifecycle/index.ts` | daemon start/stop wiring | `workspace-reaper` (Slice 9) |
| Plugin health | `registry/plugin-health.ts` | `registry/index.ts` health-check loop; Core's degradation behavior on `failed` | — |
| Task health | `daemon/health-monitor.ts` | daemon main-tick wiring; stuck detection | blocked-escalation + review-reminders (Slices 6/10) |

### In Scope

- **Strengthening (the bulk, no behavior change):**
  - **Resilience / failure isolation** — a thrown error in any periodic background service (sweep,
    health check, cost handling) must never take down the daemon or skip sibling work; per-unit
    isolation where a batch processes many items (e.g. per-table in the data-lifecycle sweep, already
    per-plugin in health).
  - **Fail-loud** — every swallowed/`debug`-level degradation that hides a real failure (e.g. the
    cost snapshot-save failure logged at `debug`, bare `catch {}` blocks in blob cleanup) names what
    failed and what was reduced, at an appropriate level.
  - **Observability depth** — milestones + transitions emitted richly as drill-down observations/
    decisions (cost breach + 80%-crossing, plugin-health transitions, non-empty prune results);
    **liveness** surfaced per service via a "last run / current state / next run" record (not a
    per-tick heartbeat); the data path completed (emit → persist → API) **and rendered into the
    existing dashboard pages** (metrics/system/overview/activity) — no net-new pages.
  - **Standards enforcement** — every applicable section of `coding-standards.md`, `anti-patterns.md`,
    and `philosophy.md` applied to the change set (sections enumerated at research/plan time).
  - **Single source of truth** — collapse any duplicated constants/logic across the four areas.
  - **Dead surface** — delete methods with zero callers, unconsumed fields, vestigial scaffolding.
  - **Module boundaries** — fix any leaky cross-imports or misplaced concerns surfaced by research.
- **Two correctness fixes (the ONLY behavior changes — both fix a documented-contract violation):**
  1. **Daily-window reset for provider requests + token totals.** `daily_requests` (config: "Max CLI
     requests per day") and `CostStatus.daily_tokens` are monotonic all-time counters today;
     `rolloverWindows` only resets `cost_usd`. Fix: extend the existing daily UTC rollover to also
     reset provider request counts and token totals, so the names match behavior. (Fixes a provider
     blocked forever once its "daily" cap is hit, and a mislabeled dashboard number.)
  2. **Protect active tasks' events/observations from pruning.** Today `journal_entries`/`checkpoints`
     exclude active tasks but `events`/`observations` do not, so a task blocked past the retention age
     loses the start of its live trail. Fix: extend `excludeActiveTasks` to `events` + `observations`.

### Out of Scope (deliberate)

- **No unification** of the four timing mechanisms into one "background service" abstraction — *unless*
  research proves the timer/lifecycle boilerplate is genuinely copy-pasted and error-prone, in which
  case a thin shared helper is surfaced to the owner with evidence before any build.
- **No plugin-health gating.** Plugin health stays **advisory/observability-only** (it informs the
  owner; it does not gate plugin selection/usage). The slice makes this *explicit and documented* as a
  deliberate design decision; it does not add degradation behavior.
- **No net-new dashboard pages** or redesign; surface into existing pages only. Dedicated views and
  the docs-site/demo/license polish belong to Slice 13.
- **No new features** of any kind beyond the two contract-fixes above.
- **Sibling paths are verify-only:** the workspace-reaper (Slice 9) and the blocked-escalation +
  review-reminder logic (Slices 6/10) get a verification pass (confirm they're clean and standards-
  compliant), not rework.

## Requirements

### Functional

1. **Daily windows are genuinely daily.** Provider `requests_used` and token totals reset at the UTC
   day boundary via the existing rollover mechanism; a provider that hit its `daily_requests` cap
   yesterday is usable again today; `daily_tokens` reflects the current day. Snapshot/replay restore
   the windowed values correctly across a restart.
2. **Active tasks never lose their trail.** A pruning sweep deletes no `events` or `observations` rows
   belonging to a task in an active state (`requirements_gathering`, `queued`, `active`, `blocked`),
   consistent with the existing journal/checkpoint protection. System events (`task_id = null`) still
   prune by age.
3. **No background service can crash the daemon.** Any thrown error in a periodic sweep / health check
   / cost handler is caught, logged loudly with context, and isolated so sibling units still run and
   the daemon keeps ticking.
4. **Every meaningful background event is observable and drill-downable.** Cost limit breaches and
   80%-crossings, plugin health transitions (healthy/unhealthy/failed/recovered), and non-empty prune
   sweeps each leave a structured, inspectable trail; each service exposes a liveness record (last run
   / current state / next run) reachable by the dashboard.
5. **The dashboard-observer can see all of the above** rendered in the existing dashboard pages — not
   only via API or CLI.
6. **Plugin health is documented as advisory** — its purpose (signal to the owner, not a usage gate)
   is stated where a contributor would look, so the absence of gating reads as deliberate.

### Non-Functional

- **No behavior change** outside the two contract-fixes. Verify-only siblings stay byte-stable except
  for standards/observability touches that don't alter behavior.
- **Plugin Opacity preserved** — no hardcoded plugin names/tokens/platform checks introduced; Core
  still compiles and runs with every plugin deleted. (Plugin-health and cost both touch the adapter
  boundary — the lens applies directly.)
- **Single-user lens** — every owner-facing signal (cost alert, health failure, escalation) resolves
  to the one owner; a missing owner degrades gracefully (warn, never strand).
- **Tests, docs, logging are part of the same unit of work** — not follow-ups.
- **Each build session < ~500k tokens**, green on every gate, with a durable handoff note.

## Edge Cases & Error Handling

- **Cost — crash + replay correctness.** After a snapshot loss (corruption → full replay from
  sequence 0), accumulators must still be correct. *Research item:* confirm the events-retention floor
  exceeds the longest accumulator window (monthly) so a full replay can't undercount; decide whether a
  config-validation guard or documented invariant is warranted.
- **Cost — full-replay re-adds terminal tasks' per-task entries** (replay doesn't see `task.state_changed`).
  Minor memory bloat, not a limit-correctness issue. *Research item:* confirm and decide if worth a guard.
- **Data-lifecycle — one table's failure** must not abort the whole sweep (per-table isolation).
- **Data-lifecycle — blob cleanup** path-confinement stays; bare `catch {}` blocks get a log.
- **Data-lifecycle — vacuum failure** already non-fatal (warn) — verify it stays loud.
- **Plugin-health — `healthCheck()` throws vs returns unhealthy** — both already handled; verify the
  timeout path and that `failed` is reached only via the consecutive-failures threshold.
- **Health — no-op ticks** do NOT each emit an observation (liveness via last-run, per the obs ceiling).

## Open Questions (for /research — facts, not owner intent)

- Which `coding-standards.md` sections actively apply to the change set? (Enumerate by name.)
- What is emitted-but-unsurfaced on the dashboard today for each service? (Drives the "wire to the
  observer's eyes" work; bounds the UI touch.)
- Is the events-retention-floor vs monthly-window coupling a real risk under default + minimal config?
- Does the timer/lifecycle boilerplate across the four areas rise to "genuinely duplicated"? (Decides
  the unification question with evidence.)
- Exact liveness surface each service already exposes (`getLastRun`, `last_check_at`, `getCostStatus`)
  and what the dashboard would need to render it.

## Affected Systems

- `src/core/safety-layer/` — cost-tracker (daily reset), index facade, Gate-2 (verify).
- `src/core/orchestrator/agent-cost.ts` — cost emission (verify).
- `src/core/daemon/cost-limit-queue.ts` — terminate path (verify/observe).
- `src/core/data-lifecycle/index.ts` — active-task protection, per-table isolation, fail-loud, observe.
- `src/core/daemon/index.ts` — data-lifecycle + health wiring (verify/observe).
- `src/core/registry/plugin-health.ts` + `registry/index.ts` — observability, advisory documentation.
- `src/core/daemon/health-monitor.ts` — stuck detection (harden), escalation/reminders (verify-only).
- `src/schemas/config.ts`, `src/schemas/events.ts` — any schema touches for the two fixes + observability.
- `src/dashboard/api/*` + `src/dashboard/client/src/pages/*` — surface signals into existing pages.
- `docs/configuration/safety.md`, `docs/configuration/daemon.md`, `docs/architecture/observability.md`,
  relevant `docs/plugins/` and `docs/user-flows/` — synced in the same unit of work.

## Acceptance Criteria

- [ ] Provider `daily_requests` and `daily_tokens` reset at the UTC day boundary; tested across a
      window rollover and a snapshot/replay restart.
- [ ] No `events`/`observations` rows for active-state tasks are deleted by a sweep; tested.
- [ ] A forced throw inside each periodic service is caught, logged with context, isolated; the daemon
      keeps ticking and siblings still run; tested.
- [ ] Cost breach/80%-crossing, plugin-health transitions, and non-empty prune sweeps each produce an
      inspectable observation/decision; each service exposes a liveness record; verified end-to-end.
- [ ] The new signals render in the existing dashboard pages (data path emit → persist → API → render);
      verified against a seeded DB.
- [ ] Every swallowed/`debug`-level degradation that hides a real failure is now loud; no bare
      `catch {}` without a log in the change set.
- [ ] Plugin health's advisory-only nature is documented as deliberate.
- [ ] Enumerated `coding-standards.md` sections checked at plan time, applied in implementation,
      re-verified in the closing sweep; `anti-patterns.md` and `philosophy.md` clean.
- [ ] All gates green (lint, typecheck, unit, integration, e2e); docs synced; closing standards sweep
      run as its own session before the slice is marked done.

## Locked Decisions (from Session 65 Q&A)

1. **Health scope:** both plugin-health AND task-health, in full (task-health's Slice-6/10 paths verify-only).
2. **Pillar reach:** full enforcement/consumption pipeline per pillar; siblings verify-don't-rebuild.
3. **Unification:** independent; unify only if research proves genuine harmful duplication.
4. **Daily-window defect:** make provider requests + token totals genuinely daily (correctness fix).
5. **Plugin-health gating:** advisory/observability-only, made explicit + documented; no gating.
6. **Active-task pruning:** protect active tasks uniformly (events + observations too).
7. **Observability ceiling:** milestones + transitions rich; liveness via last-run; no no-op heartbeats.
8. **Dashboard reach:** complete data path + surface in existing pages; no net-new pages.
