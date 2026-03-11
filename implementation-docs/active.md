# Active Work

## Current Focus

Implementation. Building The Engineer phase by phase, bottom-up, following the 19-phase build order in `5-build/build-order.md`.

All architecture docs remain source of truth. Every implementation choice must trace back to the decisions log.

## What We're Doing

Implementing The Engineer from the bottom up — schemas and infrastructure first, then components in dependency order, then the daemon that wires everything together. Each phase produces something independently testable.

Working method: collaborative, always. Read the architecture deeply before every phase. Research, investigate, and discuss until confident. Farzam and the agent complete each other.

## Deliverables

All work lives in `/implementation-docs/`, organized by architectural layer:
- `active.md` — this file, what we're working on right now
- `layers.md` — architecture layering roadmap (see [`layers.md`](layers.md))
- `decisions.md` — decision log
- `sessions/` — succinct logs of each work session
- `0-foundation/` — Layer 0: Goals & Philosophy
  - `goals.md` — the destination (14 sections)
  - `philosophy.md` — project beliefs and principles
- `1-system/` — Layer 1: System Overview
  - `architecture-tiers.md` — three-tier model (Core / Adapter / Plugin), extensibility design
  - `overview.md` — high-level components + tier classification
  - `task-states.md` — CPU-derived task state machine
  - `relationships.md` — component relationships, data flow, simulation gaps
  - `user-flows.md` — concrete user flows from Farzam's perspective (Layer 1.5)
- `2-components/` — Layer 2: Component Architecture
  - `task-engine.md` — Task Engine (state machine, hierarchy, permissions)
  - `session-memory.md` — Session/Memory (checkpoints, knowledge, queryable journal)
  - `daemon-scheduler.md` — Daemon/Scheduler (scheduling, preemption, capacity, health)
  - `safety-layer.md` — Safety Layer (cost tracking, scope, autonomy, response timeout)
  - `orchestrator.md` — Orchestrator (phase pipeline, fast-path, notifications, supervision)
  - `workspace-manager.md` — Workspace Manager (worktrees, branch hierarchy, progressive merge)
  - `comm-plugins.md` — Communication Plugins (status query interface, GitHub state sync)
  - `event-bus.md` — Event Bus (event model, delivery guarantees, persistence)
- `3-interactions/` — Layer 3: Interactions & Protocols
  - `event-catalog.md` — Event Catalog (30 events, 10 groups, Action Pipeline)
  - `adapter-contracts.md` — Adapter Contracts (TriggerAdapter, CommunicationAdapter, LLMAdapter, ToolAdapter, GitHostingAdapter + Registry + People Directory)
  - `protocols.md` — Protocols (15 cross-component interaction protocols)
  - `error-propagation.md` — Error Propagation (failure classification, 7 chains, 6 patterns)
  - `lifecycle.md` — Lifecycle Traces (3 end-to-end scenarios, full coverage)
- `4-implementation/` — Layer 4: Implementation Design
  - `foundation.md` — Technology stack (TypeScript, Node 22, pnpm, SQLite, Biome, Zod, Vitest)
  - `layout.md` — Project layout, config system, tsconfig, Biome, git hooks, enforcement pipeline
  - `plugins.md` — Plugin system (manifest, loading, abstract classes, SDK boundary, lifecycle, process safety)
  - `operations.md` — Deployment & operations (data directory, logging, daemon, CLI, doctor, first-run)
  - `testing.md` — Testing strategy (three-tier Vitest, coverage, contract suites, boundary tests)
  - `openclaw-review.md` — OpenClaw reference (validated decisions, all high-priority patterns adopted)
  - `schemas/` — Data structures & schemas (Zod schemas, SQLite DDL, 9 files)
- `future-considerations.md` — Deferred decisions (monorepo evolution path)

## Repo Structure

```
the-engineer/
├── README.md              # Project overview
├── persona.md             # Identity (stable input to architecture)
└── implementation-docs/             # Our workspace (builders only)
    ├── active.md          # Current focus (this file)
    ├── layers.md          # Architecture layering roadmap
    ├── decisions.md       # Decision log
    ├── sessions/          # Session logs
    ├── 0-foundation/      # Layer 0: Goals & Philosophy
    ├── 1-system/          # Layer 1: System Overview
    ├── 2-components/      # Layer 2: Component Architecture
    ├── 3-interactions/    # Layer 3: Interactions & Protocols
    ├── 4-implementation/  # Layer 4: Implementation Design
    └── 5-build/           # Layer 5: Build Order & Implementation
```

