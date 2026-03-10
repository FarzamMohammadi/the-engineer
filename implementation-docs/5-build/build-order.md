# Layer 5: Build Order

Implementation sequence for The Engineer. 19 phases, bottom-up. Each phase builds on the last, dependencies flow forward only. Each phase is scoped to fit in a single agent context window.

Part of **Layer 5** — see [`../layers.md`](../layers.md). Implements specifications from [`../4-implementation/`](../4-implementation/).

---

## Approach

Bottom-up, like a compiler bootstrap. Schemas and infrastructure first, then components in dependency order, then the daemon that wires everything together. Each phase produces something independently testable.

**Hello world milestone:** Phase 12 — `createDaemon(config)` boots with fake plugins, ticks, polls a fake trigger, creates a task, dispatches to the orchestrator skeleton.

**Context window management:** Phases 1 and 14 were split to prevent context overflow. Each phase lists its primary reference documents, but agents should explore freely beyond them.

---

## Session Preparation — Read This First Every Session

Before starting any phase, the implementing agent must understand the project deeply — not just the phase spec, but the intent, philosophy, and architectural reasoning behind every decision.

### Required Reading (Every Session)

1. **`active.md`** — Current status, what just happened, what's next.
2. **`0-foundation/goals.md`** — The destination. 14 sections defining what The Engineer IS. Every implementation choice must serve these goals.
3. **`0-foundation/philosophy.md`** — Core beliefs and principles. "What would a real engineer do?" is the lens for every decision. This file defines HOW we build, not just WHAT.
4. **`sessions/{latest}.md`** — What happened last session, what's next. Continuity matters.
5. **The current phase section** from this file (`build-order.md`) — Deliverables, architecture connections, reference docs.

### Strongly Recommended Reading (Every Session)

6. **`1-system/architecture-tiers.md`** — The three-tier model (Core / Adapter / Plugin). Every line of code must respect these boundaries. Understand WHY before coding.
7. **`decisions.md`** — The full decision log (128 decisions). Not every decision is relevant to every phase, but scanning the rationale for nearby decisions prevents re-litigating settled questions and reveals reasoning the phase spec may not repeat.

### Phase-Specific Reading

Each phase section below lists "What To Read" — these are the primary implementation references for that phase. **But they are not exhaustive.** The agent should freely explore other files in `implementation-docs/` when context is needed. The architecture is deeply interconnected — a question about how the Event Bus works may lead you to `2-components/event-bus.md`, `3-interactions/event-catalog.md`, OR `3-interactions/protocols.md` depending on what you need.

### Exploration Guidance

The `implementation-docs/` directory is the single source of truth for all architectural decisions. When implementing, if you encounter ambiguity or need to make a judgment call:

1. **Search `decisions.md`** for relevant decisions — every major choice is logged with rationale and rejected alternatives.
2. **Read the Layer 2 component doc** for the component you're building — these define behavior, edge cases, and design intent.
3. **Read the Layer 3 interactions** (protocols, error propagation, lifecycle traces) when you need to understand how components work together.
4. **Read `0-foundation/philosophy.md`** when you need to make a judgment call that isn't explicitly covered — the principles guide the answer.

Never guess when a document exists that answers the question. Take time to research. Thoroughness over speed — always.

### Working Style

This is a deeply collaborative project. Farzam and the agent are partners. Key principles:
- **Never assume, always check in** — use Q&A when uncertain.
- **"What would a real engineer do?"** — apply this lens to every design question.
- **Full names, no abbreviations** — CommunicationAdapter not CommAdapter. Clarity from bottom to top.
- **Every decision must pass dual test:** works for v1 AND doesn't block future evolution.
- **Thoroughness over speed** — we have endless time. Get it right.

---

## Summary

| Phase | Name | Scope | Files | Key Milestone |
|-------|------|-------|-------|---------------|
| 0 | Project Bootstrap | Small | ~10 | Tooling works |
| 1a | Core Data Schemas | Medium | 6 | Task + events + session types |
| 1b | Integration Schemas | Medium | 8 | Adapters + orchestrator + config types |
| 2 | Database Layer | Small | 4 | SQLite + migrations |
| 3 | Config System | Medium | 4+ | YAML loading works |
| 4 | Event Bus | Medium | 3 | Pub/sub + persistence |
| 5 | Adapter Base Classes | Small | 8 | SDK boundary defined |
| 6 | Registry + Test Infra | Large | ~20 | Plugin lifecycle works |
| 7 | Task Engine | Medium | 2 | State machine works |
| 8 | Safety + People | Medium | 4 | Policy enforcement works |
| 9 | Action Pipeline | Small | 2 | Authorization middleware |
| 10 | Session/Memory + Workspace | Large | 4 | Checkpointing + git worktrees |
| 11 | Orchestrator (Skeleton) | Large | 2 | Phase pipeline runs |
| 12 | Daemon + Logging | Large | 4 | **HELLO WORLD** |
| 13 | CLI | Medium | 9 | User-operable |
| 14a | Contract Suites + Process Plugins | Medium | ~13 | BashTool + ClaudeCodeLLM |
| 14b | GitHub Plugins | Medium | ~12 | Trigger + Comm + Hosting |
| 14c | Telegram Plugin | Small | ~4 | TelegramComm |
| 15 | Integration + E2E Tests | Large | ~9 | Full confidence |

**Total: 19 phases. 6 Small, 8 Medium, 5 Large.**

---

## Dependency Graph

```
Phase 0 (Bootstrap)
  └─ Phase 1a (Core Schemas)
       └─ Phase 1b (Integration Schemas)
            ├─ Phase 2 (Database) ──────────────┐
            │    └─ Phase 4 (Event Bus) ────────┤
            ├─ Phase 3 (Config) ───────────────┐│
            │                                  ││
            ├─ Phase 5 (Adapters) ─────────────┤│
            │    ├─ Phase 14a (Contract+Proc)  ││
            │    ├─ Phase 14b (GitHub)         ││
            │    └─ Phase 14c (Telegram)       ││
            │                                  ││
            │  ┌───────────────────────────────┘│
            │  │  ┌────────────────────────────┘
            │  │  │
            │  Phase 6 (Registry) ──────────────┐
            │  │                                │
            │  Phase 7 (Task Engine) ───────────┤
            │  │                                │
            │  Phase 8 (Safety + People) ───────┤
            │  │                                │
            │  Phase 9 (Action Pipeline) ───────┤
            │  │                                │
            │  Phase 10 (Session + WS Mgr) ─────┤
            │  │                                │
            │  Phase 11 (Orchestrator) ─────────┤
            │                                   │
            └─ Phase 12 (Daemon) ───────────────┘
                 └─ Phase 13 (CLI)
                      └─ Phase 15 (Integration + E2E)
```

**Parallelization:** Phases 2+3 can run in parallel. Phases 14a/14b/14c can run in parallel with Phases 6-13 (plugins only depend on Phase 5).

---

## Phase 0: Project Bootstrap

### Context

This is the foundation everything builds on. A buildable, lintable, type-checkable empty project with all development tooling configured. No application code — just the scaffold.

### Architecture Connection

Implements the tooling decisions from Layer 4:
- Decision #66: Node.js 22 LTS
- Decision #67: pnpm
- Decision #68: ESM only (`"type": "module"`)
- Decision #70: tsx (dev) + tsdown (prod build)
- Decision #71: Biome (lint + format)
- Decision #73: Vitest (testing)
- Decision #98: tsconfig max strictness
- Decision #99: Biome `all` preset
- Decision #100: lefthook for git hooks
- Decision #101: Enforcement pipeline (pre-commit: biome+tsc, pre-push: unit tests)
- Decision #119: Three-tier Vitest configs

### Deliverables

