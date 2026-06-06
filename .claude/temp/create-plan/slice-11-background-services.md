# Plan: Slice 11 — Background Services (Hardening)

**Date**: 2026-06-05 | **Stakes**: Full
**Upstream**: `.claude/temp/research/slice-11-background-services.md` | `.claude/temp/requirements-gathering/slice-11-background-services.md`
**Worktree**: `the-engineer-slice11` (branch `slice11-background-services`, off `main@b7394b6`) | **Status**: Panel-Reviewed

## Intent

Lock the three background services — cost tracking, data lifecycle, health monitoring — down to
OSS-showcase solidity: failure-isolated, fully observable through the dashboard-observer's eyes,
standards-clean, single-sourced, dead-surface removed. Last hardening slice → **strengthen/refine/
remove, not add**; the only behavior changes are fixes where code contradicts its own documented
contract. Plan-Reviewed by a 4-lens adversarial panel (see Panel Review); six must-fixes folded in.

## Decisions

### D1: Single-source the cost-breach event — delete dead `cost.quota_exhausted`, surface `cost.limit_reached` *with a payload-aware message*
**Choice**: Delete `cost.quota_exhausted` (enum, `CostQuotaExhaustedPayloadSchema`, payloads map). It has **three** readers, all to be handled in one commit:
  1. `dashboard/api/errors.ts` `ERROR_EVENT_TYPES` → repoint to `cost.limit_reached` **and** extend `errorEventMessage` with a typed branch that composes a human message from the real payload (`${limit_type} cost limit reached: $${current_spend} of $${limit_value}${limit_scope ? " ("+limit_scope+")" : ""}`). Without this the page renders the bare token `cost.limit_reached` (the payload has none of the keys `errorEventMessage` probes).
  2. `dashboard/api/metrics.ts:76` `/quota` endpoint `WHERE type = 'cost.quota_exhausted'` → builds `exhaustion_events`, rendered by `dashboard/client/src/pages/metrics/quota-status.tsx` ("Recent Exhaustion Events") via `hooks/use-metrics.ts` + `types/api.ts`. This block has **never rendered anything** (the event was never published). **Delete it as dead surface** (the `/quota` provider-quota bars from the `quota_status` observation stay). *(Decision-gate — see note below; my recommendation is delete.)*
  3. `tests/unit/dashboard/api/errors.test.ts` references → update to the live event.
**Context**: `cost.quota_exhausted` is declared + payload-schema'd + read by two live dashboard surfaces but **published by no one**; `cost.limit_reached` (the live event) is surfaced nowhere. The `/quota` block conflates two concepts (USD/request breach vs provider-quota-window) and its client reads a `reason` field `CostLimitReachedPayload` lacks.
**Decision-gate (for owner GO)**: the `/quota` "exhaustion events" block — **delete as dead surface** (my rec: it has shown nothing since inception; cost breaches belong on the errors page) vs repoint it to provider breaches (`limit_scope != null`) + rewrite `quota-status.tsx` to read real fields.
**Rejected**: emit `cost.quota_exhausted` for provider breaches — net-new event surface against the steer.
**Consequence**: one cost-breach event, rendered legibly where the observer looks. §11 (SSOT), §14.

### D2: Delete the dead `daily_tokens` / `token_totals` surface
**Choice**: Remove `token_totals` from the cost-tracker accumulators/snapshot and `daily_tokens` from `CostStatus`.
**Context**: Panel-verified dead: the only `getCostStatus` consumer (`safety-layer/index.ts:225` `evaluateCostStatus`) builds its verdict from `warnings` + `isAnyLimitBreached` and never reads `daily_tokens`; the dashboard's token totals come from `aggregateAgentCost` over `agent_call` spans (`metrics.ts:43`), independent of the accumulator.
**Consequence**: Less surface, simpler snapshot. `restoreFromSnapshot` already tolerates missing fields → old snapshots restore cleanly (pre-v1 DB-wipe is the migration anyway).

