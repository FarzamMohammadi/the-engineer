# Research: Slice 11 — Background Services (Hardening)

**Date**: 2026-06-05 | **Repo**: the-engineer | **Branch**: main | **Commit**: b7394b6

> Done inline (no sub-agents), facts-before-opinions, against the real source. Governing steer
> (owner, Session 65): *"strengthen and make solid, pull back from new features/additions."* Every
> implication below is judged "does this make the existing code more solid?" — not "what could we add?"

---

## What I Found (observations)

### Cost pipeline — `safety-layer/cost-tracker.ts`, `orchestrator/agent-cost.ts`, `daemon/cost-limit-queue.ts`, `safety-layer/index.ts`

- **Emission is single-sourced.** `emitAgentCost` (`agent-cost.ts`) is the only publisher of `cost.incurred`; both the pipeline's `agentStep` and the orchestrator's self-unblock emit through it, and it also folds tokens/cost/duration into the task row via `taskEngine.updateTracking`. The header comment states this SSOT intent explicitly.
- **Accumulation is event-sourced with snapshot+replay crash recovery.** `cost-tracker` subscribes to `cost.incurred`, keeps in-memory accumulators (`per_task` Map, `daily`/`monthly` SpendWindow, `providers` Map, `token_totals`), debounce-snapshots to `_meta` every 5s, and on boot restores the snapshot then replays events since `last_sequence` (paginated, 1000/page). Snapshot corruption → `lastSequence=0` → full replay from sequence 0.
- **Daily/monthly windows reset; provider requests and tokens do NOT.** `rolloverWindows` resets only `daily.cost_usd` and `monthly.cost_usd` at the UTC boundary. `providers[id].requests_used` and `token_totals` are monotonic all-time — never reset.
- **`CostStatus.daily_tokens` and `token_totals` have no reader.** `getCostStatus()` computes `daily_tokens` from `token_totals`, but the only `getCostStatus` consumer path is `formatCostResponse` (cost query) → `consultJudgment({type:"cost_check"})` → `evaluateCostStatus`, which returns a `SafetyVerdict` built from `warnings` + `isAnyLimitBreached` and **drops `daily_tokens`**. No dashboard view reads it (the dashboard derives tokens/cost from `cost.incurred` events + `agent_call` spans). Grep for `.daily_tokens` outside `cost-tracker.ts`/interface: zero hits.
- **Breach enforcement is split by `task_id`.** `checkSpendLimitBreach` publishes `cost.limit_reached` with `task_id=taskId` for `per_task`, `task_id=null` for `daily`/`monthly`. `checkProviderLimitBreach` publishes with `task_id=taskId`. The daemon's `daemon:cost` subscription (`daemon/index.ts:295`) calls `costLimitQueue.add(payload.task_id)` **only when `task_id` is truthy**. `costLimitQueue.process()` (tick) terminates the dispatch via `dispatchTracker.terminate(taskId,"cost_limit_reached")`, records a `cost_limit_terminate` decision, and notifies (`cost_limit` + `ticket_comment`). → **per-task and provider breaches terminate + notify; daily/monthly breaches do neither — Gate-2 (`evaluateAction`→`checkCostLimits`) silently denies the next action only.**
- **Gate-2** (`safety-layer/index.ts` `evaluateAction`) is called from `action-pipeline/index.ts:58`; `consultJudgment` from `runner.ts:409` (autonomy) and `query-handler.ts:226` (cost query). It records a `safety_verdict` decision.
- **`cost.quota_exhausted` is a dead event.** Declared in `EventTypeSchema` (events.ts:37), has `CostQuotaExhaustedPayloadSchema` (shaped for provider quota: `provider_id`/`window_type`/`resets_at`), in the payloads map — but **published by no one** (definitive grep: zero publishers, no EVENTS topology declaration). The provider-quota concept it was designed for is emitted as `cost.limit_reached` instead.

### Data lifecycle — `core/data-lifecycle/index.ts`, daemon/bootstrap wiring

- **Periodic local DB+blob sweep.** `createDataLifecycleManager` owns a `setInterval` (`config.interval_ms`, default 1h), started/stopped by the daemon; built in `bootstrap.ts:205` with `blobsDir: tracesDir`, injected `clock`.
- **Four managed tables, two protection policies.** `events`/`observations` prune by age with `excludeActiveTasks:false`; `journal_entries`/`checkpoints` with `excludeActiveTasks:true` (the active-task `NOT IN` clause). So **an active task's events/observations are prunable; its journal/checkpoints are not.**
- **No per-table isolation.** `runCleanup` loops `MANAGED_TABLES` calling `cleanupTable` directly — one table's throw propagates and aborts the whole sweep. Blob orphan cleanup has path-confinement (`isConfinedPath`) and several bare `catch {}` (file disappeared / perm denied). Vacuum failure is caught + `warn` (non-fatal). The `setInterval` callback wraps `runCleanup` in try/catch + `observer.error` (daemon survives a sweep throw).
- **Emits `system.cleanup_completed`** (per-table deleted/remaining, blobs, vacuum, duration) + `observer.info`. Exposes `getLastRun()`.

