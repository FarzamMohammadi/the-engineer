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

---

## Part II: Gap Analysis — The Engineer vs. The Greatest OSS Projects

> The top 5 OSS projects (Linux Kernel, SQLite, PostgreSQL, Git, Nginx) didn't start great. Linux 0.01 was a mess. Git's first commit was rough. What made them legendary is what happened *after* v1 — thousands of real failures that exposed every weak assumption, and maintainers with the taste to simplify instead of patch.
>
> We don't care what they started out as. We want to be better than what they are *now*. This analysis holds The Engineer against those projects at their peak — not their v1 — and asks: what will it take to reach and surpass that tier?
>
> Three independent perspectives examined the codebase: The Engineer's own persona (taste and judgment), a Technical Architect (engineering rigor), and the lens of Linus Torvalds (data structures and practicality). Their findings are synthesized below.

---

### Where The Engineer Genuinely Excels

These are real strengths — not participation trophies. Things the greats would recognize as correct.

1. **State machine as data, not code.** `ValidTransitions` is a static const array of `{from, to}` pairs. `PermissionTable` couples state to allowed actions. This is the same pattern SQLite uses for its state machines and the Linux kernel uses for TCP state transitions. When the state machine is data, you can validate it exhaustively, visualize it, and reason about it without reading code. This is genuinely good.

2. **EventBus as audit trail with persist-before-deliver.** Every event hits SQLite before any subscriber sees it. This mirrors write-ahead logging in databases. The `replay()` method for state reconstruction on startup is the right pattern. This is not just pub/sub — it's a safety guarantee.

3. **Interface segregation done well.** The 8 interfaces are tight, minimal contracts. `ITaskEngine` is 11 methods. The Orchestrator depends on `IPluginLookup`, not the full `Registry`. These are the narrow interfaces that the greats use — do one thing, take obvious arguments, return obvious results.

4. **Factory-function decomposition in the Daemon.** `createDaemon()` returns `{ start, stop, tick, getState }`. Four methods. The closure-based subsystems (scheduler, triggerPoller, preemption, etc.) create real modularity without class hierarchies. This is closer to how nginx modules work.

5. **Pure function extraction is consistent.** `computeAgedPriority`, `isSlotConsuming`, `matchesPattern`, `checkPermission` — testable, composable, side-effect-free. This discipline runs across the entire codebase, not just one corner.

6. **Zero circular dependencies, exclusive DB writer per table.** Verified by tooling. No component imports from something that depends on it. Each table has exactly one writer. This prevents race conditions without locks and makes the dependency graph a strict DAG. This is a real structural achievement.

7. **Plugin SDK boundary enforcement.** `src/adapters/index.ts` is the single import point. Plugins cannot import from Core. This is how a well-designed SDK works.

---

### Where It Falls Short — Not in Scale, but in Quality of Thinking

#### The Phase Runner Is a God Function

`src/core/orchestrator/phase-runner.ts` — the most important file in the system and the worst designed. Two `biome-ignore` complexity suppressions. `handlePostPhaseActions` takes multiple parameters and contains 8 decision branches. `runPhasePipeline` has a for loop with mutable state, three loopback paths, and a discriminated union of post-phase outcomes that exists solely to manage control flow within one function.

Compare to how Git handles multi-step operations. Git's `merge.c` doesn't have a 1,000-line function. It has a merge strategy interface, and each strategy is a separate module. The orchestration is a thin loop that calls `strategy->merge()`.

The Phase Runner is trying to be the state machine AND the business logic AND the error handler AND the observability layer AND the notification sender AND the outreach manager AND the PR creator. A truly great engineer would split this into a phase state machine (pure data, like `ValidTransitions`) plus individual phase completion handlers.

#### 18 biome-ignore Complexity Suppressions Is a Design Smell

Eighteen functions across the codebase are too complex for the linter. The justification is always "extraction would fragment the logic." That's what every engineer says when they haven't found the right abstraction yet. SQLite has functions over 1,000 lines, but they're generated code or inherently sequential I/O. These 18 suppressions are in business logic, retry logic, and pipeline orchestration — places where the right abstraction would eliminate the complexity.

#### The Task Schema Is a God Object

`TaskSchema` has 33+ fields. A Task knows about its workspace, review state, blocked details, child summaries, loopback counts, decisions, and team members. This is an Active Record anti-pattern hiding behind a Zod schema.

Compare to Git's commit object: tree, parent(s), author, committer, message. Five concepts. Everything else lives in separate objects referenced by hash.

The `updateTaskField` method accepting `value: unknown` for 21 different fields is the symptom. This is stringly-typed mutation. A real type system would have `updateWorkspace(taskId, workspace: TaskWorkspace)` — one method per concern, fully typed. The `JSON_FIELDS` set that decides "does this need serialization?" at runtime is doing work the type system should do at compile time.

