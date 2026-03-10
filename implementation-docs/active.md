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

**Architecture: ALL COMPLETE.** Layers 0-5, 128 decisions.

**Implementation: IN PROGRESS.**

- Phase 0: Project Bootstrap — **DONE** (Session 31). 12 files: package.json, tsconfig.json, biome.json, lefthook.yml, 4 vitest configs, test/setup.ts, src/index.ts, .gitignore, .node-version. All verification passes.
- Phase 1a: Core Data Schemas — **DONE** (Session 32). 7 files in `src/schemas/`: task.ts (4 enums, 12 sub-schemas, TaskSchema, StateTransitionSchema, ValidTransitions 25 rules, PermissionTable 10 entries), events.ts (EventSchema envelope, 30 payload schemas, EventPayloads mapped type, TypedEvent generic, eventPayloadSchemas runtime registry), session-memory.ts (Session, JournalEntry, Checkpoint, KnowledgeEntry, knowledgeId()), 3 test files (126 tests), index.ts barrel. 3 Biome exceptions added (useNamingConvention, noBarrelFile, noReExportAll). All verification passes.
- Phase 1b: Integration Schemas — **DONE** (Session 33). 8 files in `src/schemas/`: config.ts (~25 schemas, all config with `.default()` values, conservative SafetyConfig defaults), adapters.ts (~37 schemas, all adapter contract types), orchestrator.ts (~22 schemas + PhaseOutputMap type), ephemeral.ts (~18 schemas, imports Phase 1a + config types), 4 test files (198 tests), index.ts barrel updated. Total: 324 tests across 7 test files. All verification passes.
- Phase 3: Config System — **DONE** (Session 34). 7 files: `src/config/loader.ts` (error classes, env var resolution, Zod schema introspection for duration parsing, `loadConfig<S>()`, `loadConfigSafe<S>()`, `loadConfigDir()`), `src/config/watcher.ts` (`createConfigWatcher()` with `fs.watch()` + 500ms debounce), `src/config/index.ts` (barrel), `PeopleConfigSchema` added to `src/schemas/config.ts`, 2 test files (59 tests), 8 YAML fixtures in `test/fixtures/configs/`. 4 Biome exceptions added (noDelete, noNonNullAssertion, noEmptyBlockStatements). Total: 383 tests across 9 test files. All verification passes.

**Next: Phase 2 — Database Layer.** SQLite setup with WAL mode, migration system, connection management. See [`5-build/build-order.md`](5-build/build-order.md) § Phase 2.
