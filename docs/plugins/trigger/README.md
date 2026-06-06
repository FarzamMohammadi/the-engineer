# Trigger Adapter

Trigger adapters discover new work by polling external sources. The Daemon calls `poll()` on each plugin's declared interval, and the adapter returns zero or more `TriggerEvent` objects representing new tasks. Each event carries an idempotency key so the Daemon can deduplicate across polls. This is the simplest adapter type -- one abstract method (`doPoll()`) beyond the standard lifecycle.

**Polling and backoff:** A plugin declares its preferred poll cadence via `poll_interval_ms` on its manifest. The Daemon honors it (falling back to the global `trigger_poll_interval_ms` config if absent). On consecutive failures, the Daemon applies exponential backoff (2^n * base, capped at 5 minutes). If the plugin throws an `AdapterMethodError` with `retry_after_ms` set (e.g. from a 429 rate-limit response), the Daemon honors that delay instead -- and does not count the rate-limit toward the consecutive-failure threshold.

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
| `event_type` | `string` | Classification (e.g. `issue`). |
| `external_ref` | `ExternalRef \| null` | Link back to the external system (type, repo, id, url, pr_decorations). Plugins can optionally set `pr_decorations` to provide platform-formatted strings for PR title/description decoration. Core treats all decoration values as opaque. See `pr_decorations` fields: `title_prefix` (e.g. `"#42:"` — plugin owns delimiter), `title_suffix`, `description_prefix`, `description_suffix` (e.g. `"Closes #42"`). |
| `title` | `string` | Human-readable title for the task. |
| `body` | `string \| null` | Full description/body text. |
| `repo` | `string` | Repository identifier (`owner/name`). |
| `clone_url` | `string` | HTTPS clone URL. Must start with `https://`. |
| `thoughts_id` | `string \| null` | Identifier for the thoughts directory (e.g. `issue-42`). |
| `metadata` | `Record<string, unknown> \| null` | Arbitrary platform-specific data (labels, assignees, timestamps). |

#### Mapping a non-git source

`TriggerEvent` requires both `repo` and an HTTPS `clone_url`, which is natural when the source *is* the code host (a GitHub issue lives in a repo). A pure tracker — Linear, Jira, a queue — names *what* work to do but is not bound to *which* codebase to do it in. The trigger answers "what"; the codebase is a separate fact the plugin must carry. Put it in **the plugin's own config**: add a `repo` and `clone_url` field (or a small repo map) that the human sets in the plugin's YAML, then stamp every event your `doPoll()` emits with those values. The trigger schema stays satisfied and the codebase binding becomes an explicit, human-set decision instead of a guess.

The nested `external_ref` may be `null` for a pure tracker — leave it out if you have nothing to link back to. If you do set it, `ExternalRefSchema` requires `type`, `repo`, and `id` (all strings): reuse the config `repo` you stamped above for `repo`, and use the tracker's own values for `id` and `type` (e.g. `{ type: "linear-issue", repo, id: "ENG-512" }`). `url` is optional — include it when the tracker exposes a web link to the item.

### InitResult

| Field | Type | Description |
|-------|------|-------------|
| `success` | `boolean` | Whether initialization succeeded. |
| `message` | `string \| null` | Error message on failure, `null` on success. |

### HealthStatus

| Field | Type | Description |
|-------|------|-------------|
| `healthy` | `boolean` | Whether the adapter is operational. |
| `message` | `string \| null` | Human-readable status message (`null` when there is nothing to report). |
| `details` | `Record<string, unknown> \| null` | Optional structured details (e.g. API rate limit remaining). |

## Developing a New Plugin

The full authoring flow — scaffold, register, run the contract suite, configure, verify, and contribute back — is the same for every adapter and lives in **[Authoring a Plugin](../../contribution-docs/how-tos/plugins/authoring.md)**. This section covers only what is specific to a trigger plugin: the class skeleton, watermark state, the manifest fields, and the contract suite. Follow the authoring guide top to bottom and return here when it points you at the trigger contract.

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

