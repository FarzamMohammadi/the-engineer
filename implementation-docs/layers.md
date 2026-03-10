# Architecture Layers

We work top-down, layer by layer. Each layer builds on the one below it. We don't go to the next layer until the current one is solid. No rushing.

---

## Layer 0: Goals & Philosophy — DONE

What we're building and why. The north star.

- `0-foundation/goals.md` — 14 sections defining the destination
- `0-foundation/philosophy.md` — 11 principles defining how we think

## Layer 1: System Overview — DONE

The 10,000-foot view. Components, how they relate, three-tier architecture (Core / Adapter / Plugin), data flow.

**Completed:**
- [x] High-level state machine — [`task-states.md`](1-system/task-states.md)
- [x] Three-tier architecture — [`architecture-tiers.md`](1-system/architecture-tiers.md)
- [x] Component inventory — [`overview.md`](1-system/overview.md)
- [x] Component relationships — [`relationships.md`](1-system/relationships.md)
- [x] Data flow — [`relationships.md`](1-system/relationships.md)

**Architecture pattern decided:** Hybrid (OS kernel authority + event bus communication + task-as-truth). See [`relationships.md`](1-system/relationships.md).

**12 gaps identified via simulation** that feed into Layer 2. Critical: mid-phase checkpointing, task hierarchy, cross-task knowledge sharing.

**Documents:**
- [`architecture-tiers.md`](1-system/architecture-tiers.md) — three-tier model (Core / Adapter / Plugin)
- [`overview.md`](1-system/overview.md) — component list, tier classification
- [`task-states.md`](1-system/task-states.md) — CPU-derived state machine
- [`relationships.md`](1-system/relationships.md) — component relationships, data flow, gaps

## Layer 1.5: User Flows — DONE

Validated Layer 1 from the user's perspective. Concrete flows grounded in Farzam's actual setup (GitHub + Telegram).

**Completed:**
- [x] 5 core user flows designed — [`user-flows.md`](1-system/user-flows.md)
- [x] 12 new gaps identified (24 total)
- [x] Key discovery: two-stage PR review (demo gate → code review)
- [x] All open questions resolved
- [ ] Finalize gap list and prioritize for Layer 2

**Key decisions made:**
- Two-stage PR review: Draft (demo gate) → Ready (code review). Feedback applies at both stages.
- Communication: GitHub + Telegram. Telegram for real-time, GitHub for code workflow.
- Everything is demo-able. Backend gets base TUI project + task-specific extensions in isolated worktrees.
- State machine as security boundary — phase determines allowed actions (failsafe).
- Phase loopback as formal state transition — Orchestrator decides, Task Engine enforces.
- DevEx for the Engineer — invest in tooling that makes the Engineer more effective.

**Documents:**
- [`user-flows.md`](1-system/user-flows.md) — 5 core flows, gap analysis, open questions

## Layer 2: Component Architecture — DONE

Each component designed individually. Interfaces, responsibilities, internal structure. All 8 components designed (including Event Bus). 24/24 gaps resolved. 41 decisions.

**Components designed:**
1. Task Engine → [`task-engine.md`](2-components/task-engine.md)
2. Session/Memory → [`session-memory.md`](2-components/session-memory.md)
3. Daemon/Scheduler → [`daemon-scheduler.md`](2-components/daemon-scheduler.md)
4. Safety Layer → [`safety-layer.md`](2-components/safety-layer.md)
5. Orchestrator → [`orchestrator.md`](2-components/orchestrator.md)
6. Workspace Manager → [`workspace-manager.md`](2-components/workspace-manager.md)
7. Comm Plugins → [`comm-plugins.md`](2-components/comm-plugins.md)
8. Event Bus → [`event-bus.md`](2-components/event-bus.md)

**Holistic Review — DONE.** 24 cross-component issues found and resolved.

**Key Layer 2 decisions:**
- Review-Pending elevated to top-level state (not sub-state of Active)
- Action classes (not individual tools) as the unit of permission gating
- Two-gate model: Task Engine gate (phase legality) → Safety Layer gate (policy compliance)

## Layer 3: Interactions & Protocols — DONE

How components talk to each other. The wiring.

**What this layer covers:**
- Event flow between components
- Message/data formats
- Adapter contracts between Core and plugins
- Error propagation — how failures flow through the system
- The full lifecycle of a task as it passes through every component

