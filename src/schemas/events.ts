import { z } from "zod";
import type { ZodType } from "zod";

import { MessageTypeSchema, PluginHealthStateSchema } from "./adapters.js";
import { ActionClassSchema, ExternalRefSchema, SubStateSchema, TaskStateSchema } from "./task.js";

// ── Event Envelope ─────────────────────────────────────────────────────────────

export const EventSchema = z.object({
  id: z.string(),
  sequence: z.number().int(),
  type: z.string(),
  source: z.string(),
  task_id: z.string().nullable(),
  timestamp: z.string().datetime(),
  payload: z.record(z.unknown()),
});
export type Event = z.infer<typeof EventSchema>;

// ── Subscription (runtime only, not persisted) ─────────────────────────────────

export const SubscriptionSchema = z.object({
  subscriber_id: z.string(),
  event_type: z.string(),
  filter: z.record(z.unknown()).nullable(),
});
export type Subscription = z.infer<typeof SubscriptionSchema>;

// ── Event Type Enum ────────────────────────────────────────────────────────────

export const EventTypeSchema = z.enum([
  "task.created",
  "task.state_changed",
  "task.rerun_requested",
  "action.rejected",
  "cost.incurred",
  "cost.limit_reached",
  "preemption.requested",
  "preemption.completed",
  "timeout.reminder",
  "timeout.self_unblock_check",
  "timeout.alert",
  "trigger.new_event",
  "workspace.created",
  "workspace.verified",
  "workspace.cleaned",
  "git.pr_merged",
  "git.branch_deleted",
  "health.stuck_detected",
  "health.trigger_failure",
  "health.plugin_unhealthy",
  "health.plugin_failed",
  "health.plugin_recovered",
  "comm.message_received",
  "comm.message_sent",
  "comm.send_failed",
  "comm.retry_succeeded",
  "comm.retry_exhausted",
  "evaluation.completed",
  "system.cleanup_completed",
  "system.reap_completed",
  "system.health_changed",
]);
export type EventType = z.infer<typeof EventTypeSchema>;

/** Constant enum values for EventType. Use instead of raw strings. */
export const EventTypes = EventTypeSchema.enum;

// ── Payload Schemas ────────────────────────────────────────────────────────────

// task.*

export const TaskCreatedPayloadSchema = z.object({
  task_id: z.string(),
  title: z.string(),
  external_ref: ExternalRefSchema.nullable(),
  idempotency_key: z.string(),
  source: z.string(),
  priority: z.number().int(),
  repo: z.string(),
});
export type TaskCreatedPayload = z.infer<typeof TaskCreatedPayloadSchema>;

/**
 * Owner asked (from the dashboard) to re-run a cancelled task as a fresh clone from its source. Written
 * directly to the events table by the dashboard process (which has no event bus), then picked up by the
 * daemon's response poller — the same cross-process path `comm.message_received` uses. Carries only the
 * source task's id; the daemon reads the rest off that task.
 */
export const TaskRerunRequestedPayloadSchema = z.object({
  task_id: z.string(),
});
export type TaskRerunRequestedPayload = z.infer<typeof TaskRerunRequestedPayloadSchema>;

export const TaskStateChangedPayloadSchema = z.object({
  task_id: z.string(),
  from_state: TaskStateSchema,
  from_sub: SubStateSchema.nullable(),
  to_state: TaskStateSchema,
  to_sub: SubStateSchema.nullable(),
  reason: z.string(),
  triggered_by: z.string(),
});
export type TaskStateChangedPayload = z.infer<typeof TaskStateChangedPayloadSchema>;

// action.*

export const ActionRejectedPayloadSchema = z.object({
  task_id: z.string(),
  action_class: ActionClassSchema,
  gate: z.enum(["task_engine", "safety_layer"]),
  reason: z.string(),
  details: z.record(z.unknown()).nullable(),
  requested_by: z.string(),
});
export type ActionRejectedPayload = z.infer<typeof ActionRejectedPayloadSchema>;

// cost.*

