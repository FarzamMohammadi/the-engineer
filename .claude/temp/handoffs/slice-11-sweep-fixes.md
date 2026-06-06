# Slice 11 Closing-Sweep Fixes — Handoff

Applied the closing-standards-sweep fixes for Slice 11 (Background Services), the final hardening slice.
All work on branch `slice11-background-services` in the `the-engineer-slice11` worktree. Refinement only —
strengthen/fix/remove, zero new features. Tests + docs included per fix. Full gates green.

## Commits (oldest → newest)

| Commit | Concern |
|--------|---------|
| `3b5b9bf` | BLOCKER 1 — flatten the safety cost-limit templates so shipped defaults enforce spending |
| `8f2e07e` | BLOCKER 2 — edge-trigger the spend-limit breach so it alerts once per window |
| `abd12d7` | SHOULD-FIX 1 — extract a shared cost breach message (daemon alert + dashboard never drift) |
| `9800323` | SHOULD-FIX 2 + 3 — correct the cost breach timing/termination prose in README + safety.md |
| `bc8bab3` | SHOULD-FIX 4 — isolate each bootstrap teardown step (no handle leak on a failing stop) |
| `c83f2c8` | SHOULD-FIX 5 — isolate each cost-limit termination (one failure no longer drops the rest) |
| `e03a850` | SHOULD-FIX 6 — sanitize comm-plugin error messages in the notification router |
| `0c5e0a3` | NITs 2/4/5/6 — Core observability + hygiene (stale-journal last_activity, sanitize, StuckCondition, notifications comment) |
| `5b877e1` | NITs 1/3 — dashboard hygiene (fail loud on quota read error, drop no-op quota cast) |

## What landed

### BLOCKER 1 — cost enforcement restored (`src/cli/bundled/templates.ts`)
`SAFETY_TEMPLATE` and `EXAMPLE_SAFETY` nested cost limits under `api:`/`cli:` wrapper keys that do NOT
exist in `CostLimitsSchema` (which is flat: `per_task/daily/monthly.cost_usd` + `providers.<id>.daily_requests`).
The loader parses with `SafetyConfigSchema` (no strict/remap), so Zod silently stripped `api`/`cli` → a user
on the shipped template got all-null limits = zero cost enforcement. Both blocks rewritten FLAT, USD numbers
preserved (5/25/250), `providers: {}` with a comment naming it as per-provider `daily_requests` caps keyed by
plugin id. Regression test at `tests/unit/cli/bundled/templates.test.ts` parses both templates' `cost_limits`
subtree through the real `CostLimitsSchema` and asserts the limits survive (not null) + structure has no
`api`/`cli` keys.

**Template parse verification (throwaway, then deleted):** parsed each flattened template's `cost_limits`
through `CostLimitsSchema` — `per_task.cost_usd=5`, `daily.cost_usd=25`, `monthly.cost_usd=250` all survive as
numbers (not null), `providers={}`, for BOTH `SAFETY_TEMPLATE` and `EXAMPLE_SAFETY`. (A full-`SafetyConfigSchema`
parse of `EXAMPLE_SAFETY` fails only on `response_timeout` duration strings, which the loader normalizes via
`parseDurations` before Zod — unrelated to the cost fix; that's why the permanent test scopes to the
`cost_limits` subtree, the exact schema the loader nests for it.)

### BLOCKER 2 — spend-breach latch (`src/core/safety-layer/cost-tracker.ts`)
`checkSpendLimitBreach` re-fired `observer.warn` + re-published `cost.limit_reached` on EVERY cost event once
`spent>=limit` (no latch), while the same file latched `providerBreached` and `crossed80`. Added
`spendBreached = { per_task: Set, daily: bool, monthly: bool }` (mirrors `crossed80`/`WindowedThresholdLatch`).
Now: once `spent>=limit`, return early if already latched, else latch THEN emit. Re-arm: `rolloverWindows`
clears `.daily`/`.monthly` beside `crossed80`; `onTaskStateChanged` deletes `.per_task` for the terminal task
beside `crossed80.per_task.delete`. Tests added (cost-tracker.test.ts): a per_task breach and a daily breach
each publish `cost.limit_reached` exactly once across multiple over-limit events; after a daily rollover the
daily breach re-arms.

> Test note for the next person: `EventBus.replay()` iterates `sinceStmt.iterate()` and the breach handler
> publishes (INSERTs) mid-iteration — better-sqlite3 silently drops a write through a live read iterator, so a
> breach published during replay never persists. The re-arm test therefore drives the rollover via replay
> (observed through the reset accumulator, not a breach event), then re-breaches on the live path. Don't try
> to assert a breach emitted *during* replay.