**Completed:**
- [x] Event Catalog — [`event-catalog.md`](3-interactions/event-catalog.md) — 30 events, 10 groups, Action Pipeline model
- [x] Adapter Contracts — [`adapter-contracts.md`](3-interactions/adapter-contracts.md) — TriggerAdapter, CommunicationAdapter, LLMAdapter, ToolAdapter, GitHostingAdapter + Registry + People Directory — FINALIZED
- [x] Protocols — [`protocols.md`](3-interactions/protocols.md) — 15 cross-component interaction protocols (P1-P15)
- [x] Error Propagation — [`error-propagation.md`](3-interactions/error-propagation.md) — failure classification, 7 propagation chains, 6 recovery patterns, comm error handling
- [x] Lifecycle — [`lifecycle.md`](3-interactions/lifecycle.md) — 3 end-to-end scenarios, 15/15 protocols, 30/30 events, full coverage — FINALIZED
- [x] Mini holistic review — all 5 L3 docs cross-referenced + L2→L3 reconciliation documented

**Key Layer 3 decisions:** Action Pipeline (Decision #42), one plugin per adapter (Decision #43), health events (Decision #44), minimal tool contract (Decision #45), LLM cost reporting contractual (Decision #46), People Directory is skeleton (Decision #47), cost limit auto-resume configurable (Decision #49), reads Gate 1 only (Decision #50), LLM fallback for response parsing (Decision #51), shutdown timeout owned by Daemon (Decision #52), Event Bus down = halt (Decision #53), LLM auto-failover (Decision #54), comm fallback chains (Decision #55), config reload health alert (Decision #56), checkpoint without LLM (Decision #57), GitHub state reconciliation (Decision #58). 58 total decisions.

## Layer 4: Implementation Design — DONE

Ready-to-code specifications. No ambiguity left. 63 decisions (#65-#127) across 6 sessions + holistic review.

**Sessions completed:**
- [x] Session 23: Foundation — technology stack (10 decisions, #65-#74) → [`foundation.md`](4-implementation/foundation.md)
- [x] Session 24: Data structures & schemas (15 decisions, #75-#89) → [`schemas/`](4-implementation/schemas/) (9 files)
- [x] Session 25: Project layout & config format (12 decisions, #90-#101) → [`layout.md`](4-implementation/layout.md)
- [x] Session 26: Plugin system & adapter implementation (7 decisions, #102-#108) → [`plugins.md`](4-implementation/plugins.md)
- [x] Session 27: Deployment & operations (10 decisions, #109-#118) → [`operations.md`](4-implementation/operations.md)
- [x] Session 28: Testing strategy (7 decisions, #119-#125) → [`testing.md`](4-implementation/testing.md)
- [x] Session 29: Holistic review (2 decisions, #126-#127) — 3 MEDIUM issues resolved, 12 items validated correct

**Key Layer 4 decisions:**
- TypeScript, Node 22 LTS, pnpm, ESM, SQLite (better-sqlite3), Biome, Zod, Vitest
- Single package with monorepo-ready boundaries, YAML config (multi-file `~/.engineer/config/`)
- Plugin manifests (`engineer.plugin.yaml`), five-phase loading, abstract class hierarchy
- Unified data directory (`~/.engineer/`), pino logging, commander CLI, `doctor` health checks
- Three-tier Vitest configs (unit/integration/e2e), contract compliance suites, boundary enforcement tests

**Documents:**
- [`foundation.md`](4-implementation/foundation.md) — technology stack
- [`schemas/`](4-implementation/schemas/) — Zod schemas, SQLite DDL, config schemas (9 files)
- [`layout.md`](4-implementation/layout.md) — project layout, config system, enforcement pipeline
- [`plugins.md`](4-implementation/plugins.md) — plugin system design
- [`operations.md`](4-implementation/operations.md) — deployment & operations
- [`testing.md`](4-implementation/testing.md) — testing strategy
- [`openclaw-review.md`](4-implementation/openclaw-review.md) — reference patterns (all high-priority items adopted)

## Layer 5: Implementation

Actual code. 19-phase bottom-up build order. 1 decision (#128).

**Session completed:**
- [x] Session 30: Build order planning (1 decision, #128) → [`build-order.md`](5-build/build-order.md)

**Build phases:** 0 (Bootstrap) → 1a (Core Schemas) → 1b (Integration Schemas) → 2 (DB) → 3 (Config) → 4 (Event Bus) → 5 (Adapters) → 6 (Registry) → 7 (Task Engine) → 8 (Safety + People) → 9 (Action Pipeline) → 10 (Session/Memory + Workspace) → 11 (Orchestrator) → 12 (Daemon — hello world) → 13 (CLI) → 14a (Contract + Process Plugins) → 14b (GitHub Plugins) → 14c (Telegram) → 15 (Integration + E2E)

**Documents:**
- [`build-order.md`](5-build/build-order.md) — full build order specification with dependency graph