Everything else in the repo will be for The Engineer (the agent) — created as we implement each phase.

## Status

**Architecture: ALL COMPLETE.** Layers 0-5, 136 decisions.

**Implementation: IN PROGRESS.**

- Phase 0: Project Bootstrap — **DONE** (Session 31). 12 files: package.json, tsconfig.json, biome.json, lefthook.yml, 4 vitest configs, test/setup.ts, src/index.ts, .gitignore, .node-version. All verification passes.
- Phase 1a: Core Data Schemas — **DONE** (Session 32). 7 files in `src/schemas/`: task.ts (4 enums, 12 sub-schemas, TaskSchema, StateTransitionSchema, ValidTransitions 25 rules, PermissionTable 10 entries), events.ts (EventSchema envelope, 30 payload schemas, EventPayloads mapped type, TypedEvent generic, eventPayloadSchemas runtime registry), session-memory.ts (Session, JournalEntry, Checkpoint, KnowledgeEntry, knowledgeId()), 3 test files (126 tests), index.ts barrel. 3 Biome exceptions added (useNamingConvention, noBarrelFile, noReExportAll). All verification passes.
- Phase 1b: Integration Schemas — **DONE** (Session 33). 8 files in `src/schemas/`: config.ts (~25 schemas, all config with `.default()` values, conservative SafetyConfig defaults), adapters.ts (~37 schemas, all adapter contract types), orchestrator.ts (~22 schemas + PhaseOutputMap type), ephemeral.ts (~18 schemas, imports Phase 1a + config types), 4 test files (198 tests), index.ts barrel updated. Total: 324 tests across 7 test files. All verification passes.
- Phase 3: Config System — **DONE** (Session 34). 7 files: `src/config/loader.ts` (error classes, env var resolution, Zod schema introspection for duration parsing, `loadConfig<S>()`, `loadConfigSafe<S>()`, `loadConfigDir()`), `src/config/watcher.ts` (`createConfigWatcher()` with `fs.watch()` + 500ms debounce), `src/config/index.ts` (barrel), `PeopleConfigSchema` added to `src/schemas/config.ts`, 2 test files (59 tests), 8 YAML fixtures in `test/fixtures/configs/`. 4 Biome exceptions added (noDelete, noNonNullAssertion, noEmptyBlockStatements). Total: 383 tests across 9 test files. All verification passes.
- Phase 2: Database Layer — **DONE** (Session 35). 5 files: `src/db/database.ts` (`DatabaseError`, `MigrationError`, migration runner, `createDatabase()`, `createInMemoryDatabase()`, `DatabaseHandle { db, close() }`), `src/db/migrations/001_initial.sql` (7 tables + 25 indexes), `src/db/index.ts` (barrel), `src/db/database.test.ts` (29 tests), `test/helpers/test-database.ts` (`createTestDatabase()` helper). Migration runner bootstraps `_meta`, applies SQL files in transactions, enables WAL + synchronous=NORMAL after migrations. No Biome exceptions needed. No prepared statement helpers (deferred to consuming phases). Total: 412 tests across 10 test files. All verification passes. Hardened in Session 035 (FK enforcement, regex fix, barrel exports, +12 tests → 424 total).

- Phase 4: Event Bus — **DONE** (Session 036). 4 files: `src/core/event-bus/index.ts` (`EventBus` class — publish with ULID + auto-increment sequence, subscribe with glob patterns, unsubscribe, replay for state reconstruction, getEventsForTask, getEventsSince, `matchesPattern()` pure function), `src/core/event-bus/index.test.ts` (35 tests), `test/helpers/test-event-bus.ts` (`createTestEventBus()` helper — getEmittedEvents, assertEventEmitted), `test/helpers/test-event-bus.test.ts` (6 tests). Pure pub/sub, no runtime payload validation (L3 spec), synchronous delivery, DB persistence before delivery. `vitest.config.ts` updated to include `test/helpers/**/*.test.ts`. Runtime payload validation documented as future consideration. Total: 469 tests across 12 test files. All verification passes.

