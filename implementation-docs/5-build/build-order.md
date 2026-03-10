# Layer 5: Build Order

Implementation sequence for The Engineer. 16 phases, bottom-up. Each phase builds on the last, dependencies flow forward only.

Part of **Layer 5** — see [`../layers.md`](../layers.md). Implements specifications from [`../4-implementation/`](../4-implementation/).

---

## Approach

Bottom-up, like a compiler bootstrap. Schemas and infrastructure first, then components in dependency order, then the daemon that wires everything together. Each phase produces something independently testable.

**Hello world milestone:** Phase 12 — `createDaemon(config)` boots with fake plugins, ticks, polls a fake trigger, creates a task, dispatches to the orchestrator skeleton.

---

## Phase 0: Project Bootstrap

**Delivers:** Buildable, lintable, type-checkable empty project with all tooling.

**Files:**
- `package.json` — pnpm, ESM (`"type": "module"`), bin entry, all scripts from testing.md
- `tsconfig.json` — max strict per Decision #98
- `biome.json` — `all` preset per Decision #99
- `lefthook.yml` — pre-commit: biome+tsc, pre-push: unit tests per Decision #101
- `vitest.config.ts`, `vitest.shared.ts`, `vitest.integration.config.ts`, `vitest.e2e.config.ts` — three-tier per Decision #119
- `test/setup.ts` — global setup skeleton
- `src/index.ts` — entry stub
- `.gitignore`, `.node-version`

**Depends on:** Nothing
**Enables:** Everything
**Verification:** `pnpm install`, `pnpm tsc --noEmit`, `pnpm biome check` all pass
**Scope:** Small

---

## Phase 1: Zod Schemas

**Delivers:** All type definitions — the type system foundation for the entire codebase.

**Files:**
- `src/schemas/task.ts` — TaskState, SubState, CascadePolicy, ActionClass, Task, StateTransition, ValidTransitions, PermissionTable, all nested types
- `src/schemas/events.ts` — Event envelope, all 30 event payload schemas, EventPayloads mapped type, TypedEvent generic
- `src/schemas/session-memory.ts` — Session, JournalEntry, Checkpoint, KnowledgeEntry
- `src/schemas/adapters.ts` — PluginManifest, InitResult, HealthStatus, AdapterError, all 5 adapter type contracts, People Directory types
- `src/schemas/orchestrator.ts` — 7 PhaseOutput schemas, CommEvent, QuestionBatch, DecompositionPlan
- `src/schemas/ephemeral.ts` — DaemonState, CostAccumulators, SafetySnapshot, WorkspaceState
- `src/schemas/config.ts` — DaemonConfigSchema, OrchestratorConfigSchema, SafetyConfigSchema, WorkspaceConfigSchema (all with `.default()`)
- Co-located unit tests for each schema file

**Source of truth:** [`../4-implementation/schemas/`](../4-implementation/schemas/)
**Depends on:** Phase 0
**Enables:** Every subsequent phase
**Verification:** All schema tests pass — valid data parses, invalid data rejected, defaults apply, enum boundaries covered
**Scope:** Large

---

## Phase 2: Database Layer

**Delivers:** SQLite setup, migration system, connection management.

**Files:**
- `src/db/database.ts` — `createDatabase(path)`: WAL mode, migrations, prepared statements. `createInMemoryDatabase()` for tests.
- `src/db/migrations/001_initial.sql` — 7 tables + indexes + `_meta` from sqlite.md
- `src/db/database.test.ts`
- `test/helpers/test-database.ts` — `createTestDatabase()` returning `{ db, cleanup }`

**Source of truth:** [`../4-implementation/schemas/sqlite.md`](../4-implementation/schemas/sqlite.md)
**Depends on:** Phase 0, Phase 1
**Enables:** Task Engine, Event Bus, Session/Memory
**Verification:** Migration runs clean, WAL enabled, schema version tracked, all 7 tables exist, re-running is idempotent
**Scope:** Small

---

## Phase 3: Config System

**Delivers:** YAML loading, env var resolution, duration parsing, Zod validation, hot-reload watcher.

**Files:**
- `src/config/loader.ts` — `loadConfig<T>(filePath, schema)`, `loadConfigDir(configDir)`. Handles missing files (Zod defaults), missing env vars (clear error), `${ENV_VAR}` resolution, `ms` duration parsing.
- `src/config/watcher.ts` — `createConfigWatcher(files, onChange)`: `node:fs.watch()`, 500ms debounce, keeps previous on invalid change.
- Tests for both + `test/fixtures/configs/` (valid/invalid YAML)

