# Plugin Contracts -- Layer 3

Every plugin type's interface contract. What plugins must implement, how they register, how they interact with the skeleton. This is the authoritative reference for building plugins -- if a method isn't here, the skeleton doesn't call it.

Part of **Layer 3** -- see [`layers.md`](../layers.md). Built on plugin types defined in [`overview.md`](../1-system/overview.md) and the comm plugin pattern established in [`comm-plugins.md`](../2-components/comm-plugins.md).

---

## Modularity Through Independent Adapters

**The Engineer is the core. Everything that varies is plugin-able through adapters.**

Each plugin is an independent adapter -- one plugin per functionality, independently registrable and replaceable. This is the foundation of The Engineer's open-source accessibility: anyone can plug in exactly the modules they need.

### The Mix-and-Match Principle

A user who wants GitHub for issue tracking, GitLab for code hosting, and Slack for communication registers three separate plugins. No coupling between them. Removing one has zero impact on the others.

GitHub provides **three separate plugins**: GitHubTriggerPlugin, GitHubCommPlugin, GitHubHostingPlugin. Each registers independently. Each is replaceable independently. Switching from GitHub Issues to Linear for triggers? Swap one plugin. Everything else stays.

### Why One Plugin Per Adapter

- **Separation of concerns** -- each plugin does one thing well
- **Independent lifecycle** -- register, update, or remove any plugin without touching others
- **Combinatorial freedom** -- N trigger plugins x M comm plugins x P hosting plugins = N*M*P valid configurations
- **Simpler contracts** -- each contract is focused and testable
- **Lower barrier to contribution** -- building a Slack comm plugin doesn't require understanding trigger or hosting interfaces

This is the adapter pattern applied at the integration boundary. The skeleton defines the contracts. Plugins implement one contract each. Mix and match freely.

---

## Universal Plugin Contract

Every plugin, regardless of type, implements this base contract. The skeleton interacts with all plugins through this common interface for lifecycle management.