export const CostIncurredPayloadSchema = z.object({
  task_id: z.string(),
  repo: z.string(),
  provider_id: z.string(),
  operation: z.string(),
  spend_usd: z.number().nullable(),
  duration_ms: z.number().int().nullable(),
  // Optional token breakdown — null when CLI doesn't report it
  input_tokens: z.number().int().nullable().default(null),
  output_tokens: z.number().int().nullable().default(null),
  total_tokens: z.number().int().nullable().default(null),
  cache_read_tokens: z.number().int().nullable().default(null),
  cache_creation_tokens: z.number().int().nullable().default(null),
  model_id: z.string().nullable().default(null),
});
export type CostIncurredPayload = z.infer<typeof CostIncurredPayloadSchema>;

export const CostLimitReachedPayloadSchema = z.object({
  task_id: z.string().nullable(),
  limit_type: z.enum(["per_task", "daily", "monthly"]),
  limit_scope: z.string().nullable(),
  current_spend: z.number(),
  limit_value: z.number(),
  resets_at: z.string().datetime().nullable(),
});
export type CostLimitReachedPayload = z.infer<typeof CostLimitReachedPayloadSchema>;

// preemption.*

export const PreemptionRequestedPayloadSchema = z.object({
  target_task_id: z.string(),
  preempting_task_id: z.string(),
  reason: z.string(),
  priority_delta: z.number().int(),
});
export type PreemptionRequestedPayload = z.infer<typeof PreemptionRequestedPayloadSchema>;

export const PreemptionCompletedPayloadSchema = z.object({
  target_task_id: z.string(),
  preempting_task_id: z.string(),
  method: z.enum(["cooperative", "forced"]),
});
export type PreemptionCompletedPayload = z.infer<typeof PreemptionCompletedPayloadSchema>;

// timeout.*

export const TimeoutReminderPayloadSchema = z.object({
  task_id: z.string(),
  blocked_since: z.string().datetime(),
  elapsed_ms: z.number().int(),
  channel: z.string(),
  question_summary: z.string(),
});
export type TimeoutReminderPayload = z.infer<typeof TimeoutReminderPayloadSchema>;

export const TimeoutSelfUnblockCheckPayloadSchema = z.object({
  task_id: z.string(),
  blocked_since: z.string().datetime(),
  elapsed_ms: z.number().int(),
  decision_category: z.string(),
  can_self_unblock: z.boolean(),
});
export type TimeoutSelfUnblockCheckPayload = z.infer<typeof TimeoutSelfUnblockCheckPayloadSchema>;

export const TimeoutAlertPayloadSchema = z.object({
  task_id: z.string(),
  blocked_since: z.string().datetime(),
  elapsed_ms: z.number().int(),
  escalation: z.string(),
});
export type TimeoutAlertPayload = z.infer<typeof TimeoutAlertPayloadSchema>;

// trigger.*

export const TriggerNewEventPayloadSchema = z.object({
  idempotency_key: z.string(),
  source: z.string(),
  event_type: z.string(),
  external_ref: ExternalRefSchema.nullable(),
  title: z.string(),
  body: z.string().nullable(),
  repo: z.string(),
  clone_url: z.string(),
  metadata: z.record(z.unknown()).nullable(),
});
export type TriggerNewEventPayload = z.infer<typeof TriggerNewEventPayloadSchema>;

// workspace.*

export const WorkspaceCreatedPayloadSchema = z.object({
  task_id: z.string(),
  repo: z.string(),
  branch: z.string(),
  worktree_path: z.string(),
  base_branch: z.string(),
  base_commit: z.string(),
});
export type WorkspaceCreatedPayload = z.infer<typeof WorkspaceCreatedPayloadSchema>;

export const WorkspaceVerifiedPayloadSchema = z.object({
  task_id: z.string(),
  status: z.enum(["valid", "recoverable", "lost"]),
  current_commit: z.string().nullable(),
  recovery_action: z.string().nullable(),
});
export type WorkspaceVerifiedPayload = z.infer<typeof WorkspaceVerifiedPayloadSchema>;

