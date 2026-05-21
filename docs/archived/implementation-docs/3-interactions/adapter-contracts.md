# Adapter Contracts -- Layer 3

Every adapter type's interface contract. What adapters must implement, how plugins register, how the Core interacts with the external world through adapters. This is the authoritative reference for building plugins -- if a method isn't here, the Core doesn't call it.

Part of **Layer 3** -- see [`layers.md`](../layers.md). Built on the three-tier model defined in [`architecture-tiers.md`](../1-system/architecture-tiers.md), plugin types from [`overview.md`](../1-system/overview.md), and the communication pattern established in [`comm-plugins.md`](../2-components/comm-plugins.md).

---

## Modularity Through Independent Adapters

**The Engineer is the Core. Everything that varies is plugin-able through adapters.**

Each plugin is an independent adapter implementation -- one plugin per adapter contract, independently registrable and replaceable. This is the foundation of The Engineer's open-source accessibility: anyone can plug in exactly the modules they need.

### The Mix-and-Match Principle

A user who wants GitHub for issue tracking, GitLab for code hosting, and Slack for communication registers three separate plugins. No coupling between them. Removing one has zero impact on the others.

GitHub provides **three separate plugins**: GitHubTriggerPlugin, GitHubCommPlugin, GitHubHostingPlugin. Each registers independently. Each is replaceable independently. Switching from GitHub Issues to Linear for triggers? Swap one plugin. Everything else stays.

### Why One Plugin Per Adapter

- **Separation of concerns** -- each plugin does one thing well
- **Independent lifecycle** -- register, update, or remove any plugin without touching others
- **Combinatorial freedom** -- N trigger plugins x M communication plugins x P hosting plugins = N*M*P valid configurations
- **Simpler contracts** -- each contract is focused and testable
- **Lower barrier to contribution** -- building a Slack communication plugin doesn't require understanding trigger or hosting interfaces

This is the adapter pattern applied at the integration boundary. The Core defines the adapter contracts. Plugins implement one contract each. Mix and match freely.

---

## Universal Adapter Contract

Every adapter, regardless of type, implements this base contract. This is the minimum requirement for any integration with the Core. The Core interacts with all adapters through this common interface for lifecycle management.

```
Adapter {
  -- Identity --
  manifest:        PluginManifest

  -- Lifecycle --
  initialize(config: object) -> InitResult
  healthCheck() -> HealthStatus
  shutdown() -> void
}

PluginManifest {
  id:              string          // Unique identifier: "github-trigger", "telegram-comm", "claude-code-llm"
  type:            AdapterType     // "trigger" | "communication" | "llm" | "tool" | "git_hosting" | ... (extensible)
  version:         string          // Semantic version: "1.0.0"
  name:            string          // Human-readable: "GitHub Issues Trigger"
  description:     string          // One-line description
  config_schema:   object          // JSON Schema for this plugin's configuration
  critical:        boolean         // If true, system startup aborts on init failure (default: true)
}

InitResult {
  success:         boolean
  message:         string?         // Error message if failed
}

HealthStatus {
  healthy:         boolean
  message:         string?         // "Connected to GitHub API", "Rate limited until 14:30"
  details:         object?         // Plugin-specific health data
}
```

### Adapter Error Contract

All adapters report errors in a common format. This allows the Core to handle errors uniformly regardless of adapter type.

```
AdapterError {
  code:            string          // Adapter-defined error code: "auth_failed", "rate_limited", "timeout"
  message:         string          // Human-readable error message
  retryable:       boolean         // Can this operation be retried?
  retry_after:     duration?       // Suggested wait time before retry (null if not retryable)
  severity:        "warning" | "error" | "fatal"
                                   // warning: degraded but operational
                                   // error: operation failed, adapter still usable
                                   // fatal: adapter unusable, needs reinitialization
}
```

### Plugin Criticality

The `critical` field in the manifest determines startup behavior. If a critical plugin fails `initialize()`, the system aborts startup (P1 step 3, error-propagation Pattern 6: Graceful-halt). Non-critical plugins that fail init are logged and skipped -- the system starts in degraded mode.

