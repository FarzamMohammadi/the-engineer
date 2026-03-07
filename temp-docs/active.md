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

Session 5 complete. **Layer 1.5 (User Flows) complete.** All open questions resolved. Validated Layer 1 from Farzam's perspective with 5 concrete user flows. 24 total gaps identified. Major discoveries: two-stage PR review (demo gate), state machine as security boundary (failsafe), DevEx for the Engineer.

Layer 1 completed items:
- [x] High-level state machine — `task-states.md`
- [x] Skeleton vs plugin classification — `overview.md`
- [x] Component relationships — `relationships.md`
- [x] Data flow — `relationships.md`

Layer 1.5 completed items:
- [x] 5 core user flows — `user-flows.md`
- [x] 12 new gaps identified (24 total)
- [x] Key decisions: demo gate, GitHub + Telegram, real-engineer-judgment over policies
- [x] State machine as security boundary — phase determines allowed actions
- [x] Phase loopback as formal state transition
- [x] DevEx for the Engineer — base TUI project + tooling pattern
- [ ] Finalize gap list and prioritize for Layer 2

Moving to **Layer 2: Component Architecture**. Start with Task Engine (most critical gaps). 24 total gaps to resolve across all components.