export const WorkspaceCleanedPayloadSchema = z.object({
  task_id: z.string(),
  branch_preserved: z.boolean(),
});
export type WorkspaceCleanedPayload = z.infer<typeof WorkspaceCleanedPayloadSchema>;

// git.*

export const GitPrMergedPayloadSchema = z.object({
  task_id: z.string(),
  repo: z.string(),
  pr_number: z.number().int().positive(),
  merge_strategy: z.enum(["merge", "squash", "rebase"]),
  merge_sha: z.string(),
  into_branch: z.string(),
});
export type GitPrMergedPayload = z.infer<typeof GitPrMergedPayloadSchema>;

export const GitBranchDeletedPayloadSchema = z.object({
  task_id: z.string(),
  repo: z.string(),
  branch: z.string(),
});
export type GitBranchDeletedPayload = z.infer<typeof GitBranchDeletedPayloadSchema>;

// health.*

export const HealthStuckDetectedPayloadSchema = z.object({
  task_id: z.string(),
  condition: z.enum(["no_journal_entries", "stale_journal", "no_state_transition", "orchestrator_crash"]),
  threshold_ms: z.number().int(),
  elapsed_ms: z.number().int(),
  last_activity: z.string().datetime().nullable(),
});
export type HealthStuckDetectedPayload = z.infer<typeof HealthStuckDetectedPayloadSchema>;

export const HealthTriggerFailurePayloadSchema = z.object({
  trigger_id: z.string(),
  consecutive_failures: z.number().int(),
  threshold: z.number().int(),
  last_error: z.string(),
  last_success: z.string().datetime().nullable(),
});
export type HealthTriggerFailurePayload = z.infer<typeof HealthTriggerFailurePayloadSchema>;

export const HealthPluginUnhealthyPayloadSchema = z.object({
  plugin_id: z.string(),
  plugin_type: z.string(),
  error: z.string(),
  consecutive_failures: z.number().int(),
});
export type HealthPluginUnhealthyPayload = z.infer<typeof HealthPluginUnhealthyPayloadSchema>;

export const HealthPluginFailedPayloadSchema = z.object({
  plugin_id: z.string(),
  plugin_type: z.string(),
  error: z.string(),
  consecutive_failures: z.number().int(),
  threshold: z.number().int(),
});
export type HealthPluginFailedPayload = z.infer<typeof HealthPluginFailedPayloadSchema>;

export const HealthPluginRecoveredPayloadSchema = z.object({
  plugin_id: z.string(),
  plugin_type: z.string(),
  previous_state: z.enum(["unhealthy", "failed"]),
});
export type HealthPluginRecoveredPayload = z.infer<typeof HealthPluginRecoveredPayloadSchema>;

// The CURRENT per-plugin health snapshot is NOT an event. It is a single-row `_meta` cache the registry
// overwrites each health-check cycle (mirroring the cost tracker's `safety_snapshot`), keeping this
// high-frequency state off the audit ledger. The transition events above
// (`plugin_unhealthy`/`plugin_failed`/`plugin_recovered`) remain the audit trail of *changes*. See
// `src/core/registry/plugin-health.ts` for the writer and `src/dashboard/api/system.ts` for the reader.

// comm.*

export const CommMessageReceivedPayloadSchema = z.object({
  source: z.string(),
  sender: z.string(),
  content: z.string(),
  reply_to: z.string().nullable(),
  task_id: z.string().nullable(),
  platform_metadata: z.record(z.unknown()),
});
export type CommMessageReceivedPayload = z.infer<typeof CommMessageReceivedPayloadSchema>;

export const CommMessageSentPayloadSchema = z.object({
  task_id: z.string().nullable(),
  target: z.string(),
  message_type: MessageTypeSchema,
  content_summary: z.string(),
  channel: z.string(),
});
export type CommMessageSentPayload = z.infer<typeof CommMessageSentPayloadSchema>;

export const CommSendFailedPayloadSchema = z.object({
  task_id: z.string(),
  person_id: z.string(),
  kind: z.string(),
  channels_tried: z.array(z.string()),
  retryable: z.boolean(),
});
export type CommSendFailedPayload = z.infer<typeof CommSendFailedPayloadSchema>;

