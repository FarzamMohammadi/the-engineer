# Ephemeral State Schemas

In-memory state that is fully reconstructable on startup. Never persisted to SQLite. Source: [`../../2-components/daemon-scheduler.md`](../../2-components/daemon-scheduler.md), [`../../2-components/safety-layer.md`](../../2-components/safety-layer.md), [`../../2-components/workspace-manager.md`](../../2-components/workspace-manager.md).

**Persistence:** None — these types exist only in memory. On restart, they're rebuilt from Task Engine state, config files, and Event Bus replay.

---

## DaemonState

The Daemon's entire runtime state. Fully reconstructable from Task Engine queries and Registry config on restart.

```typescript
// --- Capacity ---

const CapacitySchema = z.object({
  max_concurrent: z.number().int().positive(),  // default: 1
  working_tasks: z.array(z.string()),            // task IDs in Active.Working or Active.Integrating
});
type Capacity = z.infer<typeof CapacitySchema>;

// Computed: available = max_concurrent - working_tasks.length

// --- Priority Queue Entry ---

const PrioritySourceSchema = z.enum(["explicit", "default", "aged"]);

const PrioritySchema = z.object({
  value: z.number().int().min(1).max(100),
  source: PrioritySourceSchema,
  base_value: z.number().int().min(1).max(100),  // original value before aging
  assigned_at: z.string().datetime(),
});
type Priority = z.infer<typeof PrioritySchema>;

const QueueEntrySchema = z.object({
  task_id: z.string(),
  priority: PrioritySchema,
  queued_at: z.string().datetime(),
  eligible: z.boolean(),                         // dependencies satisfied?
});
type QueueEntry = z.infer<typeof QueueEntrySchema>;

// --- Trigger State ---

const TriggerStateSchema = z.object({
  plugin_id: z.string(),
  poll_interval_ms: z.number().int().positive(), // milliseconds
  last_poll: z.string().datetime().nullable(),   // null before first poll
  consecutive_failures: z.number().int(),
});
type TriggerState = z.infer<typeof TriggerStateSchema>;

// --- Preemption ---

const PreemptionStatusSchema = z.enum(["requested", "checkpointing"]);

const PendingPreemptionSchema = z.object({
  target_task_id: z.string(),
  replacement_task_id: z.string(),
  requested_at: z.string().datetime(),
  status: PreemptionStatusSchema,
});
type PendingPreemption = z.infer<typeof PendingPreemptionSchema>;

// --- Health ---

const DaemonHealthSchema = z.object({
  started_at: z.string().datetime(),
  last_heartbeat: z.string().datetime(),
  tasks_completed: z.number().int(),             // lifetime counter
  // uptime: computed from Date.now() - started_at, not stored
});
type DaemonHealth = z.infer<typeof DaemonHealthSchema>;

// --- Daemon Config (loaded from config file, not from SQLite) ---
// SUPERSEDED: Full DaemonConfigSchema with defaults and 2 additional fields
// is in config.md. This version preserved for DaemonState reference.

const DaemonConfigSchema = z.object({
  tick_interval_ms: z.number().int().positive(),         // default: 5000
  preemption_threshold: z.number().int().positive(),     // default: 20
  preemption_timeout_ms: z.number().int().positive(),    // default: 60000
  stuck_threshold_ms: z.number().int().positive(),       // default: 1800000 (30 min)
  max_active_duration_ms: z.number().int().positive(),   // default: 28800000 (8 hours)
  aging_threshold_ms: z.number().int().positive(),       // default: 86400000 (24 hours)
  aging_increment: z.number().int().positive(),          // default: 5
  aging_interval_ms: z.number().int().positive(),        // default: 86400000 (24 hours)
  aging_cap: z.number().int().min(1).max(100),           // default: 75
  shutdown_timeout_ms: z.number().int().positive(),      // default: 30000
  trigger_poll_interval_ms: z.number().int().positive(), // default: 30000 (added Session 25)
  seen_keys_ttl_ms: z.number().int().positive(),         // default: 86400000 (added Session 25)
});
type DaemonConfig = z.infer<typeof DaemonConfigSchema>;

// --- Full DaemonState ---

const DaemonStateSchema = z.object({
  capacity: CapacitySchema,
  queue: z.array(QueueEntrySchema),
  triggers: z.array(TriggerStateSchema),
  seen_trigger_keys: z.record(z.number().int()),          // { [idempotency_key]: insertion_timestamp_ms } — TTL-based expiry
  pending_preemption: PendingPreemptionSchema.nullable(),
  health: DaemonHealthSchema,
  config: DaemonConfigSchema,
});
type DaemonState = z.infer<typeof DaemonStateSchema>;
```

