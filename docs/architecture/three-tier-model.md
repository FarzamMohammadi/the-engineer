# Architecture Tiers

The three-tier model that governs how The Engineer integrates with the outside world. This is the authoritative reference for the Core / Adapter / Plugin separation.

Part of **Layer 1** — see [`../layers.md`](../layers.md) for where this fits. For the foundational intent behind this separation, see [`../0-foundation/goals.md`](../0-foundation/goals.md) § The Skeleton and Plugins.

---

## The Three-Tier Model

```
┌─────────────────────────────────────────────────────┐
│                     PLUGINS                         │
│  GitHubTriggerPlugin  TelegramCommPlugin            │
│  ClaudeCodeAgentPlugin  GitHubHostingPlugin           │
│  GitHubCommPlugin  ...                              │
│                                                     │
│  ┌─────────────────────────────────────────────┐    │
│  │               ADAPTERS                      │    │
│  │  TriggerAdapter    CommunicationAdapter     │    │
│  │  AgentAdapter        GitHostingAdapter        │    │
│  │  ...                                        │    │
│  │                                             │    │
│  │  ┌─────────────────────────────────────┐    │    │
│  │  │              CORE                   │    │    │
│  │  │  Daemon         Task Engine         │    │    │
│  │  │  Orchestrator   Event Bus           │    │    │
│  │  │  Session/Memory Safety Layer        │    │    │
│  │  │  People Directory                   │    │    │
│  │  │  Workspace Manager  Registry        │    │    │
│  │  └─────────────────────────────────────┘    │    │
│  └─────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────┘
```

**Core** — What makes The Engineer The Engineer. The invariant brain and infrastructure. This never changes regardless of what external tools, platforms, or technologies surround it. The Core defines what The Engineer does and how it thinks.

**Adapters** — The stable integration boundaries at the Core's edge. Adapters define the contracts and interfaces that any external technology must satisfy to work with The Engineer. They are the sockets in the wall — standardized, stable, universal. When Core and Adapters are set up right, The Engineer adapts to any stack without changes to itself. The adapter tier is **open by design** — new adapter types can be introduced as The Engineer's needs evolve, without changing Core or existing adapters.

**Plugins** — The interchangeable implementations that snap into Adapters. Plugins are what actually varies by use case — different users have different stacks, different tools, different needs. Only Plugins are swapped. Core and Adapters stay the same.

The Core and Adapters are the product. The Plugins are the ecosystem.

---

## Core Tier

Nine components that are always present, invariant across all configurations.

| Component | Role | Layer 2 Design |
|-----------|------|----------------|
| **Daemon** | Always-running process. Polls triggers, dispatches tasks, manages lifecycle. The heartbeat. | [`daemon-scheduler.md`](../2-components/daemon-scheduler.md) |
| **Task Engine** | Manages tasks from trigger to completion. State ownership, permissions, hierarchy. | [`task-engine.md`](../2-components/task-engine.md) |
| **Orchestrator** | The brain. Phase pipeline, agent reasoning, decision-making, communication. | [`orchestrator.md`](../2-components/orchestrator.md) |
| **Event Bus** | The nervous system. All inter-component communication flows as events. The event stream IS the audit trail. | [`event-bus.md`](../2-components/event-bus.md) |
| **Session/Memory** | State persistence, checkpoints, journal. Crash recovery foundation. | [`session-memory.md`](../2-components/session-memory.md) |
| **Safety Layer** | Guardrails, permissions, policy enforcement. Gate 2 in the Action Pipeline. Config-driven. | [`safety-layer.md`](../2-components/safety-layer.md) |
| **People Directory** | Who to talk to, their roles, how to reach them. Contact resolution for all communication. Config-driven. | [`adapter-contracts.md`](../3-interactions/adapter-contracts.md) § People Directory |
| **Workspace Manager** | Per-task git isolation via branches and worktrees. Local git operations (clone, branch, commit, push). | [`workspace-manager.md`](../2-components/workspace-manager.md) |
| **Registry** | Plugin lifecycle management. Registration, discovery, health monitoring, shutdown. The bridge between Core and the Adapter/Plugin boundary. | [`adapter-contracts.md`](../3-interactions/adapter-contracts.md) § Registry |

**Why these are Core:** They are required for basic operation, invariant across all use cases, and cannot be swapped or removed. Together they define The Engineer's identity — its ability to receive work, reason about it, execute safely, persist state, and communicate results.

**Registry's special role:** The Registry is Core infrastructure that manages the Adapter/Plugin boundary. Core components ask the Registry for adapters by type; the Registry returns references typed to the adapter contract. It manages the full lifecycle (initialize, health check, shutdown) through the Universal Adapter Contract.

