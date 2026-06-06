# Unit 3 Handoff — Health monitoring hardening

> The Unit 3 build workflow died on the output protocol (agent finished work but never emitted
> StructuredOutput; the adversarial reviewer never ran). The owner (final quality gate) completed and
> verified the unit by hand: fixed an incomplete refactor, corrected an inaccurate comment, re-ran every
> gate, and hand-checked every invariant. This handoff is owner-authored.

## What landed (commit on `slice11-background-services`)

- **D7 — surface current plugin-health state (advisory):**
  - The registry publishes a full `health.plugin_health_snapshot` event every health-check cycle
    (`plugin-health.ts` `healthCheckAll` → `publishSnapshot`), carrying every plugin's current
    `PluginHealthRecord` (reuses `PluginHealthRecordSchema` — one source of truth) + `check_interval_ms`.
    This is the cross-process surface: the dashboard runs as a separate, DB-only process
    (`startDashboard(config, port)` gets no registry), so in-memory `getAllHealthRecords()` is
    unreachable — same boundary the reaper/data-lifecycle cross with their per-sweep events.
  - `GET /api/system/plugin-health` (`dashboard/api/system.ts`) reads back the latest snapshot.
  - New `PluginHealthCard` + `use-plugin-health` hook render current state on the Overview page (joins
    the Unit-2 `DataLifecycleCard` row). Plugin-agnostic — renders whatever manifest identity is registered.
  - **Advisory invariant LOCKED:** `registry/index.test.ts` "health is advisory — selection ignores it"
    drives a plugin to `failed` and asserts `getPrimaryPlugin`/`getPlugin` still return it. `lifecycle.ts`
    (selection) was NOT touched — no health read in selection.
- **D8 — plugin-recovery notification (the slice's ONE new feature), flap-safe:**
  - New non-alert `NotificationKind` `plugin_recovered` (`schemas/notifications.ts`).
  - Daemon `daemon:health-plugin-recovered` subscription notifies the owner ONLY when
    `previous_state === failed` (a real outage cleared) — a transient `unhealthy→healthy` does NOT DM.
  - `dedupKeyFor` (`notification-router.ts`) extended via `sourceScope`: `plugin_recovered` keys on its
    `source` (`plugin:<id>`) just like alerts, so distinct plugins don't collapse and a flapping plugin
    is suppressed within the window.
  - Tests: failed→DM, unhealthy→no-DM, flap→at-most-one-DM, two-distinct-plugins→both-notify.
- **D11 + stuck-detection harden (`health-monitor.ts`):**
  - Stuck detection is now EDGE-TRIGGERED via `stuckLatch` (emit once on the crossing into stuck or on a
    genuine condition escalation; re-arm when no longer active/stuck) — no more per-tick re-publish.
  - A `task_stuck_detected` `state_transition` observation accompanies the durable event (dashboard surface).
  - `StuckCondition` extracted as a named exported type.
  - Blocked-escalation + review-reminder paths: verified-only, NOT reworked.

## Owner fixes applied during recovery
- `health-monitor.ts` referenced `StuckCondition` (undefined) and `ObservationTypes` (unimported) — the
  builder's incomplete refactor. Defined/exported `StuckCondition`, imported `ObservationTypes` (the
  canonical const, already used by `plugin-health.ts`/`daemon/index.ts`), reformatted. Typecheck was red
  until this; now green.
- The recovery-gating comment claimed the owner is "never alerted" on unhealthy and "we DM on the failed
  transition, not the unhealthy one" — FALSE (the daemon DMs on unhealthy via `daemon:health-plugin-unhealthy`).
  Rewrote the comment to the accurate rationale (gate to failed→healthy because unhealthy can oscillate;
  the owner still sees those transitions on the card + the unhealthy alert).

## Gates (owner-run)
typecheck EXIT 0 · lint EXIT 0 · `tests/unit/core/{registry,daemon}` + `tests/unit/dashboard` = 441 passed ·
`build:dashboard` EXIT 0 (the new card compiles).

## OPEN decision for the owner (surfaced, not silently decided)
`health.plugin_health_snapshot` publishes every ~60s (the health-check interval), vs the reaper/data-lifecycle
sweeps at 1h. Over the 90d retention that is ~130k snapshot rows in the events table (the audit ledger + the
cost-tracker's replay source) vs ~2k for an hourly sweep. It is correct and follows the per-cycle event
precedent, but a leaner alternative is a `_meta` single-row overwrite (the cost-tracker's `safety_snapshot`
pattern) — a continuous state cache rather than an append-only audit event. Pending owner call; see the
session report.
