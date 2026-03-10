# Event Domain Schemas

The Event Bus event envelope and all 30 event payload schemas. Source: [`../../2-components/event-bus.md`](../../2-components/event-bus.md) and [`../../3-interactions/event-catalog.md`](../../3-interactions/event-catalog.md).

**Persistence:** SQLite — `events` table. Payloads stored as JSON blobs.

**Cross-references:** Some payload schemas reference enums from the task domain (`TaskStateSchema`, `SubStateSchema`, `ActionClassSchema`). In the actual codebase, these will be imported from the task domain module.

---

## Event Envelope

Every event shares this common structure.

```typescript
const EventSchema = z.object({
  id: z.string(),                      // ULID — correlation key (referenced from checkpoints, journal)
  sequence: z.number().int(),          // global monotonic integer — ordering/query key (auto-increment)
  type: z.string(),                    // canonical type: "task.state_changed", "git.pushed", etc.
  source: z.string(),                  // emitting component: "task_engine", "workspace_manager", etc.
  task_id: z.string().nullable(),      // null for system-level events
  timestamp: z.string().datetime(),
  payload: z.record(z.unknown()),      // type-specific — validated per event type below
});
type Event = z.infer<typeof EventSchema>;
```

> **Reconciliation:** L2's Event Bus had `status` ("delivered" | "vetoed") and `veto_reason` fields. L3's Action Pipeline removed these — the Event Bus is now pure pub/sub with no pre-processing. Pipeline rejections are logged as `action.rejected` events instead. Also removed: `priority` field on Subscription (no more "pre_process" vs "normal").

### `id` vs `sequence`

Both exist on every event but serve different purposes:

| Field | Type | Purpose | Used by |
|-------|------|---------|---------|
| `id` | ULID | Correlation key — globally unique, referenced from checkpoints and journal entries | Cross-system references, `last_event_id` on checkpoints |
| `sequence` | Integer | Ordering key — monotonic, auto-increment, used for replay queries | Event replay, subscriber delivery order, snapshot pointers |

---

## Subscription (Runtime Only)

Not persisted. Registered at startup, held in memory.

```typescript
const SubscriptionSchema = z.object({
  subscriber_id: z.string(),           // component identifier
  event_type: z.string(),             // or pattern: "task.*", "git.*"
  filter: z.record(z.unknown()).nullable(), // field-level filter
});
type Subscription = z.infer<typeof SubscriptionSchema>;
```

---

## Event Type Map

Instead of a 30-variant discriminated union, we use a **mapped type** for ergonomic type-safe access:

```typescript
// Each event type maps to its payload schema
type EventPayloads = {
  "task.created": TaskCreatedPayload;
  "task.state_changed": TaskStateChangedPayload;
  "task.children_all_done": TaskChildrenAllDonePayload;
  "task.feedback_received": TaskFeedbackReceivedPayload;
  "action.rejected": ActionRejectedPayload;
  "cost.incurred": CostIncurredPayload;
  "cost.limit_reached": CostLimitReachedPayload;
  "preemption.requested": PreemptionRequestedPayload;
  "preemption.ready": PreemptionReadyPayload;
  "timeout.reminder": TimeoutReminderPayload;
  "timeout.self_unblock_check": TimeoutSelfUnblockCheckPayload;
  "timeout.alert": TimeoutAlertPayload;
  "trigger.new_event": TriggerNewEventPayload;
  "trigger.pr_review": TriggerPrReviewPayload;
  "workspace.created": WorkspaceCreatedPayload;
  "workspace.verified": WorkspaceVerifiedPayload;
  "workspace.cleaned": WorkspaceCleanedPayload;
  "workspace.merge_conflict": WorkspaceMergeConflictPayload;
  "git.branch_created": GitBranchCreatedPayload;
  "git.committed": GitCommittedPayload;
  "git.pushed": GitPushedPayload;
  "git.pr_opened": GitPrOpenedPayload;
  "git.pr_updated": GitPrUpdatedPayload;
  "git.pr_merged": GitPrMergedPayload;
  "git.merge_completed": GitMergeCompletedPayload;
  "health.stuck_detected": HealthStuckDetectedPayload;
  "health.trigger_failure": HealthTriggerFailurePayload;
  "health.config_reload_failed": HealthConfigReloadFailedPayload;
  "comm.message_received": CommMessageReceivedPayload;
  "comm.message_sent": CommMessageSentPayload;
};

// Type-safe event: Event with a specific payload type
type TypedEvent<T extends keyof EventPayloads> = Omit<Event, "payload"> & {
  type: T;
  payload: EventPayloads[T];
};

// Usage:
// const event: TypedEvent<"cost.incurred"> = ...
// event.payload.spend_usd  // type-safe access
```

