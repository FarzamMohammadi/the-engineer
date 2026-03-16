# Plugin Development Guide

## Introduction

Plugins are the extension points of The Engineer. Each plugin implements an adapter contract — an abstract interface that defines how the system interacts with external services. Swap GitHub for GitLab, Claude for GPT, Bash for a sandboxed runtime — the Core doesn't know or care.

All plugin imports come from the SDK boundary: `src/adapters/index.ts`.

## Adapter Types

| Type | Base Class | Purpose |
|------|-----------|---------|
| **Trigger** | `TriggerAdapter` | Discover new work from external sources (GitHub issues, webhooks, cron) |
| **Communication** | `CommunicationAdapter` | Send/receive messages through channels (GitHub comments, Telegram, Slack) |
| **LLM** | `LLMAdapter` | Inference from language models (Claude, GPT, local models) |
| **Tool** | `ToolAdapter` | Execute actions in the environment (bash commands, file operations) |
| **Git Hosting** | `GitHostingAdapter` | PR lifecycle management (create, review, merge, comment) |

## Plugin Manifest

Every plugin requires an `engineer.plugin.yaml` manifest file:

```yaml
# Required fields
id: my-custom-trigger          # Unique identifier
type: trigger                   # One of: trigger, communication, llm, tool, git-hosting
version: "1.0.0"               # SemVer version
name: My Custom Trigger         # Human-readable name
description: Polls a custom source for new tasks
critical: true                  # If true, daemon won't start if this plugin fails
enabled: true                   # Can be disabled without removing
entry: index.ts                 # Relative path to module exporting createPlugin()

# Type-specific metadata
adapter_meta:
  poll_interval: "60s"          # Trigger only: how often to poll
  # capabilities:               # Communication only: ["send", "receive", "sync", "issue_management"]
  # action_classes:             # Tool only: ["read", "write", "test", "git-local"]
  # provider_type: cli          # LLM only: "cli" or "api"

# What this plugin contributes to the system
contributes:
  events:                       # Events this plugin emits
    - trigger.new_event
  config_keys:                  # Config sections this plugin reads
    - my_custom_trigger
```

## Creating a Plugin

### Step 1: Create the directory

```
src/plugins/{adapter-type}/{plugin-name}/
  engineer.plugin.yaml
  index.ts
  {plugin-name}.ts
  config.ts          # Optional: Zod schema for plugin config
```

### Step 2: Write the manifest

See the format above. Set `entry: index.ts`.

### Step 3: Create the entry point

The entry point exports a `createPlugin()` factory function:

```typescript
// src/plugins/trigger/my-trigger/index.ts
import type { TriggerAdapter } from "../../../adapters/index.js";
import { MyTriggerPlugin } from "./my-trigger.js";

export function createPlugin(): TriggerAdapter {
  return new MyTriggerPlugin();
}
```

### Step 4: Implement the adapter

Extend the appropriate base class and implement the required `do*` methods:

