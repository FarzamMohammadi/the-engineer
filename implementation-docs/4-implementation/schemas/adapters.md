# Adapter & Plugin Type Schemas

Universal adapter contract, all 5 adapter types, Registry, and People Directory. Source: [`../../3-interactions/adapter-contracts.md`](../../3-interactions/adapter-contracts.md).

**Persistence:** Zod only — these types exist at runtime boundaries for validation and type inference. Not stored in SQLite directly (adapter responses may end up in event payloads or task fields, which ARE persisted).

---

## Universal Adapter Contract

Every adapter implements this base contract.

### PluginManifest

```typescript
const AdapterTypeSchema = z.enum([
  "trigger",
  "communication",
  "llm",
  "tool",
  "git_hosting",
]);
type AdapterType = z.infer<typeof AdapterTypeSchema>;

const PluginManifestSchema = z.object({
  id: z.string(),                      // "github-trigger", "telegram-comm", "claude-code-llm"
  type: AdapterTypeSchema,
  version: z.string(),                 // semver: "1.0.0"
  name: z.string(),                    // human-readable: "GitHub Issues Trigger"
  description: z.string(),
  config_schema: z.record(z.unknown()), // JSON Schema for plugin config
  critical: z.boolean(),               // if true, system aborts on init failure
});
type PluginManifest = z.infer<typeof PluginManifestSchema>;
```

> **Note:** `AdapterType` is extensible — new adapter types will be added as the system evolves. The `z.enum` will grow. The `type` field is the discriminator for adapter-specific behavior.

### InitResult

```typescript
const InitResultSchema = z.object({
  success: z.boolean(),
  message: z.string().nullable(),
});
type InitResult = z.infer<typeof InitResultSchema>;
```

### HealthStatus

```typescript
const HealthStatusSchema = z.object({
  healthy: z.boolean(),
  message: z.string().nullable(),
  details: z.record(z.unknown()).nullable(),
});
type HealthStatus = z.infer<typeof HealthStatusSchema>;
```

### AdapterError

Common error format across all adapters.

```typescript
const AdapterErrorSeveritySchema = z.enum(["warning", "error", "fatal"]);

const AdapterErrorSchema = z.object({
  code: z.string(),                    // "auth_failed", "rate_limited", "timeout", etc.
  message: z.string(),
  retryable: z.boolean(),
  retry_after_ms: z.number().int().nullable(), // milliseconds
  severity: AdapterErrorSeveritySchema,
});
type AdapterError = z.infer<typeof AdapterErrorSchema>;
```

> **Reconciliation:** L2 used `retry_after: duration`. Concrete schema uses `retry_after_ms: number` (milliseconds).

### RegistrationResult

```typescript
const RegistrationResultSchema = z.object({
  success: z.boolean(),
  plugin_id: z.string(),
  message: z.string().nullable(),
});
type RegistrationResult = z.infer<typeof RegistrationResultSchema>;
```

---

## Trigger Adapter

```typescript
const TriggerEventSchema = z.object({
  idempotency_key: z.string(),        // stable dedup key: "github:issue:owner/repo:47"
  source: z.string(),                  // plugin ID
  event_type: z.string(),             // "issue_opened", "issue_assigned", "manual_create"
  external_ref: z.string(),           // URL or ID
  title: z.string(),
  body: z.string().nullable(),
  repo: z.string(),
  metadata: z.record(z.unknown()).nullable(),
});
type TriggerEvent = z.infer<typeof TriggerEventSchema>;
```

---

## Communication Adapter

### Message Types

```typescript
const MessageTypeSchema = z.enum([
  "notification",
  "question",
  "status_response",
  "milestone",
  "alert",
]);
type MessageType = z.infer<typeof MessageTypeSchema>;

const TargetSchema = z.object({
  user_id: z.string(),                 // People Directory ID
  channel: z.string().nullable(),      // specific channel/chat (optional)
});
type Target = z.infer<typeof TargetSchema>;

const FormattedMessageSchema = z.object({
  content: z.string(),
  metadata: z.object({
    task_id: z.string().nullable(),
    type: MessageTypeSchema,
  }),
});
type FormattedMessage = z.infer<typeof FormattedMessageSchema>;

const SendResultSchema = z.object({
  success: z.boolean(),
  message_id: z.string().nullable(),   // platform message ID (for reply threading)
  error: AdapterErrorSchema.nullable(),
});
type SendResult = z.infer<typeof SendResultSchema>;
```