---

## Adapter Tier

The adapter tier is **open-ended** — the list below captures today's known integration boundaries, but new adapter types can be added as The Engineer's capabilities evolve. Adding a new adapter type means defining a new contract that extends the Universal Adapter Contract and registering a new type in the Registry. No changes to Core logic, existing adapters, or existing plugins are required.

Four adapter types are currently defined, each representing a category of external integration where technologies vary. Full contract specifications live in [`adapter-contracts.md`](../3-interactions/adapter-contracts.md).

| Adapter | Core Consumer | What It Abstracts |
|---------|--------------|-------------------|
| **TriggerAdapter** | Daemon | Work discovery from any external source. Daemon polls via `poll()` at the adapter's declared interval. |
| **CommunicationAdapter** | Orchestrator, Daemon | Human interaction — sending notifications, asking questions, receiving responses, syncing state to external platforms. |
| **AgentAdapter** | Orchestrator | All agent-driven reasoning, code generation, and analysis. Unifies CLI-based (subscription) and API-based (pay-per-token) providers behind one contract. |
| **GitHostingAdapter** | Workspace Manager | PR lifecycle via hosting platform APIs — create, update, merge, close PRs. Branch protection queries. Review status. |
| **...** | | New adapter types as needs emerge (see § Future Adapter Types and § Extensibility by Design). |

### Universal Adapter Contract

Every adapter implements this base contract for lifecycle management. This is the minimum requirement for any integration with the Core.

```
Adapter {
  manifest:        PluginManifest    -- identity, type, config schema, criticality
  initialize(config) -> InitResult
  healthCheck()    -> HealthStatus
  shutdown()       -> void
}
```

The `PluginManifest` describes the plugin that implements the adapter — its ID, version, configuration schema, and whether it's critical (abort startup on failure) or non-critical (operate in degraded mode).

### AdapterError

The error contract at the adapter boundary. Core error handling (retry logic, fallback chains, health monitoring) depends on this format.

```
AdapterError {
  code:            string          -- "auth_failed", "rate_limited", "timeout", "not_found"
  message:         string          -- Human-readable
  retryable:       boolean
  retry_after:     duration?
  severity:        "warning" | "error" | "fatal"
}
```

### Optional Adapter Methods via Capability Gates

Some adapters define optional methods that Core only calls after checking the adapter's declared capabilities. This enables adapters to support varying levels of platform integration without requiring all implementations to support everything.

**CommunicationAdapter example:**

| Capability | Required Methods | Purpose |
|------------|-----------------|---------|
| `"send"` | `sendMessage()`, `formatMessage()` | All communication adapters (required) |
| `"receive"` | `startListening()`, `stopListening()` | Inbound messages from humans |
| `"query"` | _(routed via Daemon, not adapter method)_ | Real-time status queries |
| `"sync"` | `syncTaskState()`, `reconcileState()` | State sync to external platform |
| `"issue_management"` | `commentOnIssue()`, `createIssue()`, `updateIssue()` | Issue tracking integration |

Core checks capability before calling: if a CommunicationAdapter declares `["send", "receive"]` but not `"issue_management"`, Core never calls `createIssue()` on it. The adapter contract is explicit about what's required per capability — no guessing.

---

## Plugin Tier

