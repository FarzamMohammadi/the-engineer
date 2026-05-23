# Communication Adapter

Communication adapters are the Engineer's voice -- how it talks to humans through external platforms. They are dumb transport: the Orchestrator owns all intelligence (what to say, when to say it, how to react). Plugins just format and deliver messages. The adapter has the largest contract surface of any adapter type because it supports three optional capability groups beyond the required send methods.

## Contract

`CommunicationAdapter` extends `BaseAdapter`. Methods are split into required and capability-gated optional groups. Like every adapter, it receives a [PluginContext](../plugin-context.md) (`this.context.logger`, `this.context.stateStore`) injected before `initialize()`.

### Required methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `doSendMessage(target, message)` | `(target: Target, message: FormattedMessage) => Promise<SendResult>` | Send a message to a target. Return `SendResult` with success/failure -- do not throw on delivery failure. |
| `formatMessage(content, type)` | `(content: string, type: MessageType) => string` | Format content for this platform. Synchronous, pure. Called by Core before `sendMessage()`. |
| `doInitialize(config)` | `(config: Record<string, unknown>) => Promise<InitResult>` | Parse config with Zod, set up clients. Return `{ success: false, message }` on bad config. |
| `doShutdown()` | `() => Promise<void>` | Clean up resources. |
| `doHealthCheck()` | `() => Promise<HealthStatus>` | Verify external connectivity. Must resolve within 5 seconds. |

### Optional methods (capability-gated)

Core checks `hasCapability(name)` before calling any optional method. Default implementations throw `AdapterMethodError` with code `capability_not_available`. Override only the methods your plugin supports.

#### Capability: `receive`

| Method | Signature | Description |
|--------|-----------|-------------|
| `doStartListening()` | `() => Promise<void>` | Begin receiving inbound messages. |
| `doStopListening()` | `() => Promise<void>` | Stop receiving inbound messages. |
| `doPollMessages(channels, since)` | `(channels: string[], since: string) => Promise<{ messages: InboundMessage[]; cursor: string }>` | Poll for new inbound messages. Return messages and a cursor for pagination. |

#### Capability: `sync`

| Method | Signature | Description |
|--------|-----------|-------------|
| `doSyncTaskState(taskId, oldState, newState, metadata)` | `(taskId: string, oldState: string, newState: string, metadata: SyncMetadata) => Promise<void>` | Sync a task state change to the external platform (e.g. update labels). |
| `doReconcileState(tasks)` | `(tasks: TaskReconciliationInput[]) => Promise<ReconciliationResult>` | Reconcile task states after an outage. Batch operation. |

#### Capability: `ticket_management`

| Method | Signature | Description |
|--------|-----------|-------------|
| `doCommentOnTicket(externalRef, comment)` | `(externalRef: ExternalRef, comment: string) => Promise<void>` | Comment on an external ticket (issue/PR). |
| `doCreateTicket(repo, options)` | `(repo: string, options: IssueOptions) => Promise<IssueResult>` | Create a new ticket. Returns issue number and URL. |
| `doUpdateTicket(repo, issueNumber, updates)` | `(repo: string, issueNumber: number, updates: IssueUpdates) => Promise<void>` | Update an existing ticket (state, labels, body). |

### Capability system

Capabilities are declared in the plugin manifest's `adapter_meta.capabilities` array and checked at runtime via `hasCapability()`. Core never calls an optional method without checking first.

```typescript
// In the manifest (builtin.ts):
adapter_meta: { capabilities: ["send", "sync", "ticket_management"], channel: "github" }

// Core checks before calling:
if (commPlugin.hasCapability("ticket_management")) {
  await commPlugin.commentOnTicket(externalRef, comment);
}
```

You can override `hasCapability()` directly instead of relying on `adapter_meta` if your plugin needs dynamic capability resolution:

```typescript
override hasCapability(capability: string): boolean {
  return ["send", "receive"].includes(capability);
}
```

### Error handling pattern

All public methods on `CommunicationAdapter` use `wrapAsync()` which rethrows `AdapterMethodError` as-is and wraps unknown errors as `internal_error` with `severity: "fatal"`. For `sendMessage()`, return errors in the `SendResult.error` field rather than throwing -- this lets Core distinguish delivery failures (retryable) from plugin bugs (fatal).

## Key Types

### Target

| Field | Type | Description |
|-------|------|-------------|
| `user_id` | `string` | Handle identifying the recipient (e.g. GitHub username, Telegram handle). |
| `channel` | `string \| null` | Platform-specific channel (e.g. `owner/repo#42` for GitHub, `null` for Telegram DM). |

### FormattedMessage

| Field | Type | Description |
|-------|------|-------------|
| `content` | `string` | Pre-formatted message content (output of `formatMessage()`). |
| `metadata.task_id` | `string \| null` | Associated task ID. |
| `metadata.type` | `MessageType` | One of: `notification`, `question`, `status_response`, `milestone`, `alert`. |

### SendResult

