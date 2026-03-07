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
| [`decisions.md`](decisions.md) | Architectural decision log | Ongoing |

## Foundation (Layer 0 — DONE)

These docs drive all architectural decisions:
- [`../goals.md`](../goals.md) — the destination (14 sections)
- [`../philosophy.md`](../philosophy.md) — the beliefs (11 principles)
- [`../../persona.md`](../../persona.md) — the identity

## Current Status

**Layer 1: System Overview — IN PROGRESS**

Remaining at this layer (see [`layers.md`](layers.md)):
- [ ] Component relationships — what calls what, what depends on what
- [ ] Skeleton vs plugin classification — sort every component
- [ ] Data flow — what "things" move through the system
- [x] High-level state machine — done ([`task-states.md`](task-states.md))
