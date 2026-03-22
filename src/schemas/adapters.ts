import { z } from "zod";

// ── Universal Adapter Contract ──────────────────────────────────────────────────

export const AdapterTypeSchema = z.enum(["trigger", "communication", "llm", "tool", "git_hosting"]);
export type AdapterType = z.infer<typeof AdapterTypeSchema>;

/** Constant enum values for AdapterType. Use instead of raw strings. */
export const AdapterTypes = AdapterTypeSchema.enum;

export const PluginManifestSchema = z.object({
  id: z.string(),
  type: AdapterTypeSchema,
  version: z.string(),
  name: z.string(),
  description: z.string(),
  config_schema: z.record(z.unknown()).default({}),
  critical: z.boolean().default(true),
  enabled: z.boolean().default(true),
  entry: z.string().default("index.ts"),
  adapter_meta: z.record(z.unknown()).default({}),
  contributes: z
    .object({
      events: z.array(z.string()).default([]),
      commands: z.array(z.string()).default([]),
      config_keys: z.array(z.string()).default([]),
      hooks: z.array(z.string()).default([]),
    })
    .default({}),
});
export type PluginManifest = z.infer<typeof PluginManifestSchema>;

export const InitResultSchema = z.object({
  success: z.boolean(),
  message: z.string().nullable(),
});
export type InitResult = z.infer<typeof InitResultSchema>;

export const HealthStatusSchema = z.object({
  healthy: z.boolean(),
  message: z.string().nullable(),
  details: z.record(z.unknown()).nullable(),
});
export type HealthStatus = z.infer<typeof HealthStatusSchema>;

export const AdapterErrorSeveritySchema = z.enum(["warning", "error", "fatal"]);
export type AdapterErrorSeverity = z.infer<typeof AdapterErrorSeveritySchema>;

/** Constant enum values for AdapterErrorSeverity. Use instead of raw strings. */
export const AdapterErrorSeverities = AdapterErrorSeveritySchema.enum;

export const AdapterErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
  retry_after_ms: z.number().int().nullable(),
  severity: AdapterErrorSeveritySchema,
});
export type AdapterError = z.infer<typeof AdapterErrorSchema>;

export const RegistrationResultSchema = z.object({
  success: z.boolean(),
  plugin_id: z.string(),
  message: z.string().nullable(),
});
export type RegistrationResult = z.infer<typeof RegistrationResultSchema>;

// ── Trigger Adapter ─────────────────────────────────────────────────────────────

export const TriggerEventSchema = z.object({
  idempotency_key: z.string(),
  source: z.string(),
  event_type: z.string(),
  external_ref: z.string(),
  title: z.string(),
  body: z.string().nullable(),
  repo: z.string(),
  clone_url: z
    .string()
    .url()
    .refine((u) => u.startsWith("https://"), {
      message: "clone_url must use HTTPS",
    }),
  metadata: z.record(z.unknown()).nullable(),
});
export type TriggerEvent = z.infer<typeof TriggerEventSchema>;

// ── Communication Adapter ───────────────────────────────────────────────────────

export const MessageTypeSchema = z.enum([
  "notification",
  "question",
  "status_response",
  "milestone",
  "alert",
]);
export type MessageType = z.infer<typeof MessageTypeSchema>;

/** Constant enum values for MessageType. Use instead of raw strings. */
export const MessageTypes = MessageTypeSchema.enum;

export const TargetSchema = z.object({
  user_id: z.string(),
  channel: z.string().nullable(),
});
export type Target = z.infer<typeof TargetSchema>;

export const FormattedMessageSchema = z.object({
  content: z.string(),
  metadata: z.object({
    task_id: z.string().nullable(),
    type: MessageTypeSchema,
  }),
});
export type FormattedMessage = z.infer<typeof FormattedMessageSchema>;

export const SendResultSchema = z.object({
  success: z.boolean(),
  message_id: z.string().nullable(),
  error: AdapterErrorSchema.nullable(),
});
export type SendResult = z.infer<typeof SendResultSchema>;

export const InboundMessageSchema = z.object({
  source: z.string(),
  sender: z.string(),
  content: z.string(),
  timestamp: z.string().datetime(),
  reply_to: z.string().nullable(),
  platform_metadata: z.record(z.unknown()),
});
export type InboundMessage = z.infer<typeof InboundMessageSchema>;