#### The OrchestratorContext Has 11 Dependencies

When a component needs 11 collaborators, it has too many responsibilities. The Orchestrator is the "flight director," but a flight director doesn't personally operate the radio, the fuel gauges, the landing gear, and the coffee machine. It delegates to specialist stations. The Orchestrator should take ~5 dependencies; the rest should be injected into the subsystems that actually use them.

#### Over-Abstraction for Current Scale

For a system that currently runs one task at a time (`max_concurrent` defaults to 1):
- 36 event types. Linux started with `fork()`, `exec()`, and signals.
- The Observer/ObservationStore/BlobStore/SSE stack is three separate persistence layers for a single-process system.
- HookRegistry with 10 hook points and zero registrations. Dead infrastructure.
- PreemptionGate + cooperative preemption protocol — with `max_concurrent: 1`, there's nothing to preempt.
- EventTopology with publisher/subscriber registration for a system where all participants are known at bootstrap.

Some complexity is earned (safety layer, cost tracking, workspace isolation). Some is not.

#### 16 Systems for ~130 Files Is Over-Segmented

160 non-test source files for ~29K lines of code. That's 180 lines per file average. Some files exist only to re-export or hold 20 lines of type definitions. The system count (16) and the layer count (8) reflect the design documents more than the code's natural structure. A truly great engineer would have fewer, more substantial modules.

---

### Architecture Quality Scores (Technical Architect Assessment)

| Dimension | Score | Key Factor |
|-----------|-------|------------|
| Boundary Clarity | 8/10 | Strong tier enforcement, minor concrete dependency leaks |
| Contract Quality | 8/10 | Good interface design, `updateTaskField` is the weak spot |
| Simplicity | 6/10 | Substantial machinery for single-task execution |
| Operational Readiness | 7/10 | Good crash recovery, missing auth + circuit breaking |
| Extensibility | 8/10 | Plugin substitution works, plugin composition does not |
| Error Model | 7/10 | Per-subsystem is good, no global taxonomy |
| Data Model | 8/10 | SQLite is right, JSON columns will hurt at scale |
| **Overall** | **7.4/10** | |

---

### What Would Reach the Next Tier — Concrete Actions

#### Delete

1. **Delete the AndonCord** (`orchestrator/andon-cord.ts`). Zero callers in production. A concept imported from Toyota that doesn't map to this domain. The system already has cost limits, stuck detection, and blocked escalation. YAGNI.

2. **Delete `ephemeral.ts` Zod schemas for in-memory state.** `DaemonStateSchema`, `WorkspaceStateSchema` — nobody validates in-memory state at runtime. Use TypeScript interfaces. These exist because the architecture was designed documentation-first and implemented literally.

3. **Delete the HookRegistry** (or shelve it). 10 hook points, zero consumers. Speculative infrastructure. When you need hooks, add them. The cost of dead code is that every new developer asks "what are hooks for?" and nobody can answer.

4. **Delete the 10 re-export bridges.** "Re-export for backward compatibility" comments are scar tissue. Update consumers to import from the actual module. PostgreSQL is ruthless about this: when they move a function, they update every caller.

5. **Kill the SBAR handoff formatting.** `formatPhaseHandoff()` formats every phase transition as a medical Situation/Background/Assessment/Recommendation log entry. Nobody reads structured SBAR entries in a log file. A simple `"Completed research, entering planning. 2 open questions."` carries the same information.

6. **Remove the config watcher** until it's wired. Dead code is a lie about the system.

#### Simplify

7. **Split the Task schema into focused objects.** Task identity + state (~10 fields). TaskWorkspace (repo, branch, worktree). TaskReview (PR, feedback rounds). TaskBlocked (reason, contacts, efforts). Related by `task_id` foreign key, not by nesting 33 fields into one row. This also fixes `updateTaskField(field, unknown)` — each sub-table gets typed update methods.

8. **Decompose `phase-runner.ts` into state machine + handlers.** Replace `handlePostPhaseActions` with:
   - A `PhaseCompletionPolicy` — pure function per phase returning `{next, loopback?, exit?}`
   - A generic `advancePipeline(phase, output, policy)` — under 50 lines
   - Move PR creation, decomposition, outreach into phase-specific completion hooks

9. **Reduce OrchestratorContext to ~5 dependencies.** The Orchestrator should take: `taskEngine`, `llmCaller`, `workspaceManager`, `sessionMemory`, and `observer`. Everything else should be injected into subsystems that actually use them.

10. **Unify the 3 LLM plugin NDJSON parsers.** Extract shared `parseNdjsonStream()`. Three complexity suppressions become zero.