### Event Type Enum

```typescript
const EventTypeSchema = z.enum([
  "task.created", "task.state_changed", "task.children_all_done", "task.feedback_received",
  "action.rejected",
  "cost.incurred", "cost.limit_reached",
  "preemption.requested", "preemption.ready",
  "timeout.reminder", "timeout.self_unblock_check", "timeout.alert",
  "trigger.new_event", "trigger.pr_review",
  "workspace.created", "workspace.verified", "workspace.cleaned", "workspace.merge_conflict",
  "git.branch_created", "git.committed", "git.pushed", "git.pr_opened", "git.pr_updated", "git.pr_merged", "git.merge_completed",
  "health.stuck_detected", "health.trigger_failure", "health.config_reload_failed",
  "comm.message_received", "comm.message_sent",
]);
type EventType = z.infer<typeof EventTypeSchema>;
```

---

## Payload Schemas

### `task.*` — Task Lifecycle

**Owner:** Task Engine

```typescript
const TaskCreatedPayloadSchema = z.object({
  task_id: z.string(),
  parent_id: z.string().nullable(),
  title: z.string(),
  external_ref: z.string().nullable(),  // GitHub issue URL, etc.
  source: z.string(),                   // "trigger.github", "decomposition", "manual"
  priority: z.number().int(),
  repo: z.string(),
});
type TaskCreatedPayload = z.infer<typeof TaskCreatedPayloadSchema>;

const TaskStateChangedPayloadSchema = z.object({
  task_id: z.string(),
  from_state: TaskStateSchema,               // reuses TaskState enum from task domain
  from_sub: SubStateSchema.nullable(),       // reuses SubState enum from task domain
  to_state: TaskStateSchema,
  to_sub: SubStateSchema.nullable(),
  reason: z.string(),
  triggered_by: z.string(),            // component that requested
});
type TaskStateChangedPayload = z.infer<typeof TaskStateChangedPayloadSchema>;

const TaskChildrenAllDonePayloadSchema = z.object({
  parent_task_id: z.string(),
  child_ids: z.array(z.string()),
  all_succeeded: z.boolean(),
  failed_ids: z.array(z.string()),
});
type TaskChildrenAllDonePayload = z.infer<typeof TaskChildrenAllDonePayloadSchema>;

const TaskFeedbackReceivedPayloadSchema = z.object({
  task_id: z.string(),
  stage: z.enum(["demo", "code"]),
  feedback_type: z.enum(["approved", "changes_requested", "comment"]),
  reviewer: z.string(),
  content: z.string().nullable(),
  pr_number: z.number().int().positive(),
});
type TaskFeedbackReceivedPayload = z.infer<typeof TaskFeedbackReceivedPayloadSchema>;
```

### `action.*` — Action Pipeline

**Owner:** Action Pipeline

```typescript
const ActionRejectedPayloadSchema = z.object({
  task_id: z.string(),
  action_class: ActionClassSchema,            // reuses ActionClass enum from task domain
  gate: z.enum(["task_engine", "safety_layer"]),
  reason: z.string(),
  details: z.record(z.unknown()).nullable(),
  requested_by: z.string(),
});
type ActionRejectedPayload = z.infer<typeof ActionRejectedPayloadSchema>;
```

### `cost.*` — Cost Tracking

```typescript
// Owner: Orchestrator
const CostIncurredPayloadSchema = z.object({
  task_id: z.string(),
  repo: z.string(),
  provider_id: z.string(),
  provider_type: z.enum(["cli", "api"]),
  operation: z.string(),               // "reasoning", "code_generation", "analysis"
  // API providers
  tokens_in: z.number().int().nullable(),
  tokens_out: z.number().int().nullable(),
  spend_usd: z.number().nullable(),
  // CLI providers
  usage_units: z.number().int().nullable(),
  remaining: z.number().int().nullable(),
});
type CostIncurredPayload = z.infer<typeof CostIncurredPayloadSchema>;

// Owner: Safety Layer
const CostLimitReachedPayloadSchema = z.object({
  task_id: z.string().nullable(),       // null if global limit
  limit_type: z.enum(["per_task", "daily", "monthly"]),
  limit_scope: z.string().nullable(),
  current_spend: z.number(),
  limit_value: z.number(),
  provider_type: z.enum(["cli", "api"]),
  resets_at: z.string().datetime().nullable(),
});
type CostLimitReachedPayload = z.infer<typeof CostLimitReachedPayloadSchema>;
```

### `preemption.*` — Task Preemption

