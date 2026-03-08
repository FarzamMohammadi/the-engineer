# Architecture Layers

We work top-down, layer by layer. Each layer builds on the one below it. We don't go to the next layer until the current one is solid. No rushing.

---

## Layer 0: Goals & Philosophy — DONE

What we're building and why. The north star.

- `temp-docs/goals.md` — 14 sections defining the destination
- `temp-docs/philosophy.md` — 11 principles defining how we think

## Layer 1: System Overview — DONE

The 10,000-foot view. Components, how they relate, skeleton vs plugins, data flow.

**Completed:**
- [x] High-level state machine — [`task-states.md`](task-states.md)
- [x] Skeleton vs plugin classification — [`overview.md`](overview.md)
- [x] Component relationships — [`relationships.md`](relationships.md)
- [x] Data flow — [`relationships.md`](relationships.md)

**Architecture pattern decided:** Hybrid (OS kernel authority + event bus communication + task-as-truth). See [`relationships.md`](relationships.md).

**12 gaps identified via simulation** that feed into Layer 2. Critical: mid-phase checkpointing, task hierarchy, cross-task knowledge sharing.

**Documents:**
- [`overview.md`](overview.md) — component list, skeleton/plugin classification
- [`task-states.md`](task-states.md) — CPU-derived state machine
- [`relationships.md`](relationships.md) — component relationships, data flow, gaps

## Layer 1.5: User Flows — DONE

Validated Layer 1 from the user's perspective. Concrete flows grounded in Farzam's actual setup (GitHub + Telegram).

**Completed:**
- [x] 5 core user flows designed — [`user-flows.md`](user-flows.md)
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
- [`user-flows.md`](user-flows.md) — 5 core flows, gap analysis, open questions

## Layer 2: Component Architecture — IN PROGRESS

Each component designed individually. Interfaces, responsibilities, internal structure.

**What this layer covers:**
- Each core component (daemon, orchestrator, registry, task engine) gets its own design doc
- Each supporting system (people directory, workspace manager, session/memory, safety) gets its own design doc
- The Active state's internal phases get designed here
- Plugin interfaces defined (what must a trigger implement? a comm channel? an LLM provider?)

**24 gaps grouped by component. Design order:**
1. Task Engine (6 gaps) — DONE → [`task-engine.md`](task-engine.md)
2. Session/Memory (3 gaps: #2, #7, #21) — DONE → [`session-memory.md`](session-memory.md)
3. Daemon/Scheduler (2 gaps: #8, #12) — DONE → [`daemon-scheduler.md`](daemon-scheduler.md)
4. Safety Layer (3 gaps: #5, #17, #19) — DONE → [`safety-layer.md`](safety-layer.md)
5. Orchestrator (7 gaps: #1, #4, #10, #15, #16, #18, #23) — DONE → [`orchestrator.md`](orchestrator.md)
6. Workspace Manager (1 gap: #11) — DONE → [`workspace-manager.md`](workspace-manager.md)
7. Comm Plugins (2 gaps: #20, #22) — DONE → [`comm-plugins.md`](comm-plugins.md)

**All 7 components designed. 24/24 gaps resolved. 38 decisions.**

**Final step: Holistic Review** — review all 7 designs together as one unified system. Cross-component gaps, interface mismatches, terminology consistency, missing handoffs.

**Key Layer 2 decisions so far:**
- Review-Pending elevated to top-level state (not sub-state of Active)
- Action classes (not individual tools) as the unit of permission gating
- Two-gate model: Task Engine gate (phase legality) → Safety Layer gate (policy compliance)

## Layer 3: Interactions & Protocols

How components talk to each other. The wiring.

**What this layer covers:**
- Event flow between components
- Message/data formats
- API contracts between skeleton and plugins
- Error propagation — how failures flow through the system
- The full lifecycle of a task as it passes through every component

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