```
Plugin {
  -- Identity --
  manifest:        PluginManifest

  -- Lifecycle --
  initialize(config: object) -> InitResult
  healthCheck() -> HealthStatus
  shutdown() -> void
}

PluginManifest {
  id:              string          // Unique identifier: "github-trigger", "telegram-comm", "claude-code-llm"
  type:            PluginType      // "trigger" | "comm" | "llm_provider" | "tool" | "git_hosting"
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

### Plugin Error Contract

All plugins report errors in a common format. This allows the skeleton to handle errors uniformly regardless of plugin type.

```
PluginError {
  code:            string          // Plugin-defined error code: "auth_failed", "rate_limited", "timeout"
  message:         string          // Human-readable error message
  retryable:       boolean         // Can this operation be retried?
  retry_after:     duration?       // Suggested wait time before retry (null if not retryable)
  severity:        "warning" | "error" | "fatal"
                                   // warning: degraded but operational
                                   // error: operation failed, plugin still usable
                                   // fatal: plugin unusable, needs reinitialization
}
```

### Plugin Criticality

The `critical` field in the manifest determines startup behavior. If a critical plugin fails `initialize()`, the system aborts startup (P1 step 3, error-propagation Pattern 6: Graceful-halt). Non-critical plugins that fail init are logged and skipped -- the system starts in degraded mode.

Defaults: trigger plugins and the primary comm plugin are critical (the system can't function without work intake and human communication). Secondary comm plugins, tool plugins, and additional LLM providers are non-critical by default. The `critical` field can be overridden in configuration.

### Standard Error Codes

Plugins define error codes in `PluginError.code`. These common codes allow the skeleton to handle errors uniformly:

| Code | Meaning | Retryable? |
|------|---------|-----------|
| `auth_failed` | Authentication/authorization failure | No (needs reinitialization) |
| `rate_limited` | External API rate limit hit | Yes (respect `retry_after`) |
| `timeout` | Operation timed out | Yes |
| `network_error` | Network connectivity failure | Yes |
| `not_found` | Requested resource doesn't exist | No |
| `conflict` | Conflicting state (e.g., concurrent modification) | Depends on context |
| `invalid_input` | Bad parameters passed to plugin | No |

Plugin-type-specific codes:

| Code | Plugin Type | Meaning |
|------|------------|---------|
| `merge_conflict` | git-hosting | PR has merge conflicts |
| `branch_not_found` | git-hosting | Branch deleted or doesn't exist |
| `pr_not_mergeable` | git-hosting | Protection requirements not met |
| `context_exceeded` | LLM | Prompt exceeds max context window |
| `quota_exhausted` | LLM | Provider quota or budget exhausted |

Plugins may define additional codes beyond these. The common codes are conventions, not an exhaustive enum.

### Configuration Contract

Each plugin declares its configuration schema in the manifest (`config_schema`). The Registry validates configuration against this schema at registration time.

- **Plugins never read configuration directly** -- they receive validated config via `initialize(config)`
- **Config hot-reload**: Registry can call `shutdown()` then `initialize(new_config)` for config changes
- **Secrets**: Sensitive values (API keys, tokens) are referenced by name, resolved by the skeleton's secret manager. Plugins receive resolved values, never secret references.

### Behavior During Event Bus Outage

Plugins do not emit events themselves -- the skeleton emits events post-action (e.g., after `sendMessage()` succeeds, the skeleton emits `comm.message_sent`). When the Event Bus goes down, plugins continue responding to direct calls (`healthCheck()`, `sendMessage()`, etc.) normally. The skeleton detects Event Bus failure and invokes Graceful-halt -- checkpointing active tasks and stopping new work (Decision #53). See [`error-propagation.md`](error-propagation.md) Chain 2.

---

## Registry

The Registry is a **skeleton** component (not a plugin). It manages all plugin registration, discovery, and lifecycle. Every plugin interacts with the system through the Registry.

**Derived from:** Service registries (Consul, Eureka, Kubernetes service discovery) -- discovery, health, lifecycle management.

```
Registry {
  -- Registration --
  register(manifest: PluginManifest, instance: Plugin) -> RegistrationResult
  deregister(plugin_id: string) -> void

  -- Discovery --
  getPlugin(type: PluginType, id: string) -> Plugin?
  getPluginsByType(type: PluginType) -> Plugin[]
  getPrimaryPlugin(type: PluginType) -> Plugin?

  -- Lifecycle --
  initializeAll() -> void         // Called at system startup, initializes all registered plugins
  shutdownAll() -> void           // Called at system shutdown
  healthCheckAll() -> HealthReport[]

  -- Hot-swap --
  replace(plugin_id: string, new_manifest: PluginManifest, new_instance: Plugin) -> RegistrationResult
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

When multiple plugins of the same type exist (e.g., two comm plugins: Telegram + Slack), one is designated **primary**. The primary is used when a specific plugin isn't specified by the caller:

- Primary designation is configuration, not code: `primary: true` in the plugin's config
- Only one primary per type. If none designated, the first registered is primary.
- Primary is a convenience default, not an exclusion -- callers can always request a specific plugin by ID.

### Plugin Type Registry

The Registry maintains separate indexes by plugin type. Discovery queries return only plugins of the requested type. This keeps lookups fast and prevents type confusion.

---

## Trigger Plugin Contract

Trigger plugins discover new work from external sources and feed it into the system. The Daemon polls trigger plugins on their declared interval.

**Derived from:** Webhook receivers, message queue consumers, polling adapters.

Reference: [`daemon-scheduler.md`](../2-components/daemon-scheduler.md) § Trigger Polling for how the Daemon manages trigger plugins.

```
TriggerPlugin extends Plugin {
  poll_interval:   duration        // How often the Daemon should poll: 30s, 60s, etc.
  poll() -> TriggerEvent[]
}

TriggerEvent {
  idempotency_key: string          // Stable, unique dedup key: "github:issue:owner/repo:47"
  source:          string          // This plugin's ID
  event_type:      string          // "issue_opened", "issue_assigned", "manual_create"
  external_ref:    string          // URL or ID of the external item
  title:           string          // Task title derived from trigger
  body:            string?         // Description/body from external source
  repo:            string          // Target repo
  metadata:        object?         // Source-specific data (labels, assignees, milestones, etc.)
}
```

### Behavioral Contract

- **Idempotency keys MUST be stable**: The same external item must always produce the same key. The Daemon deduplicates using these keys. Unstable keys cause duplicate tasks.
- **`poll()` returns only new items**: The plugin tracks its own watermark (last seen ID, last poll timestamp, etc.) and returns only items the Daemon hasn't seen.
- **Errors are surfaced, not swallowed**: If the external API fails, the plugin throws a `PluginError`. The Daemon manages consecutive failure counting and health alerts (`health.trigger_failure` events).
- **`poll_interval` is a contract, not a suggestion**: The Daemon respects it. Plugins should set it based on the external API's rate limits and expected event frequency.
- **`poll()` must be fast**: No heavy processing. Return raw data, let the Daemon and Task Engine handle interpretation.

### Event Types and Metadata Schemas

The `event_type` field in `TriggerEvent` is open-ended -- plugins can define new types. These are the canonical types the skeleton understands:

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

### Implementations

| Plugin | Source | Notes |
|--------|--------|-------|
| GitHubIssuesTrigger | GitHub Issues API | Polls for new/assigned issues and PR reviews. Key: `github:issue:{owner}/{repo}:{number}` or `github:review:{owner}/{repo}:{pr}:{review_id}` |
| ManualTrigger | CLI / API | Accepts manual task creation. Key: `manual:{timestamp}:{title_hash}` |
| *(future)* JiraTrigger | Jira REST API | Polls for assigned tickets |
| *(future)* LinearTrigger | Linear API | Polls for assigned issues |

---

## Comm Plugin Contract

Comm plugins are the Engineer's voice -- how it communicates with humans through external platforms. They are dumb transport: the Orchestrator owns all intelligence (what to say, when). Comm plugins handle the mechanical platform interaction.

**Derived from:** Chat bot adapters, notification gateway patterns, webhook receivers.

Reference: [`comm-plugins.md`](../2-components/comm-plugins.md) for the full Layer 2 design including ownership boundaries, state sync, and query routing.

```
CommPlugin extends Plugin {
  capabilities:    string[]        // Subset of: "send", "receive", "query", "sync"

  -- Outbound --
  sendMessage(target: Target, message: FormattedMessage) -> SendResult
  formatMessage(content: string, type: MessageType) -> string

  -- Inbound (if "receive" capability) --
  startListening() -> void         // Begin receiving messages (webhook server, long-poll, etc.)
  stopListening() -> void          // Stop receiving messages

  -- State Sync (if "sync" capability) --
  syncTaskState(task_id: string, old_state: string, new_state: string, metadata: SyncMetadata) -> void
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
  error:           PluginError?
}

SyncMetadata {
  task_title:      string          // Human-readable task title
  external_ref:    string?         // GitHub issue URL, Jira ticket ID, etc.
  sub_state:       string?         // Sub-state if applicable (e.g., "Demo", "Code" for Review-Pending)
  reason:          string?         // Why the transition happened (for milestone comments)
}

InboundMessage {
  source:          string          // Comm plugin ID that received the message
  sender:          string          // User identifier on the platform
  content:         string          // Raw message text
  timestamp:       datetime
  reply_to:        string?         // If replying to a previous outbound message
  platform_metadata: object        // Platform-specific data (chat_id, thread_id, etc.)
}
```

### Inbound Message Delivery

When a comm plugin receives a message from a human, it wraps it in an `InboundMessage` and emits a `comm.message_received` event on the Event Bus. The Daemon picks this up and routes it (to query handler or to Orchestrator via dispatch).

The plugin does NOT interpret the message -- it delivers it raw. Interpretation is the Daemon's job (keyword matching for status queries) or the Orchestrator's job (task-related responses). Plugins must not queue messages -- if the plugin is down, messages during downtime are lost. The timeout ladder (P11) handles re-delivery.

### Platform-Specific Extensions

Comm plugins that support GitHub-style platforms provide additional methods for issue/PR interaction. These are optional capabilities beyond the base contract:

```
GitHubCommPlugin extends CommPlugin {
  commentOnIssue(repo: string, issue_number: number, comment: string) -> void
  createIssue(repo: string, options: IssueOptions) -> IssueResult
  updateIssue(repo: string, issue_number: number, updates: IssueUpdates) -> void

  -- State Reconciliation (called once on recovery from outage) --
  reconcileState(tasks: TaskReconciliationInput[]) -> ReconciliationResult
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

**State reconciliation** (`reconcileState`): Called once by the skeleton (Daemon, via P15 step 15) when the GitHubCommPlugin recovers from an outage. The skeleton gathers current task states from the Task Engine and passes them to the plugin. The plugin compares expected labels/comments against GitHub's actual state, fixes mismatches (adds missing labels, posts catch-up comments for missed milestones). Reconciliation is idempotent -- safe to call multiple times. See Decision #58.

> **Terminology:** "State sync" (`syncTaskState`) is reactive -- called on every `task.state_changed` event during normal operation. "State reconciliation" (`reconcileState`) is proactive -- called once after an outage to catch up on missed sync events. Both achieve the same end state; reconciliation is the batch equivalent of sync.

### Capability-Based Loading

Not every comm plugin supports every capability:

| Capability | Meaning | Example plugins |
|-----------|---------|-----------------|
| `send` | Can send outbound messages | All plugins |
| `receive` | Can receive inbound messages from humans | Telegram, Slack, GitHub |
| `query` | Persistent connection for real-time status queries | Telegram, Slack |
| `sync` | Can sync internal state to platform representation | GitHub (labels, project boards) |

A Telegram plugin supports "send", "receive", and "query" but not "sync" (no label/issue concept). A GitHub comm plugin supports all four. The skeleton checks capabilities before calling optional methods.

### State Sync via Event Bus

Comm plugins with the `"sync"` capability subscribe to `task.state_changed` events on the Event Bus at registration time. The skeleton does NOT call `syncTaskState()` directly -- the plugin handles sync autonomously. When the plugin receives a `task.state_changed` event, it invokes its own `syncTaskState()` internally to update the external platform (labels, comments, project boards).

This keeps sync logic inside the plugin and decouples the skeleton from platform-specific sync details. The skeleton only emits events; the plugin decides how to represent state changes on its platform. See [`comm-plugins.md`](../2-components/comm-plugins.md) § GitHub State Sync and [`event-catalog.md`](event-catalog.md) § `task.state_changed` subscribers.

### Fallback Chain Mechanics

When a `sendMessage()` call fails (after retries per `PluginError.retry_after`), the skeleton -- not the plugin -- drives fallback to alternative channels.

**Flow:**
1. Skeleton resolves first contact from People Directory `contacts[]` (ordered list per person, Decision #55)
2. Calls `sendMessage()` on that channel's comm plugin
3. On failure (retries exhausted), resolves next contact in `contacts[]`
4. Calls `sendMessage()` on the next channel's comm plugin
5. Repeat until success or all channels exhausted

Plugins are unaware of fallback -- they simply send or fail. Each `sendMessage()` call is independent; the plugin doesn't know it's a fallback attempt.

**Exception -- `timeout.alert` (48hr escalation):** ALL configured channels for the person are tried in parallel (best-effort on every channel), not sequential fallback. This is the last-resort escalation.

See [`error-propagation.md`](error-propagation.md) § 5 Comm Plugin Error Handling for the full error chain.

### Implementations

| Plugin | Platform | Capabilities | Notes |
|--------|----------|-------------|-------|
| TelegramCommPlugin | Telegram Bot API | send, receive, query | Real-time notifications, questions, and status queries |
| GitHubCommPlugin | GitHub API | send, receive, sync | Issue comments, label sync, checklist management, state reconciliation |
| *(future)* SlackCommPlugin | Slack API | send, receive, query | Channel/DM messaging |
| *(future)* EmailCommPlugin | SMTP/IMAP | send | Email notifications (no real-time receive) |

---

## LLM Provider Plugin Contract

LLM provider plugins are the Engineer's thinking engine. They execute reasoning, code generation, analysis, and all LLM-powered operations. The Orchestrator interacts with LLM providers exclusively through this contract.

**Derived from:** API gateway patterns, multi-backend abstraction layers.

Reference: [`safety-layer.md`](../2-components/safety-layer.md) § Cost Tracking for the two provider models and cost event schema.

```
LLMProvider extends Plugin {
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

**Every `CompletionResult` MUST include usage data.** This is non-negotiable -- it is the bridge between LLM providers and the Safety Layer's cost tracking system.

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
| Rate limited | Yes | Respect `retry_after`. Report via `PluginError`. |
| Context window exceeded | No | Orchestrator must reduce prompt size. |
| Provider down | Yes | Report via `PluginError`. Daemon may switch to fallback provider. |
| Auth failure | No | Fatal error. Plugin needs reinitialization with new credentials. |
| Malformed response | Yes | Retry once. If persistent, report error. |

### Provider Failover

Provider priority is user configuration -- an ordered list of LLM providers in the system config (not the plugin manifest). The Daemon owns switching logic; plugins are unaware of failover.

When a provider returns a fatal `PluginError` (auth failure, prolonged downtime), the Daemon switches the active provider to the next in the priority list. If the provider fails mid-completion, the same prompt is retried on the next provider. The Orchestrator sees a transparent switch -- it calls `complete()` through the skeleton, which routes to whichever provider is currently active. Cost tracking updates automatically (events reference the new `provider_id`). The human is notified of the switch. See Decision #54.

### Implementations

| Plugin | Type | Provider | Notes |
|--------|------|----------|-------|
| ClaudeCodeProvider | cli | Claude Code CLI | Spawns `claude` process, parses streaming output |
| OpenRouterProvider | api | OpenRouter API | Multi-model routing, dollar-based billing |
| *(future)* GeminiCLIProvider | cli | Gemini CLI | Similar to Claude Code |
| *(future)* OllamaProvider | api | Ollama (local) | Local models, zero cost (usage still tracked for metrics) |

---

## Tool Plugin Contract

Tool plugins are the Engineer's hands -- how it interacts with the world beyond thinking. Following PI-Inspired Minimalism: few broad tools, not many narrow ones. Bash is the meta-tool.

**Derived from:** Unix tool philosophy (small, composable), agent tool-use patterns.

```
ToolPlugin extends Plugin {
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
  error:           PluginError?    // Populated if success is false
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

A single tool can exercise multiple action classes (e.g., BashTool exercises `read`, `write`, `test`, `git-local` depending on the command). The pipeline checks the action class of the specific operation, not all classes the tool could theoretically exercise.

### Side Effects Reporting

Tools MUST report side effects in every `ToolResult`. This is how the system maintains awareness of what changed:

- The Orchestrator uses side effects for journal entries ("Modified 3 files in src/auth/")
- The Session/Memory system uses side effects for checkpoint integrity
- The Safety Layer uses side effects for scope validation (did the tool write outside the allowed directory?)

Read-only tools (action class `read`) return empty side effects arrays.

### Self-Extension

Following PI philosophy, the agent can create new tool plugins at runtime. The Orchestrator builds a new `ToolPlugin` implementation, registers it with the Registry via dynamic registration, and uses it immediately. The Action Pipeline still gates all operations -- self-extension does not bypass safety.

Runtime-created tools are ephemeral (not persisted across restarts) unless the Orchestrator also persists them as code in the repo.

### Implementations

| Plugin | Action Classes | Notes |
|--------|---------------|-------|
| BashTool | read, write, test, git-local | The meta-tool. Composes complex operations from primitives. |
| FileOpsTool | read, write | Structured file operations (read, write, search, glob) |
| WebSearchTool | read | Web search and fetch |
| *(self-extended)* | varies | Agent creates as needed at runtime |

---

## Git-Hosting Plugin Contract

Git-hosting plugins abstract the code hosting platform's API for PR lifecycle, branch protection queries, and merge operations. The Workspace Manager is the primary consumer of this contract.

**Fully separate from Comm plugins** -- different capability domain. GitHub implements both contracts as separate plugins (GitHubCommPlugin for communication, GitHubHostingPlugin for code hosting).

**Derived from:** Git forge APIs (GitHub, GitLab, Bitbucket), abstract VCS interfaces.

Reference: [`workspace-manager.md`](../2-components/workspace-manager.md) § PR Management for how the Workspace Manager calls these operations. Resolves the open question from `workspace-manager.md` line 587: "How does the git hosting plugin interface work for GitLab, Bitbucket?"

```
GitHostingPlugin extends Plugin {
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
  error:           PluginError?    // "merge conflicts", "branch protection failed", etc.
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

### Implementations

| Plugin | Platform | Notes |
|--------|----------|-------|
| GitHubHostingPlugin | GitHub REST/GraphQL API | Full support for all contract methods |
| *(future)* GitLabHostingPlugin | GitLab API | MRs map to PRs, pipeline status maps to checks |
| *(future)* BitbucketHostingPlugin | Bitbucket API | Pull requests, build status |

---

## People Directory

The People Directory is a **skeleton** component (not a plugin). It is always present, config-driven, and does not register in the Registry. It maps people to roles, contact channels, and preferences.

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
  channel:         string          // Comm plugin ID: "telegram", "github", "slack", "email"
  handle:          string          // Platform-specific: "@farzam", "farzam@github", "farzam@example.com"
}

ContactInfo {
  channel:         string
  handle:          string
  plugin_id:       string          // Registry ID of the comm plugin that handles this channel
}
```

### How Components Use People Directory

| Component | Usage |
|-----------|-------|
| **Orchestrator** | Looks up who to notify (task.team references). Resolves contact info before sending messages via comm plugins. |
| **Task Engine** | Populates `task.team[]` from People Directory when task is created (based on repo config and roles). |
| **Comm Plugins** | `resolveContact` maps a person + channel to the specific comm plugin and platform handle needed to reach them. |
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

## Plugin Type Summary

| Type | Contract | Consumer(s) | Skeleton/Plugin |
|------|----------|-------------|-----------------|
| Trigger | TriggerPlugin | Daemon | Plugin |
| Comm | CommPlugin | Orchestrator, Daemon | Plugin |
| LLM Provider | LLMProvider | Orchestrator | Plugin |
| Tool | ToolPlugin | Orchestrator | Plugin |
| Git Hosting | GitHostingPlugin | Workspace Manager | Plugin |
| Registry | -- (is the infrastructure) | All plugins | Skeleton |
| People Directory | -- (query interface) | Orchestrator, Task Engine, Comm Plugins, Daemon | Skeleton |

### Plugin Types from `overview.md` Not Covered Here

Two plugin types listed in [`overview.md`](../1-system/overview.md) are not contracted in this document:

- **Workflow phases**: These are Orchestrator-internal (phase pipeline is Orchestrator's design). Plugin contract deferred to Layer 4 when we specify how phases are loaded/configured.
- **Observability backends**: Log/metrics export targets. Plugin contract deferred to Layer 4 when we specify the observability stack.

Both are acknowledged as future plugin types. Their contracts will be simpler (data sink patterns) and don't affect other components' designs.

---

## Cross-Cutting: How Plugins Connect to the Action Pipeline

The Action Pipeline (see [`event-catalog.md`](event-catalog.md) § Action Pipeline) gates all side-effect actions. Here's how each plugin type relates to the pipeline:

| Plugin Type | Pipeline Role |
|-------------|--------------|
| **Tool** | Executor. Tools are called during the Execute phase. Their `action_classes` declaration feeds Gate 1 (Task Engine permission check). |
| **Git Hosting** | Executor. Called by Workspace Manager during Execute phase for PR/merge operations. Declares `action_classes: ["git-remote", "merge"]` in contract, feeding Gate 1. |
| **LLM Provider** | Not gated. LLM calls are read-only reasoning operations. Cost is tracked post-call via `cost.incurred` events, not pre-gated. |
| **Comm** | Executor for outbound messages (action class: `communicate`, `ask-human`). Inbound messages bypass the pipeline (they're external input, not agent actions). |
| **Trigger** | Not gated. Trigger polling is Daemon infrastructure, not agent actions. New work flows through task creation, which IS gated. |

---

## Open Questions for Layer 4

- Plugin packaging format (npm packages, Python packages, standalone binaries, in-process modules?)
- Plugin discovery beyond explicit registration (auto-discovery from a plugins directory?)
- Plugin versioning and compatibility enforcement (semver ranges? API version negotiation?)
- Secret management implementation (env vars, vault, encrypted config?)
- Plugin sandboxing (should plugins run in isolated processes for fault isolation?)
- Config file format (YAML, TOML, JSON) for People Directory and plugin configuration
- ~~Fallback chains: when primary comm plugin fails, should the system automatically try the next one?~~ **Resolved:** Yes. People Directory `contacts[]` is an ordered list per person. System tries channels in order. See [`error-propagation.md`](error-propagation.md) § 5 and Decision #55.