### D3: Provider `daily_requests` resets daily — *windowed*, not reset-only
**Choice**: Give `ProviderUsageRecord` a `window_start` (SpendWindow-shaped). Mirror `daily.cost_usd` **exactly in all three places**: (a) reset in `rolloverWindows` at the UTC boundary; (b) in `restoreFromSnapshot`, adopt a provider's snapshot count only if `window_start === currentDailyStart`, else start at 0; (c) in `replaySpendEvent`, increment only when `getDailyWindowStart(eventTime) === today`.
**Context**: The knob is documented "Max CLI requests per day" but the counter is monotonic all-time → a provider that hits the cap is blocked **forever**. **Panel must-fix**: reset-only is insufficient — `ProviderUsageRecord` has no `window_start`, and `restoreFromSnapshot`/`replaySpendEvent` fold yesterday's counts unconditionally, so a boot just past midnight (or a snapshot-loss full replay) re-introduces the "blocked forever" bug *intermittently* (worse than the deterministic current one).
**Consequence**: A provider that hit its cap yesterday is usable today, deterministically across restarts. **The reset takes effect on the rollover triggered by the first cost event of the new day** (not at 00:00:01 on a pure read — read-time rollover declined as scope creep; conservative-safe; documented).

### D4: Daily/monthly breaches terminate the in-flight dispatches + fire ONE global alert
**Choice**: On a daily/monthly `cost.limit_reached` (`task_id=null`), enqueue `scheduler.getActiveTaskIds()` — **the in-flight dispatch set** (`→ dispatchTracker.getActiveTaskIds`), with `cost-limit-queue`'s existing `task.state===active` guard as the second gate — to the queue, which terminates each via the idempotent `dispatchTracker.terminate`. Notification shape (panel must-fix):
  - Fire **exactly one** owner alert per daily/monthly breach from the breach handler, keyed on a stable `source` (`cost:daily` / `cost:monthly`) so it passes the alert dedup and **names the global limit + the count of tasks terminated** — not N per-task DMs.
  - Per-task surfaces become the per-ticket `ticket_comment` (already un-deduped by design), **not** N owner DMs.
  - **De-dupe the batch** before processing: `const batch = [...new Set(pending.splice(0))]` — a same-tick per-task + daily breach enqueues the same task twice, and `ticket_comment` is exempt from the suppress window → double comment without this.
**Context**: README promises termination + immediate notification on *any* limit; today daily/monthly do neither. Owner-chosen full fix.
**Consequence**: Behavior change (correctness-to-contract). Works at `max_concurrent>1` (terminate all in-flight; one global alert). The provider breach publish is edge-triggered (D-note below) so a capped provider doesn't re-fire every event.

### D4-note: Edge-trigger the provider breach publish
`checkProviderLimitBreach` publishes `cost.limit_reached` on *every* event once `requests_used >= daily_requests`. With D4 giving provider breaches teeth, gate the publish on the **crossing** (publish only when `requests_used === daily_requests`, or a per-window already-breached flag reset in `rolloverWindows`). §14 edge-trigger discipline.

### D5: Protect active tasks' `events` + `observations` from pruning — *NULL-safe*
**Choice**: Extend active-task protection to `events`/`observations`, but with a **NULL-safe** clause: `AND (task_id IS NULL OR task_id NOT IN (SELECT id FROM tasks WHERE state IN (...)))`.
**Context**: **Panel must-fix (reproduced) — my research claim was BACKWARDS.** A bare `excludeActiveTasks: true` makes `NULL NOT IN (non-empty set)` evaluate to NULL → the WHERE is unsatisfied → every `task_id=NULL` system event (cost/health/trigger/cleanup audit trail) is **retained forever** whenever any task is active at sweep time; with no active task, `NOT IN (empty)` is TRUE and they're deleted — so pruning is **non-deterministic per tick** and, in the common case, an unbounded leak on the two highest-volume tables, defeating the slice's own goal.
**Consequence**: System events (`task_id IS NULL`) and terminal-task rows prune by age; only live-task rows are protected — deterministically. **Add the missing determinism test**: seed an old active-task event, an old terminal-task event, and an old `task_id=NULL` system event; run with the protection **both with an active task present and with none**; assert only the live-task event survives in both.

