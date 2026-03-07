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
- `architecture/` — all architectural decisions, component designs, roadmap, research
  - `decisions.md` — decision log
  - `overview.md` — high-level components
  - `task-states.md` — CPU-derived task state machine

## Repo Structure

```
the-engineer/
├── persona.md         # Identity (stable input to architecture)
└── temp-docs/         # Our workspace (builders only)
    ├── active.md      # Current focus (this file)
    ├── philosophy.md  # Core beliefs
    ├── sessions/      # Session logs
    └── architecture/  # All architectural work
```

Everything else in the repo will be for The Engineer (the agent) — created AFTER architecture is finalized.

## Status

Session 2 complete. Goals fully defined (14 sections). High-level architecture started — system components identified, task state machine designed (derived from CPU process model). Two new philosophies added (Derive from Proven Systems, Isolation as Survival).

Next session: continue high-level architecture. Now that goals are clear, review existing architecture docs against them. Then tackle the next component — likely **prompt architecture** (small orchestrator + on-demand phase docs) or **registry/plugin system** (the skeleton and plugins model). Stay at the current level — don't rush deeper until all high-level answers are clear.
