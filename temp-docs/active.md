# Active Work

## Current Focus

Architecture and planning ONLY. No code. No project scaffolding. No implementation.

All deliverables are documentation until Farzam explicitly says otherwise.

## What We're Doing

Designing The Engineer from the highest level down — making every architectural decision, resolving every uncertainty, and documenting everything before writing a single line of code.

Working method: collaborative, always. Highest level decisions first, then drill down together. Research, investigate, and discuss until confident. Farzam and the agent complete each other.

## Deliverables

All work lives in `/temp-docs/`:
- `active.md` — this file, what we're working on right now
- `goals.md` — the destination; what The Engineer achieves
- `philosophy.md` — project beliefs and principles (permanent, say it once)
- `sessions/` — succinct logs of each work session
- `architecture/` — all architectural work (see [`architecture/README.md`](architecture/README.md) for full index)
  - `layers.md` — architecture layering roadmap
  - `decisions.md` — decision log
  - `overview.md` — high-level components + skeleton/plugin classification
  - `task-states.md` — CPU-derived task state machine
  - `relationships.md` — component relationships, data flow, simulation gaps
  - `user-flows.md` — concrete user flows from Farzam's perspective (Layer 1.5)
  - `task-engine.md` — Task Engine Layer 2 design (state machine, hierarchy, permissions)
  - `session-memory.md` — Session/Memory Layer 2 design (checkpoints, knowledge, queryable journal)
  - `daemon-scheduler.md` — Daemon/Scheduler Layer 2 design (scheduling, preemption, capacity, health)
  - `safety-layer.md` — Safety Layer Layer 2 design (cost tracking, scope, autonomy, response timeout)
  - `orchestrator.md` — Orchestrator Layer 2 design (phase pipeline, fast-path, notifications, supervision, question batching)
  - `workspace-manager.md` — Workspace Manager Layer 2 design (worktrees, branch hierarchy, progressive merge, multi-repo, PR management)
  - `comm-plugins.md` — Comm Plugins Layer 2 design (status query interface, GitHub state sync, shared contract)
  - `event-bus.md` — Event Bus Layer 2 design (event model, delivery guarantees, persistence)
  - `event-catalog.md` — Event Catalog Layer 3 (30 events, 10 groups, Action Pipeline)
  - `plugin-contracts.md` — Plugin Contracts Layer 3 (trigger, comm, LLM, tool, git-hosting + Registry + People Directory)
  - `protocols.md` — Protocols Layer 3 (15 cross-component interaction protocols)
  - `error-propagation.md` — Error Propagation Layer 3 (failure classification, propagation chains, recovery patterns, comm error handling)
  - `lifecycle.md` — Lifecycle Traces Layer 3 (3 end-to-end scenarios, full protocol/event/contract coverage)

## Repo Structure

```
the-engineer/
├── README.md          # Project overview
├── persona.md         # Identity (stable input to architecture)
└── temp-docs/         # Our workspace (builders only)
    ├── active.md      # Current focus (this file)
    ├── goals.md       # The destination (14 sections)
    ├── philosophy.md  # Core beliefs (11 principles)
    ├── sessions/      # Session logs
    └── architecture/  # All architectural work (see README.md inside)
```

Everything else in the repo will be for The Engineer (the agent) — created AFTER architecture is finalized.

## Status

Session 21 complete. **Layer 3 COMPLETE.** Mini holistic review found and fixed 10 issues across all 5 Layer 3 docs. All cross-references verified against Layer 2 docs. Layer 2 → Layer 3 evolution documented in lifecycle.md reconciliation table. 58 total decisions (no new architectural decisions — all fixes were corrections and coverage gaps).

**Next: Layer 4 — Implementation Design.**

Layer 3 work order:
- [x] Event Catalog — `event-catalog.md` (30 events, 10 groups, Action Pipeline model) — REVIEWED & FINALIZED
- [x] Plugin Contracts — `plugin-contracts.md` (trigger, comm, LLM, tool, git-hosting + Registry + People Directory) — FINALIZED
- [x] Protocols — `protocols.md` (15 cross-component interaction protocols) — ALL 15 DRAFTED & VERIFIED (P1-P6: Task Lifecycle, P7-P10: Coordination, P11-P14: Communication, P15: Resilience)
- [x] Error Propagation — `error-propagation.md` (failure classification, 7 chains, 6 patterns, comm error handling) — COMPLETE
- [x] Lifecycle — `lifecycle.md` (3 scenarios, 15/15 protocols, 30/30 events, full coverage) — FINALIZED
- [x] Mini holistic review — cross-reference all 5 Layer 3 docs + Layer 2 docs — COMPLETE

Layers 0-2: ALL COMPLETE. Layer 3: COMPLETE. 58 total decisions.