### Inbound Message

```typescript
const InboundMessageSchema = z.object({
  source: z.string(),                  // communication plugin ID
  sender: z.string(),                  // user identifier on platform
  content: z.string(),
  timestamp: z.string().datetime(),
  reply_to: z.string().nullable(),
  platform_metadata: z.record(z.unknown()),
});
type InboundMessage = z.infer<typeof InboundMessageSchema>;
```

### State Sync

```typescript
const SyncMetadataSchema = z.object({
  task_title: z.string(),
  external_ref: z.string().nullable(),
  sub_state: z.string().nullable(),
  reason: z.string().nullable(),
});
type SyncMetadata = z.infer<typeof SyncMetadataSchema>;
```

### Issue Management

```typescript
const IssueOptionsSchema = z.object({
  title: z.string(),
  body: z.string(),
  labels: z.array(z.string()).nullable(),
  assignees: z.array(z.string()).nullable(),
  parent_issue: z.number().int().positive().nullable(),
});
type IssueOptions = z.infer<typeof IssueOptionsSchema>;

const IssueResultSchema = z.object({
  number: z.number().int().positive(),
  url: z.string(),
});
type IssueResult = z.infer<typeof IssueResultSchema>;

const IssueUpdatesSchema = z.object({
  state: z.enum(["open", "closed"]).nullable(),
  labels_add: z.array(z.string()).nullable(),
  labels_remove: z.array(z.string()).nullable(),
  body: z.string().nullable(),
});
type IssueUpdates = z.infer<typeof IssueUpdatesSchema>;
```

### Reconciliation

```typescript
const TaskReconciliationInputSchema = z.object({
  task_id: z.string(),
  external_ref: z.string(),
  expected_state: z.string(),
  expected_label: z.string(),
});
type TaskReconciliationInput = z.infer<typeof TaskReconciliationInputSchema>;

const ReconciliationResultSchema = z.object({
  reconciled: z.number().int(),
  errors: z.array(z.object({
    task_id: z.string(),
    reason: z.string(),
  })),
});
type ReconciliationResult = z.infer<typeof ReconciliationResultSchema>;
```

---

## LLM Adapter

```typescript
const CompletionRequestSchema = z.object({
  prompt: z.string(),
  options: z.object({
    max_tokens: z.number().int().positive().nullable(),
    temperature: z.number().min(0).max(1).nullable(),
    stop: z.array(z.string()).nullable(),
    tools: z.array(z.record(z.unknown())).nullable(), // tool definitions
  }),
});
type CompletionRequest = z.infer<typeof CompletionRequestSchema>;

const CompletionResultSchema = z.object({
  content: z.string(),
  tool_calls: z.array(z.record(z.unknown())).nullable(),
  finish_reason: z.enum(["stop", "max_tokens", "tool_use"]),
  usage: z.object({
    tokens_in: z.number().int(),
    tokens_out: z.number().int(),
    spend_usd: z.number().nullable(),       // API only
    remaining: z.number().int().nullable(),  // CLI only
    resets_at: z.string().datetime().nullable(), // CLI only
  }),
});
type CompletionResult = z.infer<typeof CompletionResultSchema>;

const LLMCapabilitiesSchema = z.object({
  max_context: z.number().int().positive(),
  supports_tools: z.boolean(),
  supports_vision: z.boolean(),
  model_id: z.string(),
});
type LLMCapabilities = z.infer<typeof LLMCapabilitiesSchema>;
```

---

## Tool Adapter

```typescript
const ToolDescriptionSchema = z.object({
  name: z.string(),
  description: z.string(),
  parameters: z.record(z.unknown()),   // JSON Schema
  action_classes: z.array(z.string()), // which action classes this tool exercises
});
type ToolDescription = z.infer<typeof ToolDescriptionSchema>;

const SideEffectTypeSchema = z.enum([
  "file_written",
  "file_deleted",
  "command_run",
  "network_request",
  "process_spawned",
]);

const SideEffectSchema = z.object({
  type: SideEffectTypeSchema,
  details: z.record(z.unknown()),      // type-specific
});
type SideEffect = z.infer<typeof SideEffectSchema>;

const ToolResultSchema = z.object({
  success: z.boolean(),
  output: z.string(),
  side_effects: z.array(SideEffectSchema),
  error: AdapterErrorSchema.nullable(),
});
type ToolResult = z.infer<typeof ToolResultSchema>;
```