### D6: Per-stage failure isolation in the data-lifecycle sweep — *including the blob stage*
**Choice**: Wrap each `MANAGED_TABLES` cleanup in its own try/catch (model: the reaper's per-task isolation). **Also** wrap the blob stage (`collectReferencedBlobRefs` + `cleanupOrphanedBlobs`) — it runs a real `json_extract` SQL query that can throw. Best: compute stats and **publish `system.cleanup_completed` from a `finally`** (mirror the reaper) so the completion event + the new liveness card stay truthful even on a mid-sweep failure.
**Context**: Today one table's (or the blob stage's) throw aborts the whole sweep before vacuum + the completion event → a half-done sweep emits nothing and the liveness card goes stale. Preserve sweep ordering (blob cleanup after table pruning).
**Consequence**: §5 (isolated failure boundaries), §15 (graceful degradation); liveness never lies.

### D7: Plugin health stays advisory — surface current state on a real render target + lock the invariant
**Choice**: Add `GET /api/system/plugin-health` (in `system.ts`, registered in the `systemRoutes` Hono app) returning `getAllHealthRecords()` (state + `last_check_at` + `consecutive_failures` + `last_error`). Render a **new `PluginHealthCard` on the Overview page grid** (`overview-page.tsx`) with a new hook — there is **no "system page"** in the client (panel must-fix: sidebar is Overview/Tasks/Activity/Metrics/Errors). Document health as deliberately advisory; **lock the invariant** with a test that `getPrimaryPlugin`/`getPluginsByType` still return a `failed` plugin (selection ignores health), and an API-boundary comment that the records are display-only.
**Context**: Health gates nothing (owner-confirmed advisory) AND current state is surfaced nowhere — only the last-20 health *events*. Surfacing live state is "stored-is-not-surfaced," not a feature.
**Rejected**: gate plugin usage on health — owner-rejected.
**Consequence**: The observer sees each plugin's current health + liveness; selection behavior unchanged, invariant test-locked.

### D8: Plugin-recovery notification (owner-chosen) — *from `failed` only, plugin-source-keyed*
**Choice**: Subscribe `health.plugin_recovered` in the daemon → notify the owner. Refinements (panel): a new **non-alert** `NotificationKind`; notify recovery **only from the `failed` state** (full outage cleared), not transient `unhealthy`, so it's rare and meaningful; **key its dedup on the plugin source** (extend `dedupKeyFor` — a non-alert kind otherwise keys on the null `taskId`, collapsing all plugins' recoveries to one key). The `PluginHealthCard` (D7) also shows the recovery as a state flip back to healthy; the `/health` event stream keeps carrying `plugin_recovered` rows.
**Context**: Failures alert; recovery only logs at `info`. Owner chose the symmetric closure. **This is the slice's one genuine additive change** — recorded as such per the panel; owner re-confirms at GO.
**Consequence**: A small new notification path, flap-safe and correctly scoped. Test: a flapping plugin does not spam.

### D9: Retention-floor invariant + validation warn — *monthly window, startup AND reload*
**Choice**: Validate `events.max_age_days >= the monthly window (~32d)` (the longest cost-replay horizon, per `getMonthlyWindowStart`) and `warn` naming the consequence ("a snapshot-loss replay will undercount monthly spend; cost limits may under-enforce"). Wire the warn into **both startup and the config-reload path** (safety config is hot-reloadable, so a runtime lowering is exactly when the footgun lands).
**Context**: Only `cost-tracker` full-replays `events`; `events.max_age_days` is a positive int settable as low as 1.
**Consequence**: Fail-loud on a real footgun, ~10 lines, no behavior change.

### D10: Keep the periodic services independent — cross-link, don't unify (and name the re-entrancy asymmetry)
**Choice**: Do NOT extract a shared periodic-sweep helper. Add a cross-link comment on the data-lifecycle/reaper shared shape that **also names the deliberate asymmetry**: data-lifecycle has no re-entrancy guard because `runCleanup` is fully synchronous (better-sqlite3 is sync) and the event loop cannot re-enter it; the reaper needs its `running` guard only because it does async git/network I/O.
**Context**: Real shape duplication, but extraction is net-new cross-module structure (one Slice-9 verify-only). Owner-chosen pull-back. The asymmetry note pre-empts a false "data-lifecycle is missing a guard" finding in the next audit. Adding a guard was **declined** (dead defensive code).
**Consequence**: No coupling introduced; the parallel and its asymmetry are documented, not abstracted.

