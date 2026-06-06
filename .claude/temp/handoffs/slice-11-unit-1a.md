# Handoff: Slice 11 — Unit 1a (Cost accumulation core)

**Branch**: `slice11-background-services` (worktree `the-engineer-slice11`) | **Status**: complete, all gates green.

## What changed and why

All in `src/core/safety-layer/cost-tracker.ts` + `src/core/interfaces/safety-layer.interface.ts`,
with tests + docs in the same commit. Implements plan decisions D2, D3, D4-note, D11, plus the
fail-loud snapshot fix.

- **D2 — deleted the dead token surface.** Removed `token_totals` from the accumulators, the
  snapshot, `accumulateSpend`, and `replaySpendEvent`; removed `daily_tokens` from `CostStatus`
  (`safety-layer.interface.ts`) and from `getCostStatus`. Verified dead: the only `getCostStatus`
  consumer (`safety-layer/index.ts` `evaluateCostStatus`) never read `daily_tokens`, and the
  dashboard's `metrics.ts` `token_totals` comes from `aggregateAgentCost` over `agent_call` spans
  (independent of this accumulator). `restoreFromSnapshot` ignores a `token_totals` field in an old
  snapshot (it is simply never referenced).

- **D3 — provider `daily_requests` is now a real daily counter, restart-safe.**
  `ProviderUsageRecord` gained `window_start` (SpendWindow-shaped: `{ requests_used, window_start }`).
  - `rolloverWindows` resets every provider into the new daily window at the UTC boundary
    (`resetProviderWindows`), exactly like `daily.cost_usd`.
  - `restoreFromSnapshot` adopts a provider's snapshot count only if `window_start === currentDailyStart`,
    else starts it at 0 (`restoreProviderWindows`) — mirrors the daily-cost restore guard, and tolerates
    an old window-less record (treated as stale → 0).
  - `replaySpendEvent` increments a provider only when `getDailyWindowStart(eventTime) === today`
    (mirrors the daily-cost replay filter), so a full replay across midnight excludes yesterday.

- **D4-note — provider breach publish is edge-triggered.** `checkProviderLimitBreach` now publishes
  `cost.limit_reached` only on the crossing, via a per-window `providerBreached` latch cleared in
  `rolloverWindows`. It re-arms after the daily rollover. (No more publish-on-every-event past the cap.)

- **D11 — edge-triggered observability.** Two new `state_transition` observations (named, not generic
  `lifecycle`):
  - `cost_window_rolled_over` — emitted once per daily/monthly boundary (`emitWindowRollover`).
  - `cost_warning_threshold_crossed` — emitted once on the transition into >=80% per limit window
    (`emitThresholdCrossings` / `emitCrossingOnce`), latched in `crossed80`. Daily/monthly latches
    reset on their rollover; the per-task latch resets on terminal-task prune (`onTaskStateChanged`).

- **Fail-loud.** The snapshot-save failure moved from `observer.debug` to `observer.warn`, naming the
  consequence ("crash recovery degrades to full event replay") and including the sanitized error +
  `lastSequence`. Imports `sanitizeErrorMessage` from `src/utils/sanitize.js`.

## Tests (tests/unit/core/safety-layer/cost-tracker.test.ts)

Four new behavior-as-fact tests, all proven non-vacuous by mutation-testing each one against a broken
implementation:
- `resets provider requests on UTC daily rollover`
- `drops yesterday's provider count on restore across a rollover (window_start mismatch)`
- `counts only today's provider requests on a snapshot-loss full replay across midnight`
  (asserts the breach payload's `current_spend === 2` — proving yesterday's 2 were excluded)
- `emits the 80%-crossing observation exactly once while spend stays above 80%`

New test helpers: `insertRawCostEvent` (inserts a `cost.incurred` row with a chosen timestamp — the
only way to place an event in a past/future daily window, since `EventBus.publish` always stamps `now`;
`EventBus.replay(seq)` then re-delivers it to the live `onCostEvent` with its stored timestamp) and
`createRecordingObserver` (records `observe()` calls so the once-only crossing can be asserted).

## Docs

- `docs/configuration/safety.md` — `daily_requests` row made honest (resets at UTC midnight like
  `daily.cost_usd`); added a prose note that the reset is lazy (applied on the first cost event of the
  new day, not at 00:00:00) and restart-safe.
- `docs/architecture/observability.md` — added an "Edge-trigger transitions, never heartbeat them"
  bullet to the discipline section, citing the cost tracker's once-per-occurrence 80%-crossing and
  rollover emissions as the concrete example.

## Gate results

- `pnpm run typecheck` — green (src + test configs).
- `pnpm test tests/unit/core/safety-layer/cost-tracker.test.ts` — 29 passed.
- `pnpm run lint` — green (biome + tsc + knip + madge; no findings in touched files).
- Wider regression check: `tests/unit/core/safety-layer/` + `cost-limit-queue.test.ts` — 139 passed
  (confirms the `daily_tokens` removal broke no `evaluateCostStatus`/`getCostStatus` consumer).

## What the next unit (1b) must know

- **The provider breach event is now edge-triggered** (D4-note): `cost.limit_reached` for a provider
  fires once per daily window on the crossing, not on every event. Unit 1b's daily/monthly-breach
  termination + global-alert work should not assume a provider breach re-fires each event.
- **No enforcement/termination or dashboard changes were made here** — that is Unit 1b's scope, as
  planned. The `daemon:cost` subscription, `cost-limit-queue`, the `cost.quota_exhausted` deletion,
  and the dashboard errors/metrics rewiring remain untouched.
- **Boot-state emission note (by design):** the edge-trigger latches (`crossed80`, `providerBreached`)
  start empty on construction. If a restored/replayed accumulator is already over 80% or over a
  provider cap at boot, the first cost event after boot will emit one crossing observation / publish
  one provider breach (then latch). This is intentional — the freshly-booted dashboard should reflect
  the current breach/warning state once; it does not spam.
- **`current_spend` in a provider `cost.limit_reached` payload is `requests_used`** (a request count),
  not a USD amount — relevant if 1b renders the breach numbers on the errors page.
