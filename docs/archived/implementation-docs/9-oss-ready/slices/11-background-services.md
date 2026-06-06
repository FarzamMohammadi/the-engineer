# Slice 11: Background Services (Hardening)

> **Durable design record for The Engineer's three background services — cost tracking, data
> lifecycle, and health monitoring.** This was a HARDENING slice and the last of its kind: all three
> subsystems already existed and worked; the slice locked them down to OSS-showcase solidity —
> failure-isolated, fully observable through the dashboard-observer's eyes, standards-clean,
> single-sourced, dead-surface removed. Governing rule (owner): **strengthen / refine / remove, not
> add.** The only behavior changes are fixes where the code contradicted its own documented contract.
>
> **Status: BUILT, HARDENED, AND VERIFIED — pending the owner's review + merge of
> `slice11-background-services` → `main`.** Built in a dedicated worktree as a full RRPIR: requirements
> + research (Session 65), a panel-reviewed plan (4-lens adversarial panel, 6 must-fixes folded in),
> four orchestrated build units, a 5-auditor closing standards sweep, its remediation, and a final
> owner-decided refinement. Working RRP artifacts: `.claude/temp/{requirements-gathering,research,
> create-plan}/slice-11-background-services.md`; per-unit handoffs in `.claude/temp/handoffs/`.

## Scope Framing — refinement, not greenfield

All three subsystems shipped before this slice. "Background Services" is a *category*, not a module:
the four code areas run on four independent timing mechanisms across three layers (safety-layer,
daemon, registry). The slice kept them independent (no unification — the data-lifecycle/reaper shared
shape is documented, not abstracted) and hardened each in place. The one genuinely new capability is a
plugin-recovery notification (owner-chosen). Everything else removes, fixes, or surfaces.

## The Three Pillars, As Built

### Pillar A — Cost tracking: enforce what is promised, observe every fork

- **Provider `daily_requests` is genuinely daily, restart-safe.** It was a monotonic all-time counter
  (a provider that hit its "daily" cap was blocked *forever*). `ProviderUsageRecord` gained a
  `window_start`; the UTC rollover resets it, and restore/replay are window-guarded so a post-midnight
  boot or a snapshot-loss full replay never folds yesterday's requests into today.
- **The dead token surface is gone.** `token_totals` + `CostStatus.daily_tokens` were computed,
  snapshotted, replayed — and read by no one (the dashboard derives tokens from `agent_call` spans).
  Deleted.
- **Daily/monthly breaches now enforce the README's promise.** They published `task_id=null` and so
  silently did nothing but deny the next action. They now terminate every in-flight dispatch and fire
  **exactly one** owner alert keyed `cost:daily`/`cost:monthly` (not N per-task DMs), with per-task
  surfaces as ticket comments; the queue is a `Map` keyed by taskId (`ownerAlert` OR-combined) so a
  same-tick per-task+daily breach neither double-terminates nor double-comments.
- **The cost-breach event is single-sourced and legible.** `cost.quota_exhausted` was declared,
  payload-schema'd, and read by two dashboard surfaces but **published by no one**; `cost.limit_reached`
  (the live event) was surfaced nowhere. Deleted the dead event + its dead `/quota` "exhaustion" block;
  repointed the errors page to `cost.limit_reached` with a payload-aware message ($ for USD, request
  counts for provider caps). A shared `formatCostBreach` helper means the daemon alert and the dashboard
  never drift.
- **Every fork is edge-triggered + observable.** The 80%-crossing, the daily/provider window rollover,
  and the spend breach each emit once per window (named `state_transition` observations, re-armed on
  rollover / terminal-task) — never a per-event heartbeat. The snapshot-save failure logs `warn` naming
  the consequence (crash recovery degrades to full replay), not silent `debug`.

### Pillar B — Data lifecycle: never lose a live trail, never lie about a sweep

- **NULL-safe active-task protection.** Active tasks' `events`/`observations` are now protected from
  pruning like their journal/checkpoints — but with `(task_id IS NULL OR task_id NOT IN (active set))`.
  A bare `task_id NOT IN (...)` was provably backwards (`NULL NOT IN (non-empty)` is NULL, not TRUE), so
  system rows would have become immortal whenever any task was active and pruned only when none were —
  a non-deterministic, unbounded leak on the two highest-volume tables. A determinism test runs the
  assertion **both with and without an active task**.
- **Per-stage failure isolation; truthful liveness.** Each table cleanup, the blob stage, and vacuum are
  isolated; the completion event + `getLastRun` fire from a `finally` so a mid-sweep failure still
  emits — the dashboard liveness card never goes stale on a half-failed sweep.
