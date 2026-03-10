# Plugin System & Adapter Implementation

How plugins are packaged, discovered, loaded, and implemented. This bridges the abstract adapter contracts from Layer 3 to concrete TypeScript patterns. Adopts three patterns from the [OpenClaw review](openclaw-review.md): plugin manifest as standalone file, plugin SDK as curated re-export, process safety hardening.

Part of **Layer 4** — see [`../layers.md`](../layers.md). Built on adapter contracts from [`../3-interactions/adapter-contracts.md`](../3-interactions/adapter-contracts.md), directory layout from [`layout.md`](layout.md), and schemas from [`schemas/`](schemas/).

---

## Plugin Manifest File

### Decision #102: `engineer.plugin.yaml` Per Plugin

Every plugin directory contains an `engineer.plugin.yaml` file — metadata separate from code. This file is the source of truth for plugin identity. The Registry reads manifests during discovery, before loading any plugin code.

**Why separate from code:**
- **Discovery without loading** — Registry can enumerate all plugins, check enabled state, validate manifests, without importing a single TypeScript module.
- **Enable/disable toggle** — `enabled: false` skips a plugin entirely. No code changes, no config changes. Quick debugging tool.
- **Config schema pre-validation** — The manifest's JSON Schema can validate user config before the plugin's code is even loaded.
- **Machine-readable metadata** — Version, type, criticality, and config shape are declarative. Future tooling (CLI `doctor` command, plugin marketplace) can read manifests directly.

### Manifest Format

```yaml
# src/plugins/trigger/github-trigger/engineer.plugin.yaml

# --- Universal fields (all plugins) ---
id: github-trigger                  # unique identifier, matches config file name
type: trigger                       # AdapterType: trigger | communication | llm | tool | git_hosting
version: "1.0.0"                   # semver
name: GitHub Issues Trigger         # human-readable
description: Polls GitHub Issues API for new and assigned issues
critical: true                      # abort startup on init failure?
enabled: true                       # discovery-time toggle
entry: index.ts                     # relative to plugin dir, default: index.ts

# --- Config schema (JSON Schema) ---
# Validates user config at ~/.engineer/config/plugins/github-trigger.yaml
# This is derived from the plugin's Zod schema (source of truth) via zod-to-json-schema
config_schema:
  type: object
  properties:
    repos:
      type: array
      items:
        type: object
        properties:
          owner: { type: string }
          name: { type: string }
          poll_interval: { type: string }
        required: [owner, name]
  required: [repos]

# --- Type-specific static metadata ---
adapter_meta:
  poll_interval: "30s"              # TriggerAdapter: default polling interval
```

### Manifest Fields

| Field | Type | Required | Default | Purpose |
|-------|------|----------|---------|---------|
| `id` | string | Yes | — | Unique identifier. Must match config file name (`plugins/{id}.yaml`). |
| `type` | AdapterType | Yes | — | Which adapter contract this plugin implements. |
| `version` | semver string | Yes | — | Plugin version. |
| `name` | string | Yes | — | Human-readable display name. |
| `description` | string | Yes | — | One-line description. |
| `critical` | boolean | No | `true` | If true, system startup aborts on init failure. |
| `enabled` | boolean | No | `true` | If false, plugin is skipped during discovery. |
| `entry` | string | No | `"index.ts"` | Relative path to the plugin's main module. |
| `config_schema` | JSON Schema | No | `{}` | Validates user config pre-load. Derived from Zod schema via `zod-to-json-schema`. |
| `adapter_meta` | object | No | `{}` | Type-specific static metadata (see below). |

### `adapter_meta` by Adapter Type

Type-specific metadata lives in the nested `adapter_meta` object, keeping universal fields clean.

| Adapter Type | `adapter_meta` Fields | Example |
|-------------|----------------------|---------|
| `trigger` | `poll_interval` (duration string) | `poll_interval: "30s"` |
| `communication` | `capabilities` (string[]) | `capabilities: ["send", "receive", "query"]` |
| `llm` | `provider_type` ("cli" \| "api") | `provider_type: "cli"` |
| `tool` | `action_classes` (string[]) | `action_classes: ["read", "write", "test", "git-local"]` |
| `git_hosting` | `action_classes` (string[]) | `action_classes: ["git-remote", "merge"]` |

### Config Schema Relationship

