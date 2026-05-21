# System Overview

High-level building blocks of The Engineer. This list is open-ended — we may discover more as we dig deeper.

Part of **Layer 1** — see [`../layers.md`](../layers.md) for where this fits.

---

## Core Components

| Component | Role | Tier |
|-----------|------|------|
| **Daemon** | The always-running process. Polls triggers, dispatches tasks, manages lifecycle. The heartbeat. | Core |
| **Orchestrator** | The small core prompt + state machine. Knows what phase the agent is in, loads the right reference docs. The brain. | Core |
| **Registry** | The modularity layer. Manages adapter/plugin registration, discovery, and lifecycle. The spine. | Core |
| **Task Engine** | Manages a task from trigger to completion. Phases, state transitions, parking when waiting for humans. The workflow. See [`task-states.md`](task-states.md). | Core |

## Supporting Systems

| System | Role | Tier |
|--------|------|------|
| **People Directory** | Who to talk to, their roles, how to reach them, when to contact whom. Config-driven. | Core |
| **Workspace Manager** | Per-task git isolation. Branches, commits, PRs. Keeps tasks from stepping on each other. | Core |
| **Session/Memory System** | How the agent persists state, knowledge, and decisions across sessions and tasks. | Core |
| **Safety Layer** | Guardrails, permissions, boundaries. Configurable per user — see [`../0-foundation/goals.md`](../0-foundation/goals.md) § Configurable Guardrails. | Core |

## Plugins (snap on and off per use case)

| Plugin type | Adapter Contract | Examples |
|-------------|-----------------|----------|
| **Triggers** | TriggerAdapter | GitHub Issues, Jira, webhooks, cron |
| **Communication channels** | CommunicationAdapter | Slack, GitHub Comments, Teams, WhatsApp |
| **LLM providers** | LLMAdapter | Anthropic, OpenAI, Google, Ollama |
| **Tools** | ToolAdapter | Bash, file ops, web search, communicate |
| **Workflow phases** | *(deferred to Layer 4)* | Requirements gathering, code review, etc. |
| **Observability backends** | *(deferred to Layer 4)* | Log files, dashboards, webhooks |
| **...** | | New adapter types as needs emerge |

Adapter contracts define the stable interfaces plugins must implement. The adapter tier is open-ended — new types can be added without changing Core or existing adapters. See [`adapter-contracts.md`](../3-interactions/adapter-contracts.md) for full specifications and [`architecture-tiers.md`](architecture-tiers.md) for the three-tier model and extensibility design.

## Core Principle: Isolation

Each task is its own universe — see [`../0-foundation/philosophy.md`](../0-foundation/philosophy.md) § Isolation as Survival.

---

## Event Bus

Not in the original component list. Emerged during relationship analysis as a structural element, not just a pattern.

| Component | Role | Tier |
|-----------|------|------|
| **Event Bus** | The nervous system. All inter-component communication flows as events. Every event logged — the event stream IS the audit trail. | Core |

## Relationships & Data Flow

See [`relationships.md`](relationships.md) for:
- How components connect (hybrid architecture: OS kernel + event bus + task-as-truth)
- What data flows through the system (10 data types identified)
- Gaps found via simulation-driven validation (12 gaps for Layer 2)

## Open Questions

- Are there components we haven't identified yet? (May emerge at Layer 2)
- Event Bus details: persistence model, ordering guarantees, schema (Layer 2)