11. **Make the tick loop a named step array.** `const TICK_STEPS = [processCostFlags, pollTriggers, pollResponses, ...]`. Then `tick()` is `for (const step of TICK_STEPS) await step(now)`. This is how nginx's event loop works. Self-documenting and testable at the step level.

12. **Eliminate event payload casts.** Throughout the daemon, `event.payload as EventPayloads["cost.limit_reached"]` is an unchecked cast. Add a `typedPayload<T>(event, type)` helper that validates at runtime. ~15 lines that close a real safety gap.

#### Elevate

13. **Introduce a proper error taxonomy.** Nine `errors.ts` files with no common hierarchy. Every error should be one of: `TRANSIENT` (retry), `PERMANENT` (fail the task), `OPERATIONAL` (alert the human), `BUG` (halt and scream). The retry logic in `llm-caller.ts` does string matching on error messages because there's no structured error code to match on.

14. **Split EventBus delivery from persistence.** Current `publish()` does insert + synchronous deliver in one call. Split: `persist()` returns the event, `deliver()` fans out with per-subscriber timeout. This is the difference between "we know about slow subscribers" and "slow subscribers can't cascade."

15. **Add dashboard authentication.** Even localhost-only, a bearer token from a file would prevent rogue processes from reading task data or triggering VS Code via `/api/open-explorer`.

16. **Index the events table for cleanup.** `CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp)`. One line. Prevents full table scan on every data lifecycle run.

17. **Move prompt templates to `.md` files loaded at runtime.** The ~1,800 lines of prompt builders are string concatenation in TypeScript. They change every time the LLM interaction model changes. They should be template files, not compiled code.

---

### Principles to Adopt from the Greats

#### From SQLite: Minimal Surface

SQLite has 5 C files that matter. The entire public API fits on one printed page. This codebase has 130 source files for a system that does one thing: take a GitHub issue, run it through an LLM pipeline, and create a PR. SQLite would express this as: TaskStore, Pipeline, Adapter, and main(). Four concepts.

**Lesson:** Count your concepts. If you need more than one hand to list them, ask which ones earn their existence.

#### From Git: Content-Addressable Thinking

Git doesn't have a "FileManager" or a "CommitEngine" or a "BranchScheduler." It has objects (blobs, trees, commits, tags) and operations on objects. The data model IS the system. Everything falls out of the data structures.

**Lesson:** The Engineer should think harder about what its "objects" are. A Task, a Phase Output, a Session, a Cost Record — these are the objects. The 13 "core components" are really operations masquerading as entities.

**The gap:** If The Engineer had Git's clarity, the core insight might be: "A task is a sequence of immutable events, and the current state is always a fold over those events." The events table already exists. The state machine already exists. But the `tasks` table is a mutable god object updated in place, and the events are a parallel record you could delete without changing behavior. Events should be the source of truth, not a log.

#### From Linux Kernel: Layered Contracts, Not Layered Bureaucracy

The kernel has a clear contract between userspace and kernel (syscalls), and between subsystems (internal APIs). But it doesn't have 8 layers of documentation before a single line of code. This project has 175+ decisions for ~29K lines of non-test code — roughly 1 decision per 166 lines. The ratio should be 10x lower. Most decisions should be implicit in the code.

**Lesson:** The codebase respects its own design documents too much. 175 architectural decisions implemented faithfully, but a great engineer would have thrown away 40% during implementation because the code revealed simpler solutions.

#### From Nginx: The Event Loop Is Sacred

Nginx's event loop is tiny, deterministic, and every step is named. The Daemon tick loop has the right instinct but is a procedural sequence rather than a pluggable pipeline. Making the tick a named array of steps — where steps can be added/removed/reordered without touching the loop itself — brings it to nginx's level of clarity.

#### From PostgreSQL: Fail Loudly, Recover Quietly

PostgreSQL's error handling is meticulous — every error has a code, every recovery path is documented, and panic vs. error is a fundamental distinction. This codebase logs warnings for things that should be errors, catches and continues when it should halt, and uses `observer.warn` as a general-purpose "something might be wrong" signal.

**Lesson:** Build a proper error taxonomy. `TRANSIENT`, `PERMANENT`, `OPERATIONAL`, `BUG`. Every error in every subsystem classifies as one. Retry logic keys off classification, not string matching.

---

### What Exists But Shouldn't — The Hardest Question

These are things that seemed like good ideas but a truly great engineer would say "this doesn't need to exist":

1. **`ephemeral.ts` Zod schemas for in-memory state.** A Zod schema for `DaemonStateSchema` that is never validated at runtime is documentation pretending to be code.

2. **The AndonCord.** A Toyota Production System reference that exists as a boolean flag with zero callers.

