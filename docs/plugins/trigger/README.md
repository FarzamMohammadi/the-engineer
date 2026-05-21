# Trigger Adapter

Trigger adapters discover new work by polling external sources. The Daemon calls `poll()` on a configurable interval, and the adapter returns zero or more `TriggerEvent` objects representing new tasks. Each event carries an idempotency key so the Daemon can deduplicate across polls. This is the simplest adapter type -- one abstract method (`doPoll()`) beyond the standard lifecycle.

## Contract

`TriggerAdapter` extends `BaseAdapter`. All lifecycle methods (`initialize`, `shutdown`, `healthCheck`) are inherited from `BaseAdapter` as template methods -- you implement the `do*` variants. Like every adapter, it receives a [PluginContext](../plugin-context.md) (`this.context.logger`, `this.context.stateStore`) injected before `initialize()`.

| Method | Signature | Required | Description |
|--------|-----------|----------|-------------|
| `doPoll()` | `() => Promise<TriggerEvent[]>` | Yes | Poll the external source for new events. Return `[]` when there is nothing new. |
| `doInitialize(config)` | `(config: Record<string, unknown>) => Promise<InitResult>` | Yes | Parse config with Zod, set up clients. Return `{ success: false, message }` on bad config -- never throw. |
| `doShutdown()` | `() => Promise<void>` | Yes | Clean up resources (persist state, close connections). |
| `doHealthCheck()` | `() => Promise<HealthStatus>` | Yes | Verify external connectivity. Must resolve within 5 seconds. |

The public `poll()` wrapper on `TriggerAdapter` catches errors: `AdapterMethodError` is rethrown as-is, anything else is wrapped with `code: "internal_error"` and `severity: "fatal"`.

## Key Types

### TriggerEvent

Defined in `src/schemas/adapters.ts` (`TriggerEventSchema`).

| Field | Type | Description |
|-------|------|-------------|
| `idempotency_key` | `string` | Stable key for deduplication (e.g. `github:issue:owner/repo:42`). Must be deterministic -- same event must produce the same key across polls. |
| `source` | `string` | Plugin ID that produced this event. |
| `event_type` | `string` | Classification (e.g. `issue_assigned`, `pr_review_requested`). |
| `external_ref` | `ExternalRef \| null` | Link back to the external system (type, repo, id, url, pr_decorations). Plugins can optionally set `pr_decorations` to provide platform-formatted strings for PR title/description decoration. Core treats all decoration values as opaque. See `pr_decorations` fields: `title_prefix` (e.g. `"#42:"` — plugin owns delimiter), `title_suffix`, `description_prefix`, `description_suffix` (e.g. `"Closes #42"`). |
| `title` | `string` | Human-readable title for the task. |
| `body` | `string \| null` | Full description/body text. |
| `repo` | `string` | Repository identifier (`owner/name`). |
| `clone_url` | `string` | HTTPS clone URL. Must start with `https://`. |
| `thoughts_id` | `string \| null` | Identifier for the thoughts directory (e.g. `issue-42`). |
| `metadata` | `Record<string, unknown>` | Arbitrary platform-specific data (labels, assignees, timestamps). |

### InitResult

| Field | Type | Description |
|-------|------|-------------|
| `success` | `boolean` | Whether initialization succeeded. |
| `message` | `string \| null` | Error message on failure, `null` on success. |

### HealthStatus

| Field | Type | Description |
|-------|------|-------------|
| `healthy` | `boolean` | Whether the adapter is operational. |
| `message` | `string` | Human-readable status message. |
| `details` | `Record<string, unknown> \| null` | Optional structured details (e.g. API rate limit remaining). |

## Developing a New Plugin

### Directory structure

```
src/plugins/trigger/my-trigger/
  my-trigger.ts       # Plugin class extending TriggerAdapter
  config.ts           # Zod config schema
  my-trigger.test.ts  # Tests including contract suite
```

### Minimal class skeleton

```typescript
import {
  type HealthStatus,
  type InitResult,
  TriggerAdapter,
  type TriggerEvent,
} from "../../../adapters/index.js";
import { type MyTriggerConfig, MyTriggerConfigSchema } from "./config.js";

export class MyTriggerPlugin extends TriggerAdapter {
  private config!: MyTriggerConfig;

  protected async doPoll(): Promise<TriggerEvent[]> {
    // Poll your external source, return events with stable idempotency keys
    return [];
  }

  protected doInitialize(config: Record<string, unknown>): Promise<InitResult> {
    const parsed = MyTriggerConfigSchema.safeParse(config);
    if (!parsed.success) {
      return Promise.resolve({
        success: false,
        message: `Invalid config: ${parsed.error.message}`,
      });
    }
    this.config = parsed.data;
    return Promise.resolve({ success: true, message: null });
  }

  protected doShutdown(): Promise<void> {
    return Promise.resolve();
  }

  protected async doHealthCheck(): Promise<HealthStatus> {
    return { healthy: true, message: "OK", details: null };
  }
}
```

### Core capabilities: logging and state