| File | Purpose |
|------|---------|
| `package.json` | pnpm, ESM, bin entry (`"engineer"`), scripts: test, test:unit, test:integration, test:e2e, test:all, test:watch, test:coverage, build, dev, lint, typecheck |
| `tsconfig.json` | `target: ES2022`, `module: NodeNext`, `strict: true`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature`, `verbatimModuleSyntax` |
| `biome.json` | `all` preset, 2-space indent, 100-char width, trailing commas, semicolons always, double quotes, `noExplicitAny: error`, `noExcessiveCognitiveComplexity: 15` |
| `lefthook.yml` | pre-commit: biome check + tsc --noEmit (parallel). pre-push: `pnpm test` (unit only, < 15s) |
| `vitest.config.ts` | Unit: `src/**/*.test.ts` + `test/boundary/**/*.test.ts`, pool: `forks` |
| `vitest.shared.ts` | Shared: esbuild TS transform, path aliases, `unstubEnvs`, `unstubGlobals`, setup: `test/setup.ts` |
| `vitest.integration.config.ts` | Integration: `test/integration/**/*.integration.test.ts`, pool: `forks` |
| `vitest.e2e.config.ts` | E2E: `test/e2e/**/*.e2e.test.ts`, pool: `forks`, workers: 1 |
| `test/setup.ts` | Global setup skeleton: isolated `ENGINEER_HOME` in temp dir |
| `src/index.ts` | Entry point stub |
| `.gitignore` | node_modules, dist, coverage, .engineer (runtime data), *.db |
| `.node-version` | `22` |

### Dependencies

**Runtime:** better-sqlite3, zod, yaml, ms, pino, pino-roll, commander, zod-to-json-schema, ulid
**Dev:** typescript, tsx, tsdown, @biomejs/biome, vitest, @vitest/coverage-v8, pino-pretty, lefthook, @types/better-sqlite3

### What To Read

- [`../4-implementation/layout.md`](../4-implementation/layout.md) — Decisions #98-#101 (tsconfig, biome, lefthook, enforcement)
- [`../4-implementation/testing.md`](../4-implementation/testing.md) — Decision #119 (Vitest configs, pool settings, worker scaling)
- [`../4-implementation/foundation.md`](../4-implementation/foundation.md) — Decisions #65-#74 (tech stack overview)

### Verification

```bash
pnpm install        # all deps install clean
pnpm tsc --noEmit   # type checking passes
pnpm biome check    # lint + format passes
pnpm test           # vitest runs (0 tests is OK)
```

### What This Enables

Every subsequent phase. All code, tests, and tooling build on this scaffold.

---

## Phase 1a: Core Data Schemas

### Context

The first half of the type system. These schemas define the core data model — tasks (the central entity), events (the communication mechanism), and session/memory (the persistence layer). These three are tightly coupled: events reference tasks, sessions belong to tasks, checkpoints reference phases.

### Architecture Connection

- Tasks are the CPU-derived state machine from [`../1-system/task-states.md`](../1-system/task-states.md) — 7 states, sub-states, 13 valid transitions, permission table mapping (state, sub_state) → allowed ActionClasses.
- Events are the 30 typed events from [`../3-interactions/event-catalog.md`](../3-interactions/event-catalog.md) — 10 groups, each with specific payload schemas.
- Session/Memory schemas support the checkpointing and knowledge systems from [`../2-components/session-memory.md`](../2-components/session-memory.md).
- All schemas follow Decision #78: Zod-first with mandatory named type aliases.
- Enums use lowercase_snake_case per Decision #77.
- IDs use ULID per Decision #75 (except knowledge: content hash per Decision #83).
- Timestamps use ISO 8601 strings per Decision #76.

### Deliverables

| File | Contents |
|------|----------|
| `src/schemas/task.ts` | `TaskStateSchema` (7 values), `SubStateSchema` (5 values), `CascadePolicySchema` (4 values), `ActionClassSchema` (10 values), `ExternalRefSchema`, `ChildEntrySchema`, `TeamMemberSchema`, `RelatedItemSchema`, `TaskDecisionSchema`, `ChildCompletionSummarySchema`, `TaskWorkspaceSchema`, `ReviewStateSchema`, `BlockedDetailsSchema`, `TaskSchema` (full entity), `StateTransitionSchema`, `ValidTransitions` (13 rules as const data), `PermissionTable` (state/sub → ActionClass[] as const data). Named type exports for all via `z.infer`. |
| `src/schemas/events.ts` | `EventSchema` (envelope: id, sequence, type, source, task_id, timestamp, payload), `EventTypeSchema` (30 string literals), all 30 payload schemas (e.g., `TaskCreatedPayloadSchema`, `CostIncurredPayloadSchema`), `EventPayloads` mapped type, `TypedEvent<T>` generic. |
| `src/schemas/session-memory.ts` | `SessionSchema` (id, task_id, created_at), `JournalEntrySchema` (id, session_id, timestamp, content), `CheckpointSchema` (id, session_id, phase, outputs JSON), `KnowledgeEntrySchema` (scope, repo_scope, key, content_hash, value JSON, superseded_by). |
| `src/schemas/task.test.ts` | Valid task parses, invalid states rejected, all 13 transitions in ValidTransitions are correct, PermissionTable has entries for every (state, sub_state) pair, enum boundaries. |
| `src/schemas/events.test.ts` | Event envelope parses, each of 30 payload types validates, EventPayloads mapped type is exhaustive, invalid payloads rejected. |
| `src/schemas/session-memory.test.ts` | Session/journal/checkpoint/knowledge schemas validate correctly, content hash format validated. |

### Key Implementation Notes

- `ValidTransitions` is a const data structure (not a schema) — it's the lookup table used by Task Engine's `requestTransition()`. Define it as `Record<TaskState, TaskState[]>` with sub-state constraints.
- `PermissionTable` maps `(TaskState, SubState | null)` → `ActionClass[]`. It's the lookup for Gate 1 (Action Pipeline). Define as const data.
- Event payloads: each of the 30 types has its own schema. Use the naming from the event catalog (e.g., `task.created` → `TaskCreatedPayloadSchema`). The `EventPayloads` mapped type connects event type strings to their payload schemas for type-safe access.
- `TypedEvent<T>` is a generic that narrows `Event` to a specific payload type: `type TypedEvent<T extends keyof EventPayloads> = Event & { type: T; payload: EventPayloads[T] }`.

### What To Read

- [`../4-implementation/schemas/task.md`](../4-implementation/schemas/task.md) — Task schema, state machine, enums, transitions, permissions
- [`../4-implementation/schemas/events.md`](../4-implementation/schemas/events.md) — Event envelope, all 30 payload schemas
- [`../4-implementation/schemas/session-memory.md`](../4-implementation/schemas/session-memory.md) — Session, journal, checkpoint, knowledge schemas
- [`../4-implementation/schemas/README.md`](../4-implementation/schemas/README.md) — Conventions (naming, ID generation, timestamps, enums, nullable vs optional)

### Verification

All unit tests pass. Each schema: valid data parses, invalid data rejected, defaults apply where specified, enum values match the canonical list from specs.

### What This Enables

Phase 1b (integration schemas reference task states, event types). Phase 2 (database tables mirror these schemas). Phase 4 (Event Bus uses event schemas). Phase 7 (Task Engine uses task schemas, transitions, permissions).

---

## Phase 1b: Integration Schemas

### Context

The second half of the type system. These schemas define the integration layer — adapter contracts (how plugins talk to Core), orchestrator outputs (what each phase produces), ephemeral state (runtime-only data), and configuration (how the system is configured). These reference the core schemas from Phase 1a (e.g., adapter responses include TaskState, config schemas reference event types).

### Architecture Connection

- Adapter schemas implement the 5 adapter contracts from [`../3-interactions/adapter-contracts.md`](../3-interactions/adapter-contracts.md).
- Orchestrator schemas define the 7-phase pipeline outputs from [`../2-components/orchestrator.md`](../2-components/orchestrator.md).
- Config schemas implement Decisions #90-#97 (YAML, multi-file, defaults in Zod, hot-reload, env vars, durations).
- Ephemeral schemas define runtime state that lives only in memory (daemon state, safety accumulators).

### Deliverables

| File | Contents |
|------|----------|
| `src/schemas/adapters.ts` | `AdapterTypeSchema` (5 values), `PluginManifestSchema`, `InitResultSchema`, `HealthStatusSchema`, `AdapterErrorSchema`, `PluginHealthStateSchema` (3 values: healthy/unhealthy/failed). **Per adapter type:** Trigger (`TriggerEventSchema`, idempotency_key etc.), Communication (`TargetSchema`, `FormattedMessageSchema`, `SendResultSchema`, `InboundMessageSchema` etc.), LLM (`CompletionRequestSchema`, `CompletionResultSchema`, `LLMCapabilitiesSchema`), Tool (`ToolDescriptionSchema`, `ToolResultSchema`, `SideEffectSchema`), GitHosting (`PROptionsSchema`, `PRResultSchema`, `PRStatusSchema`, `ReviewStatusSchema`, `MergeResultSchema`, etc.). **People:** `PersonSchema`, `ContactSchema`. |
| `src/schemas/orchestrator.ts` | `PhaseSchema` (7 values), 7 phase output schemas (one per phase: intake-analysis, research, planning, execution, self-review, demo-prep, integration), `CommEventSchema`, `QuestionBatchSchema`, `DecompositionPlanSchema`, `TrivialCriteriaSchema`, `SafetyQuerySchema`, `SafetyVerdictSchema`. |
| `src/schemas/ephemeral.ts` | `DaemonStateSchema` (capacity, queue, trigger state, pending preemptions, health), `CostAccumulatorsSchema` (per-task, daily, monthly), `SafetySnapshotSchema`, `WorktreeInfoSchema`, `WorkspaceStateSchema`. |
| `src/schemas/config.ts` | `DaemonConfigSchema` (tick interval, preemption, stuck/runaway, aging, shutdown, trigger poll, logging, plugins — all with `.default()`), `OrchestratorConfigSchema` (fast path, notifications, question batching, decomposition, demo, phases, journal), `SafetyConfigSchema` (cost limits, scope, autonomy, response timeout, merge), `WorkspaceConfigSchema` (workspace root, branch prefix, PR settings, cleanup, multi-repo). |
| Co-located `.test.ts` for each | Validation tests for all schemas, defaults verification for config schemas, cross-references to Phase 1a types work correctly. |

### Key Implementation Notes

- Config schemas MUST use `.default()` extensively — missing config file = system runs with all defaults (Decision #93).
- `SafetyConfigSchema` and `PeopleDirectorySchema` (in config.ts) are hot-reloadable (Decision #94) — mark with comments.
- Duration fields in config use `z.number().int()` (milliseconds internally). The config loader (Phase 3) will parse human-readable strings like `"4h"` before Zod validation.
- Adapter schemas define the contract surface — these exact types will be the method signatures in the abstract adapter classes (Phase 5).
- `PluginManifestSchema` includes `adapter_meta` as a flexible `z.record()` — type-specific metadata that varies per adapter type.

### What To Read

- [`../4-implementation/schemas/adapters.md`](../4-implementation/schemas/adapters.md) — All adapter contract types
- [`../4-implementation/schemas/orchestrator.md`](../4-implementation/schemas/orchestrator.md) — Phase outputs, comm events
- [`../4-implementation/schemas/ephemeral.md`](../4-implementation/schemas/ephemeral.md) — Runtime state schemas
- [`../4-implementation/schemas/config.md`](../4-implementation/schemas/config.md) — All config schemas with defaults

### Verification

All unit tests pass. Config schemas produce valid defaults when given empty input. Adapter schemas match the contract signatures in adapter-contracts.md. Cross-references to Phase 1a types (TaskState, EventType, etc.) compile correctly.

### What This Enables

Phase 3 (config loader uses config schemas). Phase 5 (adapter classes use adapter schemas). Phase 6 (Registry uses PluginManifest, health state). Phase 8 (Safety Layer uses SafetyConfig, cost accumulators). Phase 11 (Orchestrator uses phase output schemas).

---

## Phase 2: Database Layer

### Context

SQLite setup with WAL mode, migration system, and connection management. This is the persistence foundation — tasks, events, sessions, and knowledge all live here. The database is a single file at `~/.engineer/data/engineer.db`.

### Architecture Connection

- Decision #69: SQLite via better-sqlite3, synchronous API, WAL mode, no ORM.
- Decision #79: 7 tables + `_meta`.
- Decision #109: Database lives at `{ENGINEER_HOME}/data/engineer.db`.
- Schema versioning via `_meta` table with sequential migrations.

### Deliverables

| File | Purpose |
|------|---------|
| `src/db/database.ts` | `createDatabase(path: string)`: opens SQLite file, enables WAL + `synchronous=NORMAL`, reads and applies unapplied migrations, returns typed `Database` instance. `createInMemoryDatabase()`: same but `:memory:` for tests. Prepared statement helpers for common queries. |
| `src/db/migrations/001_initial.sql` | All 7 CREATE TABLE statements + indexes + `_meta` bootstrap with `schema_version = 1`. Copy exactly from the spec. |
| `src/db/database.test.ts` | Migration runs clean, WAL mode verified (`PRAGMA journal_mode`), schema version tracked in `_meta`, all 7 tables exist with correct columns, re-running migration is idempotent, in-memory database works. |
| `test/helpers/test-database.ts` | `createTestDatabase()` returning `{ db, cleanup }` — in-memory database with migrations applied, cleanup closes connection. Used by all subsequent phases for testing. |

### Key Implementation Notes

- WAL mode: `db.pragma('journal_mode = WAL')` and `db.pragma('synchronous = NORMAL')`.
- Migration system: read `_meta.schema_version`, scan `migrations/` directory for files numbered higher, apply in order within a transaction, update `_meta.schema_version`.
- The `events` table has an auto-incrementing `sequence` column (INTEGER PRIMARY KEY in a separate column, or use SQLite's built-in rowid aliasing).
- JSON columns (`payload`, `outputs`, `workspace`, `review`, `blocked`, `value`, `children`, etc.) are TEXT containing JSON. Queried via `json_extract()`.

### What To Read

- [`../4-implementation/schemas/sqlite.md`](../4-implementation/schemas/sqlite.md) — All CREATE TABLE statements, indexes, migration approach

### Verification

```bash
pnpm test  # database tests pass
```

Migration creates all tables. WAL mode is active. Schema version is tracked. In-memory database works for tests.

### What This Enables

Phase 4 (Event Bus persists events to `events` table). Phase 7 (Task Engine reads/writes `tasks` and `state_transitions` tables). Phase 8 (Safety Layer snapshots to `_meta`). Phase 10 (Session/Memory uses `sessions`, `journal_entries`, `checkpoints`, `knowledge` tables).

---

## Phase 3: Config System

### Context

YAML config loading with environment variable resolution, duration string parsing, Zod validation, and file watching for hot-reload. The config system is the bridge between human-readable YAML files in `~/.engineer/config/` and the validated TypeScript objects that components consume.

### Architecture Connection

- Decisions #90-#97: YAML format, multi-file organization, config location, defaults in Zod, hot-reload for safety+people, env var resolution, duration parsing.
- Decision #109: Config lives at `{ENGINEER_HOME}/config/`.
- Decision #94: `safety.yaml` and `people.yaml` are hot-reloadable; all others are startup-only.
- Decision #95: Invalid on startup = refuse to start. Invalid on hot-reload = keep previous, emit alert.
- Decision #96: `${ENV_VAR_NAME}` syntax for secrets, resolved before Zod validation.

### Deliverables

| File | Purpose |
|------|---------|
| `src/config/loader.ts` | `loadConfig<T>(filePath, zodSchema)`: read YAML file → resolve `${ENV_VAR}` references → parse duration strings via `ms` → validate with Zod schema → return typed config. `loadConfigDir(configDir)`: loads all config files, returns typed config bundle. Handles: missing file = Zod defaults, missing env var = throw with clear message, invalid YAML = throw with file path + parse error. |
| `src/config/watcher.ts` | `createConfigWatcher(files, onChange)`: watches files via `node:fs.watch()`, 500ms debounce, on change: reload + validate, if valid call `onChange(newConfig)`, if invalid keep previous + return error for logging. Returns `{ stop() }` handle. |
| `src/config/loader.test.ts` | Loads valid YAML, applies Zod defaults for missing files, resolves env vars, parses duration strings (`"4h"` → 14400000), rejects invalid YAML, rejects undefined env vars with clear error, handles empty files (all defaults). |
| `src/config/watcher.test.ts` | Debounce works (multiple rapid writes = one callback), valid reload calls onChange with new config, invalid reload keeps previous and returns error, stop() cleans up watcher. |
| `test/fixtures/configs/` | `valid-daemon.yaml`, `valid-safety.yaml`, `invalid-missing-type.yaml`, `env-vars.yaml` (uses `${TEST_VAR}`), `durations.yaml` (uses `"4h"`, `"30s"`), `empty.yaml`. |

### Key Implementation Notes

- Env var resolution: scan YAML string values for `${...}` pattern, replace with `process.env[name]`, throw if undefined. Do this BEFORE Zod validation so Zod sees the resolved values.
- Duration parsing: after env var resolution, walk the config object and parse any string values that look like durations (match `ms` package format) into milliseconds. Only do this for fields that Zod expects as numbers — don't convert arbitrary strings.
- The config loader should be generic enough to load any YAML file against any Zod schema — plugins will use it for their own config files too (Phase 6+).

### What To Read

- [`../4-implementation/layout.md`](../4-implementation/layout.md) — Decisions #90-#97 (config system design)
- [`../4-implementation/schemas/config.md`](../4-implementation/schemas/config.md) — Config schema structures with defaults (already implemented as Zod in Phase 1b)

### Verification

All unit tests pass. Config loads with Zod defaults from empty/missing files. Env vars resolve. Duration strings parse. Invalid configs produce clear Zod errors with field paths. Watcher debounces correctly.

### What This Enables

Phase 8 (Safety Layer + People Directory use hot-reloadable config). Phase 12 (Daemon loads all configs at startup). Phase 13 (CLI `config validate` command uses loader).

---

## Phase 4: Event Bus

### Context

The nervous system of the entire architecture. Every component communicates through events. The Event Bus persists all events to SQLite (the audit trail), delivers them to subscribers synchronously, and supports replay for crash recovery. Event Bus down = system halt (Decision #53).

### Architecture Connection

- The Event Bus is Core (structural, not just a pattern) — the event stream IS the audit trail.
- 30 typed events across 10 groups, defined in [`../3-interactions/event-catalog.md`](../3-interactions/event-catalog.md).
- Decision #82: Single `events` table, payload as JSON, mapped type for type safety.
- Decision #87: Event envelope simplified per L3 — no `status` or `veto_reason` (Action Pipeline handles rejections).
- Pure pub/sub — no pre-processing, no vetoing on the bus itself.

### Deliverables

| File | Purpose |
|------|---------|
| `src/core/event-bus/index.ts` | `EventBus` class. Constructor takes `Database`. **publish(event):** validate payload against schema, assign ULID id + auto-increment sequence, persist to `events` table, deliver to matching subscribers synchronously. **subscribe(subscriberId, eventType, callback):** register subscriber. Supports glob patterns (`task.*` matches `task.created`, `task.state_changed`, etc.). **unsubscribe(subscriberId).** **replay(fromSequence):** read events from DB where sequence > fromSequence, deliver to subscribers in order. **getEventsForTask(taskId):** query by task_id. **getEventsSince(sequence):** query by sequence. |
| `src/core/event-bus/index.test.ts` | Publish persists to DB and delivers to subscribers. Glob pattern matching works (`task.*`, `*`). Replay returns events in sequence order. Sequence is monotonic (never decreases). Multiple subscribers receive same event. Unsubscribe stops delivery. Events without task_id work (system events). Type-safe payload access via `TypedEvent`. |
| `test/helpers/test-event-bus.ts` | `createTestEventBus()`: creates in-memory DB via `createTestDatabase()`, returns `{ eventBus, getEmittedEvents(type?), assertEventEmitted(type, payloadMatcher), cleanup }`. Used by all subsequent phases to assert event emissions in tests. |

### Key Implementation Notes

- Sequence numbers: use a separate auto-increment column (not the ULID id). This gives total ordering even when events have identical timestamps.
- Synchronous delivery: when `publish()` is called, subscribers execute synchronously before publish returns. This ensures the audit trail is complete before the caller continues. If a subscriber throws, catch the error, log it, and continue delivering to remaining subscribers.
- Glob matching: simple pattern matching where `*` matches any segment. `task.*` matches `task.created` but not `task.state.deep`. Use a simple implementation — no need for a glob library.
- The Event Bus does NOT validate that event types are known — new event types can be introduced by plugins in the future.

### What To Read

- [`../2-components/event-bus.md`](../2-components/event-bus.md) — Event Bus design (delivery guarantees, persistence, replay)
- [`../3-interactions/event-catalog.md`](../3-interactions/event-catalog.md) — All 30 event types with payloads (for testing, not for hardcoding)
- Event schemas from Phase 1a (`src/schemas/events.ts`)

### Verification

All unit tests pass. Events persist and replay in correct order. Subscribers receive events matching their pattern. The test helper works for asserting event emissions.

### What This Enables

Every Core component depends on the Event Bus. Phase 6 (Registry emits health events). Phase 7 (Task Engine emits `task.created`, `task.state_changed`). Phase 8 (Safety Layer subscribes to `cost.incurred`, emits `cost.limit_reached`). Phase 9 (Action Pipeline emits `action.rejected`).

---

## Phase 5: Adapter Base Classes + SDK Boundary

### Context

The abstract class hierarchy that all plugins extend. This is the contract surface between Core and Plugin tiers. `src/adapters/index.ts` is the single import point for plugin authors — the future `packages/plugin-sdk/` extraction point.

### Architecture Connection

- Three-tier architecture: Core → Adapters → Plugins. Adapters are the stable middle layer.
- Decision #104: Abstract class hierarchy with BaseAdapter → 5 type-specific classes. Template method pattern.
- Decision #105: `src/adapters/index.ts` is the curated SDK boundary. Exports adapter classes, shared types, error helpers. Does NOT export Core internals.
- Decision #43: One plugin per adapter type. `instanceof` checks for runtime type safety.
- Optional adapter methods via capability gates — `hasCapability()` on BaseAdapter.

### Deliverables

| File | Purpose |
|------|---------|
| `src/adapters/base.ts` | `BaseAdapter` abstract class. Stores injected `manifest: PluginManifest`. `hasCapability(name: string): boolean` checks `manifest.adapter_meta`. Template methods: `initialize(config)` wraps `doInitialize()` with timing + error catching, `shutdown()` wraps `doShutdown()`, `healthCheck()` wraps `doHealthCheck()` with timeout. Protected abstract methods for subclasses to implement. |
| `src/adapters/trigger.ts` | `TriggerAdapter extends BaseAdapter`. Abstract: `doPoll(): Promise<TriggerEvent[]>`. Public: `poll()` wraps with timing/error handling. |
| `src/adapters/communication.ts` | `CommunicationAdapter extends BaseAdapter`. Required: `doSendMessage(target, message)`, `doFormatMessage(template, data)`. Optional (capability-gated): `doStartListening()`, `doStopListening()`, `doSyncTaskState()`, `doCommentOnIssue()`, `doManageIssueLabels()`. |
| `src/adapters/llm.ts` | `LLMAdapter extends BaseAdapter`. Abstract: `doComplete(request): Promise<CompletionResult>`, `doGetCapabilities(): LLMCapabilities`. |
| `src/adapters/tool.ts` | `ToolAdapter extends BaseAdapter`. Abstract: `doDescribe(): ToolDescription[]`, `doExecute(name, args, context): Promise<ToolResult>`. |
| `src/adapters/git-hosting.ts` | `GitHostingAdapter extends BaseAdapter`. Abstract: `doCreatePR()`, `doUpdatePR()`, `doMergePR()`, `doClosePR()`, `doGetPRStatus()`, `doGetReviewStatus()`, `doCommentOnPR()`, `doGetBranchProtection()`, `doGetDefaultBranch()`. |
| `src/adapters/errors.ts` | `createAdapterError(code, message, options?)` helper function that returns a structured `AdapterError` object (not a thrown Error). |
| `src/adapters/index.ts` | Curated re-exports: all adapter abstract classes, all shared types from `schemas/adapters.ts`, `createAdapterError`. Does NOT export anything from `src/core/`. |

### Key Implementation Notes

- Template method pattern: public methods (e.g., `poll()`) call protected abstract methods (e.g., `doPoll()`), wrapping with timing measurement, error catching (convert thrown errors to AdapterError), and logging hooks.
- The `manifest` is injected by Registry during loading, not by the plugin itself.
- `hasCapability()` checks the manifest's `adapter_meta` for capability flags. Core calls this before invoking optional methods.
- Communication adapter has the most optional methods — these are capability-gated, not required.

### What To Read

- [`../4-implementation/plugins.md`](../4-implementation/plugins.md) — Decisions #104-#105 (abstract classes, SDK boundary)
- [`../3-interactions/adapter-contracts.md`](../3-interactions/adapter-contracts.md) — All 5 adapter contracts with method signatures and types
- Adapter schemas from Phase 1b (`src/schemas/adapters.ts`)

### Verification

Template methods wrap correctly (timing, error catching). `hasCapability()` reads manifest metadata. SDK boundary (`src/adapters/index.ts`) exports only adapter classes and shared types — no Core internals.

### What This Enables

Phase 6 (Registry uses adapter classes for `instanceof` checks and plugin loading). Phases 14a/14b/14c (all plugins extend these classes). Phase 6 (fake plugins extend these classes).

---

## Phase 6: Registry + Fake Plugins + Test Infrastructure

### Context

The Registry manages plugin lifecycle — discovery, validation, loading, initialization, health monitoring, and shutdown. This phase also builds the fake plugins and test helpers that every subsequent phase uses for testing. The boundary enforcement test ensures the three-tier architecture is respected.

### Architecture Connection

- Decision #102: `engineer.plugin.yaml` manifests for discovery.
- Decision #103: Five-phase loading (discover → validate → order → load → initialize). Type-based ordering: Communication → LLM → Tool → GitHosting → Trigger (triggers last — they produce work immediately).
- Decision #106: Three-state health machine (healthy → unhealthy → failed).
- Decision #107: Plugin lifecycle config in `daemon.yaml` (dirs, health check interval, timeout, failure threshold).
- Decision #123: Integration tests use real Core + fake plugins via Registry.
- Decision #125: Boundary enforcement test verifies tier import rules.

### Deliverables

**Core:**

| File | Purpose |
|------|---------|
| `src/core/registry/index.ts` | `Registry` class. Five-phase loading: (1) discover manifests in configured dirs, (2) validate (unique IDs, valid type, semver, entry exists), (3) order by type (Comm → LLM → Tool → GitHosting → Trigger), (4) dynamic `import()` + call factory, inject manifest, (5) load user config, validate with plugin's Zod schema, call `initialize()`. `getPlugin(type)`, `getPrimaryPlugin(type)`: type-safe retrieval. Health state machine: healthy → unhealthy (1 fail) → failed (N consecutive). Health check loop. Graceful shutdown in reverse init order. Emits `health.trigger_failure` etc. via Event Bus. |
| `src/core/registry/index.test.ts` | Five-phase loading with fake plugins. Invalid manifest rejected. Duplicate ID rejected. Type-based ordering correct. Health state transitions. Graceful shutdown in reverse order. Plugin retrieval by type. |

**Test Infrastructure:**

| File | Purpose |
|------|---------|
| `test/helpers/fake-plugins/fake-trigger/` | `engineer.plugin.yaml` + `index.ts` (factory) + implementation. Configurable events to return from `poll()`, "fail next poll" flag. Minimal implementation that passes lifecycle. |
| `test/helpers/fake-plugins/fake-comm/` | Records all sent messages in memory. `getMessages()` for assertions. |
| `test/helpers/fake-plugins/fake-llm/` | Canned `CompletionResult` per phase. Configurable responses. Reports fixed usage. |
| `test/helpers/fake-plugins/fake-tool/` | Records all executed actions. Configurable results per tool name. |
| `test/helpers/fake-plugins/fake-git-hosting/` | In-memory PR tracking. Create/update/merge/close PRs without any HTTP. |
| `test/helpers/test-registry.ts` | `createTestRegistry(eventBus)`: pre-loads all 5 fake plugins, returns `{ registry, fakes }` where `fakes` gives direct access to fake plugin instances for test configuration. |
| `test/helpers/mock-factories.ts` | `createMockTask()`, `createMockManifest()`, `createMockTriggerEvent()`, `createMockEvent(type, payload)`, etc. — Zod-compliant factory functions with sensible defaults and optional overrides. |
| `test/fixtures/manifests/` | `valid-trigger.yaml`, `valid-comm.yaml`, `invalid-missing-type.yaml`, `invalid-bad-version.yaml`, `disabled-plugin.yaml` |
| `test/boundary/tier-import-rules.test.ts` | Globs all `.ts` files in `src/plugins/`, `src/adapters/`, `src/core/`. Parses import statements. Asserts: plugins only import from `src/adapters/index.ts` + `src/schemas/` + externals. Adapters never import plugins. Core never imports plugins. Reports exact file:line on violation. |

### Key Implementation Notes

- Each fake plugin MUST have a valid `engineer.plugin.yaml` manifest — the Registry discovers plugins by scanning for these files.
- Fake plugins should be minimal but complete — they pass the basic lifecycle (init returns `{success: true}`, healthCheck returns `{healthy: true}`, shutdown completes).
- The boundary test should be maintained throughout all future phases — run it as part of the unit test suite.
- Registry depends on Event Bus for emitting health events, so it needs an Event Bus instance in its constructor.
- Mock factories use Zod schemas to generate valid defaults: `TaskSchema.parse({...overrides})` with spread. This ensures factories stay in sync with schema changes.

### What To Read

- [`../4-implementation/plugins.md`](../4-implementation/plugins.md) — Decisions #102-#108 (manifest, loading, health, lifecycle)
- [`../4-implementation/testing.md`](../4-implementation/testing.md) — Decisions #123-#125 (fake plugins, test registry, boundary enforcement)

### Verification

Registry loads fake plugins via five-phase sequence. Health state machine transitions correctly. Boundary test passes. Fake plugins complete lifecycle. Mock factories produce valid data. Test registry provides easy access to fakes.

### What This Enables

Every subsequent phase uses `createTestRegistry()` and mock factories for testing. Phase 7+ (Core components tested with fake plugins). Phase 11 (Orchestrator uses Registry for adapter access). Phase 12 (Daemon uses Registry for plugin lifecycle).

---

## Phase 7: Task Engine

### Context

The state machine owner. Tasks are the central entity — every operation in the system is performed in the context of a task. The Task Engine owns state transitions (with validation), permission enforcement (Gate 1 of the Action Pipeline), and task CRUD.

### Architecture Connection

- The state machine is CPU-derived: [`../1-system/task-states.md`](../1-system/task-states.md).
- 7 states (intake → queued → active → blocked → review_pending → completed → failed), sub-states (working, supervising, integrating, demo, code).
- 13 valid transitions defined in `ValidTransitions` from Phase 1a.
- Permission table maps (state, sub_state) → allowed ActionClasses — this is Gate 1 of the Action Pipeline.
- Decision #80: Cost tracking as real columns (llm_tokens, llm_cost_usd, compute_time_ms) for hot-path updates.
- Decision #81: State transitions in separate table for cross-task audit queries.

### Deliverables

| File | Purpose |
|------|---------|
| `src/core/task-engine/index.ts` | `TaskEngine` class. Constructor takes `Database` + `EventBus`. **createTask(input):** ULID generation, insert into `tasks` table, emit `task.created` event. **requestTransition(taskId, toState, toSub, reason, triggeredBy):** validate against `ValidTransitions`, update task, insert into `state_transitions` table, emit `task.state_changed`. **checkPermission(taskId, actionClass):** lookup `PermissionTable` by current (state, sub_state), return boolean. This is Gate 1. **getTask(id), getTasksByState(state), getQueuedByPriority():** query methods. **updateTracking(taskId, tokens, costUsd, computeMs):** increment cost columns with `SET llm_tokens = llm_tokens + ?`. |
| `src/core/task-engine/index.test.ts` | All 13 valid transitions succeed. Invalid transitions rejected with clear error. Permission checks return correct allowed ActionClasses for every (state, sub_state) pair. Task creation assigns ULID and emits event. Cost tracking accumulates correctly (multiple increments). `getQueuedByPriority()` returns highest priority first. State transition is recorded in `state_transitions` table. |

### Key Implementation Notes

- Use prepared statements for all queries — both for performance and SQL injection prevention.
- The `requestTransition()` method should update the task AND insert the state transition in a single transaction.
- `checkPermission()` is a pure lookup — it reads the current task state from DB, looks up `PermissionTable`, and checks if the requested `actionClass` is in the allowed list. Returns boolean, does not throw.
- `getQueuedByPriority()` should `ORDER BY priority DESC, created_at ASC` (highest priority first, ties broken by age).

### What To Read

- [`../2-components/task-engine.md`](../2-components/task-engine.md) — Task Engine design (state machine, hierarchy, permissions)
- [`../4-implementation/schemas/task.md`](../4-implementation/schemas/task.md) — Task schema, transitions, permission table
- Task schemas from Phase 1a (`src/schemas/task.ts`)

### Verification

All unit tests pass. Every valid transition works. Every invalid transition is rejected. Permission table covers all state/sub_state combinations. Events emitted on state changes. Cost tracking accumulates.

### What This Enables

Phase 9 (Action Pipeline uses `checkPermission()` as Gate 1). Phase 12 (Daemon uses Task Engine for scheduling — queue queries, priority, state management).

---

## Phase 8: Safety Layer + People Directory

### Context

Two components that share a common pattern: both are config-driven with hot-reload support. The Safety Layer enforces cost limits and autonomy policies (Gate 2 of the Action Pipeline). The People Directory resolves contacts for notifications and identifies the owner/reviewers.

### Architecture Connection

- Safety Layer is pipeline middleware (active gate in Action Pipeline) + passive consultation (judgment) + Event Bus subscriber (cost tracking).
- Decision #126: Cost limit types are `per_task`, `daily`, `monthly` (no `per_repo`).
- Decision #84: Safety accumulator snapshots in `_meta` table for fast startup, with event replay as fallback.
- Decision #94: `safety.yaml` and `people.yaml` are hot-reloadable with 500ms debounce.
- People Directory is config-driven from `people.yaml`, used by Orchestrator for notification routing and contact resolution.

### Deliverables

| File | Purpose |
|------|---------|
| `src/core/safety-layer/index.ts` | `SafetyLayer` class. Constructor takes `Database`, `EventBus`, `SafetyConfig`. **evaluateAction(taskId, actionClass, details):** check scope boundaries (allowed repos, branch patterns, file exclusions), return allow/deny with reason. This is Gate 2. **consultJudgment(query: SafetyQuery):** return `SafetyVerdict` (autonomy decisions — does this need human approval?). **Cost tracking:** subscribes to `cost.incurred` events via Event Bus, accumulates per-task/daily/monthly spend, emits `cost.limit_reached` when thresholds hit. **Snapshot:** periodically save accumulators to `_meta`, restore on startup. **Hot-reload:** accepts new `SafetyConfig`, re-derives limits. |
| `src/core/people-directory/index.ts` | `PeopleDirectory` class. Constructor takes people config (array of Person). **getPerson(id), getOwner(), getReviewers():** lookup methods. **resolveContact(personId, preferredChannel):** returns contact info for notification routing, falls back through contact list. **Hot-reload:** accepts new people config, replaces internal data. |
| `src/core/safety-layer/index.test.ts` | Scope boundary enforcement (allowed/denied repos, branches, file patterns). Cost accumulation across multiple `cost.incurred` events. Limit detection at per_task/daily/monthly boundaries. Snapshot save/restore round-trips. Hot-reload applies new limits immediately. Autonomy verdicts follow config rules. |
| `src/core/people-directory/index.test.ts` | Loads people config. Resolves contacts by person ID. Handles missing people gracefully. Hot-reload replaces data. Owner/reviewer queries work. Channel preference fallback works. |

### Key Implementation Notes

- Safety Layer subscribes to `cost.incurred` events on construction — use `eventBus.subscribe()` from Phase 4.
- Cost accumulators are in-memory (ephemeral), rebuilt from snapshots + event replay on startup. The snapshot frequency is configurable but a reasonable default is every N events or every M minutes.
- The `evaluateAction()` method (Gate 2) checks: is this action class allowed for this task's scope? Is it within cost limits? Are there scope boundary violations?
- People Directory is simpler — it's essentially a typed lookup table with hot-reload.

### What To Read

- [`../2-components/safety-layer.md`](../2-components/safety-layer.md) — Safety Layer design (scope, cost, autonomy, response timeout)
- [`../3-interactions/adapter-contracts.md`](../3-interactions/adapter-contracts.md) — People Directory section (Person, Contact, preferences)
- Config schemas from Phase 1b (`SafetyConfigSchema`, `PeopleDirectorySchema` in `src/schemas/config.ts`)

### Verification

All unit tests pass. Scope boundaries enforced. Cost tracking accumulates and detects limits. Snapshots round-trip correctly. Hot-reload works for both components. People resolves contacts with fallback.

### What This Enables

Phase 9 (Action Pipeline uses `evaluateAction()` as Gate 2). Phase 11 (Orchestrator uses `consultJudgment()` for autonomy decisions, People Directory for notification routing).

---

## Phase 9: Action Pipeline

### Context

The authorization middleware that sits between intent and execution. Every action in the system passes through this pipeline: Gate 1 (Task Engine checks if the action is allowed in the current state) → Gate 2 (Safety Layer checks if the action is within policy) → Execute → Notify. This is a thin module (~50-100 lines) but architecturally critical.

### Architecture Connection

- Decision #127: Action Pipeline is a dedicated Core module (not embedded in Orchestrator).
- Action Pipeline replaces L2's Event Bus pre-processing model (Decision #87).
- Gate 1 = `TaskEngine.checkPermission()` (Phase 7).
- Gate 2 = `SafetyLayer.evaluateAction()` (Phase 8).
- Owns the `action.rejected` event type.
- Used by Orchestrator (Phase 11) and Workspace Manager (Phase 10) for all actions.

### Deliverables

| File | Purpose |
|------|---------|
| `src/core/action-pipeline/index.ts` | `ActionPipeline` class. Constructor takes `TaskEngine`, `SafetyLayer`, `EventBus`. **execute(taskId, actionClass, executeFn, notifyFn?):** (1) Call `taskEngine.checkPermission(taskId, actionClass)` — if denied, emit `action.rejected` with gate="task_engine", return rejection. (2) Call `safetyLayer.evaluateAction(taskId, actionClass, details)` — if denied, emit `action.rejected` with gate="safety_layer", return rejection. (3) Call `executeFn()`, capture result. (4) If `notifyFn` provided, call it with result. Return success result. |
| `src/core/action-pipeline/index.test.ts` | Gate 1 blocks when task state disallows action class (mock Task Engine to deny). Gate 2 blocks when safety policy denies (mock Safety Layer to deny). Both gates pass → executeFn called and result returned. Gate 1 checked BEFORE Gate 2 (order matters). Rejection emits `action.rejected` event with correct gate identifier. executeFn errors are caught and returned as failure result. notifyFn is optional. |

### Key Implementation Notes

- This is intentionally thin — it's a pipeline, not a decision-maker. The intelligence lives in Task Engine (permissions) and Safety Layer (policy).
- Gate order matters: Task Engine first, then Safety Layer. If the task state doesn't allow the action, there's no point checking safety policy.
- The `action.rejected` event payload should include: `taskId`, `actionClass`, `gate` (which gate rejected), `reason` (why).
- Test using `vi.fn()` mocks for Task Engine and Safety Layer — this is a unit test, not integration.

### What To Read

- [`../3-interactions/event-catalog.md`](../3-interactions/event-catalog.md) — Action Pipeline section, `action.rejected` event payload
- [`../1-system/architecture-tiers.md`](../1-system/architecture-tiers.md) — Action Pipeline in the Core tier context

### Verification

All unit tests pass. Gate order is correct. Rejections emit proper events. Both gates must pass for execution. Pipeline is a clean, thin abstraction.

### What This Enables

Phase 10 (Workspace Manager uses Action Pipeline for git operations). Phase 11 (Orchestrator uses Action Pipeline for all actions).

---

## Phase 10: Session/Memory + Workspace Manager

### Context

Two components that support the Orchestrator's execution: Session/Memory provides persistence (checkpointing for crash recovery, knowledge for cross-task learning, journal for work logging) and Workspace Manager provides isolated git environments (worktrees per task).

### Architecture Connection

- Session/Memory: [`../2-components/session-memory.md`](../2-components/session-memory.md) — three-part system (checkpoint, knowledge, journal).
- Workspace Manager: [`../2-components/workspace-manager.md`](../2-components/workspace-manager.md) — git worktrees for task isolation.
- Decision #83: Knowledge uses content hash IDs (not ULID), with supersession chain.
- Decision #124: Workspace tests use real git in temp directories.
- Git worktrees are ephemeral — created when a task starts, cleaned up when done.
- Branch naming: `engineer/{issue_number}-{slug}` per WorkspaceConfig.

### Deliverables

| File | Purpose |
|------|---------|
| `src/core/session-memory/index.ts` | `SessionMemory` class. Constructor takes `Database`. **createSession(taskId):** new session record, returns session ID. **endSession(id, reason).** **addJournalEntry(sessionId, content):** append to journal. **createCheckpoint(sessionId, phase, outputs):** save phase progress. **getLatestCheckpoint(taskId):** for crash recovery — find most recent checkpoint. **storeKnowledge(entry):** content-hash ID generation, insert or update. **getKnowledge(scope, repoScope):** query by scope. **supersede(oldId, newId):** mark old entry as superseded. |
| `src/core/workspace-manager/index.ts` | `WorkspaceManager` class. Constructor takes `EventBus`, `Registry` (for GitHostingAdapter), workspace config. **createWorkspace(taskId, repo):** `git fetch`, create branch (`engineer/{number}-{slug}`), create worktree via `git worktree add`, emit `workspace.created`. **verifyWorkspace(taskId):** check worktree exists and is clean, emit `workspace.verified`. **cleanupWorkspace(taskId, preserveBranch?):** remove worktree, optionally delete branch, emit `workspace.cleaned`. **getWorktreePath(taskId).** PR operations (createPR, etc.) delegate to GitHostingAdapter from Registry. |
| `src/core/session-memory/index.test.ts` | Session lifecycle (create → add entries → checkpoint → end). Checkpoint save/restore round-trips. Knowledge content-hash IDs are deterministic. Supersession chain works. `getLatestCheckpoint` finds correct checkpoint. |
| `src/core/workspace-manager/index.test.ts` | Tests use real git in temp directories. Create workspace creates a worktree. Branch name follows convention. Verify checks worktree state. Cleanup removes worktree. Events emitted at each lifecycle point. |

### Key Implementation Notes

- Knowledge content hash: `hash(scope + repo_scope + key + JSON.stringify(value))` — use Node.js `crypto.createHash('sha256')`, take first 32 hex chars.
- Workspace Manager shells out to git commands (`git worktree add`, `git worktree remove`, `git fetch`, `git checkout -b`). Use `child_process.execSync` or `spawnSync` for simplicity — these are short-lived commands.
- Workspace tests create temp git repos with `git init`, add some commits, then test worktree operations against them. Clean up temp dirs in `afterEach`.
- Session/Memory is purely database-backed — no Event Bus dependency.
- Workspace Manager depends on Registry to get the GitHostingAdapter for PR operations, but in tests this comes from `createTestRegistry()` with fake git hosting.

### What To Read

- [`../2-components/session-memory.md`](../2-components/session-memory.md) — Checkpoint, knowledge, journal design
- [`../2-components/workspace-manager.md`](../2-components/workspace-manager.md) — Worktree management, branch hierarchy, PR lifecycle
- [`../4-implementation/schemas/session-memory.md`](../4-implementation/schemas/session-memory.md) — Session, journal, checkpoint, knowledge schemas

### Verification

All unit tests pass. Sessions track lifecycle. Checkpoints save/restore correctly. Knowledge uses content-hash IDs. Workspaces create real git worktrees in temp directories. Events emitted at each lifecycle point.

### What This Enables

Phase 11 (Orchestrator uses Session/Memory for checkpointing and knowledge, Workspace Manager for git operations). Phase 12 (Daemon uses checkpoints for crash recovery).

---

## Phase 11: Orchestrator (Skeleton)

### Context

The brain of the system — a 7-phase pipeline that takes a task from intake to integration. This phase builds the pipeline framework with thin phase handlers. Each handler calls the LLM adapter, parses the response with `.safeParse()` (Decision #85), and produces a `PhaseOutput`. Full phase sophistication (multi-step research, iterative execution, etc.) is added later.

### Architecture Connection

- Orchestrator derives from compiler front-end + flight director: [`../2-components/orchestrator.md`](../2-components/orchestrator.md).
- 7 phases: intake-analysis → research → planning → execution → self-review → demo-prep → integration.
- Uses Action Pipeline for all actions (Gate 1 + Gate 2 before every tool call, git operation, etc.).
- Uses Registry to get LLM and Tool adapters.
- Uses Session/Memory for checkpointing (resume from checkpoint on crash recovery).
- Preemption: listens for `preemption.requested` event, checkpoints current state, emits `preemption.ready`.
- Decision #85: Phase outputs validated with `.safeParse()` — LLM output is unreliable, handle deviations gracefully.

### Deliverables

| File | Purpose |
|------|---------|
| `src/core/orchestrator/index.ts` | `Orchestrator` class. Constructor takes `EventBus`, `Registry`, `TaskEngine`, `SafetyLayer`, `ActionPipeline`, `SessionMemory`, `WorkspaceManager`. **executeTask(dispatch: Dispatch):** main loop — determine current phase (from checkpoint or start), call phase handler, validate output with `.safeParse()`, create checkpoint, write journal entry, transition to next phase. Loop until all phases complete or interrupted. **Phase handlers (thin):** each calls LLM adapter with a phase-specific prompt template, parses response. Execution phase calls Tool adapter for code operations. **Preemption:** subscribe to `preemption.requested`, checkpoint current state, emit `preemption.ready`. **Resume:** `getLatestCheckpoint()` from Session/Memory, skip completed phases. |
| `src/core/orchestrator/index.test.ts` | Pipeline progresses through all 7 phases with fake LLM returning valid phase outputs. Checkpoint created on each phase transition. Preemption interrupts pipeline and checkpoints. Resume from checkpoint starts at correct phase, skips completed phases. Action Pipeline gates are respected (test with mock that rejects one action). Invalid LLM output handled gracefully (`.safeParse()` fails, pipeline continues or retries). |

### Key Implementation Notes

- Phase handlers in the skeleton are THIN — each constructs a prompt, calls `registry.getPrimaryPlugin('llm').complete(request)`, and parses the result against the phase's output schema using `.safeParse()`.
- The execution phase is special — it also calls the Tool adapter to run commands. In the skeleton, this is a single call to `registry.getPrimaryPlugin('tool').execute()`.
- Don't implement the full sophistication of each phase (multi-step research loops, iterative test-fix cycles, etc.) — that's for later refinement.
- Preemption is event-driven: subscribe to `preemption.requested` in the constructor. When received, set a flag that the phase loop checks between steps.
- The `Dispatch` type comes from `src/schemas/ephemeral.ts` (Phase 1b).

### What To Read

- [`../2-components/orchestrator.md`](../2-components/orchestrator.md) — Orchestrator design (phase pipeline, fast-path, preemption, notifications). Focus on the pipeline structure, not every detail.
- [`../3-interactions/protocols.md`](../3-interactions/protocols.md) — P4 (task execution), P8 (preemption), P9 (crash recovery). Read these three protocols, not all 15.
- Orchestrator schemas from Phase 1b (`src/schemas/orchestrator.ts`) — phase output shapes

### Verification

All unit tests pass. Pipeline runs through all 7 phases. Checkpoints are created. Preemption works. Resume from checkpoint skips completed phases. Action Pipeline gates are respected.

### What This Enables

Phase 12 (Daemon dispatches tasks to Orchestrator). Phase 15 (E2E tests run full task lifecycles through Orchestrator).

---

## Phase 12: Daemon + Logging — HELLO WORLD

### Context

The always-running heartbeat. The Daemon is the main loop that ties everything together — polls triggers, creates tasks, dispatches to the Orchestrator, manages plugin health, handles signals, and logs everything. This phase also sets up structured logging via pino. **This is the hello world milestone** — the first point where the full system is wired and runs end-to-end.

### Architecture Connection

- Decision #112: Foreground default, `--daemon` for background. PID file. Single instance. Signal handling (SIGTERM/SIGINT → graceful shutdown).
- Decision #110-#111: pino + pino-roll for structured JSON logging, component-tagged child loggers.
- Decision #124: E2E tests use in-process daemon with `createDaemon(config)` → `{ start(), stop(), tick() }`. Injectable clock for deterministic time control.
- Daemon tick loop: poll triggers → dedup → create tasks → check queue → dispatch → aging → stuck detection → health checks.
- Protocol P1 (startup): [`../3-interactions/protocols.md`](../3-interactions/protocols.md).
- Protocol P15 (shutdown): checkpoint active task, reverse plugin shutdown, close Event Bus, close DB, remove PID.

### Deliverables

| File | Purpose |
|------|---------|
| `src/core/daemon/index.ts` | `createDaemon(config, deps?)` factory function. Returns `Daemon` object with `start()`, `stop()`, `tick()`. **Tick loop:** (1) Poll trigger plugins via Registry, (2) dedup with `seen_trigger_keys` Set (TTL per config), (3) create tasks for new events via Task Engine, (4) check queue via `taskEngine.getQueuedByPriority()`, (5) dispatch highest-priority task to Orchestrator, (6) priority aging (increment priority for aged tasks), (7) stuck/runaway detection (emit health events), (8) health checks via Registry. **Process management:** PID file at `{ENGINEER_HOME}/run/engineer.pid`, single-instance check, signal handling (SIGTERM/SIGINT → graceful shutdown per P15). **Injectable dependencies:** clock, Event Bus, Registry, Task Engine, etc. passed via deps for testability. |
| `src/core/daemon/logging.ts` | `createLogger(config)`: pino instance with pino-roll transport (daily rotation, size cap per config). `createChildLogger(parent, component)`: tagged child logger. Component tags: daemon, registry, orchestrator, task-engine, safety, session-memory, workspace-manager, event-bus, people-directory, config, cli. |
| `test/helpers/fake-clock.ts` | `FakeClock` class: `current()` returns current fake time, `advance(ms)` moves time forward, replaces `Date.now()` and timer functions for deterministic testing. |
| `src/core/daemon/index.test.ts` | Tick loop calls trigger poll. Dedup works (same idempotency key not processed twice). New trigger events create tasks. Scheduling picks highest-priority queued task. Priority aging increments after threshold. Stuck detection fires for stale active tasks. Graceful shutdown checkpoints active task and removes PID. |

### Key Implementation Notes

- `createDaemon()` is a factory function, not a class constructor — this supports the in-process testing pattern from Decision #124.
- The `deps` parameter allows injecting fake clock, test Event Bus, test Registry, etc. In production, `createDaemon()` wires everything together. In tests, callers inject fakes.
- The tick loop should be driven by the clock — `setInterval(tick, config.tick_interval_ms)` in production, `daemon.tick()` called manually in tests.
- PID file: write PID on start, check for existing PID on start (refuse if alive + is The Engineer), remove on shutdown. Use `process.pid` and `process.kill(pid, 0)` for liveness check.
- Logging: create the pino instance early in `start()`, pass child loggers to all components.

### What To Read

- [`../2-components/daemon-scheduler.md`](../2-components/daemon-scheduler.md) — Daemon design (scheduling, preemption, capacity, health)
- [`../4-implementation/operations.md`](../4-implementation/operations.md) — Decisions #110-#112 (logging, process management)
- [`../3-interactions/protocols.md`](../3-interactions/protocols.md) — P1 (startup), P15 (shutdown)

### Verification

`createDaemon()` boots with fake plugins, ticks, polls trigger, creates task, dispatches to orchestrator. Graceful shutdown works. PID file created/removed. Logs written to file via pino. **This is the hello world — the full system runs end-to-end with fake plugins.**

### What This Enables

Phase 13 (CLI commands operate the daemon). Phase 15 (E2E tests use in-process daemon).

---

## Phase 13: CLI

### Context

The user interface — 8 commands that make the system operable. Built on commander (Decision #114). The CLI is the only way users interact with The Engineer directly.

### Architecture Connection

- Decision #114: commander framework.
- Decision #115: 8 commands (start, stop, status, logs, init, doctor, install, config validate).
- Decision #116: `doctor` with 10 check categories, pre-flight subset (1-6) on `start`.
- Decision #117: Auto-create dirs on first run, fail-with-instructions for missing secrets.
- Decision #118: `init` generates template configs with comments.
- Decision #113: `install` generates launchd/systemd configs.

### Deliverables

| File | Purpose |
|------|---------|
| `src/cli/index.ts` | commander program. Binary name `engineer`. Global options: `--home` (override ENGINEER_HOME), `--verbose`, `--version`, `--help`. Registers all subcommands. |
| `src/cli/commands/start.ts` | Foreground (default) or `--daemon` (background). Runs pre-flight (doctor categories 1-6). Auto-creates dirs. Inits DB. Boots daemon. `--verbose` sets log level to debug. |
| `src/cli/commands/stop.ts` | Reads PID file, sends SIGTERM, waits for exit. `--timeout` override (default from config). |
| `src/cli/commands/status.ts` | Checks PID file (running/stopped). If running: shows active tasks, queue depth, plugin health. |
| `src/cli/commands/logs.ts` | Tails log file. Default: pino-pretty formatted. `--json` for raw JSON. `--follow` for live tail. `--lines N` for last N lines. |
| `src/cli/commands/init.ts` | Creates `~/.engineer/` structure. Generates template configs (all fields commented out with defaults shown). Plugin configs have required fields uncommented with placeholders. Safe to re-run (skips existing). `--force` overwrites. |
| `src/cli/commands/doctor.ts` | 10 check categories: Node.js runtime, data directory, config files, required secrets, database, plugin manifests, GitHub connectivity, Telegram connectivity, workspace, risky config warnings. Exit codes: 0 (pass), 1 (fail), 2 (warnings). Actionable failure messages with remediation steps. |
| `src/cli/commands/install.ts` | macOS: generates launchd plist at `~/Library/LaunchAgents/`. Linux: generates systemd unit at `~/.config/systemd/user/`. Prints registration commands for user to run. |
| `src/cli/commands/config-validate.ts` | Loads all config files via config loader (Phase 3), reports per-file validation results. |

### What To Read

- [`../4-implementation/operations.md`](../4-implementation/operations.md) — Decisions #113-#118 (CLI commands, doctor, init, install)

### Verification

Each command runs with expected output. `init` creates directory structure. `doctor` runs all checks. `config validate` detects invalid configs. `start` boots the daemon in foreground.

### What This Enables

User operation. `engineer init && engineer start` works. Phase 15 (E2E tests may use CLI commands).

---

## Phase 14a: Contract Suites + Process Plugins

### Context

The first plugin batch. Contract compliance suites (one per adapter type) verify behavioral expectations TypeScript can't express. BashToolPlugin and ClaudeCodeLLMPlugin are process-based — they spawn child processes rather than making HTTP calls, making them simpler to implement and test.

### Architecture Connection

- Decision #122: Contract compliance suites test behavioral contracts (idempotency keys, error handling, usage reporting).
- Decision #108: Process safety rules for BashToolPlugin (explicit bash, signal forwarding, workspace confinement, env sanitization, output limits).
- Plugins import ONLY from `src/adapters/index.ts` (SDK boundary, Decision #105) and `src/schemas/`.
- Each plugin has: `engineer.plugin.yaml` manifest, `index.ts` factory, `{name}.ts` implementation, `config.ts` Zod schema.

### Deliverables

**Contract Suites:**

| File | Purpose |
|------|---------|
| `test/helpers/contract-suites/trigger-contract.ts` | `runTriggerContractSuite(factory, fixtures)`: poll() returns stable idempotency keys, initialize() with invalid config returns `{success: false}` (not throw), healthCheck() completes within timeout. |
| `test/helpers/contract-suites/communication-contract.ts` | sendMessage() returns SendResult, formatMessage() produces valid output, initialize/shutdown lifecycle. |
| `test/helpers/contract-suites/llm-contract.ts` | complete() always includes usage data (tokens_in, tokens_out, spend_usd), getCapabilities() returns valid capabilities. |
| `test/helpers/contract-suites/tool-contract.ts` | execute() reports side effects, describe() returns valid tool descriptions. |
| `test/helpers/contract-suites/git-hosting-contract.ts` | PR lifecycle methods return expected shapes, error cases return AdapterError (not throw). |

**Plugins:**

| File | Purpose |
|------|---------|
| `src/plugins/tool/bash-tool/engineer.plugin.yaml` | Manifest: type=tool, critical=true. |
| `src/plugins/tool/bash-tool/index.ts` | `createPlugin()` factory. |
| `src/plugins/tool/bash-tool/bash-tool.ts` | `BashToolPlugin extends ToolAdapter`. `doExecute()`: `spawn("bash", ["-c", cmd])` with `cwd` set to task workspace, env allowlist (PATH, HOME, NODE_ENV, LANG, TERM, GIT_*), output size limit (10MB), command timeout (5 min). Reports side effects (file_written, command_run, etc.). |
| `src/plugins/tool/bash-tool/config.ts` | Zod schema: `env_passthrough` (extra env vars), `max_output_bytes`, `command_timeout_ms`. |
| `src/plugins/llm/claude-code-llm/engineer.plugin.yaml` | Manifest: type=llm, critical=true. |
| `src/plugins/llm/claude-code-llm/index.ts` | `createPlugin()` factory. |
| `src/plugins/llm/claude-code-llm/claude-code-llm.ts` | `ClaudeCodeLLMPlugin extends LLMAdapter`. `doComplete()`: spawns `claude` CLI process, passes prompt via stdin, parses structured output, reports usage (tokens, cost). `doGetCapabilities()`: returns model info. |
| `src/plugins/llm/claude-code-llm/config.ts` | Zod schema: `model`, `max_tokens`, CLI path. |

### What To Read

- [`../4-implementation/plugins.md`](../4-implementation/plugins.md) — Decision #108 (process safety rules)
- [`../4-implementation/testing.md`](../4-implementation/testing.md) — Decision #122 (contract suites)
- [`../3-interactions/adapter-contracts.md`](../3-interactions/adapter-contracts.md) — Tool and LLM adapter contracts

### Verification

All 5 contract suites defined. BashToolPlugin passes tool contract suite. ClaudeCodeLLMPlugin passes LLM contract suite. Process safety rules enforced (workspace confinement, env sanitization, output limits). Fake plugins from Phase 6 also pass their respective contract suites.

### What This Enables

Phase 14b/14c (remaining plugins use contract suites). Integration tests can use real BashTool instead of fake.

---

## Phase 14b: GitHub Plugins

### Context

Three GitHub plugins that share the Octokit library: GitHubTriggerPlugin (polls issues), GitHubCommPlugin (comments on issues/PRs), and GitHubHostingPlugin (PR lifecycle). Building them together leverages shared API knowledge.

### Architecture Connection

- Decision #74: GitHub API polling (5k/hour free tier, ~120/hour needed, 30s latency acceptable).
- GitHubTriggerPlugin implements TriggerAdapter — polls assigned issues/events.
- GitHubCommPlugin implements CommunicationAdapter — posts comments, manages labels.
- GitHubHostingPlugin implements GitHostingAdapter — full PR lifecycle.

### Deliverables

| Plugin | Key Implementation |
|--------|-------------------|
| `src/plugins/trigger/github-trigger/` | Polls GitHub Issues API via Octokit. Generates stable idempotency keys from `{repo}:{issue_number}:{event_type}`. Returns `TriggerEvent[]`. Config: `repos` (which repos to poll), `labels` (filter by label), `poll_interval_ms`. |
| `src/plugins/communication/github-comm/` | Comments on issues/PRs via Octokit. `sendMessage()` creates/updates issue comments. Optional: `commentOnIssue()`, `manageIssueLabels()`. Config: GitHub token via `${GITHUB_TOKEN}`. |
| `src/plugins/git-hosting/github-hosting/` | Full PR lifecycle via Octokit: create (draft → ready), update, merge (squash default), close, get status, get review status, comment, get branch protection, get default branch. Config: GitHub token. |

Each plugin: manifest, factory, implementation, config schema, tests (including contract suite).

### What To Read

- [`../3-interactions/adapter-contracts.md`](../3-interactions/adapter-contracts.md) — Trigger, Communication, GitHosting adapter contracts
- [`../4-implementation/plugins.md`](../4-implementation/plugins.md) — Plugin structure, manifest format

### Verification

Each plugin passes its contract suite. Plugin-specific tests verify API interaction logic (mock Octokit HTTP responses). Config validation works. Idempotency keys are stable across polls.

---

## Phase 14c: Telegram Plugin

### Context

The Telegram communication plugin. Uses the grammy library for Telegram Bot API. Separate from GitHub plugins because it's a completely different API and library.

### Architecture Connection

- CommunicationAdapter implementation.
- Telegram is Farzam's real-time communication channel (not Slack).
- Communication plugins are dumb transport — Orchestrator owns all intelligence (Decision #40).

### Deliverables

| File | Purpose |
|------|---------|
| `src/plugins/communication/telegram-comm/engineer.plugin.yaml` | Manifest: type=communication, critical=false (system works without Telegram). |
| `src/plugins/communication/telegram-comm/index.ts` | `createPlugin()` factory. |
| `src/plugins/communication/telegram-comm/telegram-comm.ts` | `TelegramCommPlugin extends CommunicationAdapter`. `doSendMessage()`: sends message via grammy bot. `doFormatMessage()`: Telegram markdown formatting. Optional: `doStartListening()` for inbound messages (bot polling). Config: bot token via `${TELEGRAM_BOT_TOKEN}`, chat ID. |
| `src/plugins/communication/telegram-comm/config.ts` | Zod schema: bot_token, chat_id, parse_mode. |
| Tests + contract suite compliance. |

### What To Read

- [`../3-interactions/adapter-contracts.md`](../3-interactions/adapter-contracts.md) — Communication adapter contract

### Verification

Passes communication contract suite. Sends messages via mocked grammy. Config validates correctly. Formatting produces valid Telegram markdown.

---

## Phase 15: Integration + E2E Tests

### Context

Cross-component integration tests (real Core, fake plugins) and full daemon lifecycle E2E tests (in-process daemon, fake clock). These tests validate that components work together correctly and that the system handles real-world scenarios.

### Architecture Connection

- Decision #123: Integration tests use real Core + fake plugins via Registry.
- Decision #124: E2E tests use in-process daemon with injectable clock.
- Decision #119: Integration config (`vitest.integration.config.ts`), E2E config (`vitest.e2e.config.ts`).
- Lifecycle traces from [`../3-interactions/lifecycle.md`](../3-interactions/lifecycle.md) — the scenarios that define "done."

### Deliverables

**Integration Tests:**

| File | Scenario |
|------|----------|
| `test/integration/registry-plugin-loading.integration.test.ts` | Five-phase loading with real Registry + fake plugins. Type ordering. Invalid manifest handling. |
| `test/integration/daemon-trigger-polling.integration.test.ts` | Daemon tick → fake trigger returns events → tasks created. Dedup across ticks. |
| `test/integration/task-lifecycle.integration.test.ts` | Task through all states with correct events emitted at each transition. |
| `test/integration/config-hot-reload.integration.test.ts` | Safety/people config changed on disk → components pick up new values. |
| `test/integration/event-bus-delivery.integration.test.ts` | Multi-subscriber delivery, ordering guarantees, pattern matching. |
| `test/integration/health-state-machine.integration.test.ts` | Plugin health transitions: healthy → unhealthy → failed, with correct health events. |

**E2E Tests:**

| File | Scenario |
|------|----------|
| `test/e2e/daemon-lifecycle.e2e.test.ts` | Startup → tick → shutdown. PID file lifecycle. Signal handling. |
| `test/e2e/task-happy-path.e2e.test.ts` | Full lifecycle: fake trigger fires → task created → orchestrator runs 7 phases → PR created (fake) → task completed. Maps to Lifecycle Trace 1 from lifecycle.md. |
| `test/e2e/crash-recovery.e2e.test.ts` | Daemon stops mid-task → restart → picks up from checkpoint → completes task. Maps to Lifecycle Trace 3. |

### What To Read

- [`../4-implementation/testing.md`](../4-implementation/testing.md) — Decisions #119, #123, #124 (test architecture)
- [`../3-interactions/lifecycle.md`](../3-interactions/lifecycle.md) — 3 lifecycle traces (happy path, decomposition, crash recovery)

### Verification

All integration and E2E tests pass. Happy path runs end-to-end with fake plugins. Crash recovery demonstrates checkpoint + resume. No flakiness (deterministic via fake clock).

---

## Resolved Decisions

- **Schema scope:** Split into 1a (core data) + 1b (integration types) for context window management. Pure data, shared conventions.
- **Plugin timing:** Split into 14a (contract suites + process plugins) + 14b (GitHub, all Octokit) + 14c (Telegram, grammy). Different APIs deserve isolated context.
- **Hello world:** Phase 12 is natural — bottom-up means each phase is independently testable via unit tests.
- **Granularity:** 19 total phases. 6 Small, 8 Medium, 5 Large — no phase risks context overflow.
