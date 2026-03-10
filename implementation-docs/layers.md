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

## Layer 2: Component Architecture — IN PROGRESS

Each component designed individually. Interfaces, responsibilities, internal structure.

**What this layer covers:**
- Each core component (daemon, orchestrator, registry, task engine) gets its own design doc
- Each supporting system (people directory, workspace manager, session/memory, safety) gets its own design doc
- The Active state's internal phases get designed here
- Plugin interfaces defined (what must a trigger implement? a comm channel? an LLM provider?)

**24 gaps grouped by component. Design order:**
1. Task Engine (6 gaps) — DONE → [`task-engine.md`](2-components/task-engine.md)
2. Session/Memory (3 gaps: #2, #7, #21) — DONE → [`session-memory.md`](2-components/session-memory.md)
3. Daemon/Scheduler (2 gaps: #8, #12) — DONE → [`daemon-scheduler.md`](2-components/daemon-scheduler.md)
4. Safety Layer (3 gaps: #5, #17, #19) — DONE → [`safety-layer.md`](2-components/safety-layer.md)
5. Orchestrator (7 gaps: #1, #4, #10, #15, #16, #18, #23) — DONE → [`orchestrator.md`](2-components/orchestrator.md)
6. Workspace Manager (1 gap: #11) — DONE → [`workspace-manager.md`](2-components/workspace-manager.md)
7. Comm Plugins (2 gaps: #20, #22) — DONE → [`comm-plugins.md`](2-components/comm-plugins.md)
8. Event Bus (added during holistic review) — DONE → [`event-bus.md`](2-components/event-bus.md)

**All 7 components designed. 24/24 gaps resolved. 38 decisions.**

**Holistic Review — DONE.** Reviewed all 7 designs together as one unified system. Found 24 cross-component issues (5 HIGH, 11 MEDIUM, 8 LOW), all resolved. 3 new decisions. Created Event Bus Layer 2 design doc. Established canonical event taxonomy convention. Total decisions: 41.

**Key Layer 2 decisions so far:**
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

## Layer 4: Implementation Design

Ready-to-code specifications. No ambiguity left.

**What this layer covers:**
- Technology choices (specific libraries, frameworks, versions)
- Data structures and schemas
- File and directory layout (the actual project structure)
- Configuration format and schema
- Deployment specifications (Dockerfile, compose, env vars)
- Testing strategy

## Layer 5: Implementation

Actual code. Phased rollout. This is where we finally write code — and not a line before.