### Reconstruction on Restart

| Field | How it's rebuilt |
|-------|-----------------|
| `capacity` | Scan Active tasks via Task Engine: `SELECT id FROM tasks WHERE state = 'active' AND sub_state IN ('working', 'integrating')` |
| `queue` | Scan Queued tasks: `SELECT id, priority FROM tasks WHERE state = 'queued'` |
| `triggers` | Reload from Registry config. `last_poll` starts null, `consecutive_failures` resets to 0. |
| `seen_trigger_keys` | Lost on restart. Worst case: duplicate task creation, caught by Task Engine dedup (idempotency key on `external_ref`). |
| `pending_preemption` | Lost. If Daemon crashed mid-preemption, the task remains Active.Working (safe state — no action needed). |
| `health` | Reset with new `started_at`. Lifetime counters lost (acceptable — not critical data). |
| `config` | Reloaded from config file. |

### Seen Trigger Keys: TTL

`seen_trigger_keys` is a record with time-based expiry. Each key maps to its insertion timestamp (ms since epoch). Keys older than a configurable TTL (e.g., 24 hours) are evicted to prevent unbounded memory growth. At runtime, this is a `Map<string, number>` — the `z.record(z.number())` schema documents the shape.

---

## Dispatch

The context package the Daemon hands to the Orchestrator when scheduling a task.

```typescript
const DispatchSchema = z.object({
  task: z.lazy(() => TaskSchema),                  // full Task object from Task Engine
  resume_from: z.lazy(() => CheckpointSchema).nullable(), // null for new tasks
  knowledge: z.object({
    repo: z.array(z.lazy(() => KnowledgeEntrySchema)),   // filtered by task's repo
    user: z.array(z.lazy(() => KnowledgeEntrySchema)),   // user-scope knowledge
  }),
});
type Dispatch = z.infer<typeof DispatchSchema>;
```

> **Note:** `z.lazy()` references here indicate cross-schema imports — not circular dependencies. The actual implementation will use direct imports from their respective modules.

---

## Safety Accumulators

Ephemeral cost tracking state. Rebuilt from `cost.incurred` events on startup, with periodic snapshots for fast recovery.

```typescript
// --- API spend tracking ---

const ApiTaskSpendSchema = z.object({
  cost_usd: z.number(),
});

const ApiWindowSpendSchema = z.object({
  cost_usd: z.number(),
  window_start: z.string().datetime(),
});

const ApiSpendSchema = z.object({
  per_task: z.record(ApiTaskSpendSchema),       // { [task_id]: { cost_usd } }
  daily: ApiWindowSpendSchema,
  monthly: ApiWindowSpendSchema,
  global: z.object({ cost_usd: z.number() }),
});
type ApiSpend = z.infer<typeof ApiSpendSchema>;

// --- CLI usage tracking ---

const CliProviderUsageSchema = z.object({
  requests_used: z.number().int(),
  tokens_used: z.number().int(),
  last_known_remaining: z.number().int().nullable(),
  last_known_reset: z.string().datetime().nullable(),
});
type CliProviderUsage = z.infer<typeof CliProviderUsageSchema>;

// --- Full accumulators ---

const CostAccumulatorsSchema = z.object({
  api_spend: ApiSpendSchema,
  cli_usage: z.record(CliProviderUsageSchema),   // { [provider_id]: usage }
});
type CostAccumulators = z.infer<typeof CostAccumulatorsSchema>;
```

