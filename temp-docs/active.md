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

Session 4 complete. **Layer 1 is DONE.** Designed the hybrid architecture pattern (OS kernel + event bus + task-as-truth), mapped all component relationships and data flows, validated via simulation. Found 12 gaps for Layer 2.

Layer 1 completed items:
- [x] High-level state machine — `task-states.md`
- [x] Skeleton vs plugin classification — `overview.md`
- [x] Component relationships — `relationships.md`
- [x] Data flow — `relationships.md`

Moving to **Layer 2: Component Architecture**. Each component gets its own design doc. Priority items from simulation gaps:
- Task Engine: task hierarchy (parent-child), cascade failure detection
- Session/Memory: mid-phase checkpointing, cross-task knowledge sharing
- Orchestrator: fast-path for trivial tasks, parent-task "tech lead" role, proactive status
- Daemon: scheduling/priority, concurrent task execution
- Safety Layer: cumulative cost tracking
- Workspace Manager: multi-repo support