```typescript
// src/plugins/trigger/my-trigger/my-trigger.ts
import {
  TriggerAdapter,
  createAdapterError,
  AdapterMethodError,
  type TriggerEvent,
  type HealthStatus,
  type InitResult,
} from "../../../adapters/index.js";

export class MyTriggerPlugin extends TriggerAdapter {
  private apiUrl = "";
  private lastPollTimestamp = "";

  // Called during plugin initialization with validated config
  protected async doInitialize(
    config: Record<string, unknown>,
  ): Promise<InitResult> {
    const url = config["api_url"];
    if (typeof url !== "string" || url.length === 0) {
      return { success: false, message: "api_url is required" };
    }
    this.apiUrl = url;
    return { success: true, message: "Initialized" };
  }

  // Called during graceful shutdown
  protected async doShutdown(): Promise<void> {
    // Clean up resources (close connections, cancel timers, etc.)
  }

  // Called every 60s by the Registry health monitor
  protected async doHealthCheck(): Promise<HealthStatus> {
    try {
      const response = await fetch(`${this.apiUrl}/health`);
      return {
        healthy: response.ok,
        message: response.ok ? "API reachable" : `HTTP ${String(response.status)}`,
        details: null,
      };
    } catch (error) {
      return {
        healthy: false,
        message: error instanceof Error ? error.message : "Unknown error",
        details: null,
      };
    }
  }

  // Called by the Daemon on each poll interval
  protected async doPoll(): Promise<TriggerEvent[]> {
    try {
      const response = await fetch(
        `${this.apiUrl}/tasks?since=${this.lastPollTimestamp}`,
      );
      if (!response.ok) {
        throw new AdapterMethodError(
          createAdapterError("network_error", `HTTP ${String(response.status)}`, {
            retryable: true,
            severity: "error",
          }),
        );
      }

      const data = (await response.json()) as Array<{
        id: string;
        title: string;
        body: string;
        created_at: string;
      }>;
      this.lastPollTimestamp = new Date().toISOString();

      return data.map((item) => ({
        source: "my-trigger",
        type: "issue_opened" as const,
        idempotency_key: `my-trigger:${item.id}`,
        payload: {
          title: item.title,
          body: item.body,
          repo: "owner/repo",
          number: Number(item.id),
          author: "unknown",
          labels: [],
          assignees: [],
          url: `${this.apiUrl}/tasks/${item.id}`,
        },
        timestamp: item.created_at,
      }));
    } catch (error) {
      if (error instanceof AdapterMethodError) throw error;
      throw new AdapterMethodError(
        createAdapterError(
          "internal_error",
          error instanceof Error ? error.message : String(error),
          { severity: "fatal" },
        ),
      );
    }
  }
}
```

## Testing Your Plugin

Use the contract compliance suites in `test/helpers/contract-suites/` to validate your plugin implements the adapter contract correctly:

```typescript
// src/plugins/trigger/my-trigger/my-trigger.test.ts
import { describe } from "vitest";
import { runTriggerContractSuite } from "../../../../test/helpers/contract-suites/trigger-contract.js";
import { MyTriggerPlugin } from "./my-trigger.js";

// Run the standard contract suite
runTriggerContractSuite(
  () => new MyTriggerPlugin(),
  {
    validConfig: { api_url: "http://localhost:8080" },
    invalidConfig: { api_url: 123 },
    manifest: {
      id: "my-trigger",
      type: "trigger",
      version: "1.0.0",
      name: "My Trigger",
      description: "Test trigger",
      critical: false,
      enabled: true,
      entry: "index.ts",
      adapter_meta: { poll_interval: "30s" },
      contributes: { events: ["trigger.new_event"], config_keys: [] },
    },
  },
);

// Add plugin-specific tests
describe("MyTriggerPlugin", () => {
  // Test behavior specific to your implementation
});
```

Available contract suites:

| Suite | Import |
|-------|--------|
| `runTriggerContractSuite()` | `test/helpers/contract-suites/trigger-contract.js` |
| `runCommunicationContractSuite()` | `test/helpers/contract-suites/communication-contract.js` |
| `runLLMContractSuite()` | `test/helpers/contract-suites/llm-contract.js` |
| `runToolContractSuite()` | `test/helpers/contract-suites/tool-contract.js` |
| `runGitHostingContractSuite()` | `test/helpers/contract-suites/git-hosting-contract.js` |

## Configuration

Plugin configuration lives in `~/.engineer/config/plugins/{plugin-id}.yaml`. The Registry resolves config through a `configResolver` callback during initialization.

### Defining Your Config Schema

Create a Zod schema in your plugin's `config.ts`. This schema is used during `doInitialize()` to validate incoming config:

