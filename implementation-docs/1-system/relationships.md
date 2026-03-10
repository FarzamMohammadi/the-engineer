# Component Relationships & Data Flow

How components connect and what moves through the system. Part of **Layer 1** — see [`../layers.md`](../layers.md).

Derived from proven systems — see [`../0-foundation/philosophy.md`](../0-foundation/philosophy.md) § Derive from Proven Systems.

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
                              │ORCHESTRATOR │      │  ADAPTERS      │
                              │             │      │  ┌──────────┐ │
                              │  the brain  │      │  │ Trigger  │ │
                              │  (LLM,      │──────│  │ Comm     │ │
                              │   tools,    │      │  │ LLM      │ │
                              │   phases)   │      │  │ Tool     │ │
                              └─────────────┘      │  │ GitHost  │ │
                                                   │  │ ...      │ │
                                     │             │  └──┬───────┘ │
                                     │             │  PLUGINS      │
                                     │             │  (snap in)    │
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
| **Safety Layer** | Nothing (pure config eval) | Orchestrator (passive consultation), Action Pipeline (Gate 2) |
| **Session/Memory** | Nothing (pure storage) | Task Engine, Orchestrator |
| **Workspace Manager** | Safety Layer (passive scope checks), Event Bus | Task Engine |
| **People Directory** | Nothing (pure config) | Orchestrator |

---

## Key Relationships (plain English)

- **Daemon → Task Engine**: "Here's a trigger event, create a task." / "This task is queued and we have capacity, activate it."
- **Daemon → Registry**: "What triggers are registered? Poll them."
- **Task Engine → Orchestrator** (via Daemon): "Task #42 is Active. Here's its full context. Go."
- **Orchestrator → Registry**: "Give me the LLM provider. Give me the tools. Give me the comm channels."
- **Orchestrator → People Directory**: "Who should I ask about backend architecture on this repo?"
- **Orchestrator → Safety Layer** (passive): "Can I push to main? Can I send this Slack message?"
- **Safety Layer** (Gate 2 in Action Pipeline): Evaluates policy before side-effect actions execute. See Action Pipeline (Decision #42).
- **Task Engine → Session/Memory**: "Save task #42 state." / "Restore task #42 from last session."
- **Task Engine → Workspace Manager**: "Set up an isolated workspace for task #42." / "Clean up after completion."
- **Everyone → Event Bus**: Emit events. Subscribe to events of interest.

---

## Safety Layer: Action Pipeline Gate + Passive Consultation

| Mode | Purpose | How it works |
|------|---------|-------------|
| **Gate 2 (Action Pipeline)** | Hard limits and policy enforcement | Evaluates every side-effect action before execution. Part of the two-gate Action Pipeline: Gate 1 (Task Engine — state permission) → Gate 2 (Safety Layer — policy check). See [`../3-interactions/event-catalog.md`](../3-interactions/event-catalog.md) § Action Pipeline. |
| **Passive (consulted)** | Judgment calls that need evaluation | Orchestrator explicitly asks "can I do X?" before acting. For decisions like branch policy, autonomy level, who to contact. |
| **Event Bus subscriber** | Cost tracking | Subscribes to `cost.incurred` events, maintains ephemeral accumulators, enforces cost limits. |

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

See [`../0-foundation/goals.md`](../0-foundation/goals.md) § Continuous Growth for the full vision.

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
| 11 | Multi-repo workspace management | Extreme | Medium | Workspace Mgr design — **RESOLVED** ([`workspace-manager.md`](../2-components/workspace-manager.md)) |
| 12 | Scheduling and priority (preemption) | Difficult + Extreme | High | Daemon design — **RESOLVED** ([`daemon-scheduler.md`](../2-components/daemon-scheduler.md)) |

All 12 Layer 1 gaps resolved at Layer 2.

---

## Event Conventions

Established during Layer 2 Holistic Review. The full event catalog and schemas are Layer 3 deliverables, but these conventions apply across all components now.

### Canonical Events with Subscription Filters

Components emit **canonical events**. Subscribers use **filters** to select the events they care about. Shorthand names in component docs are subscription filters, not distinct event types.

**Example:** The Task Engine emits `task.state_changed { task_id, from_state, to_state, from_sub, to_sub, reason, timestamp }`. The Daemon subscribes with a filter: `task.state_changed where to_state == "Completed"`. In documentation, this is written as `task.completed` for brevity -- but it is NOT a separate event type.

### Canonical Event Types

| Emitted by | Canonical event | What it carries |
|-----------|----------------|-----------------|
| Task Engine | `task.state_changed` | task_id, from/to state+sub, reason, timestamp |
| Task Engine | `task.created` | task_id, parent_id?, source trigger |
| Task Engine | `task.children_all_done` | parent_task_id, child_ids |
| Task Engine | `task.feedback_received` | task_id, feedback source, content |
| Orchestrator | `action.requested` | task_id, action_class, details |
| Orchestrator | `cost.incurred` | task_id, provider, cost details |
| Safety Layer | `cost.limit_reached` | task_id?, limit_type, current_spend, limit_value |
| Daemon | `preemption.requested` | target_task_id, reason |
| Daemon | `trigger.new_event` | trigger source, payload |
| Daemon | `timeout.reminder` | task_id, stage |
| Daemon | `timeout.self_unblock_check` | task_id |
| Daemon | `timeout.alert` | task_id |
| Orchestrator | `preemption.ready` | task_id, checkpoint_id |
| Workspace Manager | `workspace.created` | task_id, repo, branch, worktree_path |
| Workspace Manager | `workspace.cleaned` | task_id |
| Workspace Manager | `workspace.merge_conflict` | task_id, source_branch, target_branch, conflicting_files |
| Workspace Manager | `git.committed` | task_id, sha |
| Workspace Manager | `git.pushed` | task_id, branch |
| Workspace Manager | `git.pr_opened` | task_id, pr_number, draft |
| Workspace Manager | `git.pr_updated` | task_id, pr_number, changes |
| Workspace Manager | `git.pr_merged` | task_id, pr_number |
| Workspace Manager | `git.merge_completed` | task_id, source_branch, target_branch |
| Communication Plugin | `comm.message_received` | source plugin, sender, content, timestamp |
| Communication Plugin | `comm.message_sent` | target, content, task_id? |

### Action Pipeline (supersedes Event Bus Pre-Processing)

Safety checks happen in the **Action Pipeline** before actions execute, not through Event Bus pre-processing. The pipeline gates side-effect actions through two sequential checks: Gate 1 (Task Engine — is this action class legal in the current state?) → Gate 2 (Safety Layer — does policy allow this?). Events on the Event Bus are always post-action notifications — pure pub/sub with no interception. See [`../3-interactions/event-catalog.md`](../3-interactions/event-catalog.md) § Action Pipeline and Decision #42.

---

## Open Questions for Layer 3

- How does the Event Bus handle ordering? Are events guaranteed in-order per task?
- What's the persistence model for the Event Bus? In-memory with flush? Write-ahead log?
- Full event schemas for all event types across all components (building on Event Conventions above)
- Plugin interface contracts (triggers, comm, LLM providers, tools)
- Cross-component interaction protocols (dispatch, resume, preemption handshake)
- Git hosting abstraction (GitHub/GitLab/Bitbucket)
- Cross-repo coordination mechanics (commit ordering, coordinated merge)