### D11: Observability ceiling — milestones + transitions rich (edge-triggered), liveness via last-run
**Choice**: Emit rich drill-down observations/decisions for every state-change (cost breach, **80%-crossing edge-triggered**, daily/provider rollover edge-triggered, plugin-health transition, non-empty prune). **Edge-trigger** the 80%-crossing and rollover emissions (emit once on transition into ≥80%, reset on rollover; once per rollover boundary) — a naive per-call check would emit on every event past 80% (the noise D11 forbids). Liveness via `getLastRun`/`getAllHealthRecords`/`getCostStatus` snapshots on existing pages. No per-tick heartbeats; no net-new pages.
**Consequence**: Liveness + transitions visible without burying the trail; existing observer verbs + existing pages (Overview/Metrics/Errors).

## Scope Boundary

**Delivering**: D1–D11 across cost / data-lifecycle / health, tests + docs + logging per unit, then a closing standards sweep.

**Deferring** (explicit): periodic-sweep extraction (D10); plugin-health usage gating (D7); net-new dashboard pages/redesign (Slice 13); per-person notification prefs (single-user); read-time rollover (D3, scope creep); data-lifecycle re-entrancy guard (unneeded). **Verify-only siblings**: workspace-reaper (Slice 9), blocked-escalation + review-reminders (Slices 6/10) — standards skim, not rework.

## Task Breakdown

> Build sessions run **sequentially in the `the-engineer-slice11` worktree** (shared worktree → no
> parallel mutation), each green on every gate, each a cohesive commit, each leaving a handoff note.

### Unit 1a: Cost accumulation core — *standards §5, §12, §15*
**Goal**: The accumulator carries no dead surface, resets provider requests daily (windowed, restart-safe), and emits its transitions edge-triggered.
**Where**: `src/core/safety-layer/cost-tracker.ts`, `src/core/interfaces/safety-layer.interface.ts`, `tests/unit/core/safety-layer/cost-tracker.test.ts`, `docs/configuration/safety.md`, `docs/architecture/observability.md`.
**Approach**: D2 (delete `token_totals`/`daily_tokens`). D3 (windowed provider reset — record `window_start`; reset/restore-guard/replay-filter). D4-note (edge-trigger provider breach publish). D11 (edge-triggered 80%-crossing + rollover observations). Fail-loud: snapshot-save failure → `warn` not `debug` (§5 + §12). Update the `daily_requests` doc (resets daily, effective on the first new-day event).
**Verify**: `pnpm test …/cost-tracker.test.ts` incl. (1) provider requests reset on UTC rollover, (2) restore-across-rollover drops yesterday, (3) **snapshot-loss full-replay-across-midnight proves yesterday's requests are NOT counted today**, (4) a single 80%-crossing emission across multiple events above 80%; `pnpm typecheck`.
**Depends on**: Nothing. **Commit**: `/commit` after green.

### Unit 1b: Cost enforcement + dashboard surfacing — *standards §11, §14*
**Goal**: Every breach terminates in-flight work and is legibly visible to the owner; one cost-breach event, rendered with its real numbers.
**Where**: `src/core/safety-layer/cost-tracker.ts` (breach publish/global-alert), `src/core/daemon/index.ts` (`daemon:cost`), `src/core/daemon/cost-limit-queue.ts`, `src/schemas/events.ts` (delete `cost.quota_exhausted`), `src/schemas/notifications.ts` (global cost-limit alert kind/source if needed), `src/dashboard/api/errors.ts` + `metrics.ts`, `src/dashboard/client/src/pages/metrics/quota-status.tsx` + `hooks/use-metrics.ts` + `types/api.ts`, tests (`cost-limit-queue.test.ts`, `errors.test.ts`), `README.md`.
**Approach**: D4 (enqueue in-flight set; ONE global alert keyed `cost:daily`/`cost:monthly`; per-task → ticket_comment; `[...new Set(...)]` batch dedup). D1 (delete dead event; errors page payload-aware message; `/quota` exhaustion block per the GO decision — default delete-dead-block). Sync README to the actual enforcement.
**Verify**: `pnpm test` — cost-limit-queue terminate-all-active at `max_concurrent>1` with **N terminates but ONE global owner DM**; errors.test asserting a seeded `cost.limit_reached` renders the spend/limit numbers (not the bare type). Manual: seed a `cost.limit_reached`, confirm it renders on errors; `/quota` no longer queries a deleted type; `pnpm lint`.
**Depends on**: Unit 1a. **Commit**: `/commit` after green.