### Snapshot Mechanism

Accumulators are rebuilt from `cost.incurred` events, but full replay on every startup is wasteful as event volume grows. Periodic snapshots provide fast recovery.

```typescript
const SafetySnapshotSchema = z.object({
  accumulators: CostAccumulatorsSchema,
  last_event_sequence: z.number().int(),         // events.sequence pointer
  snapshot_at: z.string().datetime(),
});
type SafetySnapshot = z.infer<typeof SafetySnapshotSchema>;
```

**Storage:** Serialized as JSON in the `_meta` table: `key = 'safety_snapshot'`, `value = JSON.stringify(snapshot)`.

**Lifecycle:**
1. **On startup:** Load snapshot from `_meta`. Replay events with `sequence > last_event_sequence`. If snapshot missing/corrupt: full replay (safe fallback).
2. **During operation:** Snapshot written after every N cost events (e.g., every 100) or on graceful shutdown.
3. **Window resets:** When a daily/monthly window resets, accumulators are zeroed for that window. The snapshot captures the reset state.

---

## Safety Config (Runtime)

Loaded from config file at startup, held in memory. Hot-reloadable without restart.

```typescript
// --- Cost Limits ---

const ApiLimitSchema = z.object({
  cost_usd: z.number().positive().nullable(),    // null = unlimited
  auto_resume_on_reset: z.boolean(),
});

const CliLimitSchema = z.object({
  daily_requests: z.number().int().positive().nullable(),
  daily_tokens: z.number().int().positive().nullable(),
  auto_resume_on_reset: z.boolean(),
});

const CostLimitsSchema = z.object({
  api: z.object({
    per_task: ApiLimitSchema,
    daily: ApiLimitSchema,
    monthly: ApiLimitSchema,
  }),
  cli: z.record(CliLimitSchema),                // { [provider_id]: limits }
});
type CostLimits = z.infer<typeof CostLimitsSchema>;

// --- Scope Boundaries ---

const ScopeBoundariesSchema = z.object({
  repos: z.object({
    allowed: z.array(z.string()).nullable(),     // null = unrestricted
  }),
  branches: z.object({
    create_pattern: z.string(),                  // regex: "engineer/.*"
    push_to: z.array(z.string()),                // "engineer/*"
    merge_to: z.array(z.string()),               // "main"
  }),
  files: z.object({
    exclude_patterns: z.array(z.string()),       // globs: [".env*", "secrets/**", "*.pem", "*.key"]
  }),
  external: z.object({
    allowed_domains: z.array(z.string()).nullable(), // null = unrestricted
  }),
});
type ScopeBoundaries = z.infer<typeof ScopeBoundariesSchema>;

// --- Autonomy Boundaries ---

const AutonomyLevelSchema = z.enum(["always_ask", "threshold", "always_decide"]);

const AutonomyDecisionSchema = z.object({
  level: AutonomyLevelSchema,
  threshold: z.string().nullable(),              // condition when level="threshold"
  description: z.string(),
});
type AutonomyDecision = z.infer<typeof AutonomyDecisionSchema>;

const AutonomyBoundariesSchema = z.object({
  decisions: z.record(AutonomyDecisionSchema),   // { [category]: decision }
  repo_overrides: z.record(z.object({
    decisions: z.record(AutonomyDecisionSchema.partial()),
  })),
});
type AutonomyBoundaries = z.infer<typeof AutonomyBoundariesSchema>;

// --- Response Timeout Policy ---

const TimeoutStageSchema = z.object({
  name: z.string(),
  after_ms: z.number().int().positive(),         // milliseconds
  action: z.string(),                            // "send_reminder", "evaluate_self_unblock", "escalation_alert"
  repeat: z.boolean().nullable(),                // null = no repeat
  repeat_interval_ms: z.number().int().positive().nullable(),
});
type TimeoutStage = z.infer<typeof TimeoutStageSchema>;

const ResponseTimeoutSchema = z.object({
  blocked: z.object({
    stages: z.array(TimeoutStageSchema),
  }),
  review_pending: z.object({
    reminder_after_ms: z.number().int().positive(),
    repeat_interval_ms: z.number().int().positive(),
  }),
});
type ResponseTimeout = z.infer<typeof ResponseTimeoutSchema>;

// --- Merge Policy ---

const MergePolicySchema = z.object({
  auto_merge: z.object({
    default: z.boolean(),                        // default: false
    repos: z.record(z.boolean()),                // { [repo]: boolean }
  }),
});
type MergePolicy = z.infer<typeof MergePolicySchema>;

// --- Full Safety Config ---

const SafetyConfigSchema = z.object({
  cost_limits: CostLimitsSchema,
  scope: ScopeBoundariesSchema,
  autonomy: AutonomyBoundariesSchema,
  response_timeout: ResponseTimeoutSchema,
  merge: MergePolicySchema,
});
type SafetyConfig = z.infer<typeof SafetyConfigSchema>;
```