export const SyncMetadataSchema = z.object({
  task_title: z.string(),
  external_ref: z.string().nullable(),
  sub_state: z.string().nullable(),
  reason: z.string().nullable(),
});
export type SyncMetadata = z.infer<typeof SyncMetadataSchema>;

export const IssueOptionsSchema = z.object({
  title: z.string(),
  body: z.string(),
  labels: z.array(z.string()).nullable(),
  assignees: z.array(z.string()).nullable(),
  parent_issue: z.number().int().positive().nullable(),
});
export type IssueOptions = z.infer<typeof IssueOptionsSchema>;

export const IssueResultSchema = z.object({
  number: z.number().int().positive(),
  url: z.string(),
});
export type IssueResult = z.infer<typeof IssueResultSchema>;

export const IssueUpdatesSchema = z.object({
  state: z.enum(["open", "closed"]).nullable(),
  labels_add: z.array(z.string()).nullable(),
  labels_remove: z.array(z.string()).nullable(),
  body: z.string().nullable(),
});
export type IssueUpdates = z.infer<typeof IssueUpdatesSchema>;

export const TaskReconciliationInputSchema = z.object({
  task_id: z.string(),
  external_ref: z.string(),
  expected_state: z.string(),
  expected_label: z.string(),
});
export type TaskReconciliationInput = z.infer<typeof TaskReconciliationInputSchema>;

export const ReconciliationResultSchema = z.object({
  reconciled: z.number().int(),
  errors: z.array(
    z.object({
      task_id: z.string(),
      reason: z.string(),
    }),
  ),
});
export type ReconciliationResult = z.infer<typeof ReconciliationResultSchema>;

// ── LLM Adapter ─────────────────────────────────────────────────────────────────
// CLI-only contract. LLMs are inference-only (D143) — prompt in, text out.
// Plugin-specific details (flags, output parsing) belong in each plugin, not here.

export const InferenceRequestSchema = z.object({
  prompt: z.string(),
  system_prompt: z.string().nullable().default(null),
  /** Working directory for the CLI process. Plugins use this as CWD
   *  so the CLI loads the target repo's project context, not the daemon's. */
  cwd: z.string().nullable().default(null),
});
export type InferenceRequest = z.infer<typeof InferenceRequestSchema>;

export const InferenceResultSchema = z.object({
  content: z.string(),
  cost_usd: z.number().nullable(),
  duration_ms: z.number().int(),
});
export type InferenceResult = z.infer<typeof InferenceResultSchema>;

export const LLMCapabilitiesSchema = z.object({
  model_id: z.string(),
});
export type LLMCapabilities = z.infer<typeof LLMCapabilitiesSchema>;

// ── Tool Adapter ────────────────────────────────────────────────────────────────

export const ToolExecutionContextSchema = z.object({
  workspace_path: z.string(),
  task_id: z.string(),
});
export type ToolExecutionContext = z.infer<typeof ToolExecutionContextSchema>;

export const ToolDescriptionSchema = z.object({
  name: z.string(),
  description: z.string(),
  parameters: z.record(z.unknown()),
  action_classes: z.array(z.string()),
});
export type ToolDescription = z.infer<typeof ToolDescriptionSchema>;

export const SideEffectTypeSchema = z.enum([
  "file_written",
  "file_deleted",
  "command_run",
  "network_request",
  "process_spawned",
]);
export type SideEffectType = z.infer<typeof SideEffectTypeSchema>;

export const SideEffectSchema = z.object({
  type: SideEffectTypeSchema,
  details: z.record(z.unknown()),
});
export type SideEffect = z.infer<typeof SideEffectSchema>;

export const ToolResultSchema = z.object({
  success: z.boolean(),
  output: z.string(),
  side_effects: z.array(SideEffectSchema),
  error: AdapterErrorSchema.nullable(),
});
export type ToolResult = z.infer<typeof ToolResultSchema>;

// ── Git Hosting Adapter ─────────────────────────────────────────────────────────

export const MergeStrategySchema = z.enum(["merge", "squash", "rebase"]);
export type MergeStrategy = z.infer<typeof MergeStrategySchema>;

/** Constant enum values for MergeStrategy. Use instead of raw strings. */
export const MergeStrategies = MergeStrategySchema.enum;

export const PROptionsSchema = z.object({
  repo: z.string(),
  branch: z.string(),
  base: z.string(),
  title: z.string(),
  body: z.string(),
  draft: z.boolean(),
  labels: z.array(z.string()).nullable(),
  reviewers: z.array(z.string()).nullable(),
});
export type PROptions = z.infer<typeof PROptionsSchema>;

