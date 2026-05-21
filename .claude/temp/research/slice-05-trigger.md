# Research: Slice 5 — Trigger & Requirements (Contacts) Flow

**Date**: 2026-05-21 | **Repo**: the-engineer | **Branch**: main | **Commit**: ad7b400

Scope: implementation-detail surfaces feeding the Slice 5 plan. Decisions live in
`docs/archived/implementation-docs/9-oss-ready/slices/05-trigger.md`. Core flows already grounded in
Session 17; this doc covers the surfaces not yet read + cross-cutting discoveries.

## What I Found

### DB layer (for #2 idempotency_key column, #4 plugin_state table, StateStore impl)
**Files**: `src/db/database.ts`, `src/db/migrations/001_schema.sql`, `src/core/task-engine/queries.ts`

- `better-sqlite3`, synchronous prepared statements. Migration runner loads numbered `NNN_*.sql` from
  `migrations/`, applies those with `version > schema_version` (tracked in `_meta`), each wrapped in a
  `db.transaction()`. **Migration files MUST NOT contain BEGIN/COMMIT/ROLLBACK** (runner wraps them;
  a guard regex throws `MigrationError` if present).
- `001_schema.sql` header: *"Single source of truth — consolidated from all prior migrations."* So the
  universal "consolidate migrations" rule is already in force — **new columns/tables are added by
  editing `001_schema.sql`**, not by adding `003_*.sql`. (Dev DBs are wiped via `reset.sh`; pre-v1, no
  data-migration path needed.)
- `tasks` table: `external_ref TEXT` (JSON), indexed via `idx_tasks_external_ref_active` on
  `json_extract(external_ref,'$.type'/'$.repo'/'$.id')`. There is a `source` column and `thoughts_id`.
  **No `idempotency_key` column.**
- `findByExternalRef(ref)` (`queries.ts:76`) runs a prepared statement on `(type, repo, id)` and returns
  a boolean. Pattern to mirror for `findByIdempotencyKey`.
- DB is `--home`-aware: created at a path derived from `engineerHome`; dir `0o700`, file `0o600`, WAL,
  FK on, `auto_vacuum=INCREMENTAL` (so `DataLifecycleManager` can vacuum).

### Plugin state persistence — TWO plugins hand-roll it (for #4 StateStore)
**Files**: `src/plugins/trigger/github-trigger/github-trigger.ts:119-121`,
`src/plugins/communication/telegram-comm/telegram-comm.ts:400`

- github-trigger: `getWatermarkPath()` = `process.env["ENGINEER_HOME"] ?? join(homedir(),".engineer")`
  then `join(home, "state", manifest.id, "watermarks.json")`. Load on init, save on shutdown,
  temp+rename, bare `catch {}`.
- **telegram-comm independently does the same**: `join(engineerHome, "state", manifest.id,
  "chat-map.json")` — same `state/{plugin-id}/*.json` shape, same env guess. (chat-map = Telegram
  user→chat_id mapping for the `/start` handshake.)
- Both **ignore `--home`** — they read `process.env["ENGINEER_HOME"]`, not the resolved `engineerHome`.

### `engineerHome` / `--home` flow (for StateStore path-correctness)
**Files**: `src/core/daemon/types.ts:31`, `daemon/index.ts:180`, `src/config/env.ts`, `src/cli/pid.ts`,
`src/core/observer/logging.ts:58`

- Core threads a properly-resolved `engineerHome` string everywhere (daemon ctx, logger, env, pid,
  evaluation). Plugins are the **only** consumers that don't receive it — they guess via env.
- Implication path is clean: a Core-side StateStore (DB-backed, already `--home`-aware) needs no path
  logic at all.

### Registry injection (for #7 PluginContext)
**Files**: `src/core/registry/lifecycle.ts:56`, `src/core/registry/index.ts:96-98`, `src/adapters/base.ts`

- `lifecycle.ts:56`: `instance.manifest = manifest`. `registry/index.ts:96`:
  `instance.hookRegistry = this.hookRegistry`; `:98`: `instance.observer =
  this.observer.child("plugin-loader")` — **generic scope, not per-plugin**.
- `base.ts`: `manifest`, `hookRegistry?: unknown`, `observer?: unknown` are public fields; an
  `AdapterObserver` interface (debug/info/warn/error) is defined *adapter-side* to avoid tier import
  violations. `initialize(config)` is the only data passed at init; the three fields are set *before*.
- All 7 plugins implement `doInitialize(config: Record<string, unknown>)` (6 sync, telegram async).
  None take a context param today.

### SDK boundary (for #4/#7 interface placement, #16 npm)
**Files**: `src/adapters/index.ts`

- Curated plugin-author import surface. Exports `BaseAdapter`, `AdapterObserver`, the 4 contracts,
  error helpers, schema types. **Explicitly excludes** Event Bus, DB, Config, Core internals. Header
  comment: *"This is the future `packages/plugin-sdk/` extraction point."*

### Daemon config knobs (for #5 cadence, #8 backoff)
**Files**: `src/schemas/config.ts:36-209`

- `DaemonConfigSchema` has: `trigger_poll_interval_ms` (:94), `response_poll_interval_ms` (:100),
  `seen_keys_ttl_ms` (:108), `plugins.consecutive_failures_threshold` (default 3, :137),
  `notification_retry` (:156), `review_polling` (:192). All numeric `_ms` fields.