Defaults: trigger plugins and the primary communication plugin are critical (the system can't function without work intake and human communication). Secondary communication plugins, tool plugins, and additional LLM providers are non-critical by default. The `critical` field can be overridden in configuration.

### Standard Error Codes

Adapters define error codes in `AdapterError.code`. These common codes allow the Core to handle errors uniformly:

| Code | Meaning | Retryable? |
|------|---------|-----------|
| `auth_failed` | Authentication/authorization failure | No (needs reinitialization) |
| `rate_limited` | External API rate limit hit | Yes (respect `retry_after`) |
| `timeout` | Operation timed out | Yes |
| `network_error` | Network connectivity failure | Yes |
| `not_found` | Requested resource doesn't exist | No |
| `conflict` | Conflicting state (e.g., concurrent modification) | Depends on context |
| `invalid_input` | Bad parameters passed to adapter | No |

Adapter-type-specific codes:

| Code | Adapter Type | Meaning |
|------|------------|---------|
| `merge_conflict` | GitHostingAdapter | PR has merge conflicts |
| `branch_not_found` | GitHostingAdapter | Branch deleted or doesn't exist |
| `pr_not_mergeable` | GitHostingAdapter | Protection requirements not met |
| `context_exceeded` | LLMAdapter | Prompt exceeds max context window |
| `quota_exhausted` | LLMAdapter | Provider quota or budget exhausted |

Adapters may define additional codes beyond these. The common codes are conventions, not an exhaustive enum.

### Configuration Contract

Each plugin declares its configuration schema in the manifest (`config_schema`). The Registry validates configuration against this schema at registration time.

- **Plugins never read configuration directly** -- they receive validated config via `initialize(config)`
- **Config hot-reload**: Registry can call `shutdown()` then `initialize(new_config)` for config changes
- **Secrets**: Sensitive values (API keys, tokens) are referenced by name, resolved by the Core's secret manager. Plugins receive resolved values, never secret references.

### Behavior During Event Bus Outage

Plugins do not emit events themselves -- the Core emits events post-action (e.g., after `sendMessage()` succeeds, the Core emits `comm.message_sent`). When the Event Bus goes down, plugins continue responding to direct calls (`healthCheck()`, `sendMessage()`, etc.) normally. The Core detects Event Bus failure and invokes Graceful-halt -- checkpointing active tasks and stopping new work (Decision #53). See [`error-propagation.md`](error-propagation.md) Chain 2.

---

## Registry

The Registry is a **Core** component (not an adapter, not a plugin). It manages all plugin registration, discovery, and lifecycle. Every plugin interacts with the system through the Registry. It is the bridge between the Core and the Adapter/Plugin boundary.

**Derived from:** Service registries (Consul, Eureka, Kubernetes service discovery) -- discovery, health, lifecycle management.

```
Registry {
  -- Registration --
  register(manifest: PluginManifest, instance: Adapter) -> RegistrationResult
  deregister(plugin_id: string) -> void

  -- Discovery --
  getPlugin(type: AdapterType, id: string) -> Adapter?
  getPluginsByType(type: AdapterType) -> Adapter[]
  getPrimaryPlugin(type: AdapterType) -> Adapter?

  -- Lifecycle --
  initializeAll() -> void         // Called at system startup, initializes all registered plugins
  shutdownAll() -> void           // Called at system shutdown
  healthCheckAll() -> HealthReport[]

  -- Hot-swap --
  replace(plugin_id: string, new_manifest: PluginManifest, new_instance: Adapter) -> RegistrationResult
}

RegistrationResult {
  success:         boolean
  plugin_id:       string
  message:         string?         // Error if failed: "Config validation failed", "Duplicate ID"
}
```

### Registration Rules

- **Unique IDs**: No two plugins can share the same `id`. Rejected at registration.
- **Schema validation**: Plugin's `config_schema` is validated structurally at registration. The user-provided config is validated against it.
- **Lifecycle enforcement**: Registry calls `initialize(config)` immediately after registration. If initialization fails, the plugin is deregistered.
- **Health monitoring**: Registry periodically calls `healthCheck()` on all registered plugins. Unhealthy plugins are flagged but not automatically removed (the Daemon handles escalation via `health.trigger_failure` events for triggers, direct alerts for others).

### Primary Plugin Convention

When multiple plugins of the same type exist (e.g., two communication plugins: Telegram + Slack), one is designated **primary**. The primary is used when a specific plugin isn't specified by the caller:

- Primary designation is configuration, not code: `primary: true` in the plugin's config
- Only one primary per type. If none designated, the first registered is primary.
- Primary is a convenience default, not an exclusion -- callers can always request a specific plugin by ID.

### Plugin Type Registry

The Registry maintains separate indexes by adapter type. Discovery queries return only plugins of the requested type. This keeps lookups fast and prevents type confusion.

---

## Trigger Adapter

Trigger adapters discover new work from external sources and feed it into the system. The Daemon polls trigger adapters on their declared interval.

**Derived from:** Webhook receivers, message queue consumers, polling adapters.

Reference: [`daemon-scheduler.md`](../2-components/daemon-scheduler.md) § Trigger Polling for how the Daemon manages trigger adapters.

```
TriggerAdapter extends Adapter {
  poll_interval:   duration        // How often the Daemon should poll: 30s, 60s, etc.
  poll() -> TriggerEvent[]
}

TriggerEvent {
  idempotency_key: string          // Stable, unique dedup key: "github:issue:owner/repo:47"
  source:          string          // This plugin's ID
  event_type:      string          // "issue_opened", "issue_assigned", "manual_create"
  external_ref:    ExternalRef?    // Structured reference to the originating ticket/issue (includes optional pr_decorations for title/description decoration)
  title:           string          // Task title derived from trigger
  body:            string?         // Description/body from external source
  repo:            string          // Target repo
  clone_url:       string          // HTTPS clone URL for the target repo
  thoughts_id:     string?         // Trigger-provided thoughts/ directory identifier
  metadata:        object?         // Source-specific data (labels, assignees, milestones, etc.)
}
```

### Behavioral Contract

- **Idempotency keys MUST be stable**: The same external item must always produce the same key. The Daemon deduplicates using these keys. Unstable keys cause duplicate tasks.
- **`poll()` returns only new items**: The plugin tracks its own watermark (last seen ID, last poll timestamp, etc.) and returns only items the Daemon hasn't seen.
- **Errors are surfaced, not swallowed**: If the external API fails, the plugin throws an `AdapterError`. The Daemon manages consecutive failure counting and health alerts (`health.trigger_failure` events).
- **`poll_interval` is a contract, not a suggestion**: The Daemon respects it. Plugins should set it based on the external API's rate limits and expected event frequency.
- **`poll()` must be fast**: No heavy processing. Return raw data, let the Daemon and Task Engine handle interpretation.

### Event Types and Metadata Schemas

The `event_type` field in `TriggerEvent` is open-ended -- plugins can define new types. These are the canonical types the Core understands:

| event_type | Meaning | Idempotency Key Pattern |
|-----------|---------|------------------------|
| `issue_opened` | New issue/ticket created | `{platform}:issue:{repo}:{number}` |
| `issue_assigned` | Existing issue assigned to The Engineer | `{platform}:issue:{repo}:{number}` |
| `issue_reopened` | Previously closed issue reopened | `{platform}:issue:{repo}:{number}` |
| `pr_review_received` | PR review submitted on an Engineer-owned PR | `{platform}:review:{repo}:{pr}:{review_id}` |
| `manual_create` | Manual task creation via CLI or API | `manual:{timestamp}:{title_hash}` |

For `pr_review_received`, the `metadata` field MUST include:

```
metadata (for pr_review_received) {
  task_id:         string          // Task that owns this PR (looked up by PR → branch → task mapping)
  pr_number:       number
  review_type:     "approved" | "changes_requested" | "comment"
  pr_state:        "draft" | "ready"   // Whether PR is still draft or marked ready
  reviewer:        string          // Platform username of the reviewer
  comment:         string?         // Review comment text (null for approval-only reviews)
}
```

The Daemon translates `pr_review_received` trigger events into `trigger.pr_review` events on the Event Bus (see [`event-catalog.md`](event-catalog.md) § `trigger.pr_review`), which then become `task.feedback_received` events after validation. This keeps the trigger layer cleanly separated from the task lifecycle.

---

*Below: concrete plugins implementing the TriggerAdapter contract.*

### Implementations

| Plugin | Source | Notes |
|--------|--------|-------|
| GitHubTriggerPlugin | GitHub Issues API | Polls for new/assigned issues and PR reviews. Key: `github:issue:{owner}/{repo}:{number}` or `github:review:{owner}/{repo}:{pr}:{review_id}` |
| ManualTriggerPlugin | CLI / API | Accepts manual task creation. Key: `manual:{timestamp}:{title_hash}` |
| *(future)* JiraTriggerPlugin | Jira REST API | Polls for assigned tickets |
| *(future)* LinearTriggerPlugin | Linear API | Polls for assigned issues |

---

## Communication Adapter

Communication adapters are the Engineer's voice -- how it communicates with humans through external platforms. They are dumb transport: the Orchestrator owns all intelligence (what to say, when). Communication adapters handle the mechanical platform interaction.

**Derived from:** Chat bot adapters, notification gateway patterns, webhook receivers.

Reference: [`comm-plugins.md`](../2-components/comm-plugins.md) for the full Layer 2 design including ownership boundaries, state sync, and query routing.

```
CommunicationAdapter extends Adapter {
  capabilities:    string[]        // Subset of: "send", "receive", "query", "sync", "issue_management"

  -- Outbound (required) --
  sendMessage(target: Target, message: FormattedMessage) -> SendResult
  formatMessage(content: string, type: MessageType) -> string

  -- Inbound (required if "receive" capability) --
  startListening() -> void         // Begin receiving messages (webhook server, long-poll, etc.)
  stopListening() -> void          // Stop receiving messages

  -- State Sync (required if "sync" capability) --
  syncTaskState(task_id: string, old_state: string, new_state: string, metadata: SyncMetadata) -> void
  reconcileState(tasks: TaskReconciliationInput[]) -> ReconciliationResult

  -- Issue Management (required if "issue_management" capability) --
  commentOnIssue(repo: string, issue_number: number, comment: string) -> void
  createIssue(repo: string, options: IssueOptions) -> IssueResult
  updateIssue(repo: string, issue_number: number, updates: IssueUpdates) -> void
}

Target {
  user_id:         string          // Maps to People Directory entry
  channel:         string?         // Specific channel/chat/thread (optional)
}

FormattedMessage {
  content:         string          // Platform-specific formatted content
  metadata: {
    task_id:       string?
    type:          MessageType
  }
}

MessageType = "notification" | "question" | "status_response" | "milestone" | "alert"

SendResult {
  success:         boolean
  message_id:      string?         // Platform message ID (for reply threading)
  error:           AdapterError?
}

SyncMetadata {
  task_title:      string          // Human-readable task title
  external_ref:    string?         // GitHub issue URL, Jira ticket ID, etc.
  sub_state:       string?         // Sub-state if applicable (e.g., "Demo", "Code" for Review-Pending)
  reason:          string?         // Why the transition happened (for milestone comments)
}

InboundMessage {
  source:          string          // Communication plugin ID that received the message
  sender:          string          // User identifier on the platform
  content:         string          // Raw message text
  timestamp:       datetime
  reply_to:        string?         // If replying to a previous outbound message
  platform_metadata: object        // Platform-specific data (chat_id, thread_id, etc.)
}

IssueOptions {
  title:           string
  body:            string
  labels:          string[]?
  assignees:       string[]?
  parent_issue:    number?         // Link to parent issue for cross-reference
}

IssueResult {
  number:          number          // The created issue number
  url:             string
}

IssueUpdates {
  state:           "open" | "closed"?
  labels_add:      string[]?       // Labels to add (e.g., "engineer:active")
  labels_remove:   string[]?       // Labels to remove (e.g., "engineer:queued")
  body:            string?         // For updating checklists on parent issues
}

TaskReconciliationInput {
  task_id:         string
  external_ref:    string          // GitHub issue URL/number
  expected_state:  string          // Current internal state (from Task Engine)
  expected_label:  string          // Expected label: "engineer:active", etc.
}

ReconciliationResult {
  reconciled:      number          // How many tasks had mismatched state
  errors:          ReconciliationError[]
}

ReconciliationError {
  task_id:         string
  reason:          string          // "issue_not_found", "api_error", etc.
}
```

### Inbound Message Delivery

When a communication plugin receives a message from a human, it wraps it in an `InboundMessage` and emits a `comm.message_received` event on the Event Bus. The Daemon picks this up and routes it (to query handler or to Orchestrator via dispatch).

The plugin does NOT interpret the message -- it delivers it raw. Interpretation is the Daemon's job (keyword matching for status queries) or the Orchestrator's job (task-related responses). Plugins must not queue messages -- if the plugin is down, messages during downtime are lost. The timeout ladder (P11) handles re-delivery.

### State Reconciliation

`reconcileState` is called once by the Core (Daemon, via P15 step 15) when a communication plugin recovers from an outage. The Core gathers current task states from the Task Engine and passes them to the plugin. The plugin compares expected labels/comments against the external platform's actual state, fixes mismatches (adds missing labels, posts catch-up comments for missed milestones). Reconciliation is idempotent -- safe to call multiple times. See Decision #58.

> **Terminology:** "State sync" (`syncTaskState`) is reactive -- called on every `task.state_changed` event during normal operation. "State reconciliation" (`reconcileState`) is proactive -- called once after an outage to catch up on missed sync events. Both achieve the same end state; reconciliation is the batch equivalent of sync.

### Capability-Based Loading

Not every communication adapter supports every capability. The Core checks capabilities before calling optional methods.

| Capability | Meaning | Required Methods | Example Plugins |
|-----------|---------|-----------------|-----------------|
| `send` | Can send outbound messages | `sendMessage()`, `formatMessage()` | All plugins |
| `receive` | Can receive inbound messages from humans | `startListening()`, `stopListening()` | Telegram, Slack, GitHub |
| `query` | Persistent connection for real-time status queries | _(routed via Daemon, not adapter method)_ | Telegram, Slack |
| `sync` | Can sync internal state to platform representation | `syncTaskState()`, `reconcileState()` | GitHub (labels, project boards) |
| `issue_management` | Can manage issues/tickets on external platform | `commentOnIssue()`, `createIssue()`, `updateIssue()` | GitHub |

A Telegram plugin supports "send", "receive", and "query" but not "sync" or "issue_management" (no label/issue concept). A GitHub communication plugin supports all five. The Core checks capabilities before calling optional methods.

### State Sync via Event Bus

Communication plugins with the `"sync"` capability subscribe to `task.state_changed` events on the Event Bus at registration time. The Core does NOT call `syncTaskState()` directly -- the plugin handles sync autonomously. When the plugin receives a `task.state_changed` event, it invokes its own `syncTaskState()` internally to update the external platform (labels, comments, project boards).

This keeps sync logic inside the plugin and decouples the Core from platform-specific sync details. The Core only emits events; the plugin decides how to represent state changes on its platform. See [`comm-plugins.md`](../2-components/comm-plugins.md) § GitHub State Sync and [`event-catalog.md`](event-catalog.md) § `task.state_changed` subscribers.

### Fallback Chain Mechanics

When a `sendMessage()` call fails (after retries per `AdapterError.retry_after`), the Core -- not the plugin -- drives fallback to alternative channels.

**Flow:**
1. Core resolves first contact from People Directory `contacts[]` (ordered list per person, Decision #55)
2. Calls `sendMessage()` on that channel's communication plugin
3. On failure (retries exhausted), resolves next contact in `contacts[]`
4. Calls `sendMessage()` on the next channel's communication plugin
5. Repeat until success or all channels exhausted

Plugins are unaware of fallback -- they simply send or fail. Each `sendMessage()` call is independent; the plugin doesn't know it's a fallback attempt.

**Exception -- `timeout.alert` (48hr escalation):** ALL configured channels for the person are tried in parallel (best-effort on every channel), not sequential fallback. This is the last-resort escalation.

See [`error-propagation.md`](error-propagation.md) § 5 Communication Plugin Error Handling for the full error chain.

---

*Below: concrete plugins implementing the CommunicationAdapter contract.*

### Implementations

| Plugin | Platform | Capabilities | Notes |
|--------|----------|-------------|-------|
| TelegramCommPlugin | Telegram Bot API | send, receive, query | Real-time notifications, questions, and status queries |
| GitHubCommPlugin | GitHub API | send, receive, sync, issue_management | Issue comments, label sync, checklist management, state reconciliation |
| *(future)* SlackCommPlugin | Slack API | send, receive, query | Channel/DM messaging |
| *(future)* EmailCommPlugin | SMTP/IMAP | send | Email notifications (no real-time receive) |

---

## LLM Adapter

LLM adapters are the Engineer's thinking engine. They execute reasoning, code generation, analysis, and all LLM-powered operations. The Orchestrator interacts with LLM adapters exclusively through this contract.

**Derived from:** API gateway patterns, multi-backend abstraction layers.

Reference: [`safety-layer.md`](../2-components/safety-layer.md) § Cost Tracking for the two provider models and cost event schema.

```
LLMAdapter extends Adapter {
  provider_type:   "cli" | "api"   // CLI (subscription) vs API (pay-per-token)

  complete(request: CompletionRequest) -> CompletionResult
  getCapabilities() -> LLMCapabilities
}

CompletionRequest {
  prompt:          string          // The full prompt (system + user + context)
  options: {
    max_tokens:    number?         // Max output tokens
    temperature:   number?         // 0.0 - 1.0
    stop:          string[]?       // Stop sequences
    tools:         ToolDef[]?      // Tool/function definitions (if provider supports)
  }
}

CompletionResult {
  content:         string          // The LLM's response
  tool_calls:      ToolCall[]?     // If the LLM invoked tools (for tool-use providers)
  finish_reason:   "stop" | "max_tokens" | "tool_use"

  -- Usage (REQUIRED -- the bridge to cost tracking) --
  usage: {
    tokens_in:     number          // Input tokens consumed
    tokens_out:    number          // Output tokens generated

    -- API-specific --
    spend_usd:     number?         // Dollar cost of this call (null for CLI providers)

    -- CLI-specific --
    remaining:     number?         // Remaining quota (null for API providers, or if unknown)
    resets_at:     datetime?       // When quota resets (null if unknown)
  }
}

LLMCapabilities {
  max_context:     number          // Max context window in tokens
  supports_tools:  boolean         // Can the provider do tool use?
  supports_vision: boolean         // Can the provider process images?
  model_id:        string          // The underlying model: "claude-sonnet-4-5-20250514", "gpt-4o", etc.
}
```

### Cost Reporting Contract

**Every `CompletionResult` MUST include usage data.** This is non-negotiable -- it is the bridge between LLM adapters and the Safety Layer's cost tracking system.

The Orchestrator wraps usage data from `CompletionResult.usage` into a `cost.incurred` event (see [`event-catalog.md`](event-catalog.md) § `cost.incurred`). The Safety Layer subscribes to these events and maintains cost accumulators. If a provider cannot report usage, it MUST return best-effort estimates.

### CLI vs API Provider Differences

| Concern | CLI Provider | API Provider |
|---------|-------------|-------------|
| Cost unit | Subscription quota (requests, tokens/day) | Dollars per token |
| Limit source | Provider-imposed | User-configured budget |
| `spend_usd` | null (not applicable) | Actual dollar cost |
| `remaining` | Remaining quota if provider reports it | null (budget tracked by Safety Layer) |
| Rate limits | Provider's rate limit (requests/min) | API key rate limit |
| Invocation | Spawns CLI process, parses output | HTTP API call |

### Error Handling

| Error | Retryable? | Action |
|-------|-----------|--------|
| Rate limited | Yes | Respect `retry_after`. Report via `AdapterError`. |
| Context window exceeded | No | Orchestrator must reduce prompt size. |
| Provider down | Yes | Report via `AdapterError`. Daemon may switch to fallback provider. |
| Auth failure | No | Fatal error. Plugin needs reinitialization with new credentials. |
| Malformed response | Yes | Retry once. If persistent, report error. |

### Provider Failover

Provider priority is user configuration -- an ordered list of LLM providers in the system config (not the plugin manifest). The Daemon owns switching logic; plugins are unaware of failover.

When a provider returns a fatal `AdapterError` (auth failure, prolonged downtime), the Daemon switches the active provider to the next in the priority list. If the provider fails mid-completion, the same prompt is retried on the next provider. The Orchestrator sees a transparent switch -- it calls `complete()` through the Core, which routes to whichever provider is currently active. Cost tracking updates automatically (events reference the new `provider_id`). The human is notified of the switch. See Decision #54.

---

*Below: concrete plugins implementing the LLMAdapter contract.*

### Implementations

| Plugin | Type | Provider | Notes |
|--------|------|----------|-------|
| ClaudeCodeLLMPlugin | cli | Claude Code CLI | Spawns `claude` process, parses streaming output |
| OpenRouterLLMPlugin | api | OpenRouter API | Multi-model routing, dollar-based billing |
| *(future)* GeminiCLIPlugin | cli | Gemini CLI | Similar to Claude Code |
| *(future)* OllamaLLMPlugin | api | Ollama (local) | Local models, zero cost (usage still tracked for metrics) |

---

## Tool Adapter

Tool adapters are the Engineer's hands -- how it interacts with the world beyond thinking. Following PI-Inspired Minimalism: few broad tools, not many narrow ones. Bash is the meta-tool.

**Derived from:** Unix tool philosophy (small, composable), agent tool-use patterns.

```
ToolAdapter extends Adapter {
  action_classes:  string[]        // Which action classes this tool exercises: ["write", "test"], ["read"], etc.

  describe() -> ToolDescription
  execute(action: string, params: object) -> ToolResult
}

ToolDescription {
  name:            string          // Tool name: "bash", "file_ops", "web_search"
  description:     string          // What the tool does (for LLM tool-use prompts)
  parameters:      object          // JSON Schema for the params object
  action_classes:  string[]        // Same as manifest -- repeated for LLM context
}

ToolResult {
  success:         boolean
  output:          string          // Tool output (stdout, file contents, search results, etc.)
  side_effects:    SideEffect[]    // What changed (REQUIRED for write/test/git tools)
  error:           AdapterError?   // Populated if success is false
}

SideEffect {
  type:            "file_written" | "file_deleted" | "command_run" | "network_request" | "process_spawned"
  details:         object          // Type-specific: { path: "...", bytes: N } for file_written, etc.
}
```

### Action Class Mapping

Each tool declares which action classes it exercises. This feeds into Gate 1 of the Action Pipeline -- the Task Engine checks whether the current state+sub-state permits the declared action class before the tool executes.

The 10 action classes are defined in [`task-engine.md`](../2-components/task-engine.md) § Action Classes:
`read`, `write`, `test`, `git-local`, `git-remote`, `communicate`, `merge`, `deploy`, `task-manage`, `ask-human`

A single tool can exercise multiple action classes (e.g., BashToolPlugin exercises `read`, `write`, `test`, `git-local` depending on the command). The pipeline checks the action class of the specific operation, not all classes the tool could theoretically exercise.

### Side Effects Reporting

Tools MUST report side effects in every `ToolResult`. This is how the system maintains awareness of what changed:

- The Orchestrator uses side effects for journal entries ("Modified 3 files in src/auth/")
- The Session/Memory system uses side effects for checkpoint integrity
- The Safety Layer uses side effects for scope validation (did the tool write outside the allowed directory?)

Read-only tools (action class `read`) return empty side effects arrays.

### Self-Extension

Following PI philosophy, the agent can create new tool plugins at runtime. The Orchestrator builds a new ToolAdapter implementation, registers it with the Registry via dynamic registration, and uses it immediately. The Action Pipeline still gates all operations -- self-extension does not bypass safety.

Runtime-created tools are ephemeral (not persisted across restarts) unless the Orchestrator also persists them as code in the repo.

---

*Below: concrete plugins implementing the ToolAdapter contract.*

### Implementations

| Plugin | Action Classes | Notes |
|--------|---------------|-------|
| BashToolPlugin | read, write, test, git-local | The meta-tool. Composes complex operations from primitives. |
| FileOpsToolPlugin | read, write | Structured file operations (read, write, search, glob) |
| WebSearchToolPlugin | read | Web search and fetch |
| *(self-extended)* | varies | Agent creates as needed at runtime |

---

## Git Hosting Adapter

Git hosting adapters abstract the code hosting platform's API for PR lifecycle, branch protection queries, and merge operations. The Workspace Manager is the primary consumer of this contract.

**Fully separate from communication adapters** -- different capability domain. GitHub implements both contracts as separate plugins (GitHubCommPlugin for communication, GitHubHostingPlugin for code hosting).

**Scope:** This adapter covers hosting platform API operations only. Local git operations (clone, fetch, branch, commit, push, worktree management) are handled directly by the Workspace Manager -- no adapter needed for local git.

**Derived from:** Git forge APIs (GitHub, GitLab, Bitbucket), abstract VCS interfaces.

Reference: [`workspace-manager.md`](../2-components/workspace-manager.md) § PR Management for how the Workspace Manager calls these operations. Resolves the open question from `workspace-manager.md` line 587: "How does the git hosting plugin interface work for GitLab, Bitbucket?"

```
GitHostingAdapter extends Adapter {
  action_classes:  string[]        // ["git-remote", "merge"] — feeds Action Pipeline Gate 1

  -- PR Lifecycle --
  createPR(options: PROptions) -> PRResult
  updatePR(repo: string, pr_number: number, updates: PRUpdates) -> void
  mergePR(repo: string, pr_number: number, strategy: MergeStrategy) -> MergeResult
  closePR(repo: string, pr_number: number) -> void

  -- PR Queries --
  getPRStatus(repo: string, pr_number: number) -> PRStatus
  getReviewStatus(repo: string, pr_number: number) -> ReviewStatus

  -- PR Comments --
  commentOnPR(repo: string, pr_number: number, comment: string, reply_to: string?) -> CommentResult

  -- Branch Queries --
  getBranchProtection(repo: string, branch: string) -> BranchProtection
  getDefaultBranch(repo: string) -> string
}

PROptions {
  repo:            string
  branch:          string          // Source branch
  base:            string          // Target branch (usually "main")
  title:           string
  body:            string          // PR description (provided by Orchestrator)
  draft:           boolean         // true for demo stage, false for ready
  labels:          string[]?
  reviewers:       string[]?       // From task.team where role = "reviewer"
}

PRResult {
  pr_number:       number
  url:             string          // Full PR URL
}

PRUpdates {
  title:           string?
  body:            string?
  draft:           boolean?        // Set false to mark Ready (Draft -> Ready transition)
  labels_add:      string[]?
  labels_remove:   string[]?
}

MergeStrategy = "merge" | "squash" | "rebase"

MergeResult {
  merge_sha:       string          // Merge commit SHA
  success:         boolean
  error:           AdapterError?   // "merge conflicts", "branch protection failed", etc.
}

PRStatus {
  number:          number
  state:           "open" | "closed" | "merged"
  draft:           boolean
  mergeable:       boolean         // Can this PR be merged? (no conflicts, checks pass)
  checks_passing:  boolean         // Are CI checks passing?
  url:             string
}

ReviewStatus {
  approved:        boolean         // At least one approval with no outstanding change requests
  approvals:       number          // Number of approvals
  changes_requested: boolean       // Any reviewer requested changes
  reviewers:       ReviewerState[]
}

ReviewerState {
  username:        string
  state:           "approved" | "changes_requested" | "commented" | "pending"
}

CommentResult {
  comment_id:      string          // Platform comment ID
  url:             string          // Direct link to the comment
}

BranchProtection {
  protected:       boolean
  required_reviews: number         // Minimum approvals required
  required_checks: string[]        // Required CI check names
  restrictions:    object?         // Who can push (platform-specific)
}
```

### Behavioral Contract

- **PR creation emits events**: After `createPR` succeeds, the Workspace Manager emits `git.pr_opened` on the Event Bus.
- **Draft -> Ready is explicit**: The Workspace Manager calls `updatePR` with `{ draft: false }` to transition. Emits `git.pr_updated`.
- **Merge respects branch protection**: `mergePR` must check that protection requirements are met. If not met, return an error rather than attempting to force.
- **Platform-agnostic**: The contract uses generic concepts (PR, review, branch protection) that map to every major git hosting platform. Platform-specific features (GitHub Actions, GitLab CI pipelines) are accessed via the `metadata` fields or future extensions.

---

*Below: concrete plugins implementing the GitHostingAdapter contract.*

### Implementations

| Plugin | Platform | Notes |
|--------|----------|-------|
| GitHubHostingPlugin | GitHub REST/GraphQL API | Full support for all contract methods |
| *(future)* GitLabHostingPlugin | GitLab API | MRs map to PRs, pipeline status maps to checks |
| *(future)* BitbucketHostingPlugin | Bitbucket API | Pull requests, build status |

---

## People Directory

The People Directory is a **Core** component (not an adapter, not a plugin). It is always present, config-driven, and does not register in the Registry. It maps people to roles, contact channels, and preferences.

Reference: [`task-engine.md`](../2-components/task-engine.md) § Task Carries Its Team for how tasks reference people.

```
PeopleDirectory {
  -- Queries --
  getPerson(id: string) -> Person?
  getByRole(role: string) -> Person[]
  resolveContact(person_id: string, channel: string) -> ContactInfo?
  getAll() -> Person[]

  -- Config reload --
  reload() -> void                 // Re-read people config file (hot-reload)
}

Person {
  id:              string          // Unique identifier: "farzam", "alice"
  name:            string          // Display name: "Farzam Mohammadi"
  roles:           string[]        // "owner", "reviewer", "stakeholder", etc.
  contacts:        Contact[]       // How to reach them, per channel
  preferences: {
    notification_level: "all" | "milestones" | "critical"  // How much to notify
    quiet_hours:   { start: time, end: time }?              // Don't disturb (optional)
  }
}

Contact {
  channel:         string          // Communication plugin ID: "telegram", "github", "slack", "email"
  handle:          string          // Platform-specific: "@farzam", "farzam@github", "farzam@example.com"
}

ContactInfo {
  channel:         string
  handle:          string
  plugin_id:       string          // Registry ID of the communication plugin that handles this channel
}
```

### How Components Use People Directory

| Component | Usage |
|-----------|-------|
| **Orchestrator** | Looks up who to notify (task.team references). Resolves contact info before sending messages via communication adapters. |
| **Task Engine** | Populates `task.team[]` from People Directory when task is created (based on repo config and roles). |
| **Communication Plugins** | `resolveContact` maps a person + channel to the specific communication plugin and platform handle needed to reach them. |
| **Daemon** | Looks up owner for health alerts and cost limit notifications. |

### Configuration

People are defined in a config file (format decided at Layer 4 -- YAML, TOML, or similar). The file is hot-reloadable: changes take effect without system restart.

```
people:
  - id: farzam
    name: Farzam Mohammadi
    roles: [owner, reviewer]
    contacts:
      - channel: telegram
        handle: "@farzam"
      - channel: github
        handle: "farzam"
    preferences:
      notification_level: milestones
```

---

## Adapter Type Summary

| Adapter Type | Contract | Core Consumer(s) | Tier |
|-------------|----------|-------------------|------|
| Trigger | TriggerAdapter | Daemon | Adapter |
| Communication | CommunicationAdapter | Orchestrator, Daemon | Adapter |
| LLM | LLMAdapter | Orchestrator | Adapter |
| Tool | ToolAdapter | Orchestrator | Adapter |
| Git Hosting | GitHostingAdapter | Workspace Manager | Adapter |
| ... | *(new adapter types as needs emerge)* | | Adapter |
| Registry | -- (Core infrastructure) | All adapters/plugins | Core |
| People Directory | -- (Core infrastructure) | Orchestrator, Task Engine, Communication Plugins, Daemon | Core |

### Future and Evolving Adapter Types

The adapter tier is **open-ended by design**. Two known plugin types do not yet have adapter contracts:

- **Workflow phases**: Orchestrator-internal (phase pipeline is Orchestrator's design). Adapter contract deferred to Layer 4.
- **Observability backends**: Log/metrics export targets. Adapter contract deferred to Layer 4.

Beyond these, new adapter types will emerge as The Engineer's capabilities grow. Adding a new adapter type follows the same pattern as the five existing ones: define a contract extending the Universal Adapter Contract, register the type in the Registry, and have the consuming Core component look it up. No changes to existing adapters or plugins are required. See [`architecture-tiers.md`](../1-system/architecture-tiers.md) § Extensibility by Design and Decision #64.

---

## Cross-Cutting: How Adapters Connect to the Action Pipeline

The Action Pipeline (see [`event-catalog.md`](event-catalog.md) § Action Pipeline) gates all side-effect actions. Here's how each adapter type relates to the pipeline:

| Adapter Type | Pipeline Role |
|-------------|--------------|
| **ToolAdapter** | Executor. Tools are called during the Execute phase. Their `action_classes` declaration feeds Gate 1 (Task Engine permission check). |
| **GitHostingAdapter** | Executor. Called by Workspace Manager during Execute phase for PR/merge operations. Declares `action_classes: ["git-remote", "merge"]` in contract, feeding Gate 1. |
| **LLMAdapter** | Not gated. LLM calls are read-only reasoning operations. Cost is tracked post-call via `cost.incurred` events, not pre-gated. |
| **CommunicationAdapter** | Executor for outbound messages (action class: `communicate`, `ask-human`). Inbound messages bypass the pipeline (they're external input, not agent actions). |
| **TriggerAdapter** | Not gated. Trigger polling is Daemon infrastructure, not agent actions. New work flows through task creation, which IS gated. |

---

## Open Questions for Layer 4

- ~~Plugin packaging format (npm packages, Python packages, standalone binaries, in-process modules?)~~ **Resolved:** In-process TypeScript modules with `engineer.plugin.yaml` manifest and factory function export. Decision #102, #103. See [`../4-implementation/plugins.md`](../4-implementation/plugins.md).
- ~~Plugin discovery beyond explicit registration (auto-discovery from a plugins directory?)~~ **Resolved:** Registry scans configurable directories recursively for `engineer.plugin.yaml` files. Decision #103.
- Plugin versioning and compatibility enforcement (semver ranges? API version negotiation?)
- ~~Secret management implementation (env vars, vault, encrypted config?)~~ **Resolved:** Env vars via `${ENV_VAR_NAME}` syntax in config files, resolved at load time. Decision #96.
- Plugin sandboxing (should plugins run in isolated processes for fault isolation?) — Deferred. V1 plugins run in-process. Process safety rules (Decision #108) mitigate risks.
- ~~Config file format (YAML, TOML, JSON) for People Directory and plugin configuration~~ **Resolved:** YAML. Decision #90.
- ~~Fallback chains: when primary communication plugin fails, should the system automatically try the next one?~~ **Resolved:** Yes. People Directory `contacts[]` is an ordered list per person. System tries channels in order. See [`error-propagation.md`](error-propagation.md) § 5 and Decision #55.