| Field | Type | Description |
|-------|------|-------------|
| `success` | `boolean` | Whether the message was delivered. |
| `message_id` | `string \| null` | Platform message ID on success. |
| `error` | `AdapterError \| null` | Structured error on failure (code, message, retryable flag). |

### InboundMessage

| Field | Type | Description |
|-------|------|-------------|
| `source` | `string` | Platform name (e.g. `"telegram"`, `"github"`). |
| `sender` | `string` | Username or ID of the message author. |
| `content` | `string` | Message text. |
| `timestamp` | `string` | ISO 8601 datetime. |
| `reply_to` | `string \| null` | ID of the message being replied to. |
| `platform_metadata` | `Record<string, unknown>` | Platform-specific data (chat_id, message_id, etc.). |

### SyncMetadata

| Field | Type | Description |
|-------|------|-------------|
| `task_title` | `string` | Task title for display. |
| `external_ref` | `ExternalRef \| null` | Link to external ticket (repo, id, url). |
| `sub_state` | `string \| null` | Task sub-state for label granularity. |
| `reason` | `string \| null` | Reason for the state change. |

### IssueOptions / IssueResult / IssueUpdates

| Type | Key Fields | Description |
|------|------------|-------------|
| `IssueOptions` | `title`, `body`, `labels?`, `assignees?`, `parent_issue?` | Input for creating a new ticket. |
| `IssueResult` | `number`, `url` | Output from ticket creation. |
| `IssueUpdates` | `state?`, `labels_add?`, `labels_remove?`, `body?` | Partial update to an existing ticket. All fields nullable -- only non-null fields are applied. |

### ReconciliationResult

| Field | Type | Description |
|-------|------|-------------|
| `reconciled` | `number` | Count of tasks whose external state was corrected. |
| `errors` | `Array<{ task_id, reason }>` | Tasks that failed reconciliation. |

## Developing a New Plugin

### Directory structure

