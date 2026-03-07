# Component Relationships & Data Flow

How components connect and what moves through the system. Part of **Layer 1** — see [`layers.md`](layers.md).

Derived from proven systems — see [`../philosophy.md`](../philosophy.md) § Derive from Proven Systems.

---

## Architecture Pattern: The Hybrid

Three proven systems, one architecture:

| Proven system | What we take from it | Applied as |
|---------------|---------------------|------------|
| **OS kernel** | Central authority, clear lifecycle management, scheduler loop | Daemon as heartbeat, Task Engine as state authority |
| **Kubernetes controllers** | State-as-truth, components react to state changes | Task object as source of truth |
| **Actor model** | Explicit message-passing, audit trails, isolation | Event Bus as universal communication medium |

**The three organizing principles:**

1. **Authority** (OS kernel) — Daemon is the heartbeat. Task Engine owns task state. There is always a clear answer to "who is in charge?"
2. **Communication** (Actor model) — All inter-component communication flows as events through the Event Bus. Every event is logged. The event stream IS the audit trail.
3. **Truth** (Kubernetes) — The Task object is the source of truth for any piece of work. Components react to its state transitions.

---

## Component Relationship Diagram

```
                    ┌──────────────────────────────────────────────────────┐
                    │                     EVENT BUS                        │
                    │  (nervous system — all events flow here, all logged) │
                    │  subscribers: Safety, Observability, any component   │
                    └──┬──────┬──────┬──────┬──────┬──────┬───────────────┘
                       │      │      │      │      │      │
                 ┌─────┴──┐ ┌─┴────┐ │  ┌───┴──┐ ┌┴────┐ │
                 │ DAEMON │ │ TASK │ │  │ REG- │ │SAFE-│ │
                 │        │ │ENGINE│ │  │ISTRY │ │ TY  │ │
                 │ heart- │ │      │ │  │      │ │LAYER│ │
                 │ beat,  │ │state │ │  │lookup│ │     │ │
                 │ sched- │ │owner │ │  │ only │ │dual │ │
                 │ uler   │ │      │ │  │      │ │mode │ │
                 └────────┘ └──────┘ │  └──────┘ └─────┘ │
                                     │                    │
                              ┌──────┴──────┐      ┌─────┴──────────┐
                              │ORCHESTRATOR │      │    PLUGINS     │
                              │             │      │                │
                              │  the brain  │      │ triggers       │
                              │  (LLM,      │      │ comms          │
                              │   tools,    │      │ LLM providers  │
                              │   phases)   │      │ tools          │
                              └─────────────┘      │ workflow phases│
                                     │             │ observability  │
                              ┌──────┴─────────────┴──────────┐
                              │      SUPPORTING SYSTEMS       │
                              │                               │
                              │  Session/Memory  (persist)    │
                              │  Workspace Mgr   (git iso.)  │
                              │  People Directory (contacts)  │
                              └───────────────────────────────┘
```

---

## Dependency Table

No circular dependencies. Everything flows downward.

| Component | Depends on | Depended on by |
|-----------|-----------|----------------|
| **Daemon** | Registry, Task Engine, Event Bus | Nothing (top-level) |
| **Task Engine** | Session/Memory, Workspace Mgr, Event Bus | Daemon |
| **Orchestrator** | Registry, People Dir, Safety Layer, Session/Memory, Event Bus | Task Engine (via Daemon) |
| **Registry** | Nothing (pure lookup) | Daemon, Orchestrator |
| **Event Bus** | Nothing (infrastructure) | Everything |
| **Safety Layer** | Nothing (pure config eval) | Orchestrator (passive), Event Bus (active interceptor) |
| **Session/Memory** | Nothing (pure storage) | Task Engine, Orchestrator |
| **Workspace Manager** | Nothing (pure git ops) | Task Engine |
| **People Directory** | Nothing (pure config) | Orchestrator |

---

## Key Relationships (plain English)

- **Daemon → Task Engine**: "Here's a trigger event, create a task." / "This task is queued and we have capacity, activate it."
- **Daemon → Registry**: "What triggers are registered? Poll them."
- **Task Engine → Orchestrator** (via Daemon): "Task #42 is Active. Here's its full context. Go."
- **Orchestrator → Registry**: "Give me the LLM provider. Give me the tools. Give me the comm channels."
- **Orchestrator → People Directory**: "Who should I ask about backend architecture on this repo?"
- **Orchestrator → Safety Layer** (passive): "Can I push to main? Can I send this Slack message?"
- **Safety Layer → Event Bus** (active): Intercepts events that violate hard limits (cost caps, scope boundaries) before they're processed.
- **Task Engine → Session/Memory**: "Save task #42 state." / "Restore task #42 from last session."
- **Task Engine → Workspace Manager**: "Set up an isolated workspace for task #42." / "Clean up after completion."
- **Everyone → Event Bus**: Emit events. Subscribe to events of interest.