Two representations of each plugin's config schema, serving different purposes:

| | Zod Schema (in code) | JSON Schema (in manifest) |
|---|---|---|
| **Location** | `src/plugins/{type}/{name}/config.ts` | `engineer.plugin.yaml` `config_schema` field |
| **Source of truth?** | Yes — all runtime validation uses Zod | No — derived from Zod via `zod-to-json-schema` |
| **Used for** | Runtime validation during `initialize()` | Pre-load validation, documentation, tooling |
| **Type inference** | Yes — `z.infer<>` generates TypeScript types | No |

The Zod schema in plugin code is the authoritative config definition. The manifest's JSON Schema is a mirror that enables validation without loading code. The `zod-to-json-schema` package generates one from the other — no manual sync required.

### Example Manifests

**CommunicationAdapter (Telegram):**

```yaml
id: telegram-comm
type: communication
version: "1.0.0"
name: Telegram Communication
description: Send/receive messages via Telegram Bot API
critical: true
enabled: true
entry: index.ts

config_schema:
  type: object
  properties:
    bot_token: { type: string }
    allowed_chat_ids: { type: array, items: { type: number } }
  required: [bot_token]

adapter_meta:
  capabilities: ["send", "receive", "query"]
```

**LLMAdapter (Claude Code CLI):**

```yaml
id: claude-code-llm
type: llm
version: "1.0.0"
name: Claude Code CLI
description: LLM reasoning via Claude Code CLI process
critical: true
enabled: true
entry: index.ts

config_schema:
  type: object
  properties:
    model: { type: string }
    max_tokens: { type: number }

adapter_meta:
  provider_type: cli
```

**ToolAdapter (Bash):**

```yaml
id: bash-tool
type: tool
version: "1.0.0"
name: Bash Shell Tool
description: Execute shell commands in task workspace
critical: false
enabled: true
entry: index.ts

config_schema:
  type: object
  properties:
    max_output_bytes: { type: number }
    command_timeout_ms: { type: number }
    env_passthrough: { type: array, items: { type: string } }

adapter_meta:
  action_classes: ["read", "write", "test", "git-local"]
```

---

## Plugin Loading & Discovery

### Decision #103: Five-Phase Loading Sequence

The Registry discovers and loads plugins through five sequential phases. This aligns with the P1 System Startup protocol from [`../3-interactions/protocols.md`](../3-interactions/protocols.md).

```
Phase 1: Discover
  → Recursively scan plugin directories for engineer.plugin.yaml
  → Parse each manifest YAML
  → Skip enabled: false (log and move on)
  → Result: list of parsed manifests

Phase 2: Validate
  → Unique ID enforcement (no duplicate id values)
  → Type validation (type must be known AdapterType)
  → Version format (must be valid semver)
  → Entry point existence (file must exist on disk)
  → Config schema structural validation (valid JSON Schema if present)
  → Invalid manifest = hard failure (startup aborted with clear error)

Phase 3: Order
  → Sort plugins by adapter type into initialization order:
     1. Communication (needed for error alerts during subsequent init)
     2. LLM (needed for Orchestrator)
     3. Tool (needed for Orchestrator)
     4. Git Hosting (needed for Workspace Manager)
     5. Trigger (last — produces events immediately, everything must be ready)
  → Within same type: alphabetical by id (deterministic)

Phase 4: Load
  → For each plugin in order:
     1. Dynamic import() of the entry module
     2. Module must export: createPlugin(): Adapter (factory function)
     3. Call factory to get plugin instance
     4. Inject parsed manifest into the instance (Registry owns manifest)

Phase 5: Initialize
  → For each loaded plugin in order:
     1. Load user config from ~/.engineer/config/plugins/{id}.yaml
        (missing file = empty config, validated against Zod defaults)
     2. Validate config against plugin's Zod schema (in code, not manifest)
     3. Resolve ${ENV_VAR} secrets in config values
     4. Call plugin.initialize(validatedConfig)
     5. On success: register in Registry, start health monitoring
     6. On failure:
        - critical: true → abort startup, print clear error
        - critical: false → log error, skip plugin, continue
```

### Discovery Path

Configurable via `plugins.dirs` in `daemon.yaml`. Default: `["src/plugins"]`.