### SHOULD-FIX 1 — shared cost breach formatter (`src/core/safety-layer/cost-breach-message.ts`)
New `formatCostBreach(breach)` is the single source for the "$X of $Y" money-prose and the $-vs-request-count
decision. Daemon global alert (`daemon/index.ts`) and dashboard error list (`dashboard/api/errors.ts`) both use
it; surface-specific wrapper text stays local (daemon's "Global ..." prefix + "Terminating N" suffix). Takes a
`CostBreach = Pick<CostLimitReachedPayload, ...>` (the message-relevant fields only) so the dashboard reader,
which reads an untyped stored payload, need not reconstruct the whole event — and a missing unrelated field
(e.g. `resets_at`) never blanks a real breach. Exported from the safety-layer barrel. Direct unit test +
existing daemon/dashboard end-to-end tests cover both branches.

### SHOULD-FIX 2 + 3 — doc accuracy
- `README.md:95`: "before the agent's current call settles" was FALSE (`cost.incurred` is emitted AFTER a run;
  termination is deferred to the next tick, hitting the NEXT dispatch). Softened to "before the next agent call
  can accrue more spend." Global-vs-per-task sentence kept.
- `docs/configuration/safety.md`: Cost Limits intro now states that on breach The Engineer terminates the
  offending in-flight task and tells the owner (per-task/provider → DM about that task; global daily/monthly →
  terminate all in-flight with one alert), cross-linking `README#safety` rather than restating.

### SHOULD-FIX 4 — isolated bootstrap teardown (`src/cli/commands/start/bootstrap.ts`)
The three sync teardown calls (`traceExport.stop()` → `dbHandle.close()` → `loggerHandle.close()`) ran as one
unguarded sequence in both the `cleanup()` closure and the failure rollback — a throwing `stop()` leaked the db
+ logger handles. New `safeClose(observer, label, fn)` wraps each step in its own try/catch (warns with
`sanitizeErrorMessage`, continues), mirroring the isolation already around `registry.shutdownAll`. No dedicated
unit test (the helper is a 5-line guard, `bootstrap()` is a heavy integration shell with no existing unit test,
and exporting the private helper purely to test it would add a knip warning against the project's zero-warning
bar — judgment call under "Apply with judgment").

### SHOULD-FIX 5 — isolated cost-limit termination (`src/core/daemon/cost-limit-queue.ts`)
`process()`'s per-task loop (terminate + recordDecision + notify) had no per-task try/catch — the batch is
already drained from `pending`, so one throw dropped every remaining breached task and aborted the tick (a
runaway agent whose termination was dropped keeps spending). Extracted `terminateBreachedTask` (keeps the loop
flat, newspaper order) and wrapped each call in its own try/catch that warns naming the task + dropped action.
Test added: one task's `terminate` throws, the rest still terminate, the failure is warned.

### SHOULD-FIX 6 — sanitize router errors (`src/core/daemon/notification-router.ts`)
Four `err instanceof Error ? err.message : String(err)` sites (notify, delivery chain, single delivery, retry)
→ `sanitizeErrorMessage(err)` (already imported). These errors originate at the comm-plugin boundary and can
echo a token/URL into the log (Trust Through Restraint). Existing router tests (41) cover the paths.

### NITs
1. `quota-status.tsx` — dropped the no-op `as Record<string, unknown> | null` cast (`data.live` already has it).
2. `cost-tracker.ts` `restoreFromSnapshot` catch — added `{ error: sanitizeErrorMessage(error) }` to the warn
   (mirrors the `saveSnapshot` catch).
3. `metrics.ts` `/quota` outer catch — warns naming the endpoint + sanitized error before returning the empty
   shape (Fail Loud). Threaded the existing `config.observer` into `MetricsRoutesDeps` (the dashboard already
   passes `observer.child("dashboard")`; the API layer just didn't receive it). Dashboard API has `noConsole`
   on, so the structured observer is the right loud channel.
4. `health-monitor.ts` `emitStuckDetected` — threads the computed `latestTimestampStr` into `last_activity` (ISO)
   for `stale_journal`; null for `no_journal_entries`/`no_state_transition`. Both the event payload AND the
   `task_stuck_detected` observation. Tests assert all three conditions' `last_activity`.
5. `health-monitor.ts` — dropped the `export` on `type StuckCondition` (nothing imports it; only used in-file).
   Note: a prior Unit-3 handoff said it was "exported"; the sweep correctly found that export speculative/unused.
6. `schemas/notifications.ts` — added a comment that the `Notification` union is a purely in-process message
   contract that never crosses a parse boundary, so the hand-typed (compiler-enforced) union is deliberate
   (Parse-Don't-Validate; not a Schema-First violation). `NotificationKindSchema` stays Zod (the kind string
   reaches durable storage + config surfaces).

## Out of scope (deliberately untouched)
Per the sweep mandate: did NOT touch the `health.plugin_health_snapshot` topology, `/health-query`, or
`check_interval_ms` — a separate owner decision is pending on the snapshot mechanism (see the Unit-3 handoff's
OPEN decision). Verified by diff: no edits to `plugin-health.ts`, `/health-query`, or the snapshot interval.

## Gates (all green)
- `pnpm run typecheck` — EXIT 0
- `pnpm run lint` — EXIT 0 (biome + tsc + knip + madge; 3 pre-existing file-finding warnings, no errors)
- `pnpm test` — 2585 passed (135 files)
- `pnpm run build:dashboard` — EXIT 0 (the quota-status edit + Fail-Loud path compile; chunk-size note is the
  pre-existing advisory, not an error)
