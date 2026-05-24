import { z } from "zod";

import { DaemonConfigSchema, SafetyConfigSchema, WorkspaceConfigSchema } from "./config.js";
import { CheckpointSchema, KnowledgeEntrySchema } from "./session-memory.js";
import { TaskSchema } from "./task.js";

// ── Daemon State ────────────────────────────────────────────────────────────────
// Fully reconstructable on restart from Task Engine state, config files, and
// Event Bus replay. See ephemeral.md § Reconstruction on Restart.

export const CapacitySchema = z.object({
  max_concurrent: z.number().int().positive(),
  working_tasks: z.array(z.string()),
});
export type Capacity = z.infer<typeof CapacitySchema>;

export const PrioritySourceSchema = z.enum(["explicit", "default", "aged"]);
export type PrioritySource = z.infer<typeof PrioritySourceSchema>;

/** Constant enum values for PrioritySource. Use instead of raw strings. */
export const PrioritySources = PrioritySourceSchema.enum;

export const PrioritySchema = z.object({
  value: z.number().int().min(1).max(100),
  source: PrioritySourceSchema,
  base_value: z.number().int().min(1).max(100),
  assigned_at: z.string().datetime(),
});
export type Priority = z.infer<typeof PrioritySchema>;

export const QueueEntrySchema = z.object({
  task_id: z.string(),
  priority: PrioritySchema,
  queued_at: z.string().datetime(),
  eligible: z.boolean(),
});
export type QueueEntry = z.infer<typeof QueueEntrySchema>;

export const TriggerStateSchema = z.object({
  plugin_id: z.string(),
  poll_interval_ms: z.number().int().positive(),
  last_poll: z.string().datetime().nullable(),
  consecutive_failures: z.number().int(),
});
export type TriggerState = z.infer<typeof TriggerStateSchema>;

export const PreemptionStatusSchema = z.enum(["requested", "checkpointing"]);
export type PreemptionStatus = z.infer<typeof PreemptionStatusSchema>;

/** Constant enum values for PreemptionStatus. Use instead of raw strings. */
export const PreemptionStatuses = PreemptionStatusSchema.enum;

export const PendingPreemptionSchema = z.object({
  target_task_id: z.string(),
  replacement_task_id: z.string(),
  requested_at: z.string().datetime(),
  status: PreemptionStatusSchema,
});
export type PendingPreemption = z.infer<typeof PendingPreemptionSchema>;

export const DaemonHealthSchema = z.object({
  started_at: z.string().datetime(),
  last_heartbeat: z.string().datetime(),
  tasks_completed: z.number().int(),
});
export type DaemonHealth = z.infer<typeof DaemonHealthSchema>;

export const DaemonStateSchema = z.object({
  capacity: CapacitySchema,
  queue: z.array(QueueEntrySchema),
  triggers: z.array(TriggerStateSchema),
  seen_trigger_keys: z.record(z.number().int()),
  pending_preemption: PendingPreemptionSchema.nullable(),
  health: DaemonHealthSchema,
  config: DaemonConfigSchema,
});
export type DaemonState = z.infer<typeof DaemonStateSchema>;

// ── Dispatch ────────────────────────────────────────────────────────────────────
// The context package the Daemon hands to the Orchestrator when scheduling a task.
//
// The schema covers the *serializable* dispatch payload — fields persisted to
// the journal, replayed at boot, or inspected by tests. The runtime `Dispatch`
// type extends it with `signal`, an AbortSignal owned by the dispatch-tracker
// that lets phase-runner / llm-caller / LLM plugins honor force-termination.
// `signal` is runtime infrastructure, not parsed input, so it lives outside
// the Zod schema by design (see Parse-Don't-Validate in coding-standards § 4).

export const DispatchSchema = z.object({
  task: TaskSchema,
  resume_from: CheckpointSchema.nullable(),
  knowledge: z.object({
    repo: z.array(KnowledgeEntrySchema),
    user: z.array(KnowledgeEntrySchema),
  }),
});
export type DispatchPayload = z.infer<typeof DispatchSchema>;

export type Dispatch = DispatchPayload & {
  /** Aborted by `dispatchTracker.terminate(...)`. Slice 6 ships the wiring;
   *  honoring through phase-runner → llm-caller → LLM plugins lands in Slice 8. */
  readonly signal: AbortSignal;
};

// ── Safety Accumulators ─────────────────────────────────────────────────────────
// Ephemeral cost tracking state. Rebuilt from cost.incurred events on startup,
// with periodic snapshots for fast recovery.

export const ApiTaskSpendSchema = z.object({
  cost_usd: z.number(),
});
export type ApiTaskSpend = z.infer<typeof ApiTaskSpendSchema>;

export const ApiWindowSpendSchema = z.object({
  cost_usd: z.number(),
  window_start: z.string().datetime(),
});
export type ApiWindowSpend = z.infer<typeof ApiWindowSpendSchema>;

export const ApiSpendSchema = z.object({
  per_task: z.record(ApiTaskSpendSchema),
  daily: ApiWindowSpendSchema,
  monthly: ApiWindowSpendSchema,
  global: z.object({ cost_usd: z.number() }),
});
export type ApiSpend = z.infer<typeof ApiSpendSchema>;

export const CliProviderUsageSchema = z.object({
  requests_used: z.number().int(),
  tokens_used: z.number().int(),
  last_known_remaining: z.number().int().nullable(),
  last_known_reset: z.string().datetime().nullable(),
});
export type CliProviderUsage = z.infer<typeof CliProviderUsageSchema>;

export const CostAccumulatorsSchema = z.object({
  api_spend: ApiSpendSchema,
  cli_usage: z.record(CliProviderUsageSchema),
});
export type CostAccumulators = z.infer<typeof CostAccumulatorsSchema>;

export const SafetySnapshotSchema = z.object({
  accumulators: CostAccumulatorsSchema,
  last_event_sequence: z.number().int(),
  snapshot_at: z.string().datetime(),
});
export type SafetySnapshot = z.infer<typeof SafetySnapshotSchema>;

// ── Safety State ────────────────────────────────────────────────────────────────

export const SafetyStateSchema = z.object({
  config: SafetyConfigSchema,
  accumulators: CostAccumulatorsSchema,
  intercepted_event_types: z.array(z.string()),
});
export type SafetyState = z.infer<typeof SafetyStateSchema>;

// ── Workspace State ─────────────────────────────────────────────────────────────
// Active worktrees tracked in memory. Rebuilt on restart by scanning Task Engine
// for tasks with non-null workspace fields, cross-referenced with filesystem.

export const WorktreeInfoSchema = z.object({
  task_id: z.string(),
  repo: z.string(),
  branch: z.string(),
  worktree_path: z.string(),
  created_at: z.string().datetime(),
  status: z.enum(["active", "idle", "verifying"]),
});
export type WorktreeInfo = z.infer<typeof WorktreeInfoSchema>;

export const WorkspaceStateSchema = z.object({
  config: WorkspaceConfigSchema,
  active_worktrees: z.record(WorktreeInfoSchema),
});
export type WorkspaceState = z.infer<typeof WorkspaceStateSchema>;

// ── Event Bus Subscriptions ─────────────────────────────────────────────────────
// Registered at startup by each component. Held in memory.
// callback is z.unknown() because function references can't be validated by Zod.
// The runtime type is (event: Event) => void | Promise<void>.

export const EventSubscriptionSchema = z.object({
  subscriber_id: z.string(),
  event_type: z.string(),
  filter: z.record(z.unknown()).nullable(),
  callback: z.unknown(),
});
export type EventSubscription = z.infer<typeof EventSubscriptionSchema>;