```typescript
// config.ts
import { z } from "zod";

export const MyTriggerConfigSchema = z.object({
  // Secrets: reference env vars with ${VAR} — never hardcode tokens
  api_token: z.string().min(1),

  // Duration fields: use the _ms suffix so the config loader
  // automatically accepts human-readable strings like "30s", "5m", "2h"
  poll_interval_ms: z.number().int().positive().default(30_000),
  request_timeout_ms: z.number().int().positive().default(10_000),

  // Regular fields with defaults
  max_retries: z.number().int().min(0).default(3),
  labels: z.array(z.string()).default([]),
});

export type MyTriggerConfig = z.output<typeof MyTriggerConfigSchema>;
```

### Config File

Environment variables can be referenced using `${ENV_VAR}` syntax — resolved at load time, never stored on disk:

```yaml
# ~/.engineer/config/plugins/my-trigger.yaml
api_token: ${MY_TRIGGER_API_TOKEN}
poll_interval_ms: "30s"    # Duration strings accepted for _ms fields
request_timeout_ms: "10s"
max_retries: 3
labels: ["bug", "feature"]
```

### Validating in doInitialize()

```typescript
protected async doInitialize(config: Record<string, unknown>): Promise<InitResult> {
  const parsed = MyTriggerConfigSchema.safeParse(config);
  if (!parsed.success) {
    return { success: false, message: `Invalid config: ${parsed.error.message}` };
  }
  this.config = parsed.data;
  return { success: true, message: null };
}
```

### Conventions

- **`_ms` suffix** for all duration fields — enables the config loader's automatic duration string parsing
- **`z.default()`** on every optional field — ensures missing fields don't break validation
- **`z.string().min(1)`** for required strings — catches empty strings early
- **`${ENV_VAR}`** for secrets — keeps credentials out of config files on disk

## Lifecycle

Plugins go through five phases managed by the Registry:

1. **Discover** — Registry scans directories for `engineer.plugin.yaml` manifests
2. **Validate** — Checks unique IDs, valid type, entry point existence
3. **Order** — Plugins are initialized in type order: Communication > LLM > Tool > GitHosting > Trigger
4. **Load** — Dynamic import of entry module, `createPlugin()` factory called
5. **Initialize** — Config validated and resolved, `plugin.initialize(config)` called

After initialization, plugins enter the health monitoring loop:

```
healthy ──(1 failed check)──> unhealthy ──(3 consecutive failures)──> failed
   ^                              |
   └──(successful check)──────────┘
```

Health checks run every 60 seconds with a 5-second timeout per check.

During shutdown, plugins receive `shutdown()` in reverse initialization order. The `doShutdown()` method should clean up resources but must never throw — errors are logged and swallowed.

## Best Practices

**Error handling:** Use `createAdapterError()` for structured errors with codes, retryability, and severity. Throw via `AdapterMethodError`:

```typescript
import { createAdapterError, AdapterMethodError } from "../../../adapters/index.js";

throw new AdapterMethodError(
  createAdapterError("rate_limited", "GitHub API rate limit exceeded", {
    retryable: true,
    retry_after_ms: 60000,
    severity: "warning",
  }),
);
```

Standard error codes: `auth_failed`, `rate_limited`, `timeout`, `network_error`, `not_found`, `conflict`, `invalid_input`, `internal_error`.

**Capability declaration:** For `CommunicationAdapter` plugins, declare capabilities in `adapter_meta.capabilities`. Core checks `hasCapability()` before calling optional methods:

```yaml
adapter_meta:
  capabilities:
    - send              # Required: sendMessage()
    - sync              # Optional: syncTaskState(), reconcileState()
    - issue_management  # Optional: commentOnIssue(), createIssue(), updateIssue()
```

**Side effects:** `ToolAdapter` plugins must report side effects in `ToolResult` for every write, test, or git action:

```typescript
return {
  success: true,
  output: "File created",
  side_effects: [
    { type: "file_created", details: { path: "/src/new-file.ts" } },
  ],
};
```

**Graceful shutdown:** Release all resources in `doShutdown()`. Cancel pending timers, close connections, terminate child processes. The method must not throw.