- No per-plugin interval override structure exists yet.

### Manifest poll_interval & duration parsing (for #5)
**Files**: `src/plugins/builtin.ts:40`, `src/schemas/adapters.ts:30`

- github-trigger manifest: `adapter_meta: { poll_interval: "30s" }` — a **string**. `adapter_meta` is
  `z.record(z.unknown())` (untyped). Built-in manifests are **inline in `builtin.ts`** (`entry:
  "builtin"`), not YAML files.
- **No dedicated duration-string parser found** in `src/` (config uses numeric `_ms` fields directly).
  Parsing `"30s"` would need a small util, or the manifest value changed to numeric ms.

### `engineer doctor` structure (for #13 owner-channel validation)
**Files**: `src/cli/commands/doctor.ts:23-61`, `src/cli/index.ts:154-175`

- `DoctorCheck` + `DoctorCategory { category, checks[] }`. `runAllChecks(engineerHome, bundle?)` returns
  a `DoctorCategory[]` built from a categories array (:41). Receives the loaded `ConfigBundle` (so it
  has `people`). Category 9 (risky config) is conditional on config loading. Exit code: 0 pass / 1 fail
  / 2 warnings (`computeExitCode`). A code comment says "8 base + 1 conditional" — a stale hardcoded
  count (minor; flag per no-stale-counts).

### People loading (for #12 single-user warn)
**Files**: `src/cli/commands/start/bootstrap.ts:144-145,245`, `src/core/people-directory/index.ts`

- `bootstrap.ts:145`: `new PeopleDirectory({ people: config.people })`. `config.people` also passed to
  comm init (:245). `PeopleDirectory` constructor (`buildMap`) is the **single chokepoint** all
  consumers funnel through.

### `trigger.pr_review` deletion set (#3) — exact
**Files**: `src/schemas/events.ts:46,239-248,523,577`, `src/plugins/builtin.ts:35,41`,
`src/plugins/trigger/github-trigger/github-trigger.ts` (JSDoc), `src/cli/bundled/plugin-docs.ts:38`

- `events.ts`: enum entry (:46), `TriggerPrReviewPayloadSchema` + type (:239-248), type map (:523),
  schema map (:577). builtin.ts: description (:35), `contributes` (:41). Confirmed zero producers/
  consumers.

## What It Means

### Patterns to follow
- **Migrations**: edit `001_schema.sql` for the `idempotency_key` column + `plugin_state` table; no
  BEGIN/COMMIT inside. Mirror `idx_tasks_external_ref_active` for an `idempotency_key` index. Add
  `findByIdempotencyKey` mirroring `findByExternalRef` (prepared statement, boolean return).
- **StateStore = DB-backed**, not file-backed: a `plugin_state(plugin_id, key, value)` table reusing the
  existing `--home`-aware DB. Sidesteps all path/atomicity issues that the file approach hand-rolled.
- **PluginContext interfaces adapter-side** (`adapters/index.ts`, beside `AdapterObserver`),
  implementations Core-side, injected by Registry — extending the existing inject-before-initialize
  pattern. Per-plugin observer = `observer.child(manifest.id)`.

### Risks
- **StateStore has a second consumer nobody mentioned: telegram-comm's `chat-map.json`.** Migrating it
  is a *communication-plugin* change (Slice 12 by our boundary), but Slice 5 builds the primitive AND
  the #7 PluginContext rewire touches telegram's `initialize` anyway. **Decide in plan**: rewire
  telegram's chat-map → StateStore in Slice 5 (while we're in the file) or defer to Slice 12. Leaving it
  half-migrated (PluginContext available but chat-map still file-based) is the trap.
- **PluginContext rewire scope**: full consolidation (replace `this.manifest`/`this.observer` with
  `this.context.*` across all 7 plugins) is high-churn; additive (keep `this.manifest`, add typed
  `this.stateStore` + `this.logger`) is lower-churn but less "consolidated." Plan must pick a lane.
  `this.manifest.id` is referenced widely — full consolidation ripples.
- **Duration parsing** (`"30s"`): adds a small util + a place it can fail (parse error). Alternative:
  make `adapter_meta.poll_interval` numeric ms and skip the parser. Plan decides; either way, validate
  at the boundary (parse-don't-validate).
- **Migration of dev DBs**: adding a column to `001_schema.sql` won't apply to existing dev databases
  (schema_version already past 1). Acceptable pre-v1 (reset.sh wipes), but the plan should note testing
  starts from a fresh DB.
- **`#9/#10` files are partly Slice 12** (`response-poller`, `unblock-resolver`, `outreach-sender`).
  Slice 5 builds only what relates (the trigger-side dedup, the StateStore); the reply-token + sender
  check are designed-but-deferred. Don't pull them in.

### Open questions (for the plan / Farzam)
- **telegram chat-map → StateStore**: migrate in Slice 5 (opportunistic, while rewiring init) or Slice 12?
- **PluginContext shape**: full `this.context` consolidation vs additive `this.stateStore`+`this.logger`?
- **poll_interval representation**: keep `"30s"` string + add parser, or switch manifest to numeric ms?
- **per-plugin interval override**: does the daemon config need a per-plugin override map (#5), or is the
  manifest default + global fallback enough for v1 single-user?