- Phase 5: Adapter Base Classes + SDK Boundary — **DONE** (Session 037). 9 source files in `src/adapters/`: `errors.ts` (`createAdapterError()` factory + `AdapterMethodError` throwable class), `base.ts` (`BaseAdapter` abstract class — manifest injection, `hasCapability()`, lifecycle template methods), `trigger.ts` (`TriggerAdapter` — poll/doPoll), `communication.ts` (`CommunicationAdapter` — 1 required + 7 optional methods with default-throw pattern, capability-gated), `llm.ts` (`LLMAdapter` — complete/doComplete, getCapabilities sync), `tool.ts` (`ToolAdapter` — describe sync, execute/doExecute with `ToolExecutionContext`), `git-hosting.ts` (`GitHostingAdapter` — 9 template-wrapped PR/branch methods), `index.ts` (curated SDK boundary barrel). 8 test files (114 tests). `ToolExecutionContextSchema` added to `src/schemas/adapters.ts`. 6 discrepancies between L3/L4/L5 specs identified and resolved. Template method pattern on all async I/O methods; sync pure methods (`formatMessage`, `describe`, `getCapabilities`) left as direct abstract. 1 Biome exception added (noNamespaceImport for SDK boundary test). Total: 584 tests across 20 test files. All verification passes.

- Phase 6: Registry + Fake Plugins + Test Infrastructure — **DONE** (Session 038). ~21 files total. `src/core/registry/index.ts` (`Registry` class — five-phase loading pipeline: discover → validate → order → load → initialize, programmatic `register()`/`deregister()` as pure storage, health state machine with 3 states healthy/unhealthy/failed, health check loop with configurable interval/timeout/threshold, `configResolver` callback for decoupled config, rich logging at every step). `src/core/registry/index.test.ts` (58 tests). `src/schemas/events.ts` updated with 3 new health event types (`health.plugin_unhealthy`, `health.plugin_failed`, `health.plugin_recovered`) + payload schemas. 5 fake plugins in `test/helpers/fake-plugins/` (FakeTriggerPlugin, FakeCommunicationPlugin, FakeLLMPlugin, FakeToolPlugin, FakeGitHostingPlugin — each with engineer.plugin.yaml manifest + test control surface). `test/helpers/mock-factories.ts` (7 factory functions, 17 tests). `test/helpers/test-registry.ts` (`createTestRegistry()` → registry + fakes + cleanup, 5 tests). `test/boundary/tier-import-rules.test.ts` (6 tests — enforces three-tier import rules). 5 YAML test fixtures in `test/fixtures/manifests/`. Dual tsconfig setup: `tsconfig.test.json` for test code with `rootDir: "."`. Total: 670 tests across 24 test files. All verification passes (tests + typecheck + lint).

- Phase 7: Task Engine — **DONE** (Session 039). 3 files: `src/core/task-engine/index.ts` (`TaskEngine` class — createTask with no auto-transition (intake, caller transitions to queued), requestTransition with all 25 valid transitions validated, checkPermission returning PermissionResult with conditional metadata for Gate 1, getTask, getTasksByState, getQueuedByPriority, getChildren, getStateHistory, updateTaskField for 15 updatable fields with JSON serialization, updateTracking with atomic SQL increment), `src/core/task-engine/index.test.ts` (79 tests), `test/helpers/test-task-engine.ts` (`createTestTaskEngine()` helper). `isValidTransition()` exported pure function with `subStateMatches()` helper. `rowToTask()` exported for test helper use. Protocol P2 updated (intake→queued is caller-driven). Build order updated (getChildren/updateTaskField/getStateHistory noted as done in Phase 7). Total: 749 tests across 25 test files. All verification passes (tests + typecheck + lint).