- **Surfaced on the dashboard.** The sweep published `system.cleanup_completed` that no view read (only
  the reaper's card existed); a new Overview `DataLifecycleCard` renders it.
- **Retention-floor guard.** A startup `warn` fires when `events` retention drops below the monthly cost
  window (the cost-tracker's replay horizon), naming the consequence. Daemon config is restart-only, so
  there is correctly no reload path.

### Pillar C — Health monitoring: advisory state, made visible; recovery, made known

- **Plugin health stays advisory — and is now visible.** Selection never reads health (a locked
  invariant test drives a plugin to `failed` and asserts `getPrimaryPlugin` still returns it). Current
  per-plugin state is surfaced on a new Overview `PluginHealthCard` via `/api/system/plugin-health`.
- **Current state lives in a `_meta` single-row cache (owner decision).** The cross-process surface
  (the dashboard is a separate DB-only process, so in-memory `getAllHealthRecords()` is unreachable) is
  an overwritten `_meta` row written each health-check cycle — mirroring the cost-tracker's
  `safety_snapshot` — *not* a per-cycle event. This keeps current-state in one authoritative place and
  off the append-only events ledger (which the cost-tracker full-replays). The transition events
  (`plugin_unhealthy`/`_failed`/`_recovered`) remain the audit trail of changes.
- **The one new feature: a plugin-recovery notification.** When a `failed` plugin recovers, the owner
  is DM'd — gated to `failed→healthy` only (a transient `unhealthy` oscillation does not spam), deduped
  on the plugin source (so distinct plugins don't collapse and a flapping plugin is suppressed).
- **Stuck detection is edge-triggered.** A still-stuck task no longer re-publishes `health.stuck_detected`
  every tick; it emits once per crossing (or on a genuine condition escalation) and carries the stale
  journal timestamp it computed.

## Locked Decisions

- **Strengthen, not add.** The only behavior changes fix contract violations (daily_requests reset,
  daily/monthly termination, the dead-event rewire); the only net-new feature is the recovery
  notification (owner-chosen, flap-safe).
- **No unification.** The data-lifecycle/reaper shared lifecycle shape is documented (incl. the
  deliberate re-entrancy asymmetry: data-lifecycle is sync and cannot self-overlap; the reaper does
  async I/O and needs its guard) — not extracted. Owner-decided.
- **Health is advisory.** No gating of plugin selection; the absence of gating is documented as
  deliberate and test-locked.
- **Current health state is a `_meta` cache, not an event.** Owner-decided after the closing sweep and
  the analysis flagged the per-60s event's ledger/replay cost; the transitions stay as events.

## What the Closing Sweep Caught (that green CI hid)

The slice's quality gate was a 5-auditor adversarial sweep, and it earned its place — two blockers
passed every per-unit review and all green gates:

1. **Shipped templates silently disabled all cost enforcement.** The bundled `safety.yaml` nested cost
   limits under `api:`/`cli:` keys the flat `CostLimitsSchema` silently strips → a user on the shipped
   config saw `5/25/250` but got all-null = **zero enforcement**. Flattened both templates; pinned by a
   test that parses them through the real schema.
2. **The spend breach was not edge-triggered** — it re-warned and re-published `cost.limit_reached` on
   every event past the limit, while the same slice had latched the provider breach and the 80%-crossing.
   Added the matching `spendBreached` latch.

Plus failure-isolation gaps on the daemon's teardown + cost-limit-queue paths, four comm-plugin error
logs that could leak a token (now sanitized), and doc/source drifts — all remediated.

## Lens Check

- **Resilience.** Strongly positive. A sweep can no longer crash the daemon (per-stage + per-task
  isolation); the cost runaway is actually stopped (templates + edge-trigger + global termination);
  liveness never lies on a half-failed sweep.
- **Plugin Integrity.** Positive. No hardcoded plugin names/types introduced; the health surface renders
  whatever manifest identity is registered; Core compiles and runs with every plugin deleted.
- **Plugin Authoring Simplicity.** Neutral — no new adapter surface.
- **UX.** Positive. Cost breaches are legible (real numbers, not a bare token); one global alert instead
  of N confusing per-task DMs; the owner sees plugin health + recovery and the data-lifecycle sweep.
- **Observability.** Strongly positive — the slice's spine. Every fork edge-triggered + named; current
  health + sweep results + cost breaches all rendered where the observer looks; the events ledger kept
  lean (snapshot moved to `_meta`).

## Build Record

Sixteen green commits on `slice11-background-services` (off `main@b7394b6`): cost core (`8ec00b1`,
`04a5066`), cost enforcement + dashboard (`12bdd9f`), data lifecycle (`ecf6fb0`), health monitoring
(`191300a`), the closing-sweep remediation (`3b5b9bf`–`be9622a`: template flatten, spend-breach latch,
shared breach message, doc syncs, two isolation fixes, secret sanitization, nits), and the `_meta`
snapshot refinement (`c4b584c`). Final verification (owner-run): typecheck 0, lint 0, **2587 unit + 64
integration + 16 e2e**, `build:dashboard` 0.

## Cross-Slice Notes

- **Pre-existing item carried forward:** `src/cli/bundled/plugin-docs.ts` (the agent-docs mirror) still
  has the pre-existing `AGENT_README` drift flagged since Slice 10 — out of this slice's scope; a
  dedicated agent-docs sync remains.
- **Slice 12 (Agent Readiness)** is being built in parallel in its own worktree off the same baseline;
  this slice touched no Slice-12 surface.

## Future Considerations

- Whether to gate plugin selection on health (currently advisory-only) — a deliberate v1 narrowing.
- A leaner health-snapshot cadence if `_meta` write volume ever matters (currently one overwrite/cycle).