export const PRResultSchema = z.object({
  pr_number: z.number().int().positive(),
  url: z.string(),
});
export type PRResult = z.infer<typeof PRResultSchema>;

export const PRUpdatesSchema = z.object({
  title: z.string().nullable(),
  body: z.string().nullable(),
  draft: z.boolean().nullable(),
  labels_add: z.array(z.string()).nullable(),
  labels_remove: z.array(z.string()).nullable(),
});
export type PRUpdates = z.infer<typeof PRUpdatesSchema>;

export const MergeResultSchema = z.object({
  merge_sha: z.string(),
  success: z.boolean(),
  error: AdapterErrorSchema.nullable(),
});
export type MergeResult = z.infer<typeof MergeResultSchema>;

export const PRStatusSchema = z.object({
  number: z.number().int().positive(),
  state: z.enum(["open", "closed", "merged"]),
  draft: z.boolean(),
  mergeable: z.boolean(),
  checks_passing: z.boolean(),
  url: z.string(),
});
export type PRStatus = z.infer<typeof PRStatusSchema>;

export const ReviewerStateSchema = z.object({
  username: z.string(),
  state: z.enum(["approved", "changes_requested", "commented", "pending"]),
});
export type ReviewerState = z.infer<typeof ReviewerStateSchema>;

export const ReviewStatusSchema = z.object({
  approved: z.boolean(),
  approvals: z.number().int(),
  changes_requested: z.boolean(),
  reviewers: z.array(ReviewerStateSchema),
  /** Review body text and inline comments from formal reviews. */
  comments: z.array(z.string()).default([]),
});
export type ReviewStatus = z.infer<typeof ReviewStatusSchema>;

export const PRCommentSchema = z.object({
  id: z.string(),
  author: z.string(),
  body: z.string(),
  created_at: z.string(),
});
export type PRComment = z.infer<typeof PRCommentSchema>;

export const CommentResultSchema = z.object({
  comment_id: z.string(),
  url: z.string(),
});
export type CommentResult = z.infer<typeof CommentResultSchema>;

export const BranchProtectionSchema = z.object({
  protected: z.boolean(),
  required_reviews: z.number().int(),
  required_checks: z.array(z.string()),
  restrictions: z.record(z.unknown()).nullable(),
});
export type BranchProtection = z.infer<typeof BranchProtectionSchema>;

// ── People Directory ────────────────────────────────────────────────────────────

export const NotificationLevelSchema = z.enum(["all", "milestones", "critical"]);
export type NotificationLevel = z.infer<typeof NotificationLevelSchema>;

/** Constant enum values for NotificationLevel. Use instead of raw strings. */
export const NotificationLevels = NotificationLevelSchema.enum;

export const ContactSchema = z.object({
  channel: z.string(),
  handle: z.string(),
});
export type Contact = z.infer<typeof ContactSchema>;

export const PersonSchema = z.object({
  id: z.string(),
  name: z.string(),
  roles: z.array(z.string()),
  contacts: z.array(ContactSchema),
  preferences: z
    .object({
      notification_level: NotificationLevelSchema.default("milestones"),
      quiet_hours: z
        .object({
          start: z.string(),
          end: z.string(),
        })
        .nullable()
        .default(null),
    })
    .default({}),
});
export type Person = z.infer<typeof PersonSchema>;

export const ContactInfoSchema = z.object({
  channel: z.string(),
  handle: z.string(),
  plugin_id: z.string(),
});
export type ContactInfo = z.infer<typeof ContactInfoSchema>;

// ── Plugin Health ───────────────────────────────────────────────────────────────

export const PluginHealthStateSchema = z.enum(["healthy", "unhealthy", "failed"]);
export type PluginHealthState = z.infer<typeof PluginHealthStateSchema>;

/** Constant enum values for PluginHealthState. Use instead of raw strings. */
export const PluginHealthStates = PluginHealthStateSchema.enum;

export const PluginHealthRecordSchema = z.object({
  plugin_id: z.string(),
  state: PluginHealthStateSchema,
  consecutive_failures: z.number().int().default(0),
  last_check_at: z.string().datetime().nullable(),
  last_healthy_at: z.string().datetime().nullable(),
  last_error: z.string().nullable(),
});
export type PluginHealthRecord = z.infer<typeof PluginHealthRecordSchema>;