### Safety Layer Runtime State

```typescript
const SafetyStateSchema = z.object({
  config: SafetyConfigSchema,
  accumulators: CostAccumulatorsSchema,
  intercepted_event_types: z.array(z.string()),  // derived from config at startup
});
type SafetyState = z.infer<typeof SafetyStateSchema>;
```

---

## Workspace Ephemeral State

The Workspace Manager tracks active worktrees in memory. The persistent artifact is the branch (and `workspace` field on the Task object), not the worktree directory.

```typescript
const WorktreeInfoSchema = z.object({
  task_id: z.string(),
  repo: z.string(),                              // "owner/repo"
  branch: z.string(),                            // "engineer/47-dark-mode"
  worktree_path: z.string(),                     // absolute filesystem path
  created_at: z.string().datetime(),
  status: z.enum(["active", "idle", "verifying"]),
});
type WorktreeInfo = z.infer<typeof WorktreeInfoSchema>;

// SUPERSEDED: Full WorkspaceConfigSchema with all L2 fields, defaults,
// and sub-objects (pr, cleanup, multi_repo) is in config.md.
// This 6-field version was the Session 24 partial — now replaced.

const WorkspaceConfigSchema = z.object({
  workspace_root: z.string(),
  branch_prefix: z.string(),
  slug_max_length: z.number().int().positive(),
  fetch_before_create: z.boolean(),
  default_base_branch: z.string(),
  pr: z.object({ /* see config.md */ }).passthrough(),
  cleanup: z.object({ /* see config.md */ }).passthrough(),
  child_pr_strategy: z.enum(["merge_into_parent", "individual_prs"]),
  multi_repo: z.object({ /* see config.md */ }).passthrough(),
});
type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>;

const WorkspaceStateSchema = z.object({
  config: WorkspaceConfigSchema,
  active_worktrees: z.record(WorktreeInfoSchema), // { [task_id]: worktree }
});
type WorkspaceState = z.infer<typeof WorkspaceStateSchema>;
```

### Reconstruction on Restart

1. **Config:** Reloaded from config file.
2. **Active worktrees:** Rebuilt by scanning Task Engine for tasks with non-null `workspace` fields, cross-referenced with filesystem (`git worktree list`). Stale worktrees (no matching task) are cleaned up.

---

## Event Bus Subscriptions

Registered at startup by each component. Held in memory.

```typescript
const EventSubscriptionSchema = z.object({
  subscriber_id: z.string(),
  event_type: z.string(),                       // or pattern: "task.*", "git.*"
  filter: z.record(z.unknown()).nullable(),      // field-level filter on payload
  callback: z.unknown(),                         // function reference — not serializable
});
type EventSubscription = z.infer<typeof EventSubscriptionSchema>;
```

> **Note:** `callback` is `z.unknown()` in the schema because function references can't be validated by Zod. The runtime type is `(event: Event) => void | Promise<void>`. This schema documents the shape, not validates the callback.