3. **The SBAR handoff logging.** Medical communication protocol formatting for log messages. Charming conceptual design with zero operational value.

4. **`EventSubscriptionSchema` with `callback: z.unknown()`.** A Zod schema that cannot validate the thing it describes. It exists because "everything gets a schema" was a design rule that shouldn't have been applied here.

5. **The `EventDeclaration` arrays co-located in every module.** Runtime documentation that could be a single catalog file or just test infrastructure.

6. **The dual `observationStore` and `observer` in OrchestratorContext.** The Observer already wraps the ObservationStore. Having both is a leaky abstraction — the Orchestrator calls one in some places and the other in others. Pick one.

7. **The 7 narrowed `Pick<>` types in `daemon/types.ts`.** Seven type aliases to "minimize" context. They add cognitive overhead without preventing misuse. Every subsystem could take `DaemonContext` and behave identically.

8. **The 1,800 lines of prompt templates as TypeScript functions.** These are the largest non-test, non-schema source files. They're string concatenation that changes with every LLM interaction update. They should be template files loaded at runtime, not compiled TypeScript.

---

### What Scares the Experts at 10x Complexity

1. **The Task schema.** 33+ fields, 8 JSON columns, one table. At 10x you need to query by workspace branch, review state, child task status, cost bucket. Every one requires JSON extraction at query time. Normalizing later means rewriting the data access layer.

2. **Synchronous EventBus.** At 10x (10 concurrent tasks), each emitting events on every phase transition. If any subscriber takes 100ms (GitHub API call in notification router), all event delivery blocks. This is the nginx lesson: synchronous I/O in the event path kills throughput.

3. **The Phase Runner at 10x.** Parallel phase execution, streaming LLM output, multi-repo coordination, partial rollback — any of these requires restructuring 1,080 lines of tightly coupled control flow.

4. **Single-process architecture.** One SQLite file, one Daemon, one PID file. Horizontal scaling requires revisiting every design decision (in-memory subscriber registry, closure-based subsystems, synchronous event delivery).

5. **The prompt system.** At 10x task complexity, prompts need context prioritization, summarization, incremental feeding. Current design gathers repo context once with no strategy for growing context windows.

---

### The Path Forward

The path to the next tier is not adding more. It is:

1. **Removing 20% of what exists** — the dead code, the over-abstraction, the ceremony that serves the architecture more than the user.

2. **Collapsing the 33-field Task into focused objects** — identity, workspace, review, tracking as separate concerns related by foreign key.

3. **Turning the 1,080-line Phase Runner into a 200-line state machine** plus pluggable handlers.

4. **Accepting that some design concepts — however beautiful on paper — don't earn their bytes** in the compiled output.

5. **Building a proper error taxonomy** so retry logic, escalation, and alerting are driven by classification, not string matching.

6. **Making events the source of truth** — not a parallel log that could be deleted without changing behavior.

The greats got great by deleting. The interfaces and boundaries survive. The EventBus delivery model, the Task schema, and the phase runner need to evolve. This codebase is ready for that phase.

---

## Part III: Code-Level Brutality — Three Reviews That Read Every File

> The Part II analysis was synthesized from summaries. This section is different. Three reviewers were given the actual source files — not descriptions, not architecture docs — and told to read every line before judging. They did.
>
> **Linus Torvalds** — data structures, over-abstraction, "show me the code"
> **D. Richard Hipp (SQLite creator)** — radical simplicity, minimal surface, testing discipline
> **Rob Pike (Go, Plan 9)** — "less is exponentially more," clarity over cleverness

---

### Review 1: Linus Torvalds

#### Are the data structures right?

**The Task schema is a junk drawer.** `TaskSchema` in `src/schemas/task.ts` has 33 fields smashed into one flat object. Identity fields, state fields, hierarchy fields, context fields, workspace fields, review fields, blocked fields, tracking fields, timestamps, session links. It has `repo` AND `clone_url` AND `workspace` (which itself contains `repo`). It has `loopback_count` and `requirements_loop_count` — pipeline-internal counters that have no business being persisted on the task entity.

The `children` array stores `ChildEntry` objects with `{ id, state, depends_on }` — denormalizing child state into the parent. Every time a child transitions, you need to update the parent's JSON blob. That's a data consistency bug waiting to happen. You have a relational database. Use a foreign key.

The `events.ts` file is 540 lines of mechanical repetition. Every event type gets its own `FooBarPayloadSchema` + `FooBarPayload` type + entry in `EventPayloads` mapped type + entry in `eventPayloadSchemas` runtime registry. Four places to update for every new event. The payload schemas are fine in principle but the duplication is staggering.

**What's right:** `ValidTransitions` as a static const array is excellent. The state machine is data, not code. `PermissionTable` is the same quality. The knowledge table with content-hash primary keys is the closest thing here to Git-style content addressing.

