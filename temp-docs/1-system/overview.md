# System Overview

High-level building blocks of The Engineer. This list is open-ended — we may discover more as we dig deeper.

Part of **Layer 1** — see [`../layers.md`](../layers.md) for where this fits.

---

## Core Components

| Component | Role | Skeleton or Plugin? |
|-----------|------|---------------------|
| **Daemon** | The always-running process. Polls triggers, dispatches tasks, manages lifecycle. The heartbeat. | Skeleton |
| **Orchestrator** | The small core prompt + state machine. Knows what phase the agent is in, loads the right reference docs. The brain. | Skeleton |
| **Registry** | The modularity layer. Triggers, comms, LLMs, tools all register as plugins. The spine. | Skeleton |
| **Task Engine** | Manages a task from trigger to completion. Phases, state transitions, parking when waiting for humans. The workflow. See [`task-states.md`](task-states.md). | Skeleton |

## Supporting Systems

| System | Role | Skeleton or Plugin? |
|--------|------|---------------------|
| **People Directory** | Who to talk to, their roles, how to reach them, when to contact whom. Config-driven. | Skeleton |
| **Workspace Manager** | Per-task git isolation. Branches, commits, PRs. Keeps tasks from stepping on each other. | Skeleton |
| **Session/Memory System** | How the agent persists state, knowledge, and decisions across sessions and tasks. | Skeleton |
| **Safety Layer** | Guardrails, permissions, boundaries. Configurable per user — see [`../0-foundation/goals.md`](../0-foundation/goals.md) § Configurable Guardrails. | Skeleton (config-driven) |

## Plugins (snap on and off per use case)

| Plugin type | Examples | Defined by |
|-------------|----------|------------|
| **Triggers** | GitHub Issues, Jira, webhooks, cron | Registry |
| **Communication channels** | Slack, GitHub Comments, Teams, WhatsApp | Registry |
| **LLM providers** | Anthropic, OpenAI, Google, Ollama | Registry |
| **Tools** | Bash, file ops, web search, communicate | Registry |
| **Workflow phases** | Requirements gathering, code review, etc. | Registry |
| **Observability backends** | Log files, dashboards, webhooks | Registry |

For the skeleton vs plugin model, see [`../0-foundation/goals.md`](../0-foundation/goals.md) § The Skeleton and Plugins.

## Core Principle: Isolation

Each task is its own universe — see [`../0-foundation/philosophy.md`](../0-foundation/philosophy.md) § Isolation as Survival.

---

## New: Event Bus

Not in the original component list. Emerged during relationship analysis as a structural element, not just a pattern.

| Component | Role | Skeleton or Plugin? |
|-----------|------|---------------------|
| **Event Bus** | The nervous system. All inter-component communication flows as events. Every event logged — the event stream IS the audit trail. | Skeleton |

## Relationships & Data Flow

See [`relationships.md`](relationships.md) for:
- How components connect (hybrid architecture: OS kernel + event bus + task-as-truth)
- What data flows through the system (10 data types identified)
- Gaps found via simulation-driven validation (12 gaps for Layer 2)

## Open Questions

- Are there components we haven't identified yet? (May emerge at Layer 2)
- Event Bus details: persistence model, ordering guarantees, schema (Layer 2)
