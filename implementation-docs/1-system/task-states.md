# Task State Machine

> **Note:** This is the Layer 1 conceptual state machine (6 states). The authoritative version — 7 states (Review-Pending added), sub-states, and 27 valid transitions — is in [`../2-components/task-engine.md`](../2-components/task-engine.md). Open questions at the bottom of this file were resolved in Layers 2-4.

Derived from CPU process state management — see [`../0-foundation/philosophy.md`](../0-foundation/philosophy.md) § Derive from Proven Systems.

High-level for now — the Active state has significant internal complexity that will be designed at Layer 2.

---

## States

| State | Derived from | Meaning |
|-------|-------------|---------|
| **Intake** | New | Task just arrived. Being loaded and understood. |
| **Queued** | Ready | Task is understood and ready to work. Waiting for agent capacity. |
| **Active** | Running | Agent is actively working on this task. Many internal phases (TBD). |
| **Blocked** | Blocked/Waiting | Cannot proceed. Missing requirements, designs, decisions, or waiting for human input. |
| **Completed** | Terminated | Work is done. PR merged or deliverable shipped. |
| **Failed** | Terminated | Task could not be completed. Reason documented. |

## Transitions

```
INTAKE --> QUEUED --> ACTIVE <--> BLOCKED
                       |
                       v
                  COMPLETED / FAILED
```

- **Intake → Queued**: Task understood, ready to be picked up.
- **Queued → Active**: Agent has capacity, begins work.
- **Active → Blocked**: Agent hits uncertainty it cannot resolve alone. Requirements missing, design unclear, needs human input.
- **Blocked → Active**: Blocker resolved (human responded, information found). Resume work.
- **Active → Completed**: All phases done, PR shipped, memory updated.
- **Active → Failed**: Unrecoverable issue. Documented and closed.
- **Active → Queued**: (Preemption) Higher priority task arrives. Context saved, task re-queued.

## The Blocked State

Blocked is NOT passive. Before entering Blocked, the agent must:

1. **Attempt self-unblock** — research, investigate, explore alternatives, read docs, search the codebase. Exhaust all options the agent can pursue alone.
2. **Reach out** — contact the right people with specific, well-formed questions. Not vague asks. Precise questions that make it easy for the human to unblock quickly.
3. **Document everything** — the Blocked state carries rich status details.

### Status Details (attached to Blocked state)

- **Why**: What specifically is blocking progress
- **Efforts made**: What the agent tried to unblock itself
- **Who was contacted**: Which people were reached out to, via which channels
- **What's needed**: Exactly what information, decision, or resource will unblock this
- **What's waiting**: Which specific response or event the agent is waiting for

This mirrors how a real senior engineer handles blockers — see [`../0-foundation/goals.md`](../0-foundation/goals.md) § Real Engineer Behavior and § Real-Time Failure Ownership.

## Internal Phases of Active (TBD)

The Active state contains many internal phases (requirements gathering, research, planning, execution, review, etc.). These are complex and will be designed in a separate document. At this level, Active is treated as a single state with rich internal behavior.

## Open Questions

- How deep do we go on internal Active phases? Separate state machine, or a flexible list?
- Should the agent be able to work on multiple tasks concurrently (CPU multi-process), or one at a time to start?
- How does preemption work? What makes one task higher priority than another?
- Should there be a "Stalled" state for tasks blocked too long? Or is that just a Blocked task with a long duration?
