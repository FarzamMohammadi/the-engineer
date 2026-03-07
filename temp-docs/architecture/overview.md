# System Overview

High-level building blocks of The Engineer. This list is open-ended — we may discover more as we dig deeper.

Part of **Layer 1** — see [`layers.md`](layers.md) for where this fits.

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
| **Safety Layer** | Guardrails, permissions, boundaries. Configurable per user — see [`../goals.md`](../goals.md) § Configurable Guardrails. | Skeleton (config-driven) |

## Plugins (snap on and off per use case)

| Plugin type | Examples | Defined by |
|-------------|----------|------------|
| **Triggers** | GitHub Issues, Jira, webhooks, cron | Registry |
| **Communication channels** | Slack, GitHub Comments, Teams, WhatsApp | Registry |
| **LLM providers** | Anthropic, OpenAI, Google, Ollama | Registry |
| **Tools** | Bash, file ops, web search, communicate | Registry |
| **Workflow phases** | Requirements gathering, code review, etc. | Registry |
| **Observability backends** | Log files, dashboards, webhooks | Registry |

For the skeleton vs plugin model, see [`../goals.md`](../goals.md) § The Skeleton and Plugins.

## Core Principle: Isolation

Each task is its own universe — see [`../philosophy.md`](../philosophy.md) § Isolation as Survival.

---

## Open Questions

- How do these components connect? What's the flow from trigger to completed PR?
- Are there components we haven't identified yet?
- Where do the boundaries between components fall exactly?
- What data flows between components? (tasks, events, messages, sessions)