---

## Git Hosting Adapter

```typescript
const MergeStrategySchema = z.enum(["merge", "squash", "rebase"]);

const PROptionsSchema = z.object({
  repo: z.string(),
  branch: z.string(),                  // source branch
  base: z.string(),                    // target branch
  title: z.string(),
  body: z.string(),
  draft: z.boolean(),
  labels: z.array(z.string()).nullable(),
  reviewers: z.array(z.string()).nullable(),
});
type PROptions = z.infer<typeof PROptionsSchema>;

const PRResultSchema = z.object({
  pr_number: z.number().int().positive(),
  url: z.string(),
});
type PRResult = z.infer<typeof PRResultSchema>;

const PRUpdatesSchema = z.object({
  title: z.string().nullable(),
  body: z.string().nullable(),
  draft: z.boolean().nullable(),
  labels_add: z.array(z.string()).nullable(),
  labels_remove: z.array(z.string()).nullable(),
});
type PRUpdates = z.infer<typeof PRUpdatesSchema>;

const MergeResultSchema = z.object({
  merge_sha: z.string(),
  success: z.boolean(),
  error: AdapterErrorSchema.nullable(),
});
type MergeResult = z.infer<typeof MergeResultSchema>;

const PRStatusSchema = z.object({
  number: z.number().int().positive(),
  state: z.enum(["open", "closed", "merged"]),
  draft: z.boolean(),
  mergeable: z.boolean(),
  checks_passing: z.boolean(),
  url: z.string(),
});
type PRStatus = z.infer<typeof PRStatusSchema>;

const ReviewerStateSchema = z.object({
  username: z.string(),
  state: z.enum(["approved", "changes_requested", "commented", "pending"]),
});
type ReviewerState = z.infer<typeof ReviewerStateSchema>;

const ReviewStatusSchema = z.object({
  approved: z.boolean(),
  approvals: z.number().int(),
  changes_requested: z.boolean(),
  reviewers: z.array(ReviewerStateSchema),
});
type ReviewStatus = z.infer<typeof ReviewStatusSchema>;

const CommentResultSchema = z.object({
  comment_id: z.string(),
  url: z.string(),
});
type CommentResult = z.infer<typeof CommentResultSchema>;

const BranchProtectionSchema = z.object({
  protected: z.boolean(),
  required_reviews: z.number().int(),
  required_checks: z.array(z.string()),
  restrictions: z.record(z.unknown()).nullable(),
});
type BranchProtection = z.infer<typeof BranchProtectionSchema>;
```

---

## People Directory

Core component — not a plugin, not an adapter. Config-driven.

```typescript
const NotificationLevelSchema = z.enum(["all", "milestones", "critical"]);

const ContactSchema = z.object({
  channel: z.string(),                 // communication plugin ID: "telegram", "github"
  handle: z.string(),                  // platform-specific: "@farzam", "farzam"
});
type Contact = z.infer<typeof ContactSchema>;

const PersonSchema = z.object({
  id: z.string(),                      // "farzam", "alice"
  name: z.string(),                    // "Farzam Mohammadi"
  roles: z.array(z.string()),         // "owner", "reviewer", "stakeholder"
  contacts: z.array(ContactSchema),   // ordered — first is preferred
  preferences: z.object({
    notification_level: NotificationLevelSchema,
    quiet_hours: z.object({
      start: z.string(),               // "22:00"
      end: z.string(),                 // "08:00"
    }).nullable(),
  }),
});
type Person = z.infer<typeof PersonSchema>;

const ContactInfoSchema = z.object({
  channel: z.string(),
  handle: z.string(),
  plugin_id: z.string(),              // Registry ID of the comm plugin
});
type ContactInfo = z.infer<typeof ContactInfoSchema>;
```
