# Handoff: Slice 11 — Unit 2 (Data lifecycle hardening)

**Branch**: `slice11-background-services` (worktree `the-engineer-slice11`) | **Status**: complete, all gates green.

## What changed and why

Implements plan decisions D5, D6, D9, D10, D11 for the data-lifecycle sweep. Tests + docs + logging in
the same commit. No new features — refine/fix/strengthen/surface only.

### D5 — NULL-safe active-task pruning of `events` + `observations`

`src/core/data-lifecycle/index.ts`:
- `MANAGED_TABLES`: `events` and `observations` now `excludeActiveTasks: true` (were `false`).
- `cleanupTable`'s active-task clause is now NULL-safe:
  `AND (task_id IS NULL OR task_id NOT IN (SELECT id FROM tasks WHERE state IN (...)))`.
- **Why the NULL arm matters:** `events`/`observations` carry system rows with `task_id IS NULL` (the
  cost/health/trigger/cleanup audit trail). A bare `task_id NOT IN (active set)` evaluates to NULL for
  those rows (`NULL NOT IN non-empty = NULL`), so they would be RETAINED whenever any task is active and
  pruned only when none is — non-deterministic per tick, an unbounded leak on the two highest-volume
  tables. The explicit `IS NULL OR ...` prunes system + terminal-task rows by age; only live-task rows are
  protected, deterministically.
- **No regression on `journal_entries`/`checkpoints`:** their `task_id` is `NOT NULL REFERENCES tasks(id)`,
  so the `IS NULL` arm never matches — the clause is behaviorally identical to before for them.

### D6 — per-stage failure isolation + truthful liveness

`runCleanup` rewritten: each `MANAGED_TABLES` cleanup is in its own try/catch (model: the reaper's
per-task isolation), the blob stage (`collectReferencedBlobRefs` + `cleanupOrphanedBlobs`) is wrapped, and
vacuum keeps its existing isolation. Stats, `lastRun`, the info log, the new liveness observation, and the
`system.cleanup_completed` event are all computed/published from a `finally` block (`finalizeSweep`) — so a
mid-sweep failure still emits a truthful completion record with whatever stages finished. Sweep ordering
preserved (blob cleanup after table pruning). A 0-row sweep still emits (liveness, not noise).

### D9 — retention-floor invariant + startup warn