```yaml
# daemon.yaml
plugins:
  dirs:
    - src/plugins              # built-in plugins (default)
    # - ~/.engineer/plugins    # future: user-installed plugins
```

The Registry scans each directory recursively for `engineer.plugin.yaml` files. Multiple directories are scanned in order — if the same `id` appears in multiple directories, the first-found wins (built-in takes precedence over user-installed).

### Plugin Directory Structure

Plugins are grouped by adapter type within each discovery directory:

```
src/plugins/
  trigger/
    github-trigger/
      engineer.plugin.yaml
      index.ts
      github-trigger.ts
      config.ts
  communication/
    telegram-comm/
      engineer.plugin.yaml
      index.ts
      telegram-comm.ts
      config.ts
    github-comm/
      engineer.plugin.yaml
      index.ts
      github-comm.ts
      config.ts
  llm/
    claude-code-llm/
      engineer.plugin.yaml
      index.ts
      claude-code-llm.ts
      config.ts
  tool/
    bash-tool/
      engineer.plugin.yaml
      index.ts
      bash-tool.ts
      config.ts
  git-hosting/
    github-hosting/
      engineer.plugin.yaml
      index.ts
      github-hosting.ts
      config.ts
```

The grouping is purely organizational — the Registry discovers plugins by scanning for `engineer.plugin.yaml` files recursively, regardless of directory nesting. The adapter type subdirectories mirror the adapter contracts in `src/adapters/`, making the relationship between contracts and implementations visually clear.

### Initialization Order Rationale

The type-based ordering derives from architectural invariants (P1 steps 2-3), not plugin preferences:

| Order | Type | Why |
|-------|------|-----|
| 1 | Communication | Error alerts during subsequent plugin initialization need a communication channel. If an LLM plugin fails to init, we need to alert the human. |
| 2 | LLM | Orchestrator needs LLM access before it can process any work. |
| 3 | Tool | Orchestrator needs tools to execute tasks. |
| 4 | Git Hosting | Workspace Manager needs hosting API before creating PRs. |
| 5 | Trigger | Triggers produce work events immediately on first poll. Everything downstream must be ready before triggers start. |