### Plugin health — `registry/plugin-health.ts`, `registry/index.ts`, `registry/lifecycle.ts`

- **Per-plugin healthCheck on a registry-owned `setInterval`** (`startHealthCheckLoop`, `health_check_interval_ms` 1m). `healthCheckAll` uses `Promise.allSettled` (per-plugin isolation); `withTimeout` (5s) guards a hung check; a throw becomes `{healthy:false}`. State machine: healthy→unhealthy (1st fail) →failed (consecutive ≥ threshold, default 3); recovery resets. Emits `health.plugin_unhealthy`/`_failed`/`_recovered`. `last_check_at`/`last_healthy_at`/`last_error`/`consecutive_failures` tracked on the in-memory `health` record.
- **Health state gates nothing.** No selection site reads it: `getPlugin`/`getPluginsByType`/`getPrimaryPlugin` (lifecycle.ts) return plugins regardless of state. Consumers of `getAllHealthRecords`/`getHealthRecord`: only pass-throughs + (not even) the dashboard. A `failed` plugin is selected and called exactly like a healthy one.
- **Degradation → owner notification works.** Daemon subscribes `health.plugin_failed` and `health.plugin_unhealthy` → `notifications.notify(alert)` with distinct `source`s (`plugin:` / `plugin-unhealthy:`). `health.plugin_recovered` has **no subscriber** (logged at `info`, not pushed). Trigger failure has its own `health.trigger_failure` → alert path.
- **`instance.manifest = manifest`** is assigned in `lifecycle.register` (Core injecting identity — consistent with the manifest-is-read-only-to-plugins rule, Core side).

### Task health — `daemon/health-monitor.ts`

- **Stuck detection (harden target):** `evaluateTaskStuckness` (pure) → `health.stuck_detected` (`no_journal_entries`/`stale_journal`/`no_state_transition`). Daemon subscribes it twice: `daemon:health-stuck` → owner alert; `daemon:hard-cap` → on `no_state_transition` + in-flight, `dispatchTracker.terminate(…,"hard_cap_exceeded")`. So stuck detection has real teeth.
- **Verify-only (Slices 6/10):** `checkBlockedEscalation` (timeout-policy stages, `awaiting_human_decision` self-unblock skip) and `checkReviewPendingReminders` (review reminders → owner). Read clean on a skim.

### Observability surface — dashboard audit (`dashboard/api/*`, `dashboard/client/src/pages/*`)

- **Cost:** `cost.incurred` is surfaced (task-agent-tab, `cost-events.ts`, `agent-cost-aggregation.ts` total spend, `system.ts` status). **`cost.limit_reached` is surfaced by no page.** The errors page (`errors.ts` `ERROR_EVENT_TYPES`) and metrics page (`metrics.ts` "hard limit breaches") both query **`cost.quota_exhausted`** — the dead event → those panels are always empty for cost.
- **Data-lifecycle:** **no view reads `system.cleanup_completed`.** `overview/cleanup-card.tsx` reads the *reaper's* `system.reap_completed`, not data-lifecycle's. The sweep is invisible on the dashboard.
- **Plugin health:** `system.ts` `/health` returns `SELECT * FROM events WHERE type LIKE 'health.%' … LIMIT 20` — the last-20 health *events*. `getAllHealthRecords()` (current per-plugin state + `last_check_at`) is exposed by **no API/view**.
- **Observer verbs available:** `startSpan`, `observe(type,name,data)`, `recordDecision(...)`, `recordError(...)` (`observer/facade.ts`/`types.ts`). State transitions are `observe("state_transition",…)` (no dedicated method). NO-OP until DB ready (two-phase startup).

### Timing mechanisms (unification evidence)

- **Four independent mechanisms:** (1) `cost-tracker` — event-driven, no timer; (2) `data-lifecycle` — own `setInterval` (`{start,stop,runCleanup,getLastRun}`, injected clock, per-sweep event); (3) `workspace-reaper` — own `setInterval`, **identical shape** (`{start,stop,runOnce,getLastRun}`, injected clock, per-sweep `system.reap_completed`) — the reaper's own comment (`index.ts:99`) says it is modeled on data-lifecycle's shape; (4) `registry` plugin-health — own `setInterval`, simpler (`setInterval`+`.catch`); plus the daemon's main `tick` loop drives task-health. → Real shape-duplication between **data-lifecycle and the reaper** specifically.

### Tests

- Exist for all four areas: `tests/unit/core/safety-layer/cost-tracker.test.ts` + `index.test.ts`, `tests/unit/core/data-lifecycle/index.test.ts`, `tests/unit/core/registry/plugin-health.test.ts`, `tests/unit/core/daemon/health-monitor.test.ts` + `cost-limit-queue.test.ts` + `index.test.ts`, plus dashboard `cost-events`/`agent-cost-aggregation`. Coverage to **extend**, not create.