```typescript
// Owner: Daemon
const PreemptionRequestedPayloadSchema = z.object({
  target_task_id: z.string(),
  preempting_task_id: z.string(),
  reason: z.string(),
  priority_delta: z.number().int(),
});
type PreemptionRequestedPayload = z.infer<typeof PreemptionRequestedPayloadSchema>;

// Owner: Orchestrator
const PreemptionReadyPayloadSchema = z.object({
  task_id: z.string(),
  checkpoint_id: z.string(),
  phase: z.string(),
  atomic_op: z.string(),               // "llm_call", "file_write", "test_run"
});
type PreemptionReadyPayload = z.infer<typeof PreemptionReadyPayloadSchema>;
```

### `timeout.*` — Response Timeouts

**Owner:** Daemon

```typescript
const TimeoutReminderPayloadSchema = z.object({
  task_id: z.string(),
  blocked_since: z.string().datetime(),
  elapsed_ms: z.number().int(),
  channel: z.string(),
  question_summary: z.string(),
});
type TimeoutReminderPayload = z.infer<typeof TimeoutReminderPayloadSchema>;

const TimeoutSelfUnblockCheckPayloadSchema = z.object({
  task_id: z.string(),
  blocked_since: z.string().datetime(),
  elapsed_ms: z.number().int(),
  decision_category: z.string(),
  can_self_unblock: z.boolean(),
});
type TimeoutSelfUnblockCheckPayload = z.infer<typeof TimeoutSelfUnblockCheckPayloadSchema>;

const TimeoutAlertPayloadSchema = z.object({
  task_id: z.string(),
  blocked_since: z.string().datetime(),
  elapsed_ms: z.number().int(),
  escalation: z.string(),             // "owner_notified", "all_channels_notified"
});
type TimeoutAlertPayload = z.infer<typeof TimeoutAlertPayloadSchema>;
```

> **Reconciliation:** L2 used `elapsed: duration` (abstract). Concrete schema uses `elapsed_ms: number` (milliseconds). Consistent with our duration convention.

### `trigger.*` — External Triggers

**Owner:** Daemon

```typescript
const TriggerNewEventPayloadSchema = z.object({
  idempotency_key: z.string(),
  source: z.string(),                  // trigger plugin ID
  event_type: z.string(),             // "issue_opened", "issue_assigned", "manual_create"
  external_ref: z.string(),
  title: z.string(),
  body: z.string().nullable(),
  repo: z.string(),
  metadata: z.record(z.unknown()).nullable(),
});
type TriggerNewEventPayload = z.infer<typeof TriggerNewEventPayloadSchema>;

const TriggerPrReviewPayloadSchema = z.object({
  task_id: z.string(),
  pr_number: z.number().int().positive(),
  repo: z.string(),
  review_type: z.enum(["approved", "changes_requested", "comment"]),
  pr_state: z.enum(["draft", "ready"]),
  reviewer: z.string(),
  comment: z.string().nullable(),
});
type TriggerPrReviewPayload = z.infer<typeof TriggerPrReviewPayloadSchema>;
```

### `workspace.*` — Workspace Lifecycle

**Owner:** Workspace Manager

```typescript
const WorkspaceCreatedPayloadSchema = z.object({
  task_id: z.string(),
  repo: z.string(),
  branch: z.string(),
  worktree_path: z.string(),
  base_branch: z.string(),
  base_commit: z.string(),
});
type WorkspaceCreatedPayload = z.infer<typeof WorkspaceCreatedPayloadSchema>;

const WorkspaceVerifiedPayloadSchema = z.object({
  task_id: z.string(),
  status: z.enum(["valid", "recoverable", "lost"]),
  current_commit: z.string().nullable(),
  recovery_action: z.string().nullable(),
});
type WorkspaceVerifiedPayload = z.infer<typeof WorkspaceVerifiedPayloadSchema>;

const WorkspaceCleanedPayloadSchema = z.object({
  task_id: z.string(),
  branch_preserved: z.boolean(),
});
type WorkspaceCleanedPayload = z.infer<typeof WorkspaceCleanedPayloadSchema>;

const WorkspaceMergeConflictPayloadSchema = z.object({
  task_id: z.string(),
  source_branch: z.string(),
  target_branch: z.string(),
  conflicting_files: z.array(z.string()),
});
type WorkspaceMergeConflictPayload = z.infer<typeof WorkspaceMergeConflictPayloadSchema>;
```

### `git.*` — Git Operations

**Owner:** Workspace Manager