### Unit 2: Data lifecycle hardening — *standards §5, §15*
**Goal**: The sweep never loses a live task's trail, never lies about liveness, survives any single stage's failure, and is visible on the dashboard.
**Where**: `src/core/data-lifecycle/index.ts`, `src/core/daemon/index.ts` + `bootstrap.ts`, `src/schemas/config.ts` (retention-floor validation) + the config-reload path, `src/dashboard/api/*` + a new cleanup card on Overview (mirror `overview/cleanup-card.tsx`), `tests/unit/core/data-lifecycle/index.test.ts`, `docs/configuration/daemon.md`.
**Approach**: D5 (NULL-safe active-task protection + determinism test, both-with-and-without-active-task). D6 (per-table + blob-stage isolation; emit completion from `finally`). D9 (monthly-window invariant + warn on startup AND reload). D11 (richer sweep emission + liveness via `getLastRun`; Overview cleanup card reading `system.cleanup_completed`). D10 (cross-link + asymmetry comment).
**Verify**: `pnpm test …/data-lifecycle/index.test.ts` incl. the D5 determinism test + "one table/blob-stage throwing does not abort the sweep (completion event still fires)"; manual: dashboard shows a data-lifecycle cleanup card; `pnpm typecheck`.
**Depends on**: Nothing (sequenced after 1b). **Commit**: `/commit` after green.

### Unit 3: Health monitoring hardening — *standards §2, §4, §14*
**Goal**: The owner sees each plugin's current health + recovery; health is documented advisory and the invariant is test-locked; stuck-detection is solid.
**Where**: `src/core/registry/plugin-health.ts` + `registry/index.ts`, `src/core/daemon/index.ts` (recovered subscription), `src/schemas/notifications.ts` (recovery kind + dedup scope in `dedupKeyFor`), `src/dashboard/api/system.ts` (+ route registration) + a new `PluginHealthCard` + hook on Overview, `src/core/daemon/health-monitor.ts` (stuck-detection), tests (`plugin-health.test.ts`, `health-monitor.test.ts`), `docs/architecture/observability.md` + plugins advisory note.
**Approach**: D7 (`/api/system/plugin-health` + `PluginHealthCard`; advisory doc; invariant test that `getPrimaryPlugin` returns a `failed` plugin). D8 (recovery notify from `failed` only, plugin-source dedup, flap-no-spam test). D11 (transition observability). Harden stuck-detection; standards-skim the Slice-6/10 escalation/reminder paths (verify-only).
**Verify**: `pnpm test …/plugin-health.test.ts` + `health-monitor.test.ts` incl. recovery-from-failed notify + flap-no-spam + advisory-invariant tests; manual: Overview shows current plugin states + a recovery flip; `pnpm lint`.
**Depends on**: Nothing (sequenced after Unit 2). **Commit**: `/commit` after green.

### Unit 4: Closing standards sweep — *its own session, per approach.md*
**Goal**: Every touched file passes a line-by-line audit vs `coding-standards.md` / `anti-patterns.md` / `philosophy.md`, with the principle-driven hunts (dead surface, dual sources, doc/bundled-mirror drift, stale counts, swallowed errors, manifest/capability match).
**Where**: All files touched by Units 1–3 + their docs + bundled mirrors (`src/cli/bundled/*`).
**Approach**: approach.md closing-sweep discipline; re-run every gate; grep every documented reference against code; update `feedback_slice_closing_standards_sweep.md` if a new defect class surfaces.
**Verify**: `pnpm lint && pnpm typecheck && pnpm test:all` green; no dead surface / swallowed errors; docs synced. **Depends on**: Units 1–3.

## Verification Contract

