import { z } from "zod";
import type { ZodType } from "zod";

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
  "task.children_all_done",
  "task.feedback_received",
  "action.rejected",
  "cost.incurred",
  "cost.limit_reached",
  "cost.quota_exhausted",
  "preemption.requested",
  "preemption.ready",
  "preemption.completed",
  "timeout.reminder",
  "timeout.self_unblock_check",
  "timeout.alert",
  "trigger.new_event",
  "workspace.created",
  "workspace.verified",
  "workspace.cleaned",
  "workspace.merge_conflict",
  "git.branch_created",
  "git.committed",
  "git.pushed",
  "git.pr_opened",
  "git.pr_updated",
  "git.pr_merged",
  "git.merge_completed",
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
  "review.poll_completed",
  "evaluation.completed",
  "system.cleanup_completed",
]);
export type EventType = z.infer<typeof EventTypeSchema>;

/** Constant enum values for EventType. Use instead of raw strings. */
export const EventTypes = EventTypeSchema.enum;

// ── Payload Schemas ────────────────────────────────────────────────────────────

// task.*

export const TaskCreatedPayloadSchema = z.object({
  task_id: z.string(),
  parent_id: z.string().nullable(),
  title: z.string(),
  external_ref: ExternalRefSchema.nullable(),
  idempotency_key: z.string(),
  source: z.string(),
  priority: z.number().int(),
  repo: z.string(),
});
export type TaskCreatedPayload = z.infer<typeof TaskCreatedPayloadSchema>;

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

export const TaskChildrenAllDonePayloadSchema = z.object({
  parent_task_id: z.string(),
  child_ids: z.array(z.string()),
  all_succeeded: z.boolean(),
  failed_ids: z.array(z.string()),
});
export type TaskChildrenAllDonePayload = z.infer<typeof TaskChildrenAllDonePayloadSchema>;

export const TaskFeedbackReceivedPayloadSchema = z.object({
  task_id: z.string(),
  stage: z.literal("code"),
  feedback_type: z.enum(["approved", "changes_requested", "comment"]),
  reviewer: z.string(),
  content: z.string().nullable(),
  pr_number: z.number().int().positive(),
});
export type TaskFeedbackReceivedPayload = z.infer<typeof TaskFeedbackReceivedPayloadSchema>;

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

export const CostQuotaExhaustedPayloadSchema = z.object({
  provider_id: z.string(),
  window_type: z.string(),
  resets_at: z.number().int().nullable(),
  task_id: z.string().nullable(),
});
export type CostQuotaExhaustedPayload = z.infer<typeof CostQuotaExhaustedPayloadSchema>;

// preemption.*

export const PreemptionRequestedPayloadSchema = z.object({
  target_task_id: z.string(),
  preempting_task_id: z.string(),
  reason: z.string(),
  priority_delta: z.number().int(),
});
export type PreemptionRequestedPayload = z.infer<typeof PreemptionRequestedPayloadSchema>;

export const PreemptionReadyPayloadSchema = z.object({
  task_id: z.string(),
  checkpoint_id: z.string(),
  phase: z.string(),
  atomic_op: z.string(),
});
export type PreemptionReadyPayload = z.infer<typeof PreemptionReadyPayloadSchema>;

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

export const WorkspaceMergeConflictPayloadSchema = z.object({
  task_id: z.string(),
  source_branch: z.string(),
  target_branch: z.string(),
  conflicting_files: z.array(z.string()),
});
export type WorkspaceMergeConflictPayload = z.infer<typeof WorkspaceMergeConflictPayloadSchema>;

// git.*

export const GitBranchCreatedPayloadSchema = z.object({
  task_id: z.string(),
  repo: z.string(),
  branch: z.string(),
  from_ref: z.string(),
  commit_sha: z.string(),
});
export type GitBranchCreatedPayload = z.infer<typeof GitBranchCreatedPayloadSchema>;

export const GitCommittedPayloadSchema = z.object({
  task_id: z.string(),
  repo: z.string(),
  sha: z.string(),
  message: z.string(),
  files_changed: z.number().int(),
});
export type GitCommittedPayload = z.infer<typeof GitCommittedPayloadSchema>;

export const GitPushedPayloadSchema = z.object({
  task_id: z.string(),
  repo: z.string(),
  branch: z.string(),
  remote: z.string(),
  commits: z.number().int(),
  head_sha: z.string(),
});
export type GitPushedPayload = z.infer<typeof GitPushedPayloadSchema>;

export const GitPrOpenedPayloadSchema = z.object({
  task_id: z.string(),
  repo: z.string(),
  pr_number: z.number().int().positive(),
  draft: z.boolean(),
  title: z.string(),
  url: z.string(),
  base_branch: z.string(),
  head_branch: z.string(),
});
export type GitPrOpenedPayload = z.infer<typeof GitPrOpenedPayloadSchema>;