### Cross-cutting

- **Events-retention vs cost replay:** only `cost-tracker` full-replays `events` on snapshot loss. Safe at default retention (90d > monthly ~31d window). `response-poller` reads `getEventsSince(0)` only to seed its max-sequence cursor, then discards — not a real history dependency.
- **Module boundaries are sound** — no leaky cross-imports or misplaced concerns found across the four areas.
- **Doc drift:** `docs/configuration/safety.md:17` "Per-provider daily request cap" — true only after the reset fix. README "terminates the in-flight dispatch … on any limit" — true only after Finding B.

---

## What It Means

### Decisions resolved (Session 65 Q&A + this research)

| # | Decision | Source |
|---|---|---|
| A | **`CostStatus.daily_tokens` + `token_totals` are dead → DELETE** (not "make daily"). Revises req-doc #4's token half. | research |
| B | **Daily/monthly breaches: full README behavior — terminate in-flight + notify.** Implement by enqueuing **all active task ids** to `cost-limit-queue` on a daily/monthly `cost.limit_reached` (terminate is idempotent; per-task overlap is safe). | owner |
| 4 | **Provider `daily_requests` resets daily** (reuse the UTC rollover). The real, enforced correctness fix. | owner |
| 6 | **Protect active tasks uniformly** — extend `excludeActiveTasks` to `events`+`observations`. (`task_id=null` system events still prune by age — `NULL NOT IN (...)` is false, so they're not excluded → correct.) | owner |
| — | **Delete dead `cost.quota_exhausted`; rewire the dashboard errors/metrics pages to `cost.limit_reached`.** | research |
| — | **Surface data-lifecycle on the dashboard** — add a card reading `system.cleanup_completed` (mirror the reaper's `cleanup-card.tsx`). | research |
| — | **Surface current plugin-health state** — expose `getAllHealthRecords()` and render it (current state + `last_check_at`), alongside the existing event stream. | research |
| 5 | **Plugin health stays advisory** (no gating) — document as deliberate. | owner |
| 7/8 | **Observability:** milestones+transitions rich, liveness via last-run; data path + existing pages only. | owner |
| — | **Unification: pull back.** Lean keep-independent; the data-lifecycle/reaper shared shape is real but extraction is net-new structure against the steer. Reconsider only if the plan finds it removes real risk. | research+steer |

### Patterns to follow

- **`recordDecision`/`observe`/`state_transition` with named types** (§14, observability.md "name the thing") — the cost-limit-queue's `cost_limit_terminate` decision is the model; the daily-window rollover, the 80%-crossing, the prune sweep, and health transitions should emit at the same grain.
- **Isolated failure boundaries** (§5) — the reaper's per-task try/catch is the model for the data-lifecycle per-table isolation.
- **`getLastRun` liveness record** (data-lifecycle) is the model; surface it (and plugin-health `last_check_at`) to the dashboard.
- **`emitAgentCost` SSOT** is the model for single-sourcing the cost-breach event.

### Risks

- **Finding B blast radius:** terminating all active tasks on a global breach must reuse `dispatchTracker.terminate` (idempotent) and the existing `terminate→blocked` routing (`task-scheduler.ts:278/324`); verify a daily breach during a per-task breach doesn't double-notify beyond the suppress window's dedup. Test at `max_concurrent>1`.
- **Deleting `token_totals`:** confirm no snapshot-format coupling breaks restore (the snapshot includes `token_totals`; deleting the field must tolerate old snapshots gracefully — pre-v1, a DB wipe is the migration, so this is acceptable, but `restoreFromSnapshot` already guards missing fields).
- **Retention floor:** if a user sets `events` retention below the monthly window, a snapshot-loss full-replay undercounts monthly. Mitigate with a documented invariant + a config-validation `warn` (cheap, no behavior change).
- **Per-table isolation change** must preserve the existing sweep ordering (blob cleanup runs after observation pruning) — isolate per-table without reordering.

### Standards sections that actively apply (per approach.md)

§5 Error Handling (isolated failure boundaries, cause chains, fail-loud), §11 SSOT (dead `cost.quota_exhausted`, the dup lifecycle shape, the deleted token path), §12 Logging (the `debug`-level snapshot-fail + degradations), §13 Async (the `setInterval` timers, no floating promises, `AbortController`/cleanup), §14 Observability (the three emit/surface gaps, name-the-type), §15 Graceful Degradation (per-table isolation, daemon-survives-a-sweep, advisory plugin-health). Plus §2 Naming, §3 Function Design / FCIS, §4 Type/Schema, §8 JSDoc/comments for general hygiene on every touched file.

### Open questions

- None blocking. The `recovered`-plugin no-notification asymmetry (failures alert, recovery doesn't) is minor — §15 only requires an `info` log on recovery, which exists; flag for the plan to confirm it's intentional, not fix.
