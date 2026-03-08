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

Session 11 complete. **Layer 2 (Component Architecture) — all 7 components designed individually.** All 24 gaps resolved. 38 decisions made. Post-design review traced all 5 user flows through the new designs — found and fixed 2 gaps and 2 inconsistencies.

**Next: Layer 2 Holistic Review** — review all 7 designs together as a unified system. Look for cross-component gaps, interface mismatches, terminology inconsistencies, missing handoffs, and anything that only becomes visible when you see the whole picture. Final polish before Layer 3.

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
- [x] Gap prioritization — grouped by component, ordered by dependency

Layer 2 progress:
- [x] Task Engine — `task-engine.md` (gaps #3, #6, #9, #13, #14, #24 resolved)
- [x] Session/Memory — `session-memory.md` (gaps #2, #7, #21 resolved)
- [x] Daemon/Scheduler — `daemon-scheduler.md` (gaps #8, #12 resolved)
- [x] Safety Layer — `safety-layer.md` (gaps #5, #17, #19 resolved)
- [x] Orchestrator — `orchestrator.md` (gaps #1, #4, #10, #15, #16, #18, #23 resolved)
- [x] Workspace Manager — `workspace-manager.md` (gap #11 resolved)
- [x] Comm Plugins — `comm-plugins.md` (gaps #20, #22 resolved)

**Component design order:** Task Engine → Session/Memory → Daemon/Scheduler → Safety Layer → Orchestrator → Workspace Mgr → Comm Plugins (ALL COMPLETE)
