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

**Layer 2: Component Architecture — IN PROGRESS**

Task Engine, Session/Memory, and Daemon/Scheduler designs complete. 11 of 24 gaps resolved. Next: Safety Layer.

**Documents:**
- [`task-engine.md`](task-engine.md) — Task Engine design (state machine, hierarchy, permissions)
- [`session-memory.md`](session-memory.md) — Session/Memory design (checkpoints, knowledge, queryable journal)
- [`daemon-scheduler.md`](daemon-scheduler.md) — Daemon/Scheduler design (scheduling, preemption, capacity, health)