export const CommRetrySucceededPayloadSchema = z.object({
  task_id: z.string(),
  person_id: z.string(),
  kind: z.string(),
  channel: z.string(),
  attempt: z.number().int(),
});
export type CommRetrySucceededPayload = z.infer<typeof CommRetrySucceededPayloadSchema>;

export const CommRetryExhaustedPayloadSchema = z.object({
  task_id: z.string(),
  person_id: z.string(),
  kind: z.string(),
  attempts: z.number().int(),
  reason: z.string(),
});
export type CommRetryExhaustedPayload = z.infer<typeof CommRetryExhaustedPayloadSchema>;

// evaluation.*

export const EvaluationCompletedPayloadSchema = z.object({
  task_id: z.string(),
  evaluation_dir: z.string(),
  total_cost_usd: z.number().nullable(),
  duration_ms: z.number().int(),
  status: z.enum(["completed", "failed"]),
});
export type EvaluationCompletedPayload = z.infer<typeof EvaluationCompletedPayloadSchema>;

// system.*

export const SystemCleanupCompletedPayloadSchema = z.object({
  duration_ms: z.number().int(),
  tables: z.record(
    z.object({
      deleted: z.number().int(),
      remaining: z.number().int(),
    }),
  ),
  /** Distinct blob refs the retained observations still point at — the protected set's size. */
  blobs_referenced: z.number().int(),
  /** Blob files the sweep walked on disk (0 when blob cleanup was skipped by the drift tripwire). */
  blobs_scanned: z.number().int(),
  blobs_deleted: z.number().int(),
  /** True when the drift tripwire refused blob cleanup this sweep (protected set empty while refs still exist). */
  blob_cleanup_skipped: z.boolean(),
  vacuum_ran: z.boolean(),
});
export type SystemCleanupCompletedPayload = z.infer<typeof SystemCleanupCompletedPayloadSchema>;

/**
 * One workspace-reaper reconciliation sweep — the durable, cross-process record of cleanup. The reaper's
 * in-memory `getLastRun()` lives in the daemon process and is unreachable from the dashboard's separate
 * process, so each sweep publishes this event (mirroring data-lifecycle's `system.cleanup_completed`) and
 * the dashboard surfaces recent sweeps from the events table. Fields mirror `ReapStats`.
 */
export const SystemReapCompletedPayloadSchema = z.object({
  /** Unreaped terminal tasks examined this sweep. */
  scanned: z.number().int(),
  /** Fully reconciled (reaped_at stamped). */
  reaped: z.number().int(),
  /** Not reaped — a dispatch was in flight (never reap a workspace out from under a running agent). */
  skipped_in_flight: z.number().int(),
  /** Not reaped this sweep for a non-error reason (a merged branch still inside its retention window). */
  deferred: z.number().int(),
  /** Reap attempted and threw — reaped_at left NULL, retried next sweep. */
  failed: z.number().int(),
  duration_ms: z.number().int(),
});
export type SystemReapCompletedPayload = z.infer<typeof SystemReapCompletedPayloadSchema>;

/**
 * A daemon-internal component's health changed (e.g. the daemon's own memory crossing the critical RSS
 * threshold). Mirrors a plugin health record's shape — component name, the new health state, and a
 * human-readable reason — so the dashboard and audit trail render system health uniformly with plugin health.
 */
export const SystemHealthChangedPayloadSchema = z.object({
  component: z.string(),
  status: PluginHealthStateSchema,
  message: z.string(),
});
export type SystemHealthChangedPayload = z.infer<typeof SystemHealthChangedPayloadSchema>;

// ── EventPayloads mapped type ──────────────────────────────────────────────────

