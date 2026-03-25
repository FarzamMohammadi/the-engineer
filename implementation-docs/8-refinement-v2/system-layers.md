# The Engineer — System Layer Specification

> **Purpose:** File-by-file extraction and documentation of every system that comprises The Engineer. Each system is defined by its boundaries, files, public API, dependencies, state, lifecycle, and isolation potential. This document is the architectural foundation for future refinement, extraction, and quality improvements.
>
> **Generated from:** Deep investigation of all ~130 non-test source files across 22 directories.

---

## Table of Contents

1. [System Map (Overview)](#1-system-map)
2. [System 1: Foundation (Schemas + Utils)](#system-1-foundation)
3. [System 2: Database](#system-2-database)
4. [System 3: Configuration](#system-3-configuration)
5. [System 4: Event Bus](#system-4-event-bus)
6. [System 5: Observability](#system-5-observability)
7. [System 6: Task Management](#system-6-task-management)
8. [System 7: Authorization](#system-7-authorization)
9. [System 8: Memory](#system-8-memory)
10. [System 9: Workspace](#system-9-workspace)
11. [System 10: Contacts](#system-10-contacts)
12. [System 11: Plugin Ecosystem](#system-11-plugin-ecosystem)
13. [System 12: Intelligence](#system-12-intelligence)
14. [System 13: Runtime](#system-13-runtime)
15. [System 14: Interface](#system-14-interface)
16. [System 15: Dashboard](#system-15-dashboard)
17. [System 16: Maintenance](#system-16-maintenance)
18. [Cross-System Dependency Graph](#cross-system-dependency-graph)
19. [Shared State Analysis](#shared-state-analysis)
20. [Circular Dependency Audit](#circular-dependency-audit)
21. [Isolation Assessment](#isolation-assessment)
22. [Architectural Strengths](#architectural-strengths)
23. [Architectural Concerns & Smells](#architectural-concerns)

---

## 1. System Map

```
Layer 0 — FOUNDATION (no dependencies)
  System 1: Foundation ............ schemas/, utils/

Layer 1 — INFRASTRUCTURE (depends on Foundation)
  System 2: Database .............. db/
  System 3: Configuration ......... config/

Layer 2 — COMMUNICATION (depends on Infrastructure)
  System 4: Event Bus ............. core/event-bus/
  System 5: Observability ......... core/observer/

Layer 3 — CORE SERVICES (depends on Communication)
  System 6:  Task Management ...... core/task-engine/
  System 7:  Authorization ........ core/action-pipeline/, core/safety-layer/
  System 8:  Memory ............... core/session-memory/
  System 9:  Workspace ............ core/workspace-manager/
  System 10: Contacts ............. core/people-directory/

Layer 4 — EXTENSIBILITY (cross-cutting, Foundation + some Core)
  System 11: Plugin Ecosystem ..... adapters/, core/registry/, core/hooks/, plugins/

Layer 5 — INTELLIGENCE (depends on Core Services + Extensibility)
  System 12: Intelligence ......... core/orchestrator/

Layer 6 — RUNTIME (depends on Intelligence + Core Services)
  System 13: Runtime .............. core/daemon/

Layer 7 — INTERFACE (depends on everything, wires it all)
  System 14: Interface ............ cli/, core/system.ts
  System 15: Dashboard ............ dashboard/

Layer 8 — MAINTENANCE (cross-cutting utility)
  System 16: Maintenance .......... core/data-lifecycle/
```

**Total: 16 systems across 8 layers.**

---

## System 1: Foundation

> Pure types, validation schemas, and stateless utilities. Zero runtime dependencies. The bedrock everything else builds on.

### Files (12)

| File | Purpose | Lines |
|------|---------|-------|
| `src/schemas/config.ts` | Config schemas (Daemon, Orchestrator, Safety, Workspace, People) | ~620 |
| `src/schemas/task.ts` | Task state machine, permissions, action classes | ~200 |
| `src/schemas/events.ts` | 30 event types + typed payload schemas | ~540 |
| `src/schemas/adapters.ts` | Plugin manifest, adapter contracts, error model | ~200 |
| `src/schemas/orchestrator.ts` | Phase enum, phase outputs, decomposition plan | ~150 |
| `src/schemas/session-memory.ts` | Session, journal, checkpoint, knowledge schemas | ~150 |
| `src/schemas/observer.ts` | 14 observation types, span options, row mapper | ~160 |
| `src/schemas/ephemeral.ts` | Runtime-only state (DaemonState, Dispatch, CostAccumulators) | ~150 |
| `src/utils/errors.ts` | `extractErrorMessage(unknown): string` | ~20 |
| `src/utils/sanitize.ts` | Token/secret redaction (3-phase: URL, env, pattern) | ~80 |
| `src/utils/clock.ts` | `Clock` interface + `RealClock` implementation | ~15 |
| `src/core/interfaces/*.ts` | 8 interface files (IEventBus, ITaskEngine, ISafetyLayer, IActionPipeline, ISessionMemory, IWorkspaceManager, IPeopleDirectory, IPluginLookup) | ~250 |

### Public API

Every schema file exports:
- **Zod schema objects** (`TaskStateSchema`, `EventSchema`, etc.)
- **TypeScript types** derived via `z.infer<>` (`Task`, `Event`, `SafetyConfig`, etc.)
- **Const enum objects** (`TaskStates`, `Phases`, `ActionClasses`, `EventTypes`, etc.)
- **Const data arrays** (`ValidTransitions` in task.ts — 27 state transitions, `PermissionTable` — per-state action permissions)

Interfaces export read-only contracts consumed by all Core components.

### Dependencies

**External:** `zod`, `node:crypto` (for `knowledgeId()` hash)
**Internal:** Schema cross-references form a DAG:
```
adapters.ts ← (no schema imports)
orchestrator.ts ← (no schema imports)
session-memory.ts ← (no schema imports)
observer.ts ← (no schema imports)
task.ts ← orchestrator.ts (Phase type)
events.ts ← task.ts (ActionClass, SubState, TaskState)
config.ts ← adapters.ts (PersonSchema), orchestrator.ts (Phase — unused import)
ephemeral.ts ← config.ts, session-memory.ts, task.ts
```

### State

**None.** All schemas are immutable after module load. Const arrays/objects are frozen by TypeScript's `as const`.

### Lifecycle

**Loaded once at import time.** Never mutated. Available for the entire process lifetime.

### Isolation Assessment

**Fully extractable.** Zero runtime dependencies on any other system. Could become `@engineer/schemas` and `@engineer/utils` packages today with no changes.

### Concerns

1. **Schema cross-references create implicit coupling** — `events.ts` importing from `task.ts` means event payloads are structurally coupled to task types. Acceptable, but worth noting if schemas ever need independent versioning.
2. **`ephemeral.ts` is a grab-bag** — DaemonState, Dispatch, and CostAccumulators are unrelated concepts sharing a file. Could be split by domain.
3. **`PermissionTable` and `ValidTransitions` define core behavior in a schema file** — These const arrays are the state machine definition. They're data, not types. Could be elevated to a dedicated state-machine-definition file for clarity.

---

## System 2: Database

> SQLite lifecycle management: file creation, migrations, pragma configuration, and permissions. Single database file, WAL mode.

### Files (3 + migrations)

| File | Purpose |
|------|---------|
| `src/db/database.ts` | `createDatabase()`, `createInMemoryDatabase()`, `runIncrementalVacuum()`, migration runner |
| `src/db/index.ts` | Barrel re-export |
| `src/db/migrations/001_initial.sql` | 7 base tables (tasks, state_transitions, events, sessions, journal_entries, checkpoints, knowledge) |
| `src/db/migrations/002_observability.sql` | (Later dropped) action_traces, phase_metrics, llm_traces |
| `src/db/migrations/003_observer.sql` | Unified observations table |
| `src/db/migrations/004_task_version.sql` | Optimistic locking column |
| `src/db/migrations/005_session_end_reasons.sql` | Expanded session end reason CHECK |
| `src/db/migrations/006_drop_observability_tables.sql` | Cleanup after Observer redesign |
| `src/db/migrations/007_add_return_to_phase.sql` | Blocked task resume tracking |
| `src/db/migrations/008_add_loopback_counts.sql` | RRPIR loop persistence |
| `src/db/migrations/009_add_blocked_end_reason.sql` | Blocked session end reason |

### Public API

- `createDatabase(dbPath, options?): DatabaseHandle` — Full lifecycle: mkdir, open, migrate, configure pragmas, set permissions
- `createInMemoryDatabase(): DatabaseHandle` — In-memory for tests
- `runIncrementalVacuum(db): void` — On-demand space reclamation
- `DatabaseHandle: { db: Database.Database, close(): void }`
- Error classes: `DatabaseError`, `MigrationError`

### Dependencies

**External:** `better-sqlite3`, `node:fs`, `node:path`
**Internal:** `utils/errors.ts` (extractErrorMessage)

### State

- `DatabaseHandle` — one per process, created by bootstrap
- SQLite in-memory state (pragmas, WAL, cache)
- `_meta` table tracks schema version for migration runner

### Lifecycle

**Created once at bootstrap, lives for entire process.** Close on shutdown. Pragmas: `foreign_keys=ON`, `journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=5000`, `cache_size=-65536`.

### Isolation Assessment

**Fully extractable.** Only depends on utils/errors.ts. Migration files are self-contained SQL. Could become `@engineer/database` with zero changes.

### Concerns

1. **Migration guard is filename-based** — relies on `NNN_*.sql` naming convention. No checksum verification.
2. **No migration rollback** — forward-only. Acceptable for v1 but worth noting.
3. **File permissions may fail silently** on some filesystems (Windows, network mounts).

---

## System 3: Configuration

> YAML config loading with env var interpolation, duration parsing, Zod validation, and hot-reload capability.

### Files (2)

| File | Purpose |
|------|---------|
| `src/config/loader.ts` | `loadConfig()`, `loadConfigSafe()`, `loadConfigDir()`, `resolveEnvVars()`, `parseDurations()` |
| `src/config/watcher.ts` | `createConfigWatcher()` — file-watch with 500ms debounce |

### Public API

- `loadConfig<S>(filePath, schema): z.output<S>` — throws on error
- `loadConfigSafe<S>(filePath, schema): { ok, config } | { ok: false, error }` — returns result
- `loadConfigDir(configDir?): ConfigDirResult` — loads all 5 config files with defaults
- `resolveEnvVars(obj, filePath): obj` — recursive `${VAR}` substitution
- `parseDurations(obj, schema): obj` — converts `"30s"` → `30000` for `*_ms` fields
- `getNumberPaths(schema): PathNode[]` — Zod schema introspection
- `createConfigWatcher<S>(filePath, schema, onChange): WatcherHandle`

### Dependencies

**External:** `zod`, `yaml`, `ms`
**Internal:** `schemas/config.ts`, `schemas/adapters.ts` (PersonSchema), `utils/errors.ts`

### State

- **Loader:** Stateless (pure functions)
- **Watcher:** Per-instance: debounce timer, stopped flag

### Lifecycle

- Loader called once at startup via CLI
- Watcher created for hot-reloadable configs (safety, workspace, people) — lives for daemon lifetime

### Isolation Assessment

**Extractable with schemas.** If schemas are extracted, config can follow. The only coupling is to Zod schema definitions.

### Concerns

1. **Duration parsing via schema introspection is clever but fragile** — relies on field naming convention (`*_ms`). A renamed field could silently skip duration parsing.
2. **Watcher not yet integrated** in production — ready for hot-reload but not wired in bootstrap.
3. **`resolveEnvVars` is recursive** — handles nested objects/arrays, but no cycle detection (not needed for config depth, but worth noting).

---

## System 4: Event Bus

> In-process pub/sub with SQLite persistence. Every event persisted before delivery. The audit trail backbone.

### Files (5)

| File | Purpose |
|------|---------|
| `src/core/event-bus/index.ts` | `EventBus` class: publish, subscribe, unsubscribe, replay, query |
| `src/core/event-bus/pattern.ts` | `matchesPattern()` — glob matching for subscriptions |
| `src/core/event-bus/topology.ts` | `EventTopology` — declarative event schema registry + validation |
| `src/core/event-bus/errors.ts` | `EventBusError`, `EventReplayError` |
| `src/core/interfaces/event-bus.interface.ts` | `IEventBus` contract |

### Public API

- `EventBus` (implements `IEventBus`):
  - `publish<T>(input: PublishInput<T>): Event` — persist + sync delivery
  - `subscribe(subscriberId, eventType, callback): void` — glob patterns supported
  - `unsubscribe(subscriberId): void`
  - `replay(fromSequence): void` — state reconstruction from persisted events
  - `getEventsForTask(taskId): Event[]`
  - `getEventsSince(sequence, limit?): Event[]`
- `matchesPattern(pattern, eventType): boolean` — exported pure function
- `EventTopology`:
  - `registerEvent(declaration)`, `registerPublisher(component, eventTypes)`, `registerSubscriber(component, patterns)`
  - `validatePayload(type, payload)`, `getTopologyGraph()` (for dashboard)

### Dependencies

**External:** `better-sqlite3`, `ulid`
**Internal:** `schemas/events.ts`, `utils/sanitize.ts`, `core/observer` (IObserver), `core/interfaces/event-bus.interface.ts`

### State

- `subscriptions: SubscriptionRecord[]` — in-memory callback list
- `topology: EventTopology | undefined` — optional schema registry
- Prepared SQL statements (insert, query by task, query since)
- 4 configurable options: validateOnPublish, subscriberWarnThresholdMs

### Lifecycle

- Created once in `createCoreComponents()`. Long-lived (daemon lifetime).
- **Design principle: Event Bus down = system halt.** DB failures propagate. This is intentional — audit trail is a safety requirement.

### Isolation Assessment

**Extractable as core infrastructure.** Depends on schemas (Event types) and observer (for logging). The DB dependency is structural — EventBus IS a persistence layer.

### Concerns

1. **Synchronous delivery** — subscribers run in publish() call stack. A slow subscriber blocks all publishers. Mitigated by `subscriberWarnThresholdMs` warning.
2. **Subscriber errors swallowed** — logged but never propagate. Could hide bugs in subscribers.
3. **Payload sanitization is publisher responsibility** — EventBus does NOT sanitize. Easy to forget `sanitizeErrorMessage()` when publishing error details (secret leakage risk).
4. **Topology validation optional in production** — silent schema drift possible.

---

## System 5: Observability

> Unified structured logging + tracing + blob storage. Three-tier: pino logs (ops), observations (traces), event bus (audit). Real-time streaming for dashboard.

### Files (9)

| File | Purpose |
|------|---------|
| `src/core/observer/facade.ts` | `Observer` class (IObserver) — logging + tracing unified API |
| `src/core/observer/observation-store.ts` | `ObservationStore` — span/point creation, DB + stream |
| `src/core/observer/store.ts` | `ObserverStore` — SQL access layer (prepared statements, dynamic queries) |
| `src/core/observer/stream.ts` | `ObserverStream` — real-time pub/sub for SSE dashboard |
| `src/core/observer/blob-store.ts` | `BlobStore` — content-addressable FS storage (SHA-256) |
| `src/core/observer/logging.ts` | `createLogger()` — pino + pino-roll factory, `ComponentTag` union |
| `src/core/observer/types.ts` | Type re-exports + `ObservationSpan`, `IObservationStore` interfaces |
| `src/core/observer/index.ts` | Barrel exports |
| `src/schemas/observer.ts` | 14 observation types, ObservationSchema, SpanOptionsSchema, rowToObservation |

### Public API

**IObserver** (what every component receives):
- Logging: `info()`, `warn()`, `error()`, `debug()` → pino rolling JSON files
- Tracing: `startSpan()` → ObservationSpan with `.end()`, `.startChild()`, `.addEvent()`, `.setError()`
- Point observations: `observe()`, `recordDecision()`, `recordError()`
- Scoping: `child(component)` → new IObserver scoped to component
- Escape hatch: `.pino` property for raw pino access

**Factories:**
- `createObserverFacade(pino, component): Observer`
- `createLogger(config, home): LoggerHandle`
- `createSilentLogger(): LoggerHandle`
- `createObservationStore(db, blobStore?): ObservationStore`
- `BlobStore(tracesDir)` — store/read/exists

### Dependencies

**External:** `pino`, `pino-roll`, `ulid`, `better-sqlite3`, `node:crypto`, `node:fs`
**Internal:** `schemas/observer.ts`, `utils/errors.ts`, `utils/sanitize.ts`

### State

- **SharedContext** (mutable singleton within Observer): `rootPino` + `store: IObservationStore | null`
- **ObserverStream**: `subscribers: Set<Function>`, `errorCounts: Map` (dead subscriber auto-eviction after 3 errors)
- **BlobStore**: `blobsDir` path (immutable)
- **LoggerHandle**: pino transport worker thread

### Lifecycle

1. `createLogger()` → pino transport ready
2. `createObserverFacade(pino)` → logging works, tracing returns NO_OP_SPAN
3. DB created
4. `createObservationStore(db, blobStore)` → ObservationStore ready
5. `observer.upgrade(store)` → all observers atomically gain tracing capability

### Isolation Assessment

**Extractable as infrastructure package.** The late-binding pattern (upgrade after DB) is the only complexity. Observer depends on schemas and DB.

### Concerns

1. **Late-binding pattern** — SharedContext with null store is necessary but fragile. If `upgrade()` never called, all tracing silently no-ops.
2. **Stream error swallowing** — subscriber errors never logged (prevents Observer→Logger→Observer circularity). Dead subscribers silently evicted.
3. **Dual write on `recordError()`** — logs to BOTH pino and observation store. Could diverge if one fails.
4. **BlobStore file permissions** — 0o600 (owner r/w only), 0o700 directories. Security-conscious but depends on OS support.

---

## System 6: Task Management

> State authority and permission oracle. CPU-derived state machine with optimistic locking.

### Files (7)

| File | Purpose |
|------|---------|
| `src/core/task-engine/index.ts` | `TaskEngine` class — facade for state transitions, creation, queries |
| `src/core/task-engine/state-machine.ts` | `StateMachine` — transition validation + execution with optimistic locking |
| `src/core/task-engine/permissions.ts` | `checkPermission()` — pure Gate 1 logic |
| `src/core/task-engine/queries.ts` | `TaskQueries` — read-only prepared statement queries |
| `src/core/task-engine/row-mapper.ts` | `rowToTask()`, `rowToStateTransition()` — pure DB→domain mappers |
| `src/core/task-engine/errors.ts` | `TaskNotFoundError`, `InvalidTransitionError`, `VersionConflictError` |
| `src/core/interfaces/task-engine.interface.ts` | `ITaskEngine` contract |

### Public API

- `TaskEngine` (implements `ITaskEngine`):
  - `createTask(input): Task` — always starts in `intake` state
  - `requestTransition(taskId, toState, toSub, reason, triggeredBy): TransitionResult`
  - `checkPermission(taskId, actionClass): PermissionResult` — Gate 1
  - `getTask(id)`, `getTasksByState(state)`, `getQueuedByPriority()`, `getChildren(parentId)`, `getStateHistory(taskId)`
  - `updateTaskField(taskId, field, value)` — 15 updatable fields
  - `updateTracking(taskId, tokens, costUsd, computeMs)` — atomic cost increment
- Pure exports: `isValidTransition()`, `subStateMatches()`, `rowToTask()`, `checkPermission()`
- Events: `task.created`, `task.state_changed`

### Dependencies

**External:** `better-sqlite3`, `ulid`
**Internal:** `schemas/task.ts` (ValidTransitions, PermissionTable, TaskState, etc.), `schemas/events.ts`, `schemas/orchestrator.ts` (Phase type), `core/interfaces/event-bus.interface.ts`, `core/observer`

### State

- Prepared SQL statements (cached at construction)
- References to EventBus and Observer (injected, not owned)
- **Database is authoritative** — tasks table + state_transitions table
- **Exclusive writer** to `tasks` and `state_transitions` tables

### Lifecycle

Created once in `createCoreComponents()`. Long-lived. Stateless in-memory (all state in DB).

### Isolation Assessment

**Extractable with schemas.** Clean interface boundary (ITaskEngine). Only depends on EventBus (for event publishing) and Observer (for logging). The permission system is pure functions.

### Concerns

1. **15 updatable fields hardcoded** — adding a field requires touching UPDATABLE_FIELDS array + JSON_FIELDS set. No compile-time safety.
2. **JSON serialization in `updateTaskField()`** — no validation that the value matches the field type. Caller must know which fields are JSON.
3. **State/sub_state pairing is implicit** — PermissionTable defines valid pairs, but there's no type-level enforcement that `active` must have a sub_state.
4. **Cost tracking is fire-and-forget** — `updateTracking()` logs warning if task not found but doesn't throw.

---

## System 7: Authorization

> Two-gate authorization pipeline. Gate 1 (state permissions) + Gate 2 (policy/cost enforcement). Every side-effect action flows through here.

### Subsystem 7A: Action Pipeline

#### Files (2)

| File | Purpose |
|------|---------|
| `src/core/action-pipeline/index.ts` | `ActionPipeline` class — thin middleware: Gate 1 → Gate 2 → Execute → Notify |
| `src/core/interfaces/action-pipeline.interface.ts` | `IActionPipeline`, `ExecuteInput<T>`, `PipelineResult<T>` |

#### Public API

- `ActionPipeline.execute<T>(input: ExecuteInput<T>): Promise<PipelineResult<T>>`
- `PipelineResult<T>` discriminated union: `executed | rejected | ask_human | error`
- Events: `action.rejected`

#### Flow
```
Gate 1: taskEngine.checkPermission(taskId, actionClass)
  → rejected? emit event, return { outcome: "rejected", gate: "task_engine" }
Gate 2: safetyLayer.evaluateAction(taskId, actionClass, details)  [skip for reads]
  → denied? emit event, return { outcome: "rejected", gate: "safety_layer" }
  → ask_human? emit event, return { outcome: "ask_human" }
Execute: await executeFn()
  → error? return { outcome: "error" }
Notify: notifyFn?.(result)  [fire-and-forget]
Return: { outcome: "executed", result }
```

### Subsystem 7B: Safety Layer

#### Files (5)

| File | Purpose |
|------|---------|
| `src/core/safety-layer/index.ts` | `SafetyLayer` class — Gate 2 facade + passive consultation |
| `src/core/safety-layer/policy-engine.ts` | `PolicyEngine` — pure scope/branch/file/merge policy evaluation |
| `src/core/safety-layer/cost-tracker.ts` | `createCostTracker()` — cost accumulation, limit checking, snapshots |
| `src/core/safety-layer/errors.ts` | `CostLimitExceededError`, `ScopeDeniedError`, `CorruptSnapshotError` |
| `src/core/interfaces/safety-layer.interface.ts` | `ISafetyLayer`, `SafetyQuery`, `SafetyVerdict`, `CostStatus` |

#### Public API

- `SafetyLayer` (implements `ISafetyLayer`):
  - `evaluateAction(taskId, actionClass, details): SafetyVerdict` — Gate 2
  - `consultJudgment(query: SafetyQuery): SafetyVerdict` — passive consultation (can_i, should_i_ask, cost_check)
  - `getCostStatus(taskId?): CostStatus` — spend totals + warnings
  - `checkAutoMergeAllowed(repo): boolean`
  - `updateConfig(newConfig)` — hot-reload
  - `flushCostSnapshot()` — persist to DB (call during shutdown)
- Events: `cost.limit_reached`

#### State

- **CostTracker**: per-task Map, daily/monthly SpendWindow, provider request counts, token totals (in-memory, snapshot to `_meta` table every 5s)
- **PolicyEngine**: config reference (mutable via updateConfig)
- Cost window rollover: daily at midnight UTC, monthly at 1st

### Dependencies

**External:** `better-sqlite3`, `zod`
**Internal:** `schemas/config.ts`, `schemas/task.ts`, `schemas/events.ts`, `core/interfaces/*`, `core/observer`

### Lifecycle

Created once in `createCoreComponents()`. Long-lived. CostTracker subscribes to EventBus (`cost.incurred`, `task.state_changed`) and accumulates passively.

### Isolation Assessment

**Extractable together (Action Pipeline + Safety Layer).** ActionPipeline is thin middleware; SafetyLayer is the brain. Clean interface boundary. CostTracker's EventBus subscription is the main coupling point.

### Concerns

1. **Warnings lost in "executed" path** — if SafetyLayer returns `action: "proceed"` with warnings (e.g., "80% of daily cost limit"), ActionPipeline doesn't include warnings in the `{ outcome: "executed" }` result.
2. **Window rollover is event-driven** — daily window doesn't reset until next cost event arrives. Could be stale for hours.
3. **Snapshot debounce 5s** — crash within 5s of cost event may lose data. Mitigated by EventBus replay on restart.
4. **`ask_human` is a signal, not a block** — pipeline returns immediately. Caller must implement the actual blocking/waiting.

---

## System 8: Memory

> Persistence layer for agent working context. Sessions, journal, checkpoints, knowledge. Pure DB storage, no intelligence.

### Files (8)

| File | Purpose |
|------|---------|
| `src/core/session-memory/index.ts` | `SessionMemory` class — facade delegating to 4 stores |
| `src/core/session-memory/sessions.ts` | `SessionStore` — session lifecycle + chain linking |
| `src/core/session-memory/journal.ts` | `JournalStore` — append-only log with dynamic SQL filtering |
| `src/core/session-memory/checkpoints.ts` | `CheckpointStore` — recovery snapshots (ordered by rowid) |
| `src/core/session-memory/knowledge.ts` | `KnowledgeStore` — content-hash upsert, supersession |
| `src/core/session-memory/row-mappers.ts` | Pure row→domain mappers (4 functions) |
| `src/core/session-memory/errors.ts` | `SessionNotFoundError`, `KnowledgeNotFoundError` |
| `src/core/interfaces/session-memory.interface.ts` | `ISessionMemory` contract |

### Public API

- `SessionMemory` (implements `ISessionMemory`):
  - Sessions: `createSession()`, `endSession()`, `getSessionChain()`
  - Journal: `addJournalEntry()`, `queryJournal()`, `getLatestJournalTimestamp()`
  - Checkpoints: `createCheckpoint()`, `getLatestCheckpoint()`
  - Knowledge: `storeKnowledge()`, `getKnowledge()`, `supersedeKnowledge()`, `confirmKnowledge()`
- **Exclusive writer** to `sessions`, `journal_entries`, `checkpoints`, `knowledge` tables

### Dependencies

**External:** `better-sqlite3`, `ulid`
**Internal:** `schemas/session-memory.ts`, `utils/sanitize.ts` (journal entry sanitization)

### State

**Stateless in-memory.** All state in DB. SessionMemory is a pure DB facade.

### Lifecycle

Created once in `createCoreComponents()`. Long-lived.

### Isolation Assessment

**Fully extractable.** Minimal dependencies (DB + schemas + sanitize). Clean interface. No EventBus coupling — does not publish or subscribe to events.

### Concerns

1. **Journal dynamic SQL** — builds WHERE clauses dynamically for filters. Uses bound parameters (safe), but complexity could grow.
2. **Knowledge content-hash ID** — SHA-256 of `scope\0repoScope\0key\0body`. Deterministic, but collision risk is theoretical.
3. **No event emission** — unlike TaskEngine, SessionMemory doesn't publish events. This is intentional (Orchestrator publishes separately), but means no audit trail for memory operations.

---

## System 9: Workspace

> Git operations service for per-task isolation. Worktree management, branch lifecycle, authentication, thoughts/ directory structure.

### Files (3)

| File | Purpose |
|------|---------|
| `src/core/workspace-manager/index.ts` | `WorkspaceManager` class — create/verify/cleanup workspaces, push, clone |
| `src/core/workspace-manager/errors.ts` | `WorkspaceNotFoundError`, `WorkspaceCreationError` |
| `src/core/interfaces/workspace-manager.interface.ts` | `IWorkspaceManager` contract |

### Public API

- `WorkspaceManager` (implements `IWorkspaceManager`):
  - `createWorkspace(taskId, repo, options?)` — clone + branch + worktree + thoughts/ dirs
  - `verifyWorkspace(taskId)` — integrity check (valid/recoverable/lost)
  - `cleanupWorkspace(taskId, preserveBranch?)` — remove worktree
  - `ensureClone(repo, cloneUrl)` — idempotent clone with transient auth
  - `pushBranch(taskId)` — push to remote with transient token injection
  - `registerExistingWorkspace(taskId, workspace)` — restore in-memory map on restart
  - `getWorktreePath(taskId)`, `getWorkspaceRecord(taskId)`
- Pure exports: `slugify()`, `branchName()`, `injectAuth()`, `validateWorkspacePath()`
- Events: `workspace.created`, `workspace.verified`, `workspace.cleaned`

### Dependencies

**External:** `node:child_process` (execFileSync), `node:fs`, `node:path`
**Internal:** `schemas/config.ts`, `schemas/orchestrator.ts` (PHASE_DIRECTORIES), `schemas/task.ts`, `schemas/events.ts`, `core/interfaces/event-bus.interface.ts`, `core/observer`, `core/orchestrator/session-result.ts` (writeSessionResultTemplate)

### State

- `workspaces: Map<string, WorkspaceRecord>` — in-memory lookup (rebuilt on restart from task.workspace DB field)
- Filesystem: worktrees at `~/.engineer/workspaces/worktrees/{repo}/{taskId}-{slug}/`
- Filesystem: clones at `~/.engineer/workspaces/{repo}/`

### Lifecycle

Created once in `createCoreComponents()`. Long-lived. Workspaces created/cleaned per-task.

### Isolation Assessment

**Mostly extractable.** One problematic import: `core/orchestrator/session-result.ts` (writeSessionResultTemplate). This creates a dependency from workspace→orchestrator, which is architecturally backwards.

### Concerns

1. **Imports from orchestrator** — `writeSessionResultTemplate()` called when creating thoughts/ directories. This couples Workspace to Orchestrator, violating the layer hierarchy. Should be injected or moved to a shared utility.
2. **Synchronous git operations** — `execFileSync` blocks the event loop during clone/push/branch operations. Acceptable for now (operations are short), but limits throughput.
3. **Token injection via URL** — transient (never persisted), but the injected URL is in-memory briefly. Credential helper is disabled to prevent caching.
4. **In-memory map rebuilt from DB** — requires `registerExistingWorkspace()` calls on restart. If a task's workspace field is corrupt, the workspace is effectively lost.

---

## System 10: Contacts

> Config-driven contact resolver. People metadata, role-based queries, channel resolution.

### Files (2)

| File | Purpose |
|------|---------|
| `src/core/people-directory/index.ts` | `PeopleDirectory` class — lookup/resolve contacts |
| `src/core/interfaces/people-directory.interface.ts` | `IPeopleDirectory` contract |

### Public API

- `PeopleDirectory` (implements `IPeopleDirectory`):
  - `getPerson(id)`, `getByRole(role)`, `getOwner()`, `getReviewers()`, `getAll()`
  - `resolveContact(personId, preferredChannel): ContactInfo | null`
  - `updateConfig(newConfig)` — hot-reload

### Dependencies

**External:** None
**Internal:** `schemas/adapters.ts` (Person, ContactInfo), `schemas/config.ts` (PeopleConfig)

### State

- `people: Map<string, Person>` — rebuilt on `updateConfig()`

### Lifecycle

Created after core components in bootstrap. Long-lived.

### Isolation Assessment

**Trivially extractable.** Zero coupling to any Core system. Pure config-driven lookup.

### Concerns

1. **Role strings are arbitrary** — no enum validation for roles. Misspelled roles fail silently.
2. **`plugin_id` set to channel name** — implicit coupling between channel names and plugin IDs.
3. **Smallest system** — arguably doesn't need to be its own system. Could be a utility in the config system.

---

## System 11: Plugin Ecosystem

> Adapters (abstract contracts), Registry (lifecycle), Hooks (extensibility), Loader (discovery), Plugins (implementations). The extensibility layer.

### Subsystem 11A: Adapter Contracts

#### Files (8)

| File | Purpose |
|------|---------|
| `src/adapters/base.ts` | `BaseAdapter` — template method: initialize/shutdown/healthCheck |
| `src/adapters/trigger.ts` | `TriggerAdapter` — single `poll()` method |
| `src/adapters/communication.ts` | `CommunicationAdapter` — send + 3 optional capability groups |
| `src/adapters/llm.ts` | `LLMAdapter` — infer + getCapabilities |
| `src/adapters/tool.ts` | `ToolAdapter` — describe + execute (workspace-confined) |
| `src/adapters/git-hosting.ts` | `GitHostingAdapter` — 9 fully required PR lifecycle methods |
| `src/adapters/errors.ts` | `AdapterMethodError`, `createAdapterError()` |
| `src/adapters/index.ts` | SDK boundary barrel (single import point for plugins) |

### Subsystem 11B: Registry

#### Files (4)

| File | Purpose |
|------|---------|
| `src/core/registry/index.ts` | `Registry` class — facade: registration, lookup, lifecycle, health |
| `src/core/registry/lifecycle.ts` | `createLifecycleManager()` — plugin records, type cache, init/shutdown ordering |
| `src/core/registry/plugin-health.ts` | `createPluginHealthMonitor()` — 3-state machine (healthy→unhealthy→failed) |
| `src/core/interfaces/plugin-lookup.interface.ts` | `IPluginLookup` — read-only lookup contract |

### Subsystem 11C: Hooks

#### Files (1)

| File | Purpose |
|------|---------|
| `src/core/hooks/index.ts` | `HookRegistry` — 10 hook points (pre/post for task, phase, tool, publish) |

### Subsystem 11D: Plugin Loader + Implementations

#### Files (19)

| File | Purpose |
|------|---------|
| `src/plugins/loader.ts` | `discoverEnabledPlugins()`, `loadBuiltinPlugins()` |
| `src/plugins/builtin.ts` | 8 plugin manifests + factory map |
| `src/plugins/trigger/github-trigger/github-trigger.ts` | GitHub issue polling |
| `src/plugins/trigger/github-trigger/config.ts` | Config schema |
| `src/plugins/communication/github-comm/github-comm.ts` | GitHub comments + sync + issue management |
| `src/plugins/communication/github-comm/config.ts` | Config schema |
| `src/plugins/communication/github-comm/github-utils.ts` | URL parsing, label diffing |
| `src/plugins/communication/telegram-comm/telegram-comm.ts` | Telegram bot notifications |
| `src/plugins/communication/telegram-comm/config.ts` | Config schema |
| `src/plugins/git-hosting/github-hosting/github-hosting.ts` | Full PR lifecycle (9 methods) |
| `src/plugins/git-hosting/github-hosting/config.ts` | Config schema |
| `src/plugins/llm/claude-code-llm/claude-code-llm.ts` | Claude Code CLI wrapper |
| `src/plugins/llm/claude-code-llm/config.ts` | Config schema |
| `src/plugins/llm/gemini-cli-llm/gemini-cli-llm.ts` | Gemini CLI wrapper |
| `src/plugins/llm/gemini-cli-llm/config.ts` | Config schema |
| `src/plugins/llm/opencode-llm/opencode-llm.ts` | OpenCode CLI wrapper |
| `src/plugins/llm/opencode-llm/config.ts` | Config schema |
| `src/plugins/tool/bash-tool/bash-tool.ts` | Shell command execution (sandbox, timeout, limits) |
| `src/plugins/tool/bash-tool/config.ts` | Config schema |

### Public API (Registry)

- `Registry`:
  - `register(manifest, instance)`, `deregister(pluginId)`
  - `getPlugin<T>(type, id)`, `getPluginsByType<T>(type)`, `getPrimaryPlugin<T>(type)`
  - `initializePlugin(pluginId, config)`, `shutdownAll()`
  - `healthCheckAll()`, `startHealthCheckLoop()`, `stopHealthCheckLoop()`
- Events: `health.plugin_unhealthy`, `health.plugin_failed`, `health.plugin_recovered`

### Dependencies

- **Adapters:** `schemas/adapters.ts` only (SDK boundary enforced)
- **Registry:** `adapters/base.ts`, `schemas/*`, `core/interfaces/*`, `utils/*`
- **Plugins:** `adapters/index.ts` (SDK barrel), `@octokit/rest`, `grammy`, `node:child_process`

### State

- **Registry:** `plugins: Map<string, PluginRecord>`, `typeCache: Map<AdapterType, BaseAdapter[]>`, health records (in-memory only)
- **Each plugin:** owns its state (octokit client, watermarks, etc.)
- **Hooks:** `hooks: Map<HookPoint, HookEntry[]>`

### Lifecycle

1. Registry created in bootstrap
2. Plugins loaded via `loadBuiltinPlugins()` (discover → create → register → config → initialize)
3. Health check loop runs periodically (default 60s)
4. Shutdown: reverse init order

### Isolation Assessment

**Adapters are extractable today** → `@engineer/plugin-sdk`. Zero core dependencies.
**Registry + Hooks extractable** with interfaces. Depends on EventBus (health events) and Observer.
**Plugins extractable individually** — each depends only on its adapter base class.

### Concerns

1. **LLM `buildLlmEnv()` duplicated** in all 3 LLM plugins. Should be shared utility.
2. **GitHub error classification duplicated** in trigger + comm plugins. Should be in `plugins/github-shared/`.
3. **`deregister()` doesn't call `shutdown()`** — resource leak risk.
4. **Plugin priority = registration order** — no explicit priority field in manifest.
5. **Observer injected as `unknown`** in BaseAdapter to avoid tier violations — clever but type-unsafe.
6. **Health records not persisted** — lost on restart. Acceptable for v1.

---

## System 12: Intelligence

> The brain. 7-phase pipeline transforming tasks from intake to integration. RRPIR methodology. CLI-native LLM invocation.

### Files (22)

| File | Purpose |
|------|---------|
| `src/core/orchestrator/index.ts` | `Orchestrator` class — `executeTask()`, session setup, preemption gate |
| `src/core/orchestrator/phase-runner.ts` | `runPhasePipeline()` — main loop, resume, routing, loopback |
| `src/core/orchestrator/phase-handlers.ts` | `createPhaseHandlers()` — 7 handler functions |
| `src/core/orchestrator/llm-caller.ts` | `createLlmCaller()` — CLI invocation, retry, cost tracking |
| `src/core/orchestrator/workspace-lifecycle.ts` | `createWorkspaceLifecycle()` — workspace + session setup |
| `src/core/orchestrator/pr-manager.ts` | `createPrManager()` — commit, push, PR creation |
| `src/core/orchestrator/decomposition-handler.ts` | `createDecompositionHandler()` — child task creation |
| `src/core/orchestrator/orchestrator-notifier.ts` | `createOrchestratorNotifier()` — milestone + issue comments |
| `src/core/orchestrator/andon-cord.ts` | `createAndonCord()` — emergency halt (reserved) |
| `src/core/orchestrator/session-result.ts` | `readSessionResult()`, `writeSessionResultTemplate()` |
| `src/core/orchestrator/types.ts` | `OrchestratorContext`, `ExecuteTaskResult`, `Outcome` |
| `src/core/orchestrator/errors.ts` | Orchestrator-specific errors |
| `src/core/orchestrator/prompts/index.ts` | Prompt barrel exports |
| `src/core/orchestrator/prompts/system.ts` | `buildCliNativeSystemPrompt()` — identity + RRPIR + security |
| `src/core/orchestrator/prompts/context.ts` | `gatherRepoContext()` — sync I/O: README, tree, commits, branch |
| `src/core/orchestrator/prompts/format.ts` | `section()`, `buildTaskBrief()`, formatting utilities |
| `src/core/orchestrator/prompts/requirements-gathering.ts` | Requirements phase prompt builder |
| `src/core/orchestrator/prompts/research.ts` | Research phase prompt builder |
| `src/core/orchestrator/prompts/planning.ts` | Planning phase prompt builder |
| `src/core/orchestrator/prompts/execution.ts` | Execution phase prompt builder |
| `src/core/orchestrator/prompts/review.ts` | Self-review phase prompt builder |
| `src/core/orchestrator/prompts/demo-prep.ts` | Demo-prep phase prompt builder |
| `src/core/orchestrator/prompts/integration.ts` | Integration phase prompt builder |

### Public API

- `Orchestrator`:
  - `executeTask(dispatch: Dispatch): Promise<ExecuteTaskResult>` — main entry
  - `attemptSelfUnblock(taskId): Promise<boolean>` — blocked task recovery
- `ExecuteTaskResult`: discriminated union (completed, review_pending, decomposed, preempted, blocked, error)
- Events: `cost.incurred`, `preemption.ready`, `comm.message_sent`
- Prompt builders: 7 phase-specific pure functions

### 7-Phase Pipeline

```
1. requirements_gathering → outreach if need_more_info → block task
2. research             → context + prior requirements
3. planning             → DECISION POINT: decomposition check
4. execution            → CLI-native, modifies files
5. self_review          → multi-step (review sub-phases + refinement) → LOOPBACK to execution (max 3)
6. demo_prep            → PR creation attempt → EXIT to review_pending
7. integration          → child task summaries, merge planning → COMPLETE
```

### Dependencies

**The most dependency-heavy system.** Imports from:
- All 8 `core/interfaces/*`
- `schemas/*` (task, events, orchestrator, session-memory, adapters, config, ephemeral)
- `adapters/*` (CommunicationAdapter, GitHostingAdapter, LLMAdapter)
- `utils/sanitize.ts`
- Receives via constructor: eventBus, registry, taskEngine, safetyLayer, actionPipeline, sessionMemory, workspaceManager, peopleDirectory, observationStore, observer

### State

- **Per-execution:** `PipelineState` (traceId, sessionId, loopbackCount, requirementsLoopCount, thoughtsDir, repoContext, returnToPhase)
- **Persistent:** task fields (phase, workspace, blocked, review, child_summaries) via TaskEngine
- **PreemptionGate:** `Map<taskId, preemption_payload>` (in-memory, EventBus-driven)

### Lifecycle

Created in bootstrap after all Core components. Long-lived. `executeTask()` called per dispatch from Daemon.

### Isolation Assessment

**Hardest to extract.** Depends on nearly everything. However, internal decomposition is clean — 9 focused subsystems via factory functions. Prompt builders are pure functions and fully extractable.

### Concerns

1. **`handlePostPhaseActions()` cognitive complexity** — 8 decision branches in one function. Biome-ignored. Trade-off between readability and cohesion.
2. **Session-result.json fallback** — missing file defaults to "phase succeeded". If CLI crashes before writing, pipeline continues as if OK.
3. **Workspace import from orchestrator** — `session-result.ts` is imported by `workspace-manager`, creating a backwards dependency.
4. **Prompt builders are pure but coupled to phase semantics** — changing a phase requires updating its prompt builder. This is acceptable coupling.
5. **Andon cord created but unused** — reserved for future emergency halt. Currently dead code.

---

## System 13: Runtime

> The always-running heartbeat. Tick loop, trigger polling, task scheduling, preemption, health monitoring, notifications, cost limits, review handling.

### Files (14)

| File | Purpose |
|------|---------|
| `src/core/daemon/index.ts` | `createDaemon()` factory — tick loop, P1 startup, P15 shutdown |
| `src/core/daemon/types.ts` | `DaemonContext`, `DaemonState`, `Daemon` interface |
| `src/core/daemon/errors.ts` | Daemon-specific errors |
| `src/core/daemon/trigger-poller.ts` | `createTriggerPoller()` — adaptive polling, dedup, backoff |
| `src/core/daemon/task-scheduler.ts` | `createTaskScheduler()` — slot management, dispatch, priority aging |
| `src/core/daemon/response-poller.ts` | `createResponsePoller()` — comm plugin polling for blocked tasks |
| `src/core/daemon/preemption-manager.ts` | `createPreemptionManager()` — priority-based task preemption |
| `src/core/daemon/review-handler.ts` | `createReviewHandler()` — PR merge/feedback detection |
| `src/core/daemon/health-monitor.ts` | `createDaemonHealthMonitor()` — stuck detection, blocked escalation |
| `src/core/daemon/notification-router.ts` | `createNotificationRouter()` — multi-channel fire-and-forget |
| `src/core/daemon/cost-limit-queue.ts` | `createCostLimitQueue()` — event-driven cost blocking |
| `src/core/daemon/query-handler.ts` | `handleQuery()` — keyword-match status queries |
| `src/core/daemon/unblock-resolver.ts` | `createUnblockResolver()` — match responses to blocked tasks |

### Public API

- `createDaemon(ctx: DaemonContext): Daemon`
- `Daemon`: `start()`, `stop()`, `tick()`, `getState()`
- `DaemonState`: running, shuttingDown, activeTaskIds, tasksCompleted, etc.

### Tick Loop (12 steps)

```
1.  costLimitQueue.process()           — drain event-driven cost blocks
2.  triggerPoller.poll()               — detect new tasks
2b. responsePoller.poll()              — unblock tasks from responses
3.  Sync base priorities from triggers
4.  preemption.evaluate()              — check for preemption
5.  scheduler.scheduleNext()           — dispatch queued → active
6.  scheduler.applyPriorityAging()     — bump old queued tasks
7.  healthMonitor.checkStuckTasks()    — detect runaway tasks
8.  healthMonitor.checkBlockedEscalation() — escalate stuck-blocked
9.  healthMonitor.checkReviewPendingReminders() — notify reviewers
10. reviewHandler.checkMerges()        — detect merged PRs
11. reviewHandler.checkFeedback()      — detect review feedback
12. triggerPoller.cleanupExpiredKeys() — expire dedup keys
```

### Dependencies

**DaemonContext requires:** config, eventBus, registry, taskEngine, safetyLayer, orchestrator, sessionMemory, workspaceManager, peopleDirectory, clock, observer, engineerHome, dataLifecycleManager

### State

- `running`, `shuttingDown` flags
- `activeDispatches: Map<taskId, Promise>` (in scheduler)
- `seenTriggerKeys: Map<string, timestamp>` (TTL dedup in trigger poller)
- `basePriorities: Map<taskId, number>` (priority aging)
- `blockedEscalationState: Map<taskId, EscalationState>` (health monitor)
- `pendingPreemption` (nullable)

### Lifecycle

- **P1 (Startup):** PID file → health check loop → data lifecycle → orphan recovery → EventBus subscriptions → tick interval → signal handlers
- **P15 (Shutdown):** Clear interval → flush cost → stop data lifecycle → drain dispatches → registry shutdown → unsubscribe → remove PID → log uptime

### Isolation Assessment

**Second hardest to extract** (after Orchestrator). Depends on Orchestrator + all Core services. However, internal decomposition into 9 focused subsystems is excellent — each is a closure-based factory with narrow dependencies.

### Concerns

1. **Tick loop is synchronous per-step** — steps 1-12 run sequentially. A slow step blocks the whole tick.
2. **Fire-and-forget dispatch** — `scheduler.dispatchTask()` spawns async execution without await. Task completion handled via callback.
3. **State in closures** — internal state of subsystems is hidden. `getState()` exposes a snapshot, but debugging requires observer logging.
4. **TTL dedup uses wall-clock time** — vulnerable to clock skew (minor risk).

---

## System 14: Interface

> User-facing CLI, component wiring (bootstrap), and the core system factory.

### Files (17)

| File | Purpose |
|------|---------|
| `src/index.ts` | Shebang entry point → `program.parseAsync()` |
| `src/cli/index.ts` | Commander.js program definition, 12+ commands |
| `src/cli/bootstrap.ts` | `bootstrap()` — 13-step component wiring, error recovery |
| `src/cli/output.ts` | `Output` class — mode-aware (human/json/quiet), color, singleton |
| `src/cli/progress.ts` | `Spinner` class — animated progress (braille frames, 80ms) |
| `src/cli/home.ts` | `resolveEngineerHome()`, `resolveDirectories()` |
| `src/cli/pid.ts` | `readPidFile()`, `isProcessRunning()` |
| `src/cli/constants.ts` | YAML_EXTENSION_PATTERN |
| `src/cli/templates.ts` | 11 template configs for `engineer init` |
| `src/cli/commands/start.ts` | Foreground/background/dry-run startup |
| `src/cli/commands/shutdown.ts` | Graceful SIGTERM + polling |
| `src/cli/commands/status.ts` | Process + queue status |
| `src/cli/commands/logs.ts` | Log viewing (static + follow mode) |
| `src/cli/commands/doctor.ts` | 11-category health checks |
| `src/cli/commands/init.ts` | First-run scaffold + interactive plugin selection |
| `src/cli/commands/setup.ts` | Full interactive wizard |
| `src/cli/commands/create-plugin.ts` | Plugin scaffolding (5 adapter types) |
| `src/cli/commands/config-validate.ts` | Schema validation |
| `src/cli/commands/config-migrate.ts` | Version migration (future) |
| `src/cli/commands/install.ts` | OS service config (launchd/systemd) |
| `src/cli/commands/prepare.ts` | Seed directory generation |
| `src/cli/commands/dashboard.ts` | Dashboard launch |
| `src/cli/commands/start-dashboard.ts` | Standalone dashboard |
| `src/cli/commands/start-background.ts` | Background daemon spawn |
| `src/cli/commands/why.ts` | Task explanation timeline |
| `src/core/system.ts` | `createCoreComponents()` — dependency-ordered core factory |

### Public API

- `program` (Commander): parses CLI args, routes to command handlers
- `bootstrap(options): Promise<BootstrapResult>` — wires all 12+ components
- `createCoreComponents(input): CoreComponentGraph` — creates 6 core components in dependency order
- Various command functions: `runStart()`, `runShutdown()`, `runStatus()`, etc.

### Bootstrap Creation Order

```
1.  Logger (pino transport)
2.  Observer facade (logging ready, tracing no-op)
3.  Database (SQLite + migrations)
4.  Core Components via createCoreComponents():
    a. EventTopology
    b. EventBus
    c. TaskEngine
    d. SafetyLayer
    e. ActionPipeline
    f. SessionMemory
    g. WorkspaceManager
5.  HookRegistry
6.  Registry
7.  Observability upgrade (observer.upgrade(store))
8.  PeopleDirectory
9.  Orchestrator
10. DataLifecycleManager
11. Daemon
12. Event topology subscriptions
13. Plugin loading
```

### Dependencies

**Imports from everything.** Bootstrap is the top of the DAG — no component imports from it.

### State

- `Output` singleton (CLI-only, module-level)
- No other global state

### Lifecycle

- CLI commands are short-lived (one-shot)
- `start` command transitions to long-lived via Daemon
- Bootstrap is a one-shot orchestration function

### Isolation Assessment

**Not extractable** — this IS the integration point. However, `createCoreComponents()` in `system.ts` is a clean extraction of the core wiring logic, usable by tests.

### Concerns

1. **Output singleton** — the only global mutable state in the entire system. CLI-only, acceptable.
2. **Bootstrap tight coupling** — imports from ALL subsystems. By design, but makes it the most change-sensitive file.
3. **No abstraction between CLI and bootstrap** — commands import bootstrap directly. Acceptable given CLI is the only consumer.

---

## System 15: Dashboard

> Real-time observability HTTP server. Read-only DB access + SSE streaming. Completely independent of daemon.

### Files (10)

| File | Purpose |
|------|---------|
| `src/dashboard/index.ts` | `startDashboard()` — HTTP server entry point |
| `src/dashboard/server.ts` | `createDashboardApp()` — Hono wiring, route mounting |
| `src/dashboard/api/tasks.ts` | Task list/detail/timeline endpoints |
| `src/dashboard/api/events.ts` | Filterable event stream |
| `src/dashboard/api/metrics.ts` | Cost aggregations + quota status |
| `src/dashboard/api/observations.ts` | Generic observations query |
| `src/dashboard/api/traces.ts` | Tool + LLM traces + blob access |
| `src/dashboard/api/messages.ts` | Owner response POST (unblock) |
| `src/dashboard/api/stream.ts` | SSE streaming (observations + events, 1s poll, 15s heartbeat) |
| `src/dashboard/api/system.ts` | Aggregate status + health events |
| `src/dashboard/static/index.html` | 98KB bundled React SPA |

### Public API

- `startDashboard(config, port): { close() }`
- 15+ HTTP endpoints (GET /api/tasks, /api/events, /api/metrics, /api/stream, POST /api/messages, etc.)

### Dependencies

**External:** `hono`, `@hono/node-server`, `better-sqlite3`
**Internal:** `core/observer/` (BlobStore, createObservationStore), `schemas/observer.ts`

### State

- **None persistent.** Read-only DB connections.
- **Per-SSE connection:** cursor state (lastObsRowId, lastEventSeq)
- Two DB connections: `db` (read-only), `writeDb` (for POST /api/messages only)

### Lifecycle

- Can start **independently** of daemon (standalone mode)
- Can run **co-located** with daemon (same process)
- SSE streams are long-lived per-connection

### Isolation Assessment

**Fully extractable.** Minimal dependencies (observer for BlobStore, schemas for types). Shares only the SQLite file with daemon. Could become a completely separate process with no code changes.

### Concerns

1. **Static SPA bundled as single HTML file** — 98KB. Works but not ideal for development iteration.
2. **CORS restricted to localhost** — correct for security, but may need adjustment for remote access.
3. **POST /api/messages writes to events table** — the only write operation. Creates coupling via shared DB.
4. **No authentication** — anyone on localhost can read all task data and send responses.

---

## System 16: Maintenance

> Automatic data retention and cleanup. Prunes old observations, events, journal entries, checkpoints. Manages blob storage.

### Files (1)

| File | Purpose |
|------|---------|
| `src/core/data-lifecycle/index.ts` | `createDataLifecycleManager()` — periodic cleanup, blob orphan removal, vacuum |

### Public API

- `createDataLifecycleManager(deps): DataLifecycleManager`
- `DataLifecycleManager`: `start()`, `stop()`, `runCleanup(): CleanupStats`, `getLastRun()`
- Pure exports: `cleanupTable()`, `collectReferencedBlobRefs()`, `cleanupOrphanedBlobs()`
- Events: `system.cleanup_completed`

### Dependencies

**External:** `better-sqlite3`, `node:fs`, `node:path`
**Internal:** `db/database.ts` (runIncrementalVacuum), `schemas/config.ts`, `schemas/events.ts`, `utils/clock.ts`, `utils/sanitize.ts`, `core/interfaces/event-bus.interface.ts`, `core/observer`

### State

- `interval: ReturnType<typeof setInterval> | null`
- `lastRun: CleanupStats | null`

### Lifecycle

Started by Daemon. Periodic interval (configurable). Stopped on shutdown.

### Isolation Assessment

**Extractable.** Clean dependencies. Could be a separate service that shares the DB file.

### Concerns

1. **Blob cleanup filesystem traversal** is complex (5+ levels of error handling, biome-ignored complexity).
2. **Active task protection** via SQL subquery — prevents accidental data loss.
3. **Path confinement checks** prevent symlink attacks in blob cleanup.

---

## Cross-System Dependency Graph

```
                         ┌─────────────┐
                         │  INTERFACE   │  (CLI + Bootstrap)
                         │  System 14   │
                         └──────┬───────┘
                                │ creates all
                 ┌──────────────┼──────────────┐
                 │              │              │
          ┌──────▼──────┐ ┌────▼─────┐ ┌──────▼──────┐
          │   RUNTIME   │ │DASHBOARD │ │ MAINTENANCE  │
          │  System 13  │ │System 15 │ │  System 16   │
          └──────┬──────┘ └────┬─────┘ └──────┬───────┘
                 │             │(DB only)      │
          ┌──────▼──────┐     │         ┌─────▼────────┐
          │INTELLIGENCE │     │         │  EVENT BUS   │
          │  System 12  │     │         │  System 4    │
          └──────┬──────┘     │         └──────────────┘
                 │             │
    ┌────────────┼────────────┐│
    │   CORE SERVICES Layer   ││
    │ ┌────┐┌────┐┌────┐┌───┐││
    │ │ S6 ││ S7 ││ S8 ││S9 │││
    │ │Task││Auth││Mem ││WS │││     ┌───────────────┐
    │ └────┘└────┘└────┘└───┘││     │PLUGIN ECOSYS. │
    │         ┌────┐         ││     │  System 11    │
    │         │S10 │         ││     │(Adapters+Reg.)│
    │         │Cont│         ││     └───────────────┘
    │         └────┘         ││
    └────────────────────────┘│
                 │            │
    ┌────────────┼────────────┘
    │   COMMUNICATION Layer   │
    │ ┌──────────┐┌─────────┐ │
    │ │EVENT BUS ││OBSERVER │ │
    │ │ System 4 ││System 5 │ │
    │ └──────────┘└─────────┘ │
    └────────────┬────────────┘
                 │
    ┌────────────┼────────────┐
    │  INFRASTRUCTURE Layer   │
    │ ┌──────┐ ┌────────────┐ │
    │ │  DB  │ │   CONFIG   │ │
    │ │Sys 2 │ │  System 3  │ │
    │ └──────┘ └────────────┘ │
    └────────────┬────────────┘
                 │
    ┌────────────┼────────────┐
    │     FOUNDATION Layer    │
    │ ┌────────┐ ┌──────────┐ │
    │ │SCHEMAS │ │  UTILS   │ │
    │ │        │ │          │ │
    │ └────────┘ └──────────┘ │
    └─────────────────────────┘
```

---

## Shared State Analysis

### Global Mutable State

| What | Where | Impact |
|------|-------|--------|
| `Output` singleton | `src/cli/output.ts` | CLI-only, single-process |
| `SharedContext` (Observer) | `src/core/observer/facade.ts` | Shared by all observer instances, mutated once via `upgrade()` |

**That's it.** Two pieces of global mutable state in the entire system. Everything else is either immutable (schemas, const arrays) or instance-owned (Maps, prepared statements).

### Shared Database Tables

**Critical design constraint: each table has exactly ONE exclusive writer.**

| Table | Writer | Readers |
|-------|--------|---------|
| `tasks` | TaskEngine | Daemon, Orchestrator, Dashboard, SafetyLayer |
| `state_transitions` | TaskEngine | Dashboard, CLI (why command) |
| `events` | EventBus (+Dashboard POST) | Daemon, Orchestrator, SafetyLayer, Dashboard |
| `sessions` | SessionMemory | Orchestrator, Dashboard |
| `journal_entries` | SessionMemory | Orchestrator, Dashboard |
| `checkpoints` | SessionMemory | Orchestrator, Daemon |
| `knowledge` | SessionMemory | Orchestrator |
| `observations` | ObservationStore | Dashboard |
| `_meta` | Database (migrations), SafetyLayer (cost snapshot) | SafetyLayer (restore) |

### Shared Event Types (Publish → Subscribe)

| Event Pattern | Publisher(s) | Subscriber(s) |
|---------------|-------------|---------------|
| `task.created` | TaskEngine | (no subscribers — informational) |
| `task.state_changed` | TaskEngine | Daemon (state sync), SafetyLayer (cost cleanup) |
| `task.children_all_done` | Daemon | Daemon (parent integration) |
| `task.feedback_received` | Daemon | Daemon (review handler) |
| `action.rejected` | ActionPipeline | (no subscribers — audit only) |
| `cost.incurred` | Orchestrator | SafetyLayer (cost accumulation) |
| `cost.limit_reached` | SafetyLayer | Daemon (cost limit queue) |
| `preemption.requested` | Daemon | Orchestrator (preemption gate) |
| `preemption.ready` | Orchestrator | Daemon (preemption completion) |
| `comm.message_received` | Dashboard POST | Daemon (response poller) |
| `comm.message_sent` | Orchestrator | (no subscribers — audit only) |
| `health.*` | Registry | (no subscribers — audit/dashboard only) |
| `workspace.*` | WorkspaceManager | (no subscribers — audit/dashboard only) |
| `system.cleanup_completed` | DataLifecycleManager | (no subscribers — audit only) |

---

## Circular Dependency Audit

**Result: ZERO circular dependencies.**

The import graph forms a strict DAG (directed acyclic graph):

```
Foundation → Infrastructure → Communication → Core Services → Intelligence → Runtime → Interface
```

No component imports from any component that depends on it. Verified by tracing all import paths.

**One potential architectural backwards reference:** `workspace-manager/index.ts` imports from `orchestrator/session-result.ts`. This is a Layer 3 → Layer 5 import, violating the layer hierarchy. It should be extracted to a shared utility.

---

## Isolation Assessment

### Extraction Readiness Score

| System | Score | Blocking Issues |
|--------|-------|-----------------|
| S1: Foundation | 10/10 | None. Zero dependencies. |
| S2: Database | 10/10 | None. Only depends on utils. |
| S3: Configuration | 9/10 | Depends on schemas (co-extract). |
| S4: Event Bus | 8/10 | Depends on schemas + observer. |
| S5: Observability | 8/10 | Late-binding pattern, DB dependency. |
| S6: Task Management | 8/10 | Clean interface. Depends on EventBus + schemas. |
| S7: Authorization | 8/10 | ActionPipeline + SafetyLayer together. EventBus for cost events. |
| S8: Memory | 9/10 | Minimal deps (DB + schemas + sanitize). |
| S9: Workspace | 7/10 | **Backwards import from orchestrator.** Sync git I/O. |
| S10: Contacts | 10/10 | Zero core coupling. |
| S11: Plugin Ecosystem | 8/10 | Adapters=10/10, Registry needs EventBus. |
| S12: Intelligence | 5/10 | Depends on nearly everything. Clean internal decomposition helps. |
| S13: Runtime | 5/10 | Depends on Intelligence + all Core. Excellent internal decomposition. |
| S14: Interface | N/A | Integration point by design. |
| S15: Dashboard | 9/10 | Only needs DB + observer schemas. |
| S16: Maintenance | 9/10 | Clean deps. Could be separate service. |

---

## Architectural Strengths

1. **Zero circular dependencies** — strict DAG. Safe to refactor any layer without cascading.
2. **Exclusive table writers** — no race conditions, no lock contention. Each table owned by one component.
3. **Interface-based injection** — 8 well-defined interfaces decouple all core components. Implementations swappable.
4. **Event Bus as communication backbone** — loose coupling between Daemon, Orchestrator, SafetyLayer. Components don't import each other directly for cross-cutting flows.
5. **Factory-function decomposition** — Daemon and Orchestrator internally use closure-based factories (createTriggerPoller, createPhaseHandlers, etc.), making sub-systems testable in isolation.
6. **Pure functions everywhere** — prompt builders, permission checks, pattern matching, slug generation, cost calculations. Easy to test, easy to extract.
7. **Three-tier observability** — Events (audit trail), Observations (traces), Logs (ops). Clean separation of concerns.
8. **Security-conscious throughout** — token sanitization at 3 chokepoints, workspace path confinement, env var allowlists, file permission enforcement.
9. **Dashboard independence** — fully standalone, read-only DB access, zero daemon coupling.
10. **Plugin SDK boundary** — `src/adapters/index.ts` is the single import point. Tier violation prevented by design.

---

## Architectural Concerns

### Category A: Layer Violations

| # | Issue | Severity | Location |
|---|-------|----------|----------|
| A1 | Workspace Manager imports from Orchestrator (`session-result.ts`) | MEDIUM | `workspace-manager/index.ts` → `orchestrator/session-result.ts` |

### Category B: Duplication

| # | Issue | Severity | Location |
|---|-------|----------|----------|
| B1 | `buildLlmEnv()` duplicated in 3 LLM plugins | LOW | claude-code-llm, gemini-cli-llm, opencode-llm |
| B2 | GitHub error classification duplicated in trigger + comm | LOW | github-trigger, github-comm |

### Category C: Missing Abstractions

| # | Issue | Severity | Location |
|---|-------|----------|----------|
| C1 | Plugin priority = registration order (no explicit priority) | LOW | registry/lifecycle.ts |
| C2 | `deregister()` doesn't call `shutdown()` (resource leak risk) | LOW | registry/index.ts |
| C3 | Observer typed as `unknown` in BaseAdapter (tier boundary hack) | LOW | adapters/base.ts |

### Category D: Information Loss

| # | Issue | Severity | Location |
|---|-------|----------|----------|
| D1 | Safety warnings lost in ActionPipeline "executed" path | MEDIUM | action-pipeline/index.ts |
| D2 | Payload sanitization is publisher responsibility (easy to forget) | MEDIUM | event-bus/index.ts |
| D3 | ObserverStream subscriber errors never logged (circularity avoidance) | LOW | observer/stream.ts |

### Category E: Operational Risks

| # | Issue | Severity | Location |
|---|-------|----------|----------|
| E1 | Synchronous git operations block event loop | LOW | workspace-manager/index.ts |
| E2 | Event Bus synchronous delivery (slow subscriber blocks all) | LOW | event-bus/index.ts |
| E3 | Dashboard has no authentication | MEDIUM | dashboard/server.ts |
| E4 | Cost window rollover is event-driven (can be stale for hours) | LOW | safety-layer/cost-tracker.ts |

### Category F: Dead or Underused Code

| # | Issue | Severity | Location |
|---|-------|----------|----------|
| F1 | Andon cord created but never checked in pipeline | LOW | orchestrator/andon-cord.ts |
| F2 | Config watcher ready but not wired in bootstrap | LOW | config/watcher.ts |
| F3 | `ephemeral.ts` is a grab-bag of unrelated schemas | LOW | schemas/ephemeral.ts |
