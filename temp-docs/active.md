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
- `philosophy.md` — project beliefs and principles (permanent, say it once)
- `sessions/` — succinct logs of each work session
- `architecture/` — all architectural decisions, component designs, roadmap, research
  - `decisions.md` — decision log
  - `README.md` — directory index

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

Session 1 complete. All foundation docs created. All premature artifacts removed (BOOT.md, memory/). Clean slate. README.md added. me.md renamed to persona.md.

Next session: begin high-level architectural design. First topic: **Prompt Architecture — small orchestrator prompt + phase-specific reference docs loaded on-demand based on state.** This is the foundational design decision that shapes everything else (phase system, document structure, context management).