```typescript
const GitBranchCreatedPayloadSchema = z.object({
  task_id: z.string(),
  repo: z.string(),
  branch: z.string(),
  from_ref: z.string(),
  commit_sha: z.string(),
});
type GitBranchCreatedPayload = z.infer<typeof GitBranchCreatedPayloadSchema>;

const GitCommittedPayloadSchema = z.object({
  task_id: z.string(),
  repo: z.string(),
  sha: z.string(),
  message: z.string(),
  files_changed: z.number().int(),
});
type GitCommittedPayload = z.infer<typeof GitCommittedPayloadSchema>;

const GitPushedPayloadSchema = z.object({
  task_id: z.string(),
  repo: z.string(),
  branch: z.string(),
  remote: z.string(),
  commits: z.number().int(),
  head_sha: z.string(),
});
type GitPushedPayload = z.infer<typeof GitPushedPayloadSchema>;

const GitPrOpenedPayloadSchema = z.object({
  task_id: z.string(),
  repo: z.string(),
  pr_number: z.number().int().positive(),
  draft: z.boolean(),
  title: z.string(),
  url: z.string(),
  base_branch: z.string(),
  head_branch: z.string(),
});
type GitPrOpenedPayload = z.infer<typeof GitPrOpenedPayloadSchema>;

const GitPrUpdatedPayloadSchema = z.object({
  task_id: z.string(),
  repo: z.string(),
  pr_number: z.number().int().positive(),
  draft: z.boolean(),
  previous_draft: z.boolean(),
  update_type: z.enum(["commits_added", "marked_ready", "description_updated"]),
});
type GitPrUpdatedPayload = z.infer<typeof GitPrUpdatedPayloadSchema>;

const GitPrMergedPayloadSchema = z.object({
  task_id: z.string(),
  repo: z.string(),
  pr_number: z.number().int().positive(),
  merge_strategy: z.enum(["merge", "squash", "rebase"]),
  merge_sha: z.string(),
  into_branch: z.string(),
});
type GitPrMergedPayload = z.infer<typeof GitPrMergedPayloadSchema>;

const GitMergeCompletedPayloadSchema = z.object({
  task_id: z.string(),
  repo: z.string(),
  source_branch: z.string(),
  target_branch: z.string(),
  merge_sha: z.string(),
  strategy: z.enum(["merge", "rebase"]),
});
type GitMergeCompletedPayload = z.infer<typeof GitMergeCompletedPayloadSchema>;
```

### `health.*` — System Health

**Owner:** Daemon

```typescript
const HealthStuckDetectedPayloadSchema = z.object({
  task_id: z.string(),
  condition: z.enum(["no_journal_entries", "no_state_transition", "orchestrator_crash"]),
  threshold_ms: z.number().int(),
  elapsed_ms: z.number().int(),
  last_activity: z.string().datetime().nullable(),
});
type HealthStuckDetectedPayload = z.infer<typeof HealthStuckDetectedPayloadSchema>;

const HealthTriggerFailurePayloadSchema = z.object({
  trigger_id: z.string(),
  consecutive_failures: z.number().int(),
  threshold: z.number().int(),
  last_error: z.string(),
  last_success: z.string().datetime().nullable(),
});
type HealthTriggerFailurePayload = z.infer<typeof HealthTriggerFailurePayloadSchema>;

const HealthConfigReloadFailedPayloadSchema = z.object({
  component: z.string(),
  config_file: z.string(),
  error: z.string(),
  running_config: z.string(),          // "previous" — kept valid config
});
type HealthConfigReloadFailedPayload = z.infer<typeof HealthConfigReloadFailedPayloadSchema>;
```

> **Reconciliation:** L2 used `threshold: duration` and `elapsed: duration`. Concrete schema uses `threshold_ms` and `elapsed_ms` (milliseconds).

### `comm.*` — Communication

**Owner:** Communication Plugins

```typescript
const CommMessageReceivedPayloadSchema = z.object({
  source: z.string(),                  // plugin ID: "telegram", "github"
  sender: z.string(),
  content: z.string(),
  reply_to: z.string().nullable(),
  task_id: z.string().nullable(),
  platform_metadata: z.record(z.unknown()),   // required, matches InboundMessage in adapters.md
});
type CommMessageReceivedPayload = z.infer<typeof CommMessageReceivedPayloadSchema>;

const CommMessageSentPayloadSchema = z.object({
  task_id: z.string().nullable(),
  target: z.string(),
  message_type: z.enum(["notification", "question", "status_response", "milestone", "alert"]),
  content_summary: z.string(),
  channel: z.string(),
});
type CommMessageSentPayload = z.infer<typeof CommMessageSentPayloadSchema>;
```

---

## SQLite Storage Notes

All 30 event types share one `events` table. The `payload` column stores the JSON blob. See [`sqlite.md`](sqlite.md) for the full DDL.

Key indexes:
- `(task_id, sequence)` — per-task ordered event retrieval
- `(type, timestamp)` — type-filtered queries (e.g., replay all `cost.incurred` events)
- `(sequence)` — global ordering for replay from snapshot