**Fix:** Split `TaskSchema` into `TaskIdentity`, `TaskState`, `TaskWorkspace`, `TaskReview`, `TaskTracking`. Store children as a DB relationship. Kill `loopback_count` and `requirements_loop_count` from the task — those are session-scoped. The events file should be generated from a single declaration table, not hand-written four times over.

#### Is the adapter hierarchy earned or premature?

**It is premature.**

5 abstract adapter classes. A Registry with a health state machine (healthy/unhealthy/failed with transitions). A plugin loader with critical/non-critical distinction. A manifest schema with `contributes.events`, `contributes.commands`, `contributes.config_keys`, `contributes.hooks`.

And the actual plugins: ONE LLM plugin enabled (Claude Code). ONE trigger (GitHub). ONE tool (Bash). ONE git host (GitHub). The "swappable" LLM plugins (OpenCode, Gemini) are disabled by default.

`CommunicationAdapter` in `src/adapters/communication.ts` has 7 optional capability-gated methods. Each has a `do*` protected method that throws `capabilityError` by default. A lot of ceremony for "send a message" and "post a GitHub comment."

The `hookRegistry` field on `BaseAdapter` is typed as `unknown` "to avoid tier import violations." You built a hooks system with 10 hook points, wired it through bootstrap, injected it into every plugin instance via the Registry — and **nobody calls `hookRegistry.execute()` anywhere in production code.** Zero consumers. That is the textbook definition of speculative generality.

The health state machine — for plugins that are basically `spawn("claude")`. If Claude CLI is down, you don't need a three-state health machine. You need a try/catch.

**Verdict:** You built a plugin platform. You needed a function call. The adapter hierarchy will earn its place when you actually have 3 LLM providers that people switch between in production. Today it is dead weight.

#### Three files that make me wince