**Source of truth:** [`../4-implementation/layout.md`](../4-implementation/layout.md) (Decisions #90-#97)
**Depends on:** Phase 0, Phase 1 (config schemas)
**Enables:** Daemon, Safety Layer, People Directory, Orchestrator
**Verification:** Loads valid YAML, applies Zod defaults for missing files, resolves env vars, parses durations, rejects invalid config with clear errors, watcher debounces correctly
**Scope:** Medium

---

## Phase 4: Event Bus

**Delivers:** The nervous system — publish, subscribe, persist to SQLite, replay.

**Files:**
- `src/core/event-bus/index.ts` — `EventBus` class: `publish(event)` persists + delivers to subscribers. `subscribe(type, callback)` with glob patterns (`task.*`). `replay(fromSequence)`. Auto-incrementing sequence. ULID event IDs.
- `src/core/event-bus/index.test.ts`
- `test/helpers/test-event-bus.ts` — `createTestEventBus()` with assertion helpers: `getEmittedEvents(type?)`, `assertEventEmitted(type, matcher)`

**Source of truth:** [`../2-components/event-bus.md`](../2-components/event-bus.md), [`../3-interactions/event-catalog.md`](../3-interactions/event-catalog.md)
**Depends on:** Phase 1 (event schemas), Phase 2 (database)
**Enables:** All Core components (everything emits/subscribes)
**Verification:** Events persist and replay in order. Subscribers receive correct events. Pattern matching works. Sequence is monotonic.
**Scope:** Medium

---

## Phase 5: Adapter Base Classes + SDK Boundary

**Delivers:** Abstract classes, error helpers, curated SDK exports.

**Files:**
- `src/adapters/base.ts` — `BaseAdapter` abstract: manifest, `hasCapability()`, template methods with timing/logging/error handling
- `src/adapters/trigger.ts`, `communication.ts`, `llm.ts`, `tool.ts`, `git-hosting.ts` — 5 abstract adapter classes
- `src/adapters/errors.ts` — `createAdapterError()` helper
- `src/adapters/index.ts` — curated SDK re-exports (future plugin-sdk extraction point)
- Tests for base + errors

**Source of truth:** [`../4-implementation/plugins.md`](../4-implementation/plugins.md) (Decisions #104-#105), [`../3-interactions/adapter-contracts.md`](../3-interactions/adapter-contracts.md)
**Depends on:** Phase 1 (adapter schemas)
**Enables:** Registry, all plugins, contract suites
**Verification:** Template methods work (timing, error catching). `hasCapability()` works. SDK boundary exports only what it should.
**Scope:** Small

---

## Phase 6: Registry + Fake Plugins + Test Infrastructure

**Delivers:** Plugin lifecycle management, fake plugins for testing, boundary enforcement.

**Files:**
- `src/core/registry/index.ts` — `Registry` class: five-phase loading (discover → validate → order → load → initialize), `getPlugin(type)`, `getPrimaryPlugin(type)`, health state machine (healthy/unhealthy/failed), health check loop, graceful shutdown in reverse order
- `src/core/registry/index.test.ts`
- `test/helpers/fake-plugins/` — FakeTrigger, FakeComm, FakeLLM, FakeTool, FakeGitHosting (each with manifest + factory)
- `test/helpers/test-registry.ts` — `createTestRegistry()` pre-loaded with fakes
- `test/helpers/mock-factories.ts` — `createMockManifest()`, `createMockTriggerEvent()`, etc.
- `test/fixtures/manifests/` — valid/invalid YAML manifests
- `test/boundary/tier-import-rules.test.ts` — architectural boundary enforcement (Decision #125)

**Source of truth:** [`../4-implementation/plugins.md`](../4-implementation/plugins.md) (Decisions #102-#108), [`../4-implementation/testing.md`](../4-implementation/testing.md) (Decisions #123-#125)
**Depends on:** Phase 1, Phase 4 (Event Bus for health events), Phase 5 (adapter classes)
**Enables:** Orchestrator (needs Registry for adapters), Daemon (needs Registry for lifecycle)
**Verification:** Registry discovers and loads fake plugins via five-phase sequence. Health state machine transitions correctly. Boundary test passes. Fake plugins init/healthCheck/shutdown.
**Scope:** Large

---

## Phase 7: Task Engine

**Delivers:** State machine, permission enforcement (Gate 1), task CRUD.

**Files:**
- `src/core/task-engine/index.ts` — `TaskEngine`: `createTask()`, `requestTransition()` (validates against ValidTransitions, emits `task.state_changed`), `checkPermission()` (PermissionTable lookup = Gate 1), `getTask()`, `getTasksByState()`, `getQueuedByPriority()`, `updateTracking()`
- `src/core/task-engine/index.test.ts`

**Source of truth:** [`../2-components/task-engine.md`](../2-components/task-engine.md), [`../4-implementation/schemas/task.md`](../4-implementation/schemas/task.md)
**Depends on:** Phase 1 (task schemas), Phase 2 (DB), Phase 4 (Event Bus)
**Enables:** Action Pipeline (Gate 1), Daemon (scheduling)
**Verification:** All valid transitions from ValidTransitions work, invalid rejected. Permission checks return correct ActionClass[] per state/sub-state. Cost tracking accumulates. Events emitted on transitions.
**Scope:** Medium

---

## Phase 8: Safety Layer + People Directory

**Delivers:** Policy enforcement (Gate 2), cost tracking, contact resolution.

**Files:**
- `src/core/safety-layer/index.ts` — `SafetyLayer`: `evaluateAction()` (Gate 2), `consultJudgment()` → SafetyVerdict, cost tracking (subscribes to `cost.incurred`, emits `cost.limit_reached`), snapshot save/restore via `_meta`, hot-reload support
- `src/core/people-directory/index.ts` — `PeopleDirectory`: loaded from people.yaml, `getPerson()`, `getOwner()`, `resolveContact()`, hot-reload
- Tests for both

**Source of truth:** [`../2-components/safety-layer.md`](../2-components/safety-layer.md), [`../3-interactions/adapter-contracts.md`](../3-interactions/adapter-contracts.md) (People Directory section)
**Depends on:** Phase 1, Phase 2, Phase 3 (config + hot-reload), Phase 4 (Event Bus)
**Enables:** Action Pipeline (Gate 2), Orchestrator (judgment, routing)
**Verification:** Scope boundaries enforced. Cost accumulation + limit detection works. Autonomy verdicts follow config. People resolves contacts. Hot-reload for both works.
**Scope:** Medium

---

## Phase 9: Action Pipeline

**Delivers:** Authorization middleware — Gate 1 + Gate 2 + Execute + Notify.

**Files:**
- `src/core/action-pipeline/index.ts` — `ActionPipeline`: `execute(taskId, actionClass, executeFn, notifyFn)`. Gate 1 → Gate 2 → execute → notify. Emits `action.rejected` on denial.
- `src/core/action-pipeline/index.test.ts`

**Source of truth:** [`../3-interactions/event-catalog.md`](../3-interactions/event-catalog.md) (Action Pipeline section), [`../1-system/architecture-tiers.md`](../1-system/architecture-tiers.md)
**Depends on:** Phase 4, Phase 7 (Task Engine = Gate 1), Phase 8 (Safety Layer = Gate 2)
**Enables:** Orchestrator
**Verification:** Gate 1 blocks disallowed actions. Gate 2 blocks denied policies. Both pass → execution. Rejections emit events. Gate order correct (Task Engine first).
**Scope:** Small

---

## Phase 10: Session/Memory + Workspace Manager

**Delivers:** Checkpointing, knowledge store, git worktree management.

**Files:**
- `src/core/session-memory/index.ts` — `SessionMemory`: session lifecycle, journal entries, checkpoints, knowledge store (content-hash IDs), supersession
- `src/core/workspace-manager/index.ts` — `WorkspaceManager`: `createWorkspace()` (fetch, branch, worktree, emit `workspace.created`), `verifyWorkspace()`, `cleanupWorkspace()`, PR ops delegated to GitHostingAdapter via Registry
- Tests for both (workspace tests use real git in temp dirs per Decision #124)

**Source of truth:** [`../2-components/session-memory.md`](../2-components/session-memory.md), [`../2-components/workspace-manager.md`](../2-components/workspace-manager.md)
**Depends on:** Phase 1, Phase 2, Phase 4, Phase 6 (Registry for GitHostingAdapter)
**Enables:** Orchestrator (checkpointing, workspace ops), Daemon (crash recovery)
**Verification:** Sessions track lifecycle. Checkpoints save/restore. Knowledge uses content-hash. Workspaces create real worktrees in temp dirs. Events emitted at each point.
**Scope:** Large

---

## Phase 11: Orchestrator (Skeleton)

**Delivers:** The brain — 7-phase pipeline with thin phase handlers.

**Files:**
- `src/core/orchestrator/index.ts` — `Orchestrator`: `executeTask(dispatch)` runs phase pipeline. Phase dispatch loop, checkpoint on transitions, journal entries, resume from checkpoint, preemption handling. Uses Action Pipeline for all actions. Uses Registry for LLM/Tool adapters. Phase handlers are thin (call LLM, parse response) — full sophistication deferred.
- `src/core/orchestrator/index.test.ts`

**Source of truth:** [`../2-components/orchestrator.md`](../2-components/orchestrator.md), [`../3-interactions/protocols.md`](../3-interactions/protocols.md) (P4, P8, P9)
**Depends on:** Phase 1, Phase 4, Phase 6, Phase 7, Phase 8, Phase 9, Phase 10
**Enables:** Daemon, full system integration
**Verification:** Pipeline runs through all 7 phases with fake LLM returning valid outputs. Checkpoints created. Preemption works. Resume skips completed phases.
**Scope:** Large

---

## Phase 12: Daemon + Logging — HELLO WORLD

**Delivers:** Main loop, process management, structured logging. First runnable system.

**Files:**
- `src/core/daemon/index.ts` — `createDaemon(config)` → `{ start(), stop(), tick() }`. Tick loop: poll triggers, dedup, create tasks, check queue, dispatch to Orchestrator, priority aging, stuck/runaway detection, health checks. Signal handling, PID file, single-instance.
- `src/core/daemon/logging.ts` — pino + pino-roll setup, component-tagged child loggers
- `test/helpers/fake-clock.ts` — `FakeClock` with `advance(ms)`, `current()`
- `src/core/daemon/index.test.ts`

**Source of truth:** [`../2-components/daemon-scheduler.md`](../2-components/daemon-scheduler.md), [`../4-implementation/operations.md`](../4-implementation/operations.md) (Decisions #110-#112)
**Depends on:** All previous phases (1-11)
**Enables:** CLI, E2E testing
**Verification:** `createDaemon()` boots with fake plugins, ticks, polls trigger, creates task, dispatches. Graceful shutdown works. PID file lifecycle. Logs to file.
**Scope:** Large

---

## Phase 13: CLI

**Delivers:** All 8 commands — the user interface.

**Files:**
- `src/cli/index.ts` — commander setup, global options (`--home`, `--verbose`, `--version`, `--help`)
- `src/cli/commands/start.ts` — foreground + `--daemon`, pre-flight checks (categories 1-6)
- `src/cli/commands/stop.ts` — PID lookup, SIGTERM, `--timeout`
- `src/cli/commands/status.ts` — PID check, DB query for active tasks
- `src/cli/commands/logs.ts` — pino-pretty, `--json`, `--follow`, `--lines`
- `src/cli/commands/init.ts` — create dirs + template configs (Decision #118)
- `src/cli/commands/doctor.ts` — 10 health check categories (Decision #116)
- `src/cli/commands/install.ts` — generate launchd/systemd configs (Decision #113)
- `src/cli/commands/config-validate.ts` — load + validate all configs

**Source of truth:** [`../4-implementation/operations.md`](../4-implementation/operations.md) (Decisions #113-#118)
**Depends on:** Phase 12 (Daemon), Phase 3, Phase 2
**Enables:** User operation — `engineer start` works
**Verification:** Each command runs with expected output. `init` creates structure. `doctor` runs checks. `config validate` catches errors. `start` boots daemon.
**Scope:** Medium

---

## Phase 14: v1 Plugin Implementations

**Delivers:** All 6 real plugins.

**Files:**
- `src/plugins/trigger/github-trigger/` — GitHub Issues polling via Octokit
- `src/plugins/communication/telegram-comm/` — Telegram via grammy
- `src/plugins/communication/github-comm/` — GitHub issue/PR comments via Octokit
- `src/plugins/llm/claude-code-llm/` — spawns `claude` CLI, parses output, reports usage
- `src/plugins/tool/bash-tool/` — `spawn("bash", ["-c", cmd])`, workspace confinement, env sanitization, output limits (Decision #108)
- `src/plugins/git-hosting/github-hosting/` — PR lifecycle via Octokit
- `test/helpers/contract-suites/` — 5 contract compliance suites (Decision #122)
- Each plugin: `engineer.plugin.yaml`, `index.ts` (factory), `{name}.ts` (implementation), `config.ts` (Zod schema), tests

**Source of truth:** [`../4-implementation/plugins.md`](../4-implementation/plugins.md), [`../3-interactions/adapter-contracts.md`](../3-interactions/adapter-contracts.md)
**Depends on:** Phase 5 (adapter classes + SDK boundary)
**Enables:** Real end-to-end operation
**Verification:** Each plugin passes its contract compliance suite + plugin-specific tests
**Scope:** Large

---

## Phase 15: Integration + E2E Tests

**Delivers:** Cross-component and full lifecycle tests.

**Files:**
- `test/integration/` — registry loading, trigger polling, task lifecycle, config hot-reload, event delivery, health state machine
- `test/e2e/` — daemon lifecycle, happy path (issue → PR), crash recovery

**Source of truth:** [`../4-implementation/testing.md`](../4-implementation/testing.md) (Decisions #119-#124), [`../3-interactions/lifecycle.md`](../3-interactions/lifecycle.md)
**Depends on:** All previous phases
**Enables:** Confidence for real-world operation
**Verification:** Happy path: trigger → task → phases → PR → complete. Crash recovery: stop mid-task, restart, resume from checkpoint.
**Scope:** Large

---

## Summary

| Phase | Name | Scope | Key Milestone |
|-------|------|-------|---------------|
| 0 | Project Bootstrap | Small | Tooling works |
| 1 | Zod Schemas | Large | Type system exists |
| 2 | Database Layer | Small | SQLite + migrations |
| 3 | Config System | Medium | YAML loading works |
| 4 | Event Bus | Medium | Pub/sub + persistence |
| 5 | Adapter Base Classes | Small | SDK boundary defined |
| 6 | Registry + Test Infra | Large | Plugin lifecycle works |
| 7 | Task Engine | Medium | State machine works |
| 8 | Safety + People | Medium | Policy enforcement works |
| 9 | Action Pipeline | Small | Authorization middleware |
| 10 | Session/Memory + Workspace | Large | Checkpointing + git worktrees |
| 11 | Orchestrator (Skeleton) | Large | Phase pipeline runs |
| 12 | Daemon + Logging | Large | **HELLO WORLD** |
| 13 | CLI | Medium | User-operable |
| 14 | v1 Plugins | Large | Real integrations |
| 15 | Integration + E2E Tests | Large | Full confidence |

**Total: 16 phases. 5 Small, 4 Medium, 7 Large.**

## Parallelization Opportunities

- Phases 2 + 3 can run in parallel (both depend only on 0 + 1)
- Phase 14 (plugins) can run in parallel with Phases 6-13 (only depends on Phase 5)
- Unit tests co-located with each phase — no separate test-writing sessions

## Dependency Graph

```
Phase 0 (Bootstrap)
  └─ Phase 1 (Schemas)
       ├─ Phase 2 (Database) ──────────┐
       │    └─ Phase 4 (Event Bus) ────┤
       ├─ Phase 3 (Config) ───────────┐│
       │                              ││
       ├─ Phase 5 (Adapters) ─────────┤│
       │    └─ Phase 14 (Plugins)     ││
       │                              ││
       │  ┌───────────────────────────┘│
       │  │  ┌────────────────────────┘
       │  │  │
       │  Phase 6 (Registry) ─────────┐
       │  │                           │
       │  Phase 7 (Task Engine) ──────┤
       │  │                           │
       │  Phase 8 (Safety + People) ──┤
       │  │                           │
       │  Phase 9 (Action Pipeline) ──┤
       │  │                           │
       │  Phase 10 (Session + WS Mgr) ┤
       │  │                           │
       │  Phase 11 (Orchestrator) ────┤
       │                              │
       └─ Phase 12 (Daemon) ──────────┘
            └─ Phase 13 (CLI)
                 └─ Phase 15 (Integration + E2E)
```