export type EventPayloads = {
  "task.created": TaskCreatedPayload;
  "task.state_changed": TaskStateChangedPayload;
  "task.rerun_requested": TaskRerunRequestedPayload;
  "action.rejected": ActionRejectedPayload;
  "cost.incurred": CostIncurredPayload;
  "cost.limit_reached": CostLimitReachedPayload;
  "preemption.requested": PreemptionRequestedPayload;
  "preemption.completed": PreemptionCompletedPayload;
  "timeout.reminder": TimeoutReminderPayload;
  "timeout.self_unblock_check": TimeoutSelfUnblockCheckPayload;
  "timeout.alert": TimeoutAlertPayload;
  "trigger.new_event": TriggerNewEventPayload;
  "workspace.created": WorkspaceCreatedPayload;
  "workspace.verified": WorkspaceVerifiedPayload;
  "workspace.cleaned": WorkspaceCleanedPayload;
  "git.pr_merged": GitPrMergedPayload;
  "git.branch_deleted": GitBranchDeletedPayload;
  "health.stuck_detected": HealthStuckDetectedPayload;
  "health.trigger_failure": HealthTriggerFailurePayload;
  "health.plugin_unhealthy": HealthPluginUnhealthyPayload;
  "health.plugin_failed": HealthPluginFailedPayload;
  "health.plugin_recovered": HealthPluginRecoveredPayload;
  "comm.message_received": CommMessageReceivedPayload;
  "comm.message_sent": CommMessageSentPayload;
  "comm.send_failed": CommSendFailedPayload;
  "comm.retry_succeeded": CommRetrySucceededPayload;
  "comm.retry_exhausted": CommRetryExhaustedPayload;
  "evaluation.completed": EvaluationCompletedPayload;
  "system.cleanup_completed": SystemCleanupCompletedPayload;
  "system.reap_completed": SystemReapCompletedPayload;
  "system.health_changed": SystemHealthChangedPayload;
};

// ── TypedEvent generic ─────────────────────────────────────────────────────────

export type TypedEvent<T extends keyof EventPayloads> = Omit<Event, "payload" | "type"> & {
  type: T;
  payload: EventPayloads[T];
};

// ── Runtime payload schema registry ────────────────────────────────────────────

export const eventPayloadSchemas: Record<EventType, ZodType> = {
  "task.created": TaskCreatedPayloadSchema,
  "task.state_changed": TaskStateChangedPayloadSchema,
  "task.rerun_requested": TaskRerunRequestedPayloadSchema,
  "action.rejected": ActionRejectedPayloadSchema,
  "cost.incurred": CostIncurredPayloadSchema,
  "cost.limit_reached": CostLimitReachedPayloadSchema,
  "preemption.requested": PreemptionRequestedPayloadSchema,
  "preemption.completed": PreemptionCompletedPayloadSchema,
  "timeout.reminder": TimeoutReminderPayloadSchema,
  "timeout.self_unblock_check": TimeoutSelfUnblockCheckPayloadSchema,
  "timeout.alert": TimeoutAlertPayloadSchema,
  "trigger.new_event": TriggerNewEventPayloadSchema,
  "workspace.created": WorkspaceCreatedPayloadSchema,
  "workspace.verified": WorkspaceVerifiedPayloadSchema,
  "workspace.cleaned": WorkspaceCleanedPayloadSchema,
  "git.pr_merged": GitPrMergedPayloadSchema,
  "git.branch_deleted": GitBranchDeletedPayloadSchema,
  "health.stuck_detected": HealthStuckDetectedPayloadSchema,
  "health.trigger_failure": HealthTriggerFailurePayloadSchema,
  "health.plugin_unhealthy": HealthPluginUnhealthyPayloadSchema,
  "health.plugin_failed": HealthPluginFailedPayloadSchema,
  "health.plugin_recovered": HealthPluginRecoveredPayloadSchema,
  "comm.message_received": CommMessageReceivedPayloadSchema,
  "comm.message_sent": CommMessageSentPayloadSchema,
  "comm.send_failed": CommSendFailedPayloadSchema,
  "comm.retry_succeeded": CommRetrySucceededPayloadSchema,
  "comm.retry_exhausted": CommRetryExhaustedPayloadSchema,
  "evaluation.completed": EvaluationCompletedPayloadSchema,
  "system.cleanup_completed": SystemCleanupCompletedPayloadSchema,
  "system.reap_completed": SystemReapCompletedPayloadSchema,
  "system.health_changed": SystemHealthChangedPayloadSchema,
};
