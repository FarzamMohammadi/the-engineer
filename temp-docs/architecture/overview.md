# System Overview

High-level building blocks of The Engineer. This list is open-ended — we may discover more as we dig deeper.

---

## Core Components

| Component | Role |
|-----------|------|
| **Daemon** | The always-running process. Polls triggers, dispatches tasks, manages lifecycle. The heartbeat. |
| **Orchestrator** | The small core prompt + state machine. Knows what phase the agent is in, loads the right reference docs. The brain. |
| **Registry** | The modularity layer. Triggers, comms, LLMs, tools all register as plugins. The spine. |
| **Task Engine** | Manages a task from trigger to completion. Phases, state transitions, parking when waiting for humans. The workflow. |

## Supporting Systems

| System | Role |
|--------|------|
| **People Directory** | Who to talk to, their roles, how to reach them, when to contact whom. Config-driven. |
| **Workspace Manager** | Per-task git isolation. Branches, commits, PRs. Keeps tasks from stepping on each other. |
| **Session/Memory System** | How the agent persists state, knowledge, and decisions across sessions and tasks. |
| **Safety Layer** | Guardrails, permissions, boundaries. What the agent can and cannot do. Configurable per user. |

## Core Principle: Isolation

Each task is its own universe. Own state, own workspace, own session log. Even when a task spawns sub-tasks, they stay grouped but isolated. Nothing bleeds across task boundaries.

In a world of chaos, how tidy we are, how isolated we work, and how well we manage modularity determines whether we stay alive and do careful work.

---

## Open Questions

- How do these components connect? What's the flow from trigger to completed PR?
- Are there components we haven't identified yet?
- Where do the boundaries between components fall exactly?