---

## Safety Layer: Dual Mode

| Mode | Purpose | How it works |
|------|---------|-------------|
| **Active (interceptor)** | Hard limits that must never be violated | Subscribes to Event Bus, vetoes events that cross cost caps, scope boundaries, or forbidden actions. Structural — nothing unsafe passes even if a component forgets to check. |
| **Passive (consulted)** | Judgment calls that need evaluation | Orchestrator explicitly asks "can I do X?" before acting. For decisions like branch policy, autonomy level, who to contact. |

---

## Data Flow: What Moves Through the System

| # | What flows | From | To | Purpose |
|---|-----------|------|-----|---------|
| 1 | **Trigger events** | External world → Trigger plugins | Event Bus → Task Engine | New work enters the system |
| 2 | **Tasks** | Task Engine (state machine) | Flows through lifecycle | Primary unit of work — ID, state, phase, parent ref, context, history |
| 3 | **Events** | Every component | Event Bus → subscribers | Universal communication AND audit trail |
| 4 | **LLM conversations** | Orchestrator | LLM providers (via Registry) | The "thinking" — prompts, completions, reasoning |
| 5 | **Tool invocations + results** | Orchestrator | Tool plugins (via Registry) | The "doing" — commands, file ops, API calls |
| 6 | **Human messages** | Orchestrator ↔ Comm plugins | Humans | Questions out, answers back |
| 7 | **State snapshots** | Task Engine / Orchestrator | Session/Memory | Checkpoints for crash recovery and session resume |
| 8 | **Knowledge** | Orchestrator | Session/Memory | Learnings that persist beyond a single LLM session |
| 9 | **Configuration** | Config files | Components at boot | Safety rules, people directory, plugin registrations, autonomy levels |
| 10 | **Workspace artifacts** | Orchestrator | Workspace Mgr → Git | The work product — branches, commits, PRs |

### Knowledge Scopes

Knowledge has three scopes, each with different isolation rules:

| Scope | What | Isolation |
|-------|------|-----------|
| **Within-task** | Phase progress, decisions made, what's been tried | Dies with the task (persists only in session log) |
| **Sibling-task** | Shared context between sub-tasks of the same parent | Controlled sharing — accessible to siblings, invisible to unrelated tasks |
| **Cross-project** | Repo-specific patterns, conventions, domain knowledge | Isolated per repo/context — learnings from repo A never pollute repo B |

See [`../goals.md`](../goals.md) § Continuous Growth for the full vision.

---

## Simulation-Validated Gaps

Architecture validated by running three scenarios through the system. Gaps identified below are acknowledged at Layer 1 and will be designed at Layer 2.

### Simulations run

| Scenario | Complexity | What it tested |
|----------|-----------|---------------|
| Fix typo in README | Simple (30 min) | Happy path, minimal phases |
| Implement OAuth2 auth | Difficult (2 days) | Human interaction, multi-session, review feedback |
| Extract module to microservice | Extreme (weeks) | Self-decomposition, sub-tasks, cross-task knowledge, failures |

### Gaps found

| # | Gap | Surfaced by | Severity | Layer 2 target |
|---|-----|------------|----------|----------------|
| 1 | Fast-path for trivial tasks | Simple | Low | Orchestrator design |
| 2 | Mid-phase checkpointing and resume | Difficult | Critical | Session/Memory design |
| 3 | Post-ship state (PR open, awaiting review) | Difficult | High | Task state machine |
| 4 | Proactive status communication | Difficult | Medium | Orchestrator design |
| 5 | Cumulative cost tracking | Difficult | Medium | Safety Layer design |
| 6 | Task hierarchy (parent-child relationships) | Extreme | Critical | Task Engine design |
| 7 | Cross-task knowledge sharing | Extreme | Critical | Session/Memory design |
| 8 | Concurrent task execution | Extreme | High | Daemon/scheduler design |
| 9 | Cascade failure detection | Extreme | High | Task Engine design |
| 10 | Parent task as "tech lead" role | Extreme | High | Orchestrator design |
| 11 | Multi-repo workspace management | Extreme | Medium | Workspace Mgr design |
| 12 | Scheduling and priority (preemption) | Difficult + Extreme | High | Daemon design |

---

## Open Questions for Layer 2

- How does the Event Bus handle ordering? Are events guaranteed in-order per task?
- What's the persistence model for the Event Bus? In-memory with flush? Write-ahead log?
- How does the Orchestrator checkpoint mid-phase for multi-session tasks?
- What does a Task object actually contain? (Schema design)
- How do sibling tasks share knowledge without breaking isolation?