**File 1: `src/core/orchestrator/phase-runner.ts`** — 900+ lines containing: outreach file reading, issue commenting, a discriminated union type, start-state resolution, checkpoint creation, phase transition recording, error handling, preemption handling, self-review loopback, loopback alerting, PR creation, post-phase action handling, and the pipeline runner. `handlePostPhaseActions` takes 10 parameters, has a `biome-ignore` for complexity, and handles 9 different concerns. The `targetIndex - 1` trick (returning index minus one so the for loop's `i++` lands correctly) appears three times. That's the kind of clever that makes people curse your name at 2am.

**File 2: `src/schemas/events.ts`** — 540 lines of pure mechanical repetition. Four parallel lists that must stay synchronized. Add one event type? Touch three places. Miss one? Silent type mismatch at runtime. This is a maintenance nightmare.

**File 3: `src/adapters/base.ts`** — `hookRegistry?: unknown` and `observer?: unknown`. You broke your own type system to avoid a tier import violation that you invented. If your architectural tier rules force you to give up type safety, your tier rules are wrong. The template method pattern wraps every lifecycle method in timing + error catching — approximately 60 lines to add `try { const start = Date.now(); ... } catch { ... }` to three methods. A decorator function would do this in 10 lines.

#### 130 files. Yes or no? How many should it be?

**No.** 160 non-test source files is approximately 3x what this needs.

**This should be 50-60 source files.** The collapse:
- Schemas: 8 files -> 4 (merge events into table-driven, merge adapters + orchestrator)
- 8 interface files -> 0 (TypeScript has structural typing, you don't need separate interface files)
- Adapter hierarchy: 5 files -> 1
- Hooks system: 1 file -> 0 (delete — zero consumers)
- Event topology: fold into event-bus/index.ts
- Registry: 3 files -> 1
- Daemon subsystems: 12 files -> 4-5 (half are under 100 lines)
- Orchestrator subsystems: 12 files -> 6-7 (prompts are fine separate, rest is over-decomposed)
- Observer: 7 files -> 3 (logger, store, facade)

#### What to delete TODAY

1. **The entire hooks system.** Zero production consumers. Remove `hookRegistry` from BaseAdapter, Registry, RegistryOptions, and bootstrap.
2. **All 8 interface files.** Replace with `type IFoo = Pick<Foo, ...>` co-located next to the class, or just use the class directly. One TaskEngine. Will always be that TaskEngine.
3. **EventTopology as a separate class.** Fold into EventBus. The dashboard graph is not being consumed by anything that couldn't query the bus directly.
4. **Collapse the Registry.** Merge lifecycle.ts and plugin-health.ts into index.ts. A thin facade delegating to a 186-line file is architecture astronautics.
5. **Kill `unknown` typed fields on BaseAdapter.** Fix the tier rules or use a minimal shared interface. `hookRegistry?: unknown` is an insult to TypeScript.
6. **Flatten `handlePostPhaseActions`.** Each of the 9 concerns becomes a function returning `PhaseCompletionResult | null`. The `targetIndex - 1` hack dies.

**The bottom line:** The state machine is solid. The event bus is clean. The daemon tick loop is sensible. But the ratio of plumbing to actual work is about 3:1. Delete the speculative abstractions. Collapse the files. Make the remaining code so simple that the architecture is obvious from reading it, not from reading the 175-decision design document.

---

### Review 2: D. Richard Hipp (SQLite)

#### API Surface

~50 methods on core classes, plus ~150 schema/type exports. For comparison: SQLite has ~200 functions for a complete relational database. This system manages a task queue and calls an LLM. The operational API (~50 methods) is defensible. The data definition layer has 3x the surface area it needs — 34 individually-named event payload schemas repeated in four different forms.

#### The "Maintain Forever" Test

**Would maintain with confidence:**
- `src/db/database.ts` — The best file in the project. Clean migration runner, transaction-wrapped, guards against nested transactions, proper errors, WAL/synchronous config, file permission hardening. This is how you write database code.
- `src/core/task-engine/queries.ts` — Five prepared statements, five methods, zero branching logic.
- `src/core/observer/blob-store.ts` — Content-addressable storage in 76 lines. SHA-256, filesystem dedup, git-style directories. Nothing to remove.
- `src/core/observer/stream.ts` — 65 lines. Dead subscriber eviction. Finished component.
- `src/core/session-memory/knowledge.ts` — Content-hash IDs, idempotent upsert, clean supersession.

**Fills me with dread:**
- `src/core/orchestrator/phase-runner.ts` — 1,080 lines, two `biome-ignore` suppressions. When this breaks, the person debugging will have to hold the entire state machine in their head simultaneously. In 20 years, every maintainer will curse this file.
- `src/schemas/events.ts` — 540 lines of boilerplate. Add one event, touch three places. Miss one? Silent type mismatch at runtime.
- `src/schemas/config.ts` — 623 lines of Zod config definitions nested 6 levels deep. Defaults inside defaults inside defaults.

#### Testing Discipline

2,400 tests. Respectable quantity. But:

**Not tested at all:**
- **Database corruption.** What happens when the SQLite file is truncated mid-write? When the WAL is corrupted? When `schema_version` has garbage? Zero corruption tests.
- **Concurrent access.** `busy_timeout = 5000`. What happens when two processes hit the same database past the timeout? No test.
- **Snapshot corruption in cost-tracker.** `restoreFromSnapshot()` does `JSON.parse` with bare catch. Good fallback. But no test corrupts the snapshot to verify the fallback path.
- **Event replay under partial failure.** Pages through events 1000 at a time. What if `getEventsSince` throws on page 3 of 5? No test.
- **Failure during failure handling.** `handlePhaseError` closes the session. What if `endSession` itself throws? The code handles one layer of failure. Not failure-during-failure. In aviation, we call this "loss of both engines." You test for it.
- **Memory pressure.** The cost tracker's `per_task` Map grows without bound during process lifetime. No test validates cleanup under load.

**Verdict:** Testing the happy path thoroughly and first-layer failures adequately. Not testing corruption, cascading failures, or resource exhaustion. For a daemon managing real money (LLM costs), this gap is significant.

#### The Minimal Surface Principle — What to Collapse

- **Event schema boilerplate:** Replace 34 individual exports + mapped type + runtime registry with a single const record of `{ type, schema }` pairs. One source of truth. Eliminates ~300 lines.
- **Merge SafetyLayer and PolicyEngine.** The facade adds no logic — it validates inputs and delegates. Merge into one class: `checkAction`, `checkCost`, `checkAutonomy`, `updateConfig`, `flush`.
- **Remove `consultJudgment`.** It's a switch statement calling three different operations behind one polymorphic method. Make them three separate methods.
- **SessionMemory: eliminate the facade.** 11 methods, every single one a one-line delegation. Either expose the four stores directly or inline them.
- **Kill `UpdatableField`.** Replace with specific typed methods or a builder.
- **Kill re-export chains.** Pick one canonical import path per type.

#### The Observability System

Observer + ObservationStore + BlobStore + ObserverStream + pino logging. Five subsystems for "know what the agent did."

The BlobStore (76 lines), ObserverStream (65 lines), and Observer facade are justified. The ObservationStore (262 lines) is a middle layer that duplicates the Observer facade — three layers of indirection for one SQLite INSERT. Eliminate the middle layer.

Observation writes are synchronous per-span. For a 7-phase pipeline with sub-spans, that's dozens of synchronous SQLite writes per task. Combined with EventBus writing to the same database — you're double-writing overlapping information.

#### ephemeral.ts

Documentation cosplaying as code. `DaemonStateSchema` is never validated at runtime. `CostAccumulatorsSchema` can't even validate its `Map` objects. Replace every schema with a plain TypeScript interface. Save Zod for actual trust boundaries: config files, LLM output, external APIs.

#### What Would I Not Have Built?

**The Event Bus as a persistence layer.** You have EventBus writing events to SQLite, Observer writing observations to SQLite, journal writing entries to SQLite, state transitions writing to SQLite. Four parallel write streams recording overlapping information. In SQLite, we'd have one table. You don't need pub/sub for an in-process single-threaded system. `better-sqlite3` is synchronous. The Event Bus is simulating distributed systems messaging for a process that talks to itself. I would have built a transaction log table and query functions.

**The Action Pipeline.** `ActionPipeline.execute()` is 40 lines. Gate 1 calls `checkPermission`. Gate 2 calls `evaluateAction`. Then calls `executeFn`. Then calls `notifyFn`. This is a function, not a class. Inline at the call sites.

**The Preemption system.** Protocol P8 with PreemptionGate, checkpoint creation, event emission — for `max_concurrent: 1` on a single thread. The preemption code path has never been exercised in production.

**The three-layer Observer indirection.** Observer facade -> ObservationStore -> ObserverStore. Eliminate the middle layer.

#### Files That Would Survive 20 Years

`database.ts`, `queries.ts`, `blob-store.ts`, `stream.ts`, `knowledge.ts` — these are files I would trust in production. Build more of the system to that standard.

---

### Review 3: Rob Pike (Go, Plan 9)

#### "The bigger the interface, the weaker the abstraction."

| Interface | Methods | Verdict |
|-----------|---------|---------|
| `IActionPipeline` | 1 | **Excellent.** One method. One job. |
| `IPluginLookup` | 3 | **Good.** Tight. |
| `IEventBus` | 7 | **Acceptable.** Query methods could be a separate reader. |
| `IPeopleDirectory` | 6 | **Too wide.** `getOwner()` and `getReviewers()` are convenience wrappers around `getByRole`. Four methods would be tight. |
| `ISafetyLayer` | 7 | **Too wide.** Three interfaces pretending to be one: safety gate, cost reporter, config holder. |
| `ITaskEngine` | 11 | **Too wide.** A state machine, a query store, and mutation operations crammed together. |
| `ISessionMemory` | 13 | **The worst.** Four domains (sessions, journal, checkpoints, knowledge) in one interface. |
| `IWorkspaceManager` | 8 | **Borderline.** Most consumers only call `getWorktreePath`. |

#### The Stranger Test

Bug: "PR creation sometimes fails." How many files does a competent engineer need to open?

1. `bootstrap.ts` (265 lines)
2. `system.ts` (103 lines)
3. `orchestrator/index.ts` (293 lines)
4. `orchestrator/types.ts` — 11 fields to understand (107 lines)
5. `orchestrator/phase-runner.ts` (1,081 lines)
6. `orchestrator/pr-manager.ts`
7. `adapters/git-hosting.ts` (122 lines)
8. The concrete GitHub hosting plugin
9. `adapters/errors.ts`
10. `orchestrator/errors.ts`

**Minimum: 10 files.** Realistically 12-15 with schemas and event types.

**Verdict:** Too many concepts for one bug. "PR creation fails" should require reading the PR creation function and the git hosting adapter. Two files. Maybe three.

#### Clarity vs Cleverness — Three Worst

**1. `phase-runner.ts` — The `targetIndex - 1` trick:**
```
return { completion: { kind: "loopback", phases, targetIndex: reqIndex - 1 } }
```
Returning `index - 1` because the for loop will `i++`. Shows up three times. If you need a comment to explain your loop control, restructure the loop.

**2. `llm-caller.ts` — The fallback IIFE:**
```
const finalResult = sessionResult && sessionResult !== "invalid"
    ? sessionResult
    : (() => { ... return { status: "ready" as const, ... }; })();
```
A ternary with an IIFE inside the false branch. Write two if statements.

**3. `base.ts` — `hookRegistry?: unknown` and `observer?: unknown`:**
The abstraction punishing you. You created a three-tier rule, then threw away type safety to comply. The architecture is wrong.

#### Three Best (Genuinely Clear)

**1. `action-pipeline.interface.ts` — the entire file.** `PipelineResult<T>` discriminated union. Four outcomes, each with exactly the data it needs. A stranger reads this once and knows what the action pipeline does.

**2. `task-scheduler.ts` — `isSlotConsuming`:**
```
export function isSlotConsuming(state: string, subState: string | null): boolean {
  return state === TaskStates.active && (subState === SubStates.working || subState === SubStates.integrating);
}
```
Pure function. Name says what it does. Body says how. No context needed.

**3. `trigger-poller.ts` — `cleanupExpiredKeys`:**
```
for (const [key, expiry] of seenTriggerKeys) {
  if (expiry <= now) seenTriggerKeys.delete(key);
}
```
Dumb loop. Does what the name says. Doesn't generate bug reports.

#### The Dependency Graph

16 named components for a system that polls for triggers, runs an LLM, commits code, and creates a PR. `DaemonContext` with 12 fields, then each subsystem `Pick`s what it needs (7 different Pick types). This is backwards — if you need 6 specific things, take 6 arguments.

#### Composition Assessment

**The closure pattern wins decisively.** Daemon subsystems (`createTriggerPoller`, `createTaskScheduler`) are clear: factory takes dependencies, returns narrow interface. Internal state is lexically scoped. No `this`, no `protected`, no template method confusion.

**The class hierarchy hurts.** `CommunicationAdapter` with `wrapAsync` wrapping `do*` methods — 176 lines to express "catch errors and wrap them." The `do*` prefix is noise. The duplicated `wrapAsync` in `communication.ts` and `git-hosting.ts` (identical function, defined twice) is the inheritance pattern failing at code sharing.

**The Orchestrator is a class that should be a factory.** One public method. Constructor creates 7 subsystems. Would be cleaner as `createOrchestrator()` matching the daemon pattern.

#### If You Rewrote This in the Simplest Possible Way

```
src/
  main.ts              # entry point, wiring, CLI
  db.ts                # SQLite setup, migrations, queries
  events.ts            # publish, subscribe, event types
  tasks.ts             # task state machine, CRUD
  safety.ts            # cost limits, autonomy checks
  sessions.ts          # session, journal, checkpoint, knowledge
  workspace.ts         # git worktree management
  daemon.ts            # tick loop, trigger polling, scheduling
  orchestrator.ts      # phase pipeline, LLM calls, PR creation
  prompts/             # prompt builders
    system.ts
    phases.ts
  plugins/
    github.ts          # trigger + hosting + comm in one file
    telegram.ts        # send-only comm
    claude.ts          # LLM
  config.ts            # load YAML, validate
  types.ts             # shared types, schemas
```

**~15 files.** Not 160. Each file owns its domain completely. The adapter hierarchy disappears. A GitHub plugin exports functions: `pollTriggers()`, `createPR()`, `commentOnIssue()`. No `BaseAdapter`, no template methods. The 8 interface files disappear. For testing, use real modules backed by test databases.

#### The Central Problem

> This codebase has the disease of premature abstraction. Every concept has been given its own file, its own interface, its own error hierarchy, its own context type. The architecture diagrams must look beautiful. But a stranger trying to fix "PR creation sometimes fails" has to open 10+ files and understand 12+ abstractions.
>
> The daemon subsystem pattern is the best part of the codebase. It's the simplest, the most readable, and — not coincidentally — it was written as closures returning plain objects. No classes, no inheritance, no interfaces.
>
> The worst parts are where object-oriented ceremony was applied: the adapter hierarchy, the error class trees, the 13-method `ISessionMemory` interface.
>
> Simplicity is complicated. This codebase chose complexity instead.

---

### What All Three Agree On

Despite different lenses, all three reviewers converge on the same core issues:

1. **The Task schema is a god object.** Split it. 33 fields in one row with 8 JSON columns is a document store pretending to be relational.

2. **`phase-runner.ts` is the most dangerous file.** 1,080 lines, 9 concerns, biome-ignored complexity. The `targetIndex - 1` trick is universally condemned.

3. **The adapter/hooks/topology system is premature.** Zero hook consumers. Health state machine for `spawn("claude")`. `unknown`-typed fields to satisfy tier rules that shouldn't exist.

4. **The event system has 4x duplication.** 34 event types defined in four parallel structures. Maintenance nightmare.

5. **~160 files is ~3x too many.** Consensus range: 15 files (Pike, radical simplicity) to 50-60 files (Torvalds, practical collapse). The interfaces, hooks, topology, and over-decomposed subsystems account for the bloat.

6. **The closure/factory pattern (daemon) beats the class/inheritance pattern (adapters) everywhere it's used.** The best code in the project uses closures. The worst uses class hierarchies.

7. **Testing covers happy paths well but misses corruption, cascading failure, and resource exhaustion.** For a daemon managing money, this is a gap.

8. **The files that would survive 20 years:** `database.ts`, `queries.ts`, `blob-store.ts`, `stream.ts`, `knowledge.ts`, `action-pipeline.interface.ts`, `isSlotConsuming`, `cleanupExpiredKeys`. Build more to that standard.
