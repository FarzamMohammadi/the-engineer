# Active Work

## Current Focus

Architecture and planning ONLY. No code. No project scaffolding. No implementation.

All deliverables are documentation until Farzam explicitly says otherwise.

## What We're Doing

Designing The Engineer from the highest level down — making every architectural decision, resolving every uncertainty, and documenting everything before writing a single line of code.

Working method: collaborative, always. Highest level decisions first, then drill down together. Research, investigate, and discuss until confident. Farzam and the agent complete each other.

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
  - `openclaw-review.md` — OpenClaw reference (validated decisions, patterns to adopt)
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
    └── 4-implementation/  # Layer 4: Implementation Design
```

Everything else in the repo will be for The Engineer (the agent) — created AFTER architecture is finalized.

## Status

Layers 0-3: ALL COMPLETE. 64 architectural decisions.

**Reconciliation R14: RESOLVED** — All config schemas concretized in Session 25.

**Layer 4 — Implementation Design: IN PROGRESS.** Broken into 6 focused sessions:

- Session 23: Foundation (technology stack) — DONE. 10 decisions (#65-#74). 74 total.
- Session 24: Data structures & schemas — DONE. 15 decisions (#75-#89). 89 total.
- Session 25: Project layout & config format — DONE. 12 decisions (#90-#101). 101 total.
- Session 26: Plugin system & adapter implementation — DONE. 7 decisions (#102-#108). 108 total.
- Session 27: Deployment & operations — DONE. 10 decisions (#109-#118). 118 total.
- Session 28: Testing strategy — NEXT

**Technology stack decided:** TypeScript, Node.js 22 LTS, pnpm, ESM, SQLite (better-sqlite3), tsx + tsdown, Biome, Zod, Vitest. Polling-only triggers for v1.

**Project layout decided:** Single package (monorepo-ready boundaries), YAML config (multi-file in `~/.engineer/config/`), lefthook (pre-commit: Biome + tsc, pre-push: Vitest), tsconfig max strictness, Biome `all` preset.

**Plugin system decided:** `engineer.plugin.yaml` manifest per plugin, five-phase loading (discover/validate/order/load/initialize), abstract class hierarchy (BaseAdapter → adapter types), curated SDK boundary (`src/adapters/index.ts`), health state machine (healthy/unhealthy/failed), process safety rules (explicit bash, signal forwarding, workspace confinement, env allowlist, output limits).

**Operations decided:** `~/.engineer/` unified data directory (ENGINEER_HOME override), pino structured logging with rolling files (500MB, 7-day retention), foreground-default daemon with PID file, commander CLI (8 commands: start/stop/status/logs/init/doctor/install/config validate), `doctor` health check (10 categories, pre-flight subset on startup), `engineer init` for template generation.