- New `src/core/data-lifecycle/inspect.ts`: pure `inspectRetentionConfig(config)` returning warnings,
  mirroring `people-directory/inspect.ts`. Floor = `MONTHLY_REPLAY_FLOOR_DAYS = 31` (the longest cost-replay
  horizon — the cost tracker full-replays `events` back to the start of the calendar month after a snapshot
  loss; on the last day of a 31-day month that span is just under 31 days). Warns when
  `events.max_age_days < 31`, naming the consequence ("undercount monthly spend; cost limits may
  under-enforce").
- **VERIFIED restart-only, so STARTUP warn only — NO reload path wired.** Daemon config (which owns
  `data_lifecycle.retention`) is restart-only: `src/schemas/config.ts:73` ("Startup-only — not
  hot-reloadable") + `docs/configuration/daemon.md` ("Hot-reload: No"). The create-plan D9 text said
  "startup AND reload", but that referred to *safety* config (hot-reloadable); retention is *daemon*
  config. Per the prompt's explicit instruction (verify; if restart-only, startup warn suffices, do not
  invent a reload path), I wired only the startup warn. Deliberate deviation from the plan text, grounded
  in the code.
- Wired into `src/cli/commands/start/bootstrap.ts` step 8 (where `warnPeopleDirectoryHealth` and the other
  startup config warnings live).
- Also surfaced on demand in `engineer doctor` (`src/cli/commands/doctor.ts`
  `checkDataLifecycleCoherence`), reusing the same pure `inspectRetentionConfig` (single source of truth,
  §11) so startup and doctor never disagree. While there I corrected the now-stale generic retention
  message ("may delete data for in-progress tasks" is false post-D5 — active-task rows are never pruned)
  and scoped the generic <7-day check to the non-events tables.

### D10 — periodic-service parallel + asymmetry documented

Added a factory docstring on `createDataLifecycleManager` naming the shared shape with the workspace reaper
AND the deliberate asymmetry: data-lifecycle has NO re-entrancy guard because `runCleanup` is fully
synchronous (better-sqlite3 + sync `fs`, the event loop cannot re-enter it); the reaper needs its `running`
guard only for its async git/network I/O. No guard added; no shared helper extracted (owner-decided).

### D11 — dashboard surface + richer sweep observability

- New `src/dashboard/client/src/pages/overview/data-lifecycle-card.tsx` (`DataLifecycleCard`), wired into
  `overview-page.tsx`. Reads `system.cleanup_completed` via the generic `useEvents` hook (no new API
  endpoint — the events route already filters by `type`), mirroring the reaper's `CleanupCard`. Shows
  per-table deleted/remaining, blobs deleted, vacuum ran, duration, and recent past sweeps. The reaper's
  card stays "Cleanup" (branches); this is "Data Lifecycle" (DB rows + blobs) — distinct names, distinct
  icons (Trash2 vs Database).
- New `data_lifecycle_sweep_completed` `state_transition` observation (task-less) emitted each sweep for
  the trace timeline. EDGE-style: no per-tick heartbeat; a 0-row sweep still emits its completion for
  liveness.

## Tests

- `tests/unit/core/data-lifecycle/index.test.ts`:
  - **D5 determinism (4 tests):** events + observations, each asserting only the live-task row survives,
    run BOTH with an active task present AND with none — locking the determinism the bare clause broke.
  - **D6 isolation (2 tests):** one table throwing (DROP checkpoints) and the blob stage throwing (DROP
    observations) each → the events table still prunes AND `system.cleanup_completed` still fires +
    `getLastRun()` non-null.
  - **D11 (1 test):** a sweep emits the `data_lifecycle_sweep_completed` observation with the tallies.
  - New helpers: `insertEventForTask`, `insertObservationForTask`, `insertTask` (tasks needs
    `created_at` + `last_transition_at`, both NOT NULL no-default).
- `tests/unit/core/data-lifecycle/inspect.test.ts` (new): the floor check — no warn at default/at the
  floor, warns one day below + at 1 day, message names the consequence.
- `tests/unit/cli/commands/doctor.test.ts`: renamed the events-retention test to the real invariant,
  added a non-events-table check, asserted the events message names the consequence.

## Docs / mirrors

- `docs/configuration/daemon.md` — Data Lifecycle section: documented active-task protection, per-stage
  isolation + truthful liveness, and the retention-floor invariant (keep events >= 31; startup warn;
  restart-only so no reload path).
- `docs/architecture/observability.md` — the dashboard passage now names both background sweeps' cards
  (`system.reap_completed` → Cleanup; `system.cleanup_completed` → Data Lifecycle) and the
  0-row-still-emits liveness rule.
- `src/cli/bundled/templates.ts` — the daemon.yaml events-retention comment now states the >= 31 floor.

## Gate results

- `pnpm run typecheck` — green (src + test configs).
- `pnpm run lint` — green (biome + tsc + knip + madge; no findings in touched files).
- `pnpm test tests/unit/core/data-lifecycle tests/unit/dashboard tests/unit/cli/commands/doctor.test.ts`
  — all green. Wider regression `tests/unit/core/daemon tests/unit/schemas tests/unit/cli
  tests/unit/core/data-lifecycle` — 806 passed.
- `pnpm run build:dashboard` — green (the new card compiles in production; root typecheck excludes the
  client, so the Vite build is the client gate — there are 9 PRE-EXISTING strict-tsconfig errors in
  untouched client files, none from this unit).

## What the next unit (Unit 3 — Health monitoring) must know

- **`DataLifecycleCard` occupies its own Overview row** below the `ActiveTasksCard`/`ActivitySnapshot`/
  `CleanupCard` row. Unit 3's `PluginHealthCard` (D7) goes on the Overview grid too — slot it into the new
  bottom row alongside `DataLifecycleCard` (it currently has one card in a `lg:grid-cols-3`).
- **`inspectRetentionConfig` / `MONTHLY_REPLAY_FLOOR_DAYS` are exported from
  `core/data-lifecycle/index.ts`** and used by bootstrap + doctor. The pattern (pure `inspect*` returning
  warnings, consumed by both startup and doctor) is the template if Unit 3 adds any config-floor check.
- **No cost-tracker / reaper internals were touched.** D5/D6/D9/D10/D11 are confined to data-lifecycle,
  its inspect sibling, bootstrap (one warn loop), doctor (retention check), the new card + overview wiring,
  and the three docs/mirrors.