export const GitPrUpdatedPayloadSchema = z.object({
  task_id: z.string(),
  repo: z.string(),
  pr_number: z.number().int().positive(),
  draft: z.boolean(),
  previous_draft: z.boolean(),
  update_type: z.enum(["commits_added", "marked_ready", "description_updated"]),
});
export type GitPrUpdatedPayload = z.infer<typeof GitPrUpdatedPayloadSchema>;

export const GitPrMergedPayloadSchema = z.object({
  task_id: z.string(),
  repo: z.string(),
  pr_number: z.number().int().positive(),
  merge_strategy: z.enum(["merge", "squash", "rebase"]),
  merge_sha: z.string(),
  into_branch: z.string(),
});
export type GitPrMergedPayload = z.infer<typeof GitPrMergedPayloadSchema>;

export const GitMergeCompletedPayloadSchema = z.object({
  task_id: z.string(),
  repo: z.string(),
  source_branch: z.string(),
  target_branch: z.string(),
  merge_sha: z.string(),
  strategy: z.enum(["merge", "rebase"]),
});
export type GitMergeCompletedPayload = z.infer<typeof GitMergeCompletedPayloadSchema>;

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
  message_type: z.enum(["notification", "question", "status_response", "milestone", "alert"]),
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

// review.*

export const ReviewPollCompletedPayloadSchema = z.object({
  task_id: z.string(),
  pr_number: z.number().int().positive(),
  repo: z.string(),
  aggregate_state: z.enum(["approved", "changes_requested", "comment", "none"]),
  approvals: z.number().int(),
  changes_requested_count: z.number().int(),
  comment_count: z.number().int(),
  reviewer_count: z.number().int(),
  pr_draft: z.boolean(),
  dedup_skipped: z.boolean(),
});
export type ReviewPollCompletedPayload = z.infer<typeof ReviewPollCompletedPayloadSchema>;

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
  blobs_deleted: z.number().int(),
  vacuum_ran: z.boolean(),
});
export type SystemCleanupCompletedPayload = z.infer<typeof SystemCleanupCompletedPayloadSchema>;

// ── EventPayloads mapped type ──────────────────────────────────────────────────

export type EventPayloads = {
  "task.created": TaskCreatedPayload;
  "task.state_changed": TaskStateChangedPayload;
  "task.children_all_done": TaskChildrenAllDonePayload;
  "task.feedback_received": TaskFeedbackReceivedPayload;
  "action.rejected": ActionRejectedPayload;
  "cost.incurred": CostIncurredPayload;
  "cost.limit_reached": CostLimitReachedPayload;
  "cost.quota_exhausted": CostQuotaExhaustedPayload;
  "preemption.requested": PreemptionRequestedPayload;
  "preemption.ready": PreemptionReadyPayload;
  "preemption.completed": PreemptionCompletedPayload;
  "timeout.reminder": TimeoutReminderPayload;
  "timeout.self_unblock_check": TimeoutSelfUnblockCheckPayload;
  "timeout.alert": TimeoutAlertPayload;
  "trigger.new_event": TriggerNewEventPayload;
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
  "review.poll_completed": ReviewPollCompletedPayload;
  "evaluation.completed": EvaluationCompletedPayload;
  "system.cleanup_completed": SystemCleanupCompletedPayload;
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
  "task.children_all_done": TaskChildrenAllDonePayloadSchema,
  "task.feedback_received": TaskFeedbackReceivedPayloadSchema,
  "action.rejected": ActionRejectedPayloadSchema,
  "cost.incurred": CostIncurredPayloadSchema,
  "cost.limit_reached": CostLimitReachedPayloadSchema,
  "cost.quota_exhausted": CostQuotaExhaustedPayloadSchema,
  "preemption.requested": PreemptionRequestedPayloadSchema,
  "preemption.ready": PreemptionReadyPayloadSchema,
  "preemption.completed": PreemptionCompletedPayloadSchema,
  "timeout.reminder": TimeoutReminderPayloadSchema,
  "timeout.self_unblock_check": TimeoutSelfUnblockCheckPayloadSchema,
  "timeout.alert": TimeoutAlertPayloadSchema,
  "trigger.new_event": TriggerNewEventPayloadSchema,
  "workspace.created": WorkspaceCreatedPayloadSchema,
  "workspace.verified": WorkspaceVerifiedPayloadSchema,
  "workspace.cleaned": WorkspaceCleanedPayloadSchema,
  "workspace.merge_conflict": WorkspaceMergeConflictPayloadSchema,
  "git.branch_created": GitBranchCreatedPayloadSchema,
  "git.committed": GitCommittedPayloadSchema,
  "git.pushed": GitPushedPayloadSchema,
  "git.pr_opened": GitPrOpenedPayloadSchema,
  "git.pr_updated": GitPrUpdatedPayloadSchema,
  "git.pr_merged": GitPrMergedPayloadSchema,
  "git.merge_completed": GitMergeCompletedPayloadSchema,
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
  "review.poll_completed": ReviewPollCompletedPayloadSchema,
  "evaluation.completed": EvaluationCompletedPayloadSchema,
  "system.cleanup_completed": SystemCleanupCompletedPayloadSchema,
};