- Phase 8: Safety Layer + People Directory — **DONE** (Session 040). 6 files. **People Directory** (`src/core/people-directory/index.ts`): pure config-driven contact resolution — `getPerson`, `getByRole`, `getOwner`, `getReviewers`, `resolveContact` (channel fallback, `plugin_id` = channel name), `getAll`, `updateConfig`. No DB, no EventBus. 16 tests. **Safety Layer** (`src/core/safety-layer/index.ts`): Gate 2 of Action Pipeline. Two-method API: `evaluateAction()` (repo/branch/file scope + merge policy + cost limits) and `consultJudgment()` (three query types: `can_i`, `should_i_ask`, `cost_check`). Returns `SafetyVerdict { allowed, action, reason, warnings? }`. Cost tracking via `cost.incurred` subscription with `_meta` snapshots + event replay. Daily/monthly UTC window management. `getTimeoutPolicy()` for Daemon. Hot-reload. 65 tests. Exported pure functions: `getDailyWindowStart`, `getMonthlyWindowStart`, `parseThreshold`, `evaluateThreshold`, `matchesPathPattern`. Test helpers: `createTestSafetyLayer()`, `createTestPeopleDirectory()`. 8 new decisions (#129-#136). Total: 830 tests across 27 test files. All verification passes (tests + typecheck + lint, 0 errors, 0 warnings).

- Phase 9: Action Pipeline — **DONE** (Session 041). 2 files. `src/core/action-pipeline/index.ts` (`ActionPipeline` class — thin authorization middleware wiring Gate 1 → Gate 2 → Execute → Notify). `execute<T>(input: ExecuteInput<T>)` takes options object with `taskId`, `actionClass`, `details`, `requestedBy`, `executeFn`, `notifyFn?`. Returns `Promise<PipelineResult<T>>` discriminated union with 4 outcomes: `executed`, `rejected`, `ask_human`, `error`. Gate 1 calls `TaskEngine.checkPermission()` — structural state check. Gate 2 calls `SafetyLayer.evaluateAction()` — policy check (skipped for `read` actions). Rejections emit `action.rejected` events. `ask_human` verdicts return to caller (Orchestrator handles transitions). Execution errors caught; notify errors logged and swallowed. `checkSafetyVerdict()` extracted private method (Biome complexity). First use of `vi.fn()` mocks in project (build order spec). 20 tests. Total: 850 tests across 28 test files. All verification passes (tests + typecheck + lint, 0 errors, 0 warnings).

- Phase 10: Session/Memory + Workspace Manager — **DONE** (Session 042). 6 new files, 2 modified. **SessionMemory** (`src/core/session-memory/index.ts`): pure database-backed storage — 11 methods (createSession, endSession, addJournalEntry, queryJournal with dynamic SQL + `json_each` tag matching, createCheckpoint, getLatestCheckpoint across sessions, storeKnowledge with content-hash upsert, getKnowledge filtered by scope, supersedeKnowledge, confirmKnowledge, getSessionChain). 4 exported row mappers. 5 input types. Prepared statements for all static queries. 34 tests. **WorkspaceManager** (`src/core/workspace-manager/index.ts`): git operations service using real `execSync` commands — createWorkspace (fetch + branch + worktree), verifyWorkspace (valid/recoverable/lost), cleanupWorkspace (idempotent), getWorktreePath. Exported pure functions: `slugify()`, `branchName()`. Emits typed workspace events. Registry deferred (PR ops not yet needed). 26 tests with real git in temp dirs. **Schema fix**: `knowledgeId()` updated to include `repoScope` for strict per-repo isolation (2 new tests). Test helpers: `createTestSessionMemory()` with FK-aware `insertTask()`, `createTestWorkspaceManager()` with bare repo + clone setup. Total: 912 tests across 30 test files. All verification passes (tests + typecheck + lint, 0 errors, 0 warnings).

- Phase 11: Orchestrator (Skeleton) — **DONE** (Session 043). 3 files. `src/core/orchestrator/index.ts` (`Orchestrator` class — 7-phase pipeline: intake_analysis → research → planning → execution → self_review → demo_prep → integration). `executeTask(dispatch)` main entry point — session setup, resume-from-checkpoint (Protocol P9), phase loop with preemption checks (Protocol P8), phase transitions (Protocol P4). 7 private phase handlers dispatched via `phaseHandlers` Record. `callLlmAndParse()` wraps ActionPipeline LLM calls + JSON parse + safeParse validation + cost.incurred emission. Execution phase additionally calls Tool adapter through ActionPipeline with `actionClass: "write"`. safeParse failures handled gracefully with fallback outputs (Decision #85). Fast-path: trivial tasks skip research/planning/demo_prep/integration. Preemption: cooperative yield between phases → checkpoint + end session + emit preemption.ready. Resume: skip completed phases, linked session. 4 helper methods extracted for Biome cognitive complexity (resolveStartState, handlePhaseError, recordPhaseTransition, applyFastPathIfNeeded). `test/helpers/test-orchestrator.ts` (`createTestOrchestrator()` — all 7 deps mocked, `setAllPhaseResponses()`, `triggerPreemption()`, mock fixtures). 35 tests across 12 groups. Total: 947 tests across 31 test files. All verification passes (tests + typecheck + lint, 0 errors, 0 warnings).

**Next: Phase 12 — Daemon + Logging (HELLO WORLD).** The always-running heartbeat that ties everything together — polls triggers, creates tasks, dispatches to the Orchestrator, manages plugin health, handles signals, and logs everything. First end-to-end system run. See [`5-build/build-order.md`](5-build/build-order.md) § Phase 12.