| Check | Type | Command or Observation |
|-------|------|----------------------|
| Types compile | Auto | `pnpm run typecheck` (EXIT 0) |
| Lint clean | Auto | `pnpm run lint` |
| Unit tests | Auto | `pnpm test` |
| Integration + E2E | Auto | `pnpm test:all` |
| Provider reset (restart-safe) | Test | reset-on-rollover; restore-across-rollover; **snapshot-loss replay-across-midnight excludes yesterday** |
| Daily breach: terminate + ONE alert | Test | `max_concurrent>1`: N terminate, exactly ONE global owner DM; batch dedup (no double ticket comment) |
| Cost breach legible | Test/Manual | errors page renders spend/limit numbers, not the bare type; `/quota` no longer queries a deleted type |
| Active trail protected (deterministic) | Test | D5 test passes with AND without an active task; only the live-task event survives |
| Sweep isolation + truthful liveness | Test | one table/blob-stage throw → sweep continues, completion event still fires |
| Plugin state + recovery visible | Test/Manual | Overview shows current states; recovery-from-failed notifies once; flapping plugin does not spam; `getPrimaryPlugin` still returns a `failed` plugin |

## Risks

| Risk | If It Happens | Mitigation |
|------|--------------|------------|
| D5 NULL clause regressed to bare `NOT IN` | System-event audit trail leaks unbounded | Ship the NULL-safe clause + the both-ways determinism test; never merge the bare flag |
| D4 fans out N DMs / double-comments | Owner spammed, confused on a global cap | One global alert keyed `cost:daily`/`cost:monthly`; batch `new Set`; `max_concurrent>1` test asserts one DM |
| D3 provider window not restart-safe | "Blocked forever" returns intermittently on a post-midnight boot | `window_start` + window-guarded restore/replay; the across-midnight replay test |
| D1 strands a reader of the deleted event | A panel queries a deleted type | All three readers handled in one commit; grep before delete; `/quota` decided at GO |
| D6 blob-stage throw aborts sweep | Half-done sweep emits nothing; liveness lies | Isolate the blob stage; publish completion from `finally` |

## Pre-Mortem (from the panel)

1. **(high)** Weeks post-ship the `events`/`observations` tables balloon and slow the daemon — D5's bare `excludeActiveTasks` silently retained every `task_id=NULL` system event whenever a task was active (and pruned them when none were, so it looked intermittent and passed manual testing). → **NULL-safe clause + both-ways determinism test (must-fix #1).**
2. **(high)** A daily cap trips at `max_concurrent=4`; the owner gets four near-identical "Task X blocked" DMs naming four tasks, none saying the daily budget is exhausted, and one task gets two duplicate ticket comments. → **One global alert keyed `cost:daily`/`cost:monthly` + batch `new Set` (must-fix #5, #6).**
3. **(med)** After a crash + restart at 00:05 UTC, a provider that served a handful of requests today is reported over its cap and its tasks terminated — D3 reset memory but restore/replay folded yesterday's counts (no `window_start`). → **`window_start` + window-guarded restore/replay + across-midnight test (must-fix #4).**

## Panel Review

**Panelists**: Correctness & Simplicity (Linus-grade), Distributed-systems resilience, Observability/dashboard-observer, Refine-over-build discipline. Each read the actual source for its lens; chair synthesis + pre-mortem.
**Incorporated (must-fix)**: D5 NULL-safe clause (research claim was reproduced-backwards); D1 third `/quota` reader + payload-aware errors message; D3 provider `window_start` across restore/replay; D4 one global alert (not N DMs) + batch dedup. **Incorporated (should-fix)**: D6 blob-stage isolation + finally-emit; D7 real render target (Overview `PluginHealthCard` + `/api/system/plugin-health`, no "system page"); D4-note edge-trigger provider breach; D9 monthly-window + hot-reload; D8 recovery-from-failed-only + plugin-source dedup; D11 edge-trigger; per-unit standards citations; D7 advisory-invariant lock; D10 re-entrancy-asymmetry note.
**Declined** (panel-concurred): revert/defer D8 — owner-chosen, panel recommends keeping (record as the one additive change, nail dedup); read-time rollover (D3) — scope creep, conservative-safe, document the boundary; data-lifecycle re-entrancy guard — unneeded (sync sweep can't re-enter), document the asymmetry instead.

## References
- Requirements: `.claude/temp/requirements-gathering/slice-11-background-services.md`
- Research: `.claude/temp/research/slice-11-background-services.md`
- Panel output: workflow `wf_e26809bc-20e` (4 critiques + synthesis)