Core injects a [PluginContext](../plugin-context.md) onto every plugin before `initialize()` runs. Use `this.context.logger` for structured logging (your `plugin_id` is stamped automatically) and `this.context.stateStore` to persist a cursor across restarts. A trigger that tracks "what have I already seen" stores its watermark there:

```typescript
protected doShutdown(): Promise<void> {
  this.context.stateStore.set("watermark", this.latestSeen);
  return Promise.resolve();
}
```

See [Plugin Context](../plugin-context.md) for the full contract, the parse-don't-trust pattern for reading state back, and error handling. Watermarks are an efficiency optimization — Core deduplicates tasks itself, so losing one only means re-fetching.

### Config schema pattern

Use Zod with `z.output` for the type (resolves defaults, required for `exactOptionalPropertyTypes`).

```typescript
// my-trigger/config.ts
import { z } from "zod";

export const MyTriggerConfigSchema = z.object({
  api_token: z.string().min(1),
  poll_interval_ms: z.number().int().positive().default(30_000),
  project_id: z.string().min(1),
});

export type MyTriggerConfig = z.output<typeof MyTriggerConfigSchema>;
```

### Registration in builtin.ts

Add three things to `src/plugins/builtin.ts`:

1. Import your plugin class.
2. Add a manifest to the `manifests` array.
3. Add a factory to the `factories` map.

```typescript
// 1. Import
import { MyTriggerPlugin } from "./trigger/my-trigger/my-trigger.js";

// 2. Manifest (in manifests array)
{
  id: "my-trigger",
  type: "trigger",
  version: "1.0.0",
  name: "My Trigger",
  description: "Polls My Service for new tasks",
  critical: true,
  requirements: [{ type: "env", name: "MY_API_TOKEN" }],
  entry: "builtin",
  adapter_meta: { poll_interval: "30s" },
  contributes: { events: ["trigger.new_event"] },
},

// 3. Factory (in factories map)
"my-trigger": () => new MyTriggerPlugin(),
```

If your plugin needs interactive setup (e.g. asking for a project ID), add a `promptForConfig` entry:

```typescript
// In promptFunctions map
"my-trigger": async () => {
  const { input } = await import("@inquirer/prompts");
  const projectId = await input({ message: "Project ID:" });
  return { project_id: projectId };
},
```

### Contract test suite

Run the shared contract suite in your test file. Path: `test/helpers/contract-suites/trigger-contract.ts`.

```typescript
// my-trigger/my-trigger.test.ts
import { runTriggerContractSuite } from "../../../../test/helpers/contract-suites/trigger-contract.js";
import { MyTriggerPlugin } from "./my-trigger.js";

const manifest = {
  id: "my-trigger",
  type: "trigger" as const,
  version: "1.0.0",
  name: "My Trigger",
  description: "Test",
  critical: true,
  entry: "builtin",
  adapter_meta: {},
  contributes: { events: [], commands: [], config_keys: [], hooks: [] },
};

runTriggerContractSuite(
  () => new MyTriggerPlugin(),
  {
    manifest,
    validConfig: { api_token: "tok_123", project_id: "proj_1" },
    invalidConfig: {},  // triggers safeParse failure
  },
);
```

The contract suite validates:
- `initialize()` succeeds with valid config, returns `{ success: false }` (not throws) with invalid config
- `healthCheck()` returns `HealthStatus` with all required fields, resolves within 5 seconds
- `shutdown()` resolves without throwing
- `poll()` returns an array where each event passes `TriggerEventSchema` validation
- Idempotency keys are stable across consecutive polls

## Built-in Plugins

| Plugin | Source | Polls | Idempotency Key Pattern | Watermarks | Requirements |
|--------|--------|-------|-------------------------|------------|--------------|
| **GitHub Trigger** | GitHub Issues | Issues assigned to user, filtered by labels | `github:issue:{owner}/{repo}:{number}` | Per-repo ISO timestamp, persisted to `~/.engineer/state/github-trigger/watermarks.json` | `GITHUB_TOKEN` env var |

The GitHub Trigger plugin also handles ETag-based conditional requests (304 Not Modified), Retry-After from 429 responses, and error classification (`auth_failed`, `not_found`, `rate_limited`, `network_error`).

## Reference

| File | Purpose |
|------|---------|
| `src/adapters/trigger.ts` | Abstract `TriggerAdapter` base class |
| `src/adapters/base.ts` | `BaseAdapter` -- lifecycle template methods, `hasCapability()` |
| `src/adapters/errors.ts` | `AdapterMethodError`, `createAdapterError()` |
| `src/adapters/index.ts` | Plugin SDK barrel -- single import point |
| `src/schemas/adapters.ts` | `TriggerEventSchema`, `PluginManifestSchema`, all shared types |
| `src/plugins/trigger/github-trigger/github-trigger.ts` | Reference implementation |
| `src/plugins/trigger/github-trigger/config.ts` | Reference config schema |
| `src/plugins/builtin.ts` | Plugin registration (manifests + factories + promptForConfig) |
| `test/helpers/contract-suites/trigger-contract.ts` | Contract compliance test suite |