Source and tests live in mirrored trees — source under `src/`, tests under `tests/unit/` (see [coding standards § 7 — Test Location](../../coding-standards.md#test-location)):

```
src/plugins/communication/my-comm/
  my-comm.ts       # Plugin class extending CommunicationAdapter
  config.ts        # Zod config schema

tests/unit/plugins/communication/my-comm/
  my-comm.test.ts  # Tests including contract suite
```

### Minimal class skeleton

A send-only plugin (simplest possible):

```typescript
import {
  CommunicationAdapter,
  type FormattedMessage,
  type HealthStatus,
  type InitResult,
  type MessageType,
  type SendResult,
  type Target,
  createAdapterError,
} from "../../../adapters/index.js";
import { type MyCommConfig, MyCommConfigSchema } from "./config.js";

const TYPE_PREFIXES: Record<MessageType, string> = {
  notification: "[Info]",
  question: "[Question]",
  status_response: "[Status]",
  milestone: "[Milestone]",
  alert: "[Alert]",
};

export class MyCommPlugin extends CommunicationAdapter {
  private config!: MyCommConfig;

  formatMessage(content: string, type: MessageType): string {
    const prefix = TYPE_PREFIXES[type] ?? "";
    return prefix ? `${prefix} ${content}` : content;
  }

  protected async doSendMessage(
    target: Target,
    message: FormattedMessage,
  ): Promise<SendResult> {
    try {
      const messageId = await myApiSend(target.channel, message.content);
      return { success: true, message_id: messageId, error: null };
    } catch (error) {
      return {
        success: false,
        message_id: null,
        error: createAdapterError(
          "network_error",
          error instanceof Error ? error.message : String(error),
          { retryable: true },
        ),
      };
    }
  }

  protected doInitialize(config: Record<string, unknown>): Promise<InitResult> {
    const parsed = MyCommConfigSchema.safeParse(config);
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

### Adding capabilities

To support optional methods, override `hasCapability()` and implement the corresponding `do*` methods:

```typescript
override hasCapability(capability: string): boolean {
  return ["send", "receive"].includes(capability);
}

// Then implement doPollMessages, doStartListening, doStopListening
protected async doPollMessages(
  _channels: string[],
  _since: string,
): Promise<{ messages: InboundMessage[]; cursor: string }> {
  // Poll your platform's API for new messages
  return { messages: [], cursor: "0" };
}
```

### Config schema pattern

```typescript
// my-comm/config.ts
import { z } from "zod";

export const MyCommConfigSchema = z.object({
  api_token: z.string().min(1),
  default_channel: z.string().default("general"),
});

export type MyCommConfig = z.output<typeof MyCommConfigSchema>;
```

Use `z.output<typeof Schema>` (not `z.infer`) -- resolves defaults and transforms, required for `exactOptionalPropertyTypes`.

### Registration in builtin.ts

```typescript
// 1. Import
import { MyCommPlugin } from "./communication/my-comm/my-comm.js";

// 2. Manifest (in manifests array)
{
  id: "my-comm",
  type: "communication",
  version: "1.0.0",
  name: "My Communication",
  description: "Sends notifications via My Platform",
  critical: false,  // communication plugins are typically non-critical
  requirements: [{ type: "env", name: "MY_API_TOKEN" }],
  entry: "builtin",
  adapter_meta: { capabilities: ["send"], channel: "my-platform" },
  contributes: { events: ["comm.message_sent"] },
},

// 3. Factory (in factories map)
"my-comm": () => new MyCommPlugin(),
```

### Contract test suite

Path: `tests/helpers/contract-suites/communication-contract.ts`.

```typescript
// tests/unit/plugins/communication/my-comm/my-comm.test.ts
import { runCommunicationContractSuite } from "../../../../helpers/contract-suites/communication-contract.js";
import { MyCommPlugin } from "./my-comm.js";

const manifest = {
  id: "my-comm",
  type: "communication" as const,
  version: "1.0.0",
  name: "My Comm",
  description: "Test",
  critical: false,
  entry: "builtin",
  adapter_meta: { capabilities: ["send"] },
  contributes: { events: [], commands: [], config_keys: [], hooks: [] },
};

runCommunicationContractSuite(
  () => new MyCommPlugin(),
  {
    manifest,
    validConfig: { api_token: "tok_123" },
    invalidConfig: {},
    target: { user_id: "testuser", channel: "test-channel" },
    message: { content: "Hello", metadata: { task_id: null, type: "notification" } },
  },
);
```

The contract suite validates:
- `initialize()` succeeds/fails correctly with valid/invalid config
- `healthCheck()` returns `HealthStatus` with all required fields, resolves within 5 seconds
- `shutdown()` resolves without throwing
- `sendMessage()` returns a valid `SendResult` (schema-validated) with required fields
- `formatMessage()` returns a non-empty string for all five `MessageType` values

## Built-in Plugins

| Plugin | Platform | Capabilities | Channel Format | Auth | Critical |
|--------|----------|--------------|----------------|------|----------|
| **GitHub Comm** | GitHub Issues/PRs | `send`, `sync`, `ticket_management` | `owner/repo#number` | `GITHUB_TOKEN` | No |
| **Telegram Comm** | Telegram Bot API | `send`, `receive` | Telegram username (resolved to chat_id) | `TELEGRAM_BOT_TOKEN` | No |

### GitHub Comm

- **send**: Posts comments on GitHub issues/PRs via `octokit.issues.createComment()`.
- **sync**: Updates labels on issues to reflect task state changes. Uses a configurable `label_prefix` (default: `engineer:`). Reconciliation batch-checks and corrects label drift after outages.
- **ticket_management**: Full CRUD -- create issues, update state/labels/body, comment on tickets.
- **formatMessage**: Prepends type-specific GitHub markdown blockquotes (e.g. `> **Info**`).
- Config: `github_token` (required), `label_prefix` (default `"engineer:"`).

### Telegram Comm

- **send**: Sends messages via `bot.api.sendMessage()` with configurable parse mode (MarkdownV2/Markdown/HTML).
- **receive**: Polls for inbound messages via `bot.api.getUpdates()`. Captures `/start` handshake messages for username-to-chat_id mapping.
- **formatMessage**: Escapes content for the configured parse mode. MarkdownV2 requires special character escaping; HTML escapes `<`, `>`, `&`.
- **Setup requirement**: Users must send `/start` to the bot before it can message them. The plugin persists username-to-chat_id mappings through the Core StateStore, keyed per plugin. Mappings are captured during initialization (drains pending updates) and during polling.
- Config: `bot_token` (required), `parse_mode` (default `"MarkdownV2"`), `disable_link_preview` (default `true`).

## Reference

| File | Purpose |
|------|---------|
| `src/adapters/communication.ts` | Abstract `CommunicationAdapter` base class (required + optional methods, capability errors) |
| `src/adapters/base.ts` | `BaseAdapter` -- lifecycle template methods, `hasCapability()` |
| `src/adapters/errors.ts` | `AdapterMethodError`, `createAdapterError()` |
| `src/adapters/index.ts` | Plugin SDK barrel -- single import point |
| `src/schemas/adapters.ts` | All Zod schemas (`Target`, `FormattedMessage`, `SendResult`, `InboundMessage`, `SyncMetadata`, `IssueOptions`, etc.) |
| `src/plugins/communication/github-comm/github-comm.ts` | Reference: send + sync + ticket_management |
| `src/plugins/communication/github-comm/config.ts` | Reference config schema |
| `src/plugins/communication/github-comm/github-utils.ts` | Label diffing and channel parsing utilities |
| `src/plugins/communication/telegram-comm/telegram-comm.ts` | Reference: send + receive, /start handshake, chat map persistence |
| `src/plugins/communication/telegram-comm/config.ts` | Reference config schema |
| `src/plugins/builtin.ts` | Plugin registration (manifests + factories) |
| `tests/helpers/contract-suites/communication-contract.ts` | Contract compliance test suite |
