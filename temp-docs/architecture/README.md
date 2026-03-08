# Architecture

All architectural decisions, component designs, research, and planning for The Engineer.

We work top-down, layer by layer — see [`layers.md`](layers.md) for the full roadmap.

---

## Documents

| Document | Purpose | Layer |
|----------|---------|-------|
| [`layers.md`](layers.md) | Architecture layering roadmap — where we are, what's next | Meta |
| [`overview.md`](overview.md) | Core components and supporting systems | Layer 1 |
| [`task-states.md`](task-states.md) | CPU-derived task state machine | Layer 1 |
| [`relationships.md`](relationships.md) | Component relationships, data flow, simulation-validated gaps | Layer 1 |
| [`user-flows.md`](user-flows.md) | Concrete user flows from Farzam's perspective, validation of Layer 1 | Layer 1.5 |
| [`task-engine.md`](task-engine.md) | Task Engine design: state machine, hierarchy, permissions | Layer 2 |
| [`session-memory.md`](session-memory.md) | Session/Memory design: checkpoints, knowledge, queryable journal | Layer 2 |
| [`daemon-scheduler.md`](daemon-scheduler.md) | Daemon/Scheduler design: scheduling, preemption, capacity, health | Layer 2 |
| [`safety-layer.md`](safety-layer.md) | Safety Layer design: cost tracking, scope, autonomy, response timeout | Layer 2 |
| [`orchestrator.md`](orchestrator.md) | Orchestrator design: phase pipeline, fast-path, notifications, supervision, question batching | Layer 2 |
| [`workspace-manager.md`](workspace-manager.md) | Workspace Manager design: worktrees, branch hierarchy, progressive merge, multi-repo interface, PR management | Layer 2 |
| [`comm-plugins.md`](comm-plugins.md) | Comm Plugins design: status query interface, GitHub state sync, shared contract | Layer 2 |
| [`event-bus.md`](event-bus.md) | Event Bus design: event model, delivery guarantees, pre-processing hook, persistence | Layer 2 |
| [`event-catalog.md`](event-catalog.md) | Event Catalog: 28 event types, Action Pipeline model, schemas | Layer 3 |
| [`plugin-contracts.md`](plugin-contracts.md) | Plugin Contracts: trigger, comm, LLM, tool, git-hosting + Registry + People Directory | Layer 3 |
| [`decisions.md`](decisions.md) | Architectural decision log | Ongoing |

## Foundation (Layer 0 — DONE)

These docs drive all architectural decisions:
- [`../goals.md`](../goals.md) — the destination (14 sections)
- [`../philosophy.md`](../philosophy.md) — the beliefs (11 principles)
- [`../../persona.md`](../../persona.md) — the identity

## Current Status

**Layer 1: System Overview — DONE**

All items complete. See [`layers.md`](layers.md).

**Layer 1.5: User Flows — DONE**

Validated Layer 1 from the user's perspective with 5 concrete flows. 24 total gaps identified. Key discoveries: two-stage PR review (demo gate), state machine as security boundary, DevEx for the Engineer.

**Layer 2: Component Architecture — DONE**

All 7 component designs complete. All 24 gaps resolved. Holistic review complete — 24 cross-component issues found and resolved. Event Bus Layer 2 design added. 41 total decisions.

**Documents:**
- [`task-engine.md`](task-engine.md) — Task Engine design (state machine, hierarchy, permissions)
- [`session-memory.md`](session-memory.md) — Session/Memory design (checkpoints, knowledge, queryable journal)
- [`daemon-scheduler.md`](daemon-scheduler.md) — Daemon/Scheduler design (scheduling, preemption, capacity, health)
- [`safety-layer.md`](safety-layer.md) — Safety Layer design (cost tracking, scope, autonomy, response timeout)
- [`orchestrator.md`](orchestrator.md) — Orchestrator design (phase pipeline, fast-path, notifications, supervision, question batching)
- [`workspace-manager.md`](workspace-manager.md) — Workspace Manager design (worktrees, branch hierarchy, progressive merge, multi-repo, PR management)
- [`comm-plugins.md`](comm-plugins.md) — Comm Plugins design (status query interface, GitHub state sync, shared contract)
- [`event-bus.md`](event-bus.md) — Event Bus design (event model, delivery guarantees, pre-processing hook, persistence)