Plugins are concrete implementations that satisfy an adapter contract. One plugin per adapter contract (Decision #43). Mix and match freely — the Core doesn't know or care which plugins are behind the adapters.

| Adapter | Example Plugins | Swap Scenario |
|---------|----------------|---------------|
| TriggerAdapter | GitHubTriggerPlugin, _(future: JiraTriggerPlugin, LinearTriggerPlugin)_ | Switch from GitHub Issues to Jira for work intake |
| CommunicationAdapter | TelegramCommPlugin, GitHubCommPlugin, _(future: SlackCommPlugin, TeamsCommPlugin)_ | Add Slack alongside Telegram, or replace both with Teams |
| AgentAdapter | ClaudeCodeAgentPlugin, _(future: OpenRouterAgentPlugin, OllamaAgentPlugin)_ | Switch from Claude to a local Ollama model |
| GitHostingAdapter | GitHubHostingPlugin, _(future: GitLabHostingPlugin, GiteaHostingPlugin)_ | Switch from GitHub to self-hosted Gitea |

**The accessibility promise:** A contributor building a new plugin (say, a Slack communication plugin) needs only the CommunicationAdapter contract from [`adapter-contracts.md`](../3-interactions/adapter-contracts.md). They don't need to understand the Orchestrator, Task Engine, Event Bus, or any Core internals. The adapter boundary is all they need.

---

## How the Tiers Interact

### Action Pipeline: Core → Adapter Gateway

All side-effect actions flow through the Action Pipeline before reaching an adapter:

```
Intent (Core component decides to act)
  │
  ├─ Gate 1: Task Engine — Is this action class legal in current state?
  ├─ Gate 2: Safety Layer — Does policy allow this action?
  ├─ Execute — Call the adapter method
  └─ Notify — Post-action event on Event Bus
```

Core components never bypass the pipeline to reach adapters directly (except read-only operations, which skip Gate 2). See [`event-catalog.md`](../3-interactions/event-catalog.md) § Action Pipeline.

### Registry: Adapter/Plugin Lifecycle Manager

The Registry (Core) manages all adapter/plugin lifecycle:

1. At startup, plugins register with their `PluginManifest`
2. Registry validates config, calls `initialize()`, starts health monitoring
3. Core components request adapters by type: `Registry.getPlugin("communication")`
4. Registry returns adapter-typed references — Core speaks only adapter contracts
5. At shutdown, Registry calls `shutdown()` on all plugins in reverse order

### Data Flow Direction

```
Core ──speaks──→ Adapter Contracts ──implemented by──→ Plugins
                                                         │
Plugins ──emit──→ Event Bus ──delivers to──→ Core        │
                                                         │
Plugins ──return──→ AdapterError ──handled by──→ Core ───┘
```

Core never imports, references, or depends on plugin-specific code. If a plugin has capabilities beyond the base adapter contract, Core discovers them through the capability model and calls only adapter-defined methods.

---

## Terminology Note

The original Layer 0/1 documents use "skeleton" for what is now formally called the **Core** tier. The evolution:

- **Layer 0** coined "skeleton vs plugin" — a two-tier model capturing the foundational intent that invariant pieces are always present and variable pieces snap on and off.
- **Layer 1** refines this into three tiers: **Core** (the skeleton), **Adapter** (stable contracts at the boundary), and **Plugin** (implementations that snap in).

"Skeleton" remains valid as the original term. "Core" is the formal architectural tier name used from Layer 1 onward.

---

## Extensibility by Design

The three-tier model is designed so that The Engineer can evolve without painting itself into a corner. Every tier is open to future change:

**Core** — Components can be added if a genuinely new invariant responsibility emerges. The Core's internal architecture (Event Bus pub/sub, Action Pipeline, Registry pattern) means new Core components plug into existing infrastructure without rewiring.

**Adapters** — New adapter types can be introduced at any time. The pattern is repeatable: define a contract that extends the Universal Adapter Contract, register the new type in the Registry, and Core components that need it look it up by type. No changes to existing adapters, existing plugins, or Core components that don't use the new adapter type. The Universal Adapter Contract (lifecycle: initialize, healthCheck, shutdown) and AdapterError are shared infrastructure — every new adapter type inherits them automatically.

**Plugins** — Anyone can build a new plugin for any adapter type at any time. The adapter contract is the only thing a plugin author needs to know. This is the entire point of the three-tier separation.

**Adapter contracts themselves** can also evolve. The capability model (optional methods gated by declared capabilities) means contracts can grow without breaking existing plugins — new capabilities are additive. A plugin that doesn't declare a new capability is never asked to implement it.

### What evolution looks like in practice

| Change | What's affected | What's NOT affected |
|--------|----------------|---------------------|
| New plugin for existing adapter | Nothing — just register it | Core, Adapters, other plugins |
| New adapter type | Registry learns a new type. One Core component becomes its consumer. | Other adapters, existing plugins, other Core components |
| New capability on existing adapter | Contract adds optional methods under a new capability gate | Existing plugins that don't declare the new capability |
| New Core component | Plugs into Event Bus, may use Registry for adapter lookup | Adapters, Plugins (unless the new component introduces a new adapter type) |
| Modifying an adapter contract | Versioned change. Existing plugins implement the old version until updated. | Other adapter types, Core components that don't use this adapter |

---

## Future Adapter Types

Two plugin categories from [`overview.md`](overview.md) are acknowledged but do not yet have adapter contracts defined:

- **Workflow Phases** — Reorderable, swappable phases in the Orchestrator's pipeline
- **Observability Backends** — Logging, dashboards, monitoring webhooks

These are deferred to Layer 4 (Implementation Design), when the implementation details are clearer. See Decision #64.

Beyond these known types, **The Engineer's needs will evolve in ways we cannot fully predict today.** The architecture explicitly accommodates this — adding a new adapter type is a well-defined, low-impact operation that follows the same pattern as the four existing types. The question for any future integration boundary is simple: "Does technology vary here across different users' stacks?" If yes, it's an adapter.
