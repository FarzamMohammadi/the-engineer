# Slice 11 handoff — plugin-health snapshot moved from a per-cycle event to a `_meta` cache

## What changed and why

The registry was publishing `health.plugin_health_snapshot` as a full event **every** health-check
cycle (default 60s) — including unchanged cycles. That is a high-frequency write onto the events table,
which is both the audit ledger and the cost tracker's full-replay scan path on every boot. The current
plugin-health state is *current-state*, not a *change*, so it does not belong on the ledger.

The owner decision: store the CURRENT plugin-health state as a single-row `_meta` cache (overwritten each
cycle), mirroring the cost tracker's `safety_snapshot` pattern. The transition events
(`health.plugin_unhealthy` / `_failed` / `_recovered`) STAY — they are the audit trail of *changes*.

## The mechanism

- **Writer:** `src/core/registry/plugin-health.ts` — `writeSnapshot()` does
  `INSERT OR REPLACE INTO _meta (key, value)` with key `plugin_health_snapshot` and value
  `JSON.stringify({ records, updated_at })`, where `updated_at` is an ISO-8601 stamp of the current moment
  (same way the cost tracker stamps `snapshot_at`). The prepared statement is created once in the factory.
  Called once per `healthCheckAll` cycle, the same place `publishSnapshot` was called before.
- **Reader:** `src/dashboard/api/system.ts` — `GET /plugin-health` does
  `SELECT value FROM _meta WHERE key = 'plugin_health_snapshot'`, parses it, and returns
  `{ records, checked_at: <updated_at> }`. No row yet → the same empty shape as before
  (`{ records: [], checked_at: null }`).
- **Liveness:** `updated_at` advances every cycle (including an unchanged one), so a stale timestamp means
  the health loop stopped — it is the loop's liveness marker, exactly as the per-cycle event's timestamp was.

## Files touched

- `src/core/registry/plugin-health.ts` — replaced `publishSnapshot` (event) with `writeSnapshot` (`_meta`).
  Added `db: Database.Database` to `PluginHealthMonitorDeps`; dropped `healthCheckIntervalMs` from the deps
  (it was only used to populate the now-removed `check_interval_ms`). Removed the now-unused `PublishInput`
  import; added `toSqliteJson`.
- `src/core/registry/index.ts` — added `db: Database.Database` to `RegistryOptions`, passed it to the health
  monitor, stopped passing `healthCheckIntervalMs` to the monitor (the Registry keeps its own copy for the
  `setInterval` timer — that is the loop cadence, a separate concern from the dropped payload field).
- `src/cli/commands/start/bootstrap.ts` — passed the real `db` (already in scope as `const db = dbHandle.db`)
  into `new Registry({ ... })`.
- `src/dashboard/api/system.ts` — `/plugin-health` reads the `_meta` row instead of the events table;
  dropped `check_interval_ms` from the response.
- `src/schemas/events.ts` — DELETED `health.plugin_health_snapshot`: the enum member,
  `HealthPluginHealthSnapshotPayloadSchema` + its type, and its entries in both the `EventPayloads` map and
  the `eventPayloadSchemas` map. Dropped the now-unused `PluginHealthRecordSchema` import
  (`PluginHealthStateSchema` stays — still used by `SystemHealthChangedPayloadSchema`). Left a short comment
  pointing to the `_meta` cache writer/reader. Transition payload schemas untouched.
- Client: `src/dashboard/client/src/types/api.ts` — dropped `check_interval_ms` from `PluginHealthResponse`;
  `checked_at` matches the endpoint. `plugin-health-card.tsx` / `use-plugin-health.ts` already read
  `{ records, checked_at }` + per-row `last_check_at`, so only doc comments changed (no render change).

## Tests

- `tests/unit/core/registry/plugin-health.test.ts` — the snapshot tests now assert the `_meta` row is
  written/overwritten with the records (not an event published). Added a roundtrip + overwrite test (a second
  cycle OVERWRITES — `COUNT(*) = 1`, one row, not appended) and an assertion that NO
  `health.plugin_health_snapshot` event is published anymore (no `health.*` event on a healthy cycle).
- `tests/unit/dashboard/api/system.test.ts` — seeds the `_meta` row and asserts the endpoint returns it;
  the overwrite test confirms a recovery flip replaces the prior state.
- Test wiring: `TestEventBusHandle` now exposes `db`; `tests/helpers/test-registry.ts` `createTestRegistry`
  takes a `db` param; the unit `index.test.ts` local `createTestRegistry`, `loader.test.ts`, and the two
  registry/health integration tests pass a `db` into `new Registry`.

## Gates (all green at commit)

- `pnpm run typecheck` — clean (tsc + test tsconfig).
- `pnpm run lint` — clean (Biome + tsc + knip + madge, no circular deps).
- `pnpm test` — 2587 unit tests pass.
- `pnpm run build:dashboard` — built (this is the client typecheck path; root tsconfig excludes the client).
- Also re-ran the registry/health integration + e2e (crash-recovery exercises the real bootstrap `db`
  wiring) — green.

## Verified

`grep -rn "plugin_health_snapshot"` over src + tests returns only the intended `_meta` key string, the
endpoint's `WHERE key = ...`, the test helpers reading that key, and the test asserting the *event* is no
longer published. The event member is gone from every enum/map. `check_interval_ms` is gone from the entire
changed surface. No live doc enumerated the snapshot event, so no live doc needed updating; the health audit
trail referenced in `docs/configuration/daemon.md` is the transition events, which still exist.

## Not touched (per scope)

Transition events, the recovery notification path, and everything from Units 1-3. This was a pure refinement
— no new features.