### Config schema

A trigger config holds only what the plugin needs to reach its source — **not** the poll interval. Poll cadence is declared on the manifest (`poll_interval_ms`); the Daemon owns poll timing, so plugins never track it themselves.

```typescript
// my-trigger/config.ts
import { z } from "zod";

export const MyTriggerConfigSchema = z.object({
  api_token: z.string().min(1),
  project_id: z.string().min(1),
});

export type MyTriggerConfig = z.output<typeof MyTriggerConfigSchema>;
```

### Trigger manifest fields

When you register in `builtin.ts` (authoring guide Step 5), a trigger manifest is the only one that declares **`poll_interval_ms`** — the Daemon owns poll timing, so the cadence lives on the manifest, not in plugin config:

```typescript
// Manifest entry (in the manifests array)
{
  id: "my-trigger",
  type: "trigger",
  version: "1.0.0",
  name: "My Trigger",
  description: "Polls My Service for new tasks",
  critical: true,
  requirements: [{ type: "env", name: "MY_API_TOKEN" }],
  entry: "builtin",
  poll_interval_ms: 30_000,
  adapter_meta: {},
  contributes: { events: ["trigger.new_event"] },
},
```

If your plugin needs interactive setup (e.g. asking for a project ID), add a `promptForConfig` entry alongside the factory:

```typescript
// In promptFunctions map
"my-trigger": async () => {
  const { input } = await import("@inquirer/prompts");
  const projectId = await input({ message: "Project ID:" });
  return { project_id: projectId };
},
```

### Contract test suite

The trigger suite is **`runTriggerContractSuite`** from `tests/helpers/contract-suites/trigger-contract.ts`. Its fixtures are a valid config, an invalid config, and a manifest (no adapter-specific fixtures):

```typescript
// tests/unit/plugins/trigger/my-trigger/my-trigger.test.ts
import { runTriggerContractSuite } from "../../../../helpers/contract-suites/trigger-contract.js";
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

This example spells `contributes` out in full; the short `{ events: ["trigger.new_event"] }` form in the registration example above is also valid — the other sub-fields (`commands`, `config_keys`, `hooks`) default when omitted.

**Keep the suite offline — inject a mock API client.** The suite calls `poll()` three times, and `poll()` runs your real `doPoll()` against the live API. With the bare example above, those calls hit the network with a fake token and the suite fails or flakes. Override `doInitialize` in the factory to swap in a fake client *after* your real init runs — exactly what the reference test (`tests/unit/plugins/trigger/github-trigger/github-trigger.test.ts`) does:

```typescript
runTriggerContractSuite(
  () => {
    const plugin = new MyTriggerPlugin();
    const origInit = plugin["doInitialize"].bind(plugin);
    plugin["doInitialize"] = async (config: Record<string, unknown>) => {
      const result = await origInit(config);
      if (result.success) {
        // Replace the real client your doPoll() calls with a fake that returns canned data.
        (plugin as unknown as { apiClient: unknown }).apiClient = createMockApiClient();
      }
      return result;
    };
    return plugin;
  },
  { manifest, validConfig: { api_token: "tok_123", project_id: "proj_1" }, invalidConfig: {} },
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
| **GitHub Trigger** | GitHub Issues | Open issues filtered by label and/or assignee | `github:issue:{owner}/{repo}:{number}` | Per-repo ISO timestamp, persisted via Core StateStore | `GITHUB_TOKEN` env var |

The GitHub Trigger plugin also handles ETag-based conditional requests (304 Not Modified), rate-limit reporting via `retry_after_ms` (Core-owned backoff), and error classification (`auth_failed`, `not_found`, `rate_limited`, `network_error`).

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
| `tests/helpers/contract-suites/trigger-contract.ts` | Contract compliance test suite |
