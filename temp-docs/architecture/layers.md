# Architecture Layers

We work top-down, layer by layer. Each layer builds on the one below it. We don't go to the next layer until the current one is solid. No rushing.

---

## Layer 0: Goals & Philosophy — DONE

What we're building and why. The north star.

- `temp-docs/goals.md` — 14 sections defining the destination
- `temp-docs/philosophy.md` — 11 principles defining how we think

## Layer 1: System Overview — IN PROGRESS

The 10,000-foot view. Components, how they relate, skeleton vs plugins, data flow.

**What needs to be completed at this layer:**
- [ ] Component relationships — what calls what, what depends on what
- [ ] Skeleton vs plugin classification — sort every component
- [ ] Data flow — what "things" move through the system (tasks, events, messages, sessions)
- [ ] High-level state machine — DONE (`task-states.md`)

**Documents:**
- [`overview.md`](overview.md) — component list, relationships, skeleton/plugin classification
- [`task-states.md`](task-states.md) — CPU-derived state machine

## Layer 2: Component Architecture

Each component designed individually. Interfaces, responsibilities, internal structure.

**What this layer covers:**
- Each core component (daemon, orchestrator, registry, task engine) gets its own design doc
- Each supporting system (people directory, workspace manager, session/memory, safety) gets its own design doc
- The Active state's internal phases get designed here
- Plugin interfaces defined (what must a trigger implement? a comm channel? an LLM provider?)

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