Plugins do NOT declare dependencies on each other — that would violate the one-plugin-per-adapter independence principle (Decision #43). The ordering is hardcoded in the Registry because it's an architectural invariant.

### Manifest Ownership

The YAML manifest is the source of truth for plugin identity. The plugin code does NOT carry its own manifest. During Phase 4 (Load), the Registry injects the parsed manifest into the plugin instance via BaseAdapter. This eliminates cross-validation problems (what if code says `id: "foo"` but YAML says `id: "bar"`?).

---

## Adapter Implementation Patterns

### Decision #104: Abstract Class Hierarchy

Adapter contracts are implemented as abstract classes, not bare TypeScript interfaces. This provides shared implementation, runtime type checking, and the template method pattern for lifecycle management.

```
BaseAdapter (abstract)
  ├── TriggerAdapter (abstract)
  ├── CommunicationAdapter (abstract)
  ├── LLMAdapter (abstract)
  ├── ToolAdapter (abstract)
  └── GitHostingAdapter (abstract)
```

### BaseAdapter

The base class for all adapters. Lives in `src/adapters/base.ts`.

```typescript
abstract class BaseAdapter {
  // --- Identity (injected by Registry, not set by plugin) ---
  manifest!: PluginManifest;

  // --- Capability check ---
  hasCapability(capability: string): boolean {
    const caps = this.manifest.adapter_meta?.capabilities;
    return Array.isArray(caps) && caps.includes(capability);
  }

  // --- Lifecycle (template method pattern) ---

  async initialize(config: object): Promise<InitResult> {
    const start = Date.now();
    try {
      const result = await this.doInitialize(config);
      // Log: "Plugin {id} initialized in {elapsed}ms"
      return result;
    } catch (error) {
      return { success: false, message: String(error) };
    }
  }

  async shutdown(): Promise<void> {
    try {
      await this.doShutdown();
    } catch {
      // Log: "Plugin {id} shutdown error (non-fatal)"
    }
  }

  // --- Plugin authors implement these ---
  protected abstract doInitialize(config: object): Promise<InitResult>;
  protected abstract doShutdown(): Promise<void>;
  abstract healthCheck(): Promise<HealthStatus>;
}
```

**What BaseAdapter provides:**
- `manifest` storage (injected by Registry after factory call)
- `hasCapability()` — checks `adapter_meta.capabilities` array
- Template method for `initialize()` — wraps `doInitialize()` with timing, logging, and error catching
- Template method for `shutdown()` — wraps `doShutdown()` with error swallowing (shutdown should not throw)
- Plugin authors override `doInitialize()`, `doShutdown()`, and `healthCheck()`

**Why abstract classes over interfaces:**
- **Shared implementation** — manifest storage, hasCapability(), and template methods are written once
- **Runtime `instanceof`** — Registry uses `instanceof TriggerAdapter` for type-safe plugin retrieval
- **Template method pattern** — initialize/shutdown wrappers guarantee timing, logging, and error handling without relying on each plugin to implement them
- **Single inheritance is fine** — Decision #43 (one plugin per adapter) means a plugin never needs to implement two adapter types

### Adapter Abstract Classes

Each adapter type extends BaseAdapter with its contract methods. These live in `src/adapters/{type}.ts`.

**TriggerAdapter:**

```typescript
abstract class TriggerAdapter extends BaseAdapter {
  abstract poll(): Promise<TriggerEvent[]>;
}
```

**CommunicationAdapter:**

```typescript
abstract class CommunicationAdapter extends BaseAdapter {
  // --- Required (all communication adapters) ---
  abstract sendMessage(target: Target, message: FormattedMessage): Promise<SendResult>;
  abstract formatMessage(content: string, type: MessageType): string;

  // --- Optional (capability-gated) ---
  // Core checks hasCapability() before calling these

  // "receive" capability
  startListening?(): Promise<void>;
  stopListening?(): Promise<void>;

  // "sync" capability
  syncTaskState?(task_id: string, old_state: string, new_state: string, metadata: SyncMetadata): Promise<void>;
  reconcileState?(tasks: TaskReconciliationInput[]): Promise<ReconciliationResult>;

  // "issue_management" capability
  commentOnIssue?(repo: string, issue_number: number, comment: string): Promise<void>;
  createIssue?(repo: string, options: IssueOptions): Promise<IssueResult>;
  updateIssue?(repo: string, issue_number: number, updates: IssueUpdates): Promise<void>;
}
```

**LLMAdapter:**

```typescript
abstract class LLMAdapter extends BaseAdapter {
  abstract complete(request: CompletionRequest): Promise<CompletionResult>;
  abstract getCapabilities(): LLMCapabilities;
}
```

**ToolAdapter:**

```typescript
abstract class ToolAdapter extends BaseAdapter {
  abstract describe(): ToolDescription;
  abstract execute(action: string, params: object): Promise<ToolResult>;
}
```

**GitHostingAdapter:**

```typescript
abstract class GitHostingAdapter extends BaseAdapter {
  abstract createPR(options: PROptions): Promise<PRResult>;
  abstract updatePR(repo: string, pr_number: number, updates: PRUpdates): Promise<void>;
  abstract mergePR(repo: string, pr_number: number, strategy: MergeStrategy): Promise<MergeResult>;
  abstract closePR(repo: string, pr_number: number): Promise<void>;
  abstract getPRStatus(repo: string, pr_number: number): Promise<PRStatus>;
  abstract getReviewStatus(repo: string, pr_number: number): Promise<ReviewStatus>;
  abstract commentOnPR(repo: string, pr_number: number, comment: string, reply_to?: string): Promise<CommentResult>;
  abstract getBranchProtection(repo: string, branch: string): Promise<BranchProtection>;
  abstract getDefaultBranch(repo: string): Promise<string>;
}
```

### What a Concrete Plugin Looks Like

A complete plugin has 3-4 files:

```
src/plugins/trigger/github-trigger/
  engineer.plugin.yaml            # manifest (source of truth for identity)
  index.ts                        # factory function export
  github-trigger.ts               # class extending TriggerAdapter
  config.ts                       # Zod config schema (source of truth)
```

**`index.ts`** — Factory function:

```typescript
import { TriggerAdapter } from "../../../adapters/index.ts";
import { GitHubTriggerPlugin } from "./github-trigger.ts";

export function createPlugin(): TriggerAdapter {
  return new GitHubTriggerPlugin();
}
```

**`config.ts`** — Zod config schema (source of truth):

```typescript
import { z } from "zod";

const RepoConfigSchema = z.object({
  owner: z.string(),
  name: z.string(),
  poll_interval: z.string().default("30s"),  // parsed by config loader via ms package
});

export const GitHubTriggerConfigSchema = z.object({
  repos: z.array(RepoConfigSchema),
});

export type GitHubTriggerConfig = z.infer<typeof GitHubTriggerConfigSchema>;
```

**`github-trigger.ts`** — Implementation:

```typescript
import { TriggerAdapter, type TriggerEvent, type InitResult, type HealthStatus } from "../../../adapters/index.ts";
import { type GitHubTriggerConfig } from "./config.ts";

export class GitHubTriggerPlugin extends TriggerAdapter {
  private config!: GitHubTriggerConfig;
  private lastPollTimestamps = new Map<string, string>();

  protected async doInitialize(config: object): Promise<InitResult> {
    this.config = config as GitHubTriggerConfig;  // already validated by Registry
    // Verify GitHub API access...
    return { success: true, message: null };
  }

  protected async doShutdown(): Promise<void> {
    // Cleanup...
  }

  async healthCheck(): Promise<HealthStatus> {
    // Check GitHub API connectivity...
    return { healthy: true, message: "Connected to GitHub API", details: null };
  }

  async poll(): Promise<TriggerEvent[]> {
    const events: TriggerEvent[] = [];
    for (const repo of this.config.repos) {
      // Poll GitHub Issues API for new/assigned issues since last poll...
      // Construct TriggerEvent with stable idempotency keys...
    }
    return events;
  }
}
```

### Capability-Gated Method Pattern

For CommunicationAdapter's optional methods, Core components check capabilities before calling:

```typescript
// In Orchestrator or Daemon:
const commPlugin = registry.getPrimaryPlugin("communication");

if (commPlugin instanceof CommunicationAdapter && commPlugin.hasCapability("sync")) {
  // TypeScript knows syncTaskState exists because we checked capability
  await commPlugin.syncTaskState!(taskId, oldState, newState, metadata);
}
```

The `hasCapability()` check is a runtime guard. The `!` non-null assertion is safe because the capability check guarantees the method exists. This matches the Layer 3 design: "Core checks capabilities before calling optional methods."

---

## Plugin SDK Boundary

### Decision #105: `src/adapters/index.ts` as Curated Surface

`src/adapters/index.ts` is the single import point for everything a plugin author needs. This is the future `packages/plugin-sdk/` extraction point (see [`../future-considerations.md`](../future-considerations.md)).

### What It Exports

```typescript
// src/adapters/index.ts

// === Adapter Base ===
export { BaseAdapter } from "./base.ts";

// === Adapter Contracts ===
export { TriggerAdapter } from "./trigger.ts";
export { CommunicationAdapter } from "./communication.ts";
export { LLMAdapter } from "./llm.ts";
export { ToolAdapter } from "./tool.ts";
export { GitHostingAdapter } from "./git-hosting.ts";

// === Shared Types (from schemas) ===
export {
  // Universal
  PluginManifestSchema, type PluginManifest,
  AdapterTypeSchema, type AdapterType,
  InitResultSchema, type InitResult,
  HealthStatusSchema, type HealthStatus,
  AdapterErrorSchema, type AdapterError,
  AdapterErrorSeveritySchema,

  // Trigger
  TriggerEventSchema, type TriggerEvent,

  // Communication
  TargetSchema, type Target,
  FormattedMessageSchema, type FormattedMessage,
  SendResultSchema, type SendResult,
  MessageTypeSchema, type MessageType,
  InboundMessageSchema, type InboundMessage,
  SyncMetadataSchema, type SyncMetadata,
  IssueOptionsSchema, type IssueOptions,
  IssueResultSchema, type IssueResult,
  IssueUpdatesSchema, type IssueUpdates,
  TaskReconciliationInputSchema, type TaskReconciliationInput,
  ReconciliationResultSchema, type ReconciliationResult,

  // LLM
  CompletionRequestSchema, type CompletionRequest,
  CompletionResultSchema, type CompletionResult,
  LLMCapabilitiesSchema, type LLMCapabilities,

  // Tool
  ToolDescriptionSchema, type ToolDescription,
  ToolResultSchema, type ToolResult,
  SideEffectSchema, type SideEffect,
  SideEffectTypeSchema,

  // Git Hosting
  PROptionsSchema, type PROptions,
  PRResultSchema, type PRResult,
  PRUpdatesSchema, type PRUpdates,
  MergeResultSchema, type MergeResult,
  MergeStrategySchema, type MergeStrategy,
  PRStatusSchema, type PRStatus,
  ReviewStatusSchema, type ReviewStatus,
  ReviewerStateSchema, type ReviewerState,
  CommentResultSchema, type CommentResult,
  BranchProtectionSchema, type BranchProtection,
} from "../schemas/adapters.ts";

// === Event Payload Types (for plugins that need them) ===
export type { TaskStateChangedPayload } from "../schemas/events.ts";

// === Error Helpers ===
export { createAdapterError } from "./errors.ts";
```

### What It Does NOT Export

- **Core component internals** — Task Engine, Orchestrator, Daemon, Safety Layer, Event Bus, Session/Memory, Workspace Manager
- **Event Bus subscription APIs** — Plugins do not subscribe to events directly. The Core manages event routing.
- **Database access** — No direct SQLite access for plugins
- **Config system** — Loader, watcher, and config internals are Core-only

### New Files

**`src/adapters/base.ts`** — BaseAdapter abstract class (see § Adapter Implementation Patterns above).

**`src/adapters/errors.ts`** — Error helper for plugin authors:

```typescript
import { type AdapterError } from "../schemas/adapters.ts";

export function createAdapterError(
  code: string,
  message: string,
  options?: {
    retryable?: boolean;
    retry_after_ms?: number | null;
    severity?: "warning" | "error" | "fatal";
  },
): AdapterError {
  return {
    code,
    message,
    retryable: options?.retryable ?? false,
    retry_after_ms: options?.retry_after_ms ?? null,
    severity: options?.severity ?? "error",
  };
}
```

Sensible defaults: not retryable, no retry delay, severity "error". Plugin authors pass only what they need to override.

### The Accessibility Promise

A contributor building a new plugin (e.g., a Slack communication plugin) imports everything from `src/adapters/index.ts`. They don't need to understand the Orchestrator, Task Engine, Event Bus, or any Core internals. The adapter boundary is all they need. This is the concrete implementation of the accessibility promise from [`../1-system/architecture-tiers.md`](../1-system/architecture-tiers.md) § Plugin Tier.

---

## Plugin Lifecycle

### Decision #106: Health State Machine

Each registered plugin has a health state tracked by the Registry. Three states with clear transitions:

```
                  successful check
          ┌──────────────────────────┐
          │                          │
          ▼                          │
     ┌─────────┐   1 failed    ┌──────────┐
     │ healthy │──────────────▶│unhealthy │
     └─────────┘               └──────────┘
          ▲                          │
          │                          │ N consecutive
          │ successful check         │ failures
          │ (after restart)          ▼
          │                    ┌─────────┐
          └────────────────────│ failed  │
                               └─────────┘
                                    │
                                    ▼
                              alert human
```

### State Transitions

| From | To | Trigger | Action |
|------|-----|---------|--------|
| healthy | unhealthy | 1 failed health check | Log warning, emit `health.plugin_unhealthy` event. No escalation. |
| unhealthy | healthy | Successful health check | Log info, clear failure counter. |
| unhealthy | failed | N consecutive failures (default 3) | Emit `health.plugin_failed` event, alert human. Type-specific response (see below). |
| failed | healthy | Successful health check after system restart | Log info, emit `health.plugin_recovered`, resume normal operation. |

### Per-Type Failure Response

| Adapter Type | On `failed` State |
|-------------|-------------------|
| Trigger | Daemon stops polling this trigger. Other triggers continue. `health.trigger_failure` event emitted. |
| Communication | Core falls back to next channel in People Directory `contacts[]` for affected recipients. |
| LLM | Daemon initiates provider failover to next in priority list (Decision #54). |
| Tool | Operations requiring this tool return `AdapterError` with severity "fatal". Orchestrator adapts. |
| Git Hosting | PR/merge operations fail with clear error. Tasks needing hosting operations are blocked. |

### No Automatic Re-initialization for v1

When a plugin enters `failed` state, the system alerts the human and waits. No automatic re-init attempts.

**Why manual-only for v1:**
- Automatic re-init can mask underlying issues (expired credentials, service permanently down)
- Simplicity — retry logic with backoff, cooldown, and max-retry tracking adds significant complexity
- The human needs to know something broke, not have it silently retry and potentially succeed on stale state

**Future consideration:** Automatic re-init with exponential backoff after a configurable cooldown period.

### Health Check Details

- **Interval:** Configurable, default 60 seconds (Decision #107)
- **Staggered execution:** Health checks are spread across the interval, not all fired simultaneously. Prevents burst load on external APIs.
- **Per-check timeout:** Default 5 seconds. If `healthCheck()` doesn't return within timeout, the plugin is marked unhealthy with message "health check timeout."
- **Exception handling:** Unhandled exceptions during `healthCheck()` are caught, logged, and treated as a failed check.

### Exception Handling in Plugin Methods

When any plugin method (`poll()`, `sendMessage()`, `complete()`, `execute()`, etc.) throws an unhandled exception:

1. The calling Core component catches the exception
2. Wraps it in an `AdapterError` with code `"internal_error"` and severity `"fatal"`
3. The Registry marks the plugin as `failed`
4. Human is alerted

This is the safety net. Well-behaved plugins should catch their own errors and return proper `AdapterError` objects. The exception handler catches bugs in plugin code.

### Graceful Shutdown

On system shutdown (SIGTERM/SIGINT), the Registry shuts down plugins in **reverse initialization order**:

```
Shutdown order (reverse of init):
  1. Trigger plugins     — stop producing work events
  2. Git Hosting plugins — finish any in-flight PR operations
  3. Tool plugins        — terminate child processes (see § Process Safety)
  4. LLM plugins         — terminate CLI processes
  5. Communication plugins — last to go, so error alerts during shutdown still work
```

**Timeout:** Each `shutdown()` call has a timeout. If a plugin doesn't respond within the per-plugin share of `DaemonConfig.shutdown_timeout_ms` (default 30s total), it is abandoned and the next plugin is shut down. The process exits after all plugins are attempted.

### Decision #107: Plugin Lifecycle Config

Plugin lifecycle settings are added to `daemon.yaml` under a `plugins` section.

```yaml
# In daemon.yaml
plugins:
  dirs:                                # plugin discovery paths
    - src/plugins                      # built-in (default)
  health_check_interval_ms: 60000     # 60 seconds between checks
  health_check_timeout_ms: 5000       # 5 seconds per health check call
  consecutive_failures_threshold: 3    # failures before "failed" state
```

**Zod schema:**

```typescript
const PluginLifecycleConfigSchema = z.object({
  dirs: z.array(z.string()).default(["src/plugins"]),
  health_check_interval_ms: z.number().int().positive().default(60_000),
  health_check_timeout_ms: z.number().int().positive().default(5_000),
  consecutive_failures_threshold: z.number().int().positive().default(3),
});
type PluginLifecycleConfig = z.infer<typeof PluginLifecycleConfigSchema>;
```

This schema is added to `DaemonConfigSchema` as a nested `plugins` field:

```typescript
const DaemonConfigSchema = z.object({
  // ... existing fields ...
  plugins: PluginLifecycleConfigSchema.default({}),
});
```

---

## Process Safety

### Decision #108: Rules for Child Process Spawning

Five rules governing how plugins spawn child processes. Primarily applicable to BashToolPlugin (shell commands) and ClaudeCodeLLMPlugin (Claude CLI process).

### Rule 1: Explicit Shell Selection

All shell commands use `spawn("bash", ["-c", command])` — never `shell: true`.

```typescript
// CORRECT — explicit shell selection
import { spawn } from "node:child_process";

spawn("bash", ["-c", command], {
  cwd: workspaceDir,
  env: sanitizedEnv,
  shell: false,     // explicit: no double-shell
});

// NEVER — implicit shell, platform-dependent
spawn(command, { shell: true });   // uses /bin/sh, not bash
spawn(`git commit -m "${msg}"`, { shell: true });  // injection risk
```

**Why explicit bash:**
- `shell: true` uses `/bin/sh` (platform default), which may be dash or another minimal POSIX shell — not bash. LLM-generated commands use bash syntax.
- Explicit `spawn("bash", ["-c", command])` guarantees the command runs in bash, regardless of system configuration.
- No double-shell: the command string is a single argument to `-c`, not concatenated into a shell string by Node.js.

**Non-shell processes** (e.g., `spawn("git", ["status"])` for direct git operations) use `shell: false` (the default) with arguments as an array. No shell involved.

### Rule 2: Signal Forwarding

When the Daemon receives SIGTERM or SIGINT:

1. Forward the signal to all child processes managed by plugins
2. Wait for graceful exit (timeout from `DaemonConfig.shutdown_timeout_ms`)
3. Send SIGKILL to children that don't exit within timeout

Plugins that spawn long-running processes (ClaudeCodeLLMPlugin spawns the `claude` CLI) MUST:
- Track their child process references (the `ChildProcess` object from `spawn()`)
- Terminate all child processes in `doShutdown()`
- Handle SIGKILL for processes that don't respond to SIGTERM

This is part of the `shutdown()` contract — the template method in BaseAdapter calls `doShutdown()`, and the plugin is responsible for cleaning up its processes.

### Rule 3: Workspace Confinement

BashToolPlugin MUST set `cwd` on every `spawn()` call to the task's workspace directory:

```typescript
spawn("bash", ["-c", command], {
  cwd: task.workspace_path,  // enforced at plugin level
  // ...
});
```

Commands cannot execute outside the task workspace unless explicitly permitted by Safety Layer scope rules. This is enforced at two levels:
- **Plugin level:** `cwd` is always set to the workspace
- **Safety Layer level:** Side effects reported in `ToolResult` are checked against scope boundaries

### Rule 4: Environment Sanitization

Child processes receive a sanitized environment constructed from an **allowlist**, not inherited from `process.env`.

**Default allowlist:**

| Variable | Purpose |
|----------|---------|
| `PATH` | Command resolution |
| `HOME` | Home directory |
| `NODE_ENV` | Runtime environment |
| `LANG` | Locale |
| `TERM` | Terminal type |
| `GIT_AUTHOR_NAME` | Git commit identity |
| `GIT_COMMITTER_NAME` | Git commit identity |
| `GIT_AUTHOR_EMAIL` | Git commit identity |
| `GIT_COMMITTER_EMAIL` | Git commit identity |

**User-configurable additions** via `env_passthrough` in plugin config:

```yaml
# ~/.engineer/config/plugins/bash-tool.yaml
env_passthrough:
  - GOPATH
  - CARGO_HOME
  - RUSTUP_HOME
```

**Why allowlist over denylist:**
- Denylist risks leaking unknown sensitive vars (new `PROVIDER_SECRET_KEY` not in the deny patterns)
- Allowlist is explicit about what enters the child process environment
- If a tool breaks because it needs an env var, the user adds it to `env_passthrough` — a clear, auditable action

### Rule 5: Output Size Limits

Child process stdout/stderr is buffered with a configurable size limit. If output exceeds the limit, the process is terminated.

```yaml
# ~/.engineer/config/plugins/bash-tool.yaml
max_output_bytes: 10485760        # 10MB default
command_timeout_ms: 300000        # 5 minutes default per command
```

**Why output limits:**
- Prevents runaway commands (e.g., `cat` on a huge binary) from consuming all available memory
- 10MB is generous for any reasonable command output
- The process is killed (SIGTERM, then SIGKILL after timeout) — not just truncated

**Why command timeout:**
- Prevents infinite-running commands from blocking the Orchestrator
- 5 minutes is a reasonable default for build/test commands
- Timeout triggers the same SIGTERM → SIGKILL sequence as output limits

### BashToolPlugin Config Summary

```yaml
# ~/.engineer/config/plugins/bash-tool.yaml
max_output_bytes: 10485760        # 10MB — max stdout+stderr
command_timeout_ms: 300000        # 5 minutes — per-command timeout
env_passthrough:                  # additional env vars to pass through
  - GOPATH
  - CARGO_HOME
```

---

## Dependencies Added This Session

| Package | Purpose | Category |
|---------|---------|----------|
| `zod-to-json-schema` | Generate JSON Schema from Zod schemas for plugin manifests | Runtime |

> Joins packages from Sessions 23 and 25: `better-sqlite3`, `zod`, `tsx`, `tsdown`, `@biomejs/biome`, `vitest`, `yaml`, `ms`, `lefthook`.
