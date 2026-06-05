import { z } from "zod";

import { ExternalRefSchema } from "./task.js";

// ── Universal Adapter Contract ──────────────────────────────────────────────────

export const AdapterTypeSchema = z.enum(["trigger", "communication", "agent", "git_hosting"]);
export type AdapterType = z.infer<typeof AdapterTypeSchema>;

/** Constant enum values for AdapterType. Use instead of raw strings. */
export const AdapterTypes = AdapterTypeSchema.enum;

export const PluginRequirementSchema = z.object({
  type: z.enum(["binary", "env"]),
  name: z.string(),
});
export type PluginRequirement = z.output<typeof PluginRequirementSchema>;

export const PluginManifestSchema = z.object({
  id: z.string(),
  type: AdapterTypeSchema,
  version: z.string(),
  name: z.string(),
  description: z.string(),
  config_schema: z.record(z.unknown()).default({}),
  critical: z.boolean().default(true),
  requirements: z.array(PluginRequirementSchema).default([]),
  combined_with: z.array(z.string()).default([]),
  entry: z.string().default("index.ts"),
  poll_interval_ms: z.number().int().positive().optional(),
  adapter_meta: z.record(z.unknown()).default({}),
  contributes: z
    .object({
      events: z.array(z.string()).default([]),
      commands: z.array(z.string()).default([]),
      config_keys: z.array(z.string()).default([]),
      hooks: z.array(z.string()).default([]),
    })
    .default({}),
  startup_hints: z.array(z.string()).default([]),
});
/**
 * Plugin identity injected by the Registry. Shallowly `Readonly` so any plugin
 * code that tries `this.manifest.X = ...` is a compile error rather than a
 * runtime contract violation. The Zod schema itself stays mutable so internal
 * parse-and-build code (e.g. `PluginManifestSchema.parse(...)` followed by
 * one-time field defaulting) keeps working.
 */
export type PluginManifest = Readonly<z.infer<typeof PluginManifestSchema>>;

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
  external_ref: ExternalRefSchema.nullable(),
  title: z.string(),
  body: z.string().nullable(),
  repo: z.string(),
  clone_url: z
    .string()
    .url()
    .refine((u) => u.startsWith("https://"), {
      message: "clone_url must use HTTPS",
    }),
  /** Trigger-provided identifier for the thoughts/ directory (e.g., "issue-42"). Null if not provided. */
  thoughts_id: z.string().nullable(),
  metadata: z.record(z.unknown()).nullable(),
});
export type TriggerEvent = z.infer<typeof TriggerEventSchema>;

// ── Communication Adapter ───────────────────────────────────────────────────────

export const MessageTypeSchema = z.enum(["notification", "question", "status_response", "milestone", "alert"]);
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
  external_ref: ExternalRefSchema.nullable(),
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
  external_ref: ExternalRefSchema.nullable(),
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

// ── Agent Adapter ───────────────────────────────────────────────────────────────
// CLI-only contract. The Engineer drives an autonomous coding agent (Claude Code,
// OpenCode, etc.) by sending it a prompt against a workspace; the agent reads
// and writes files, runs tools, and returns a structured result. Plugin-specific
// details (flags, output parsing) belong in each plugin, not here.

// The canonical, plugin-agnostic vocabulary for an agent's live activity. Each plugin
// maps its native stream into these variants; Core consumes only this union. It is the
// ONLY thing Core and agent plugins share about a run's inner activity — keep it minimal
// and free of any plugin-specific shape, so a new CLI can be mirrored by mapping into it.
export const AgentActivityEventSchema = z.discriminatedUnion("kind", [
  // Optional session-start marker: what the agent booted with. Every field is nullable
  // because a CLI may report some, all, or none of them.
  z.object({
    kind: z.literal("session"),
    model: z.string().nullable(),
    tools: z.number().int().nonnegative().nullable(),
    cwd: z.string().nullable(),
  }),
  // A chunk of the agent's user-facing answer.
  z.object({
    kind: z.literal("assistant_text"),
    text: z.string(),
  }),
  // A chunk of the agent's reasoning, when the CLI exposes it.
  z.object({
    kind: z.literal("thinking"),
    text: z.string(),
  }),
  // The agent invoked a tool. `input` is the tool's raw arguments (file contents, shell
  // commands, env) — opaque here, sanitized downstream before it is ever persisted.
  z.object({
    kind: z.literal("tool_use"),
    tool_call_id: z.string(),
    name: z.string(),
    input: z.unknown(),
  }),
  // A tool returned. `tool_call_id` pairs it with its `tool_use`; `output` is opaque and
  // sanitized downstream.
  z.object({
    kind: z.literal("tool_result"),
    tool_call_id: z.string(),
    status: z.enum(["ok", "error"]),
    output: z.unknown(),
  }),
]);
export type AgentActivityEvent = z.infer<typeof AgentActivityEventSchema>;

export const AgentRunRequestSchema = z.object({
  prompt: z.string(),
  system_prompt: z.string().nullable().default(null),
  /** Working directory for the CLI process. Plugins use this as CWD
   *  so the CLI loads the target repo's project context, not the daemon's. */
  cwd: z.string().nullable().default(null),
  /** Optional file path where the plugin should write raw CLI output for tracing.
   *  Plugins that support tracing stream stdout to this path during execution.
   *  Plugins that don't support it ignore this field. Core generates the path. */
  trace_output_path: z.string().nullable().default(null),
  /** Abort signal for the in-flight run. Plugins pass it to `spawn({ signal })` so a
   *  preemption, shutdown, or cost-limit SIGTERMs the child instead of waiting it out.
   *  Runtime-only and optional — this schema is never parsed, so carrying the handle on
   *  the inferred type keeps the type as the single source of truth with no parse hazard. */
  signal: z.instanceof(AbortSignal).optional(),
  /** Best-effort activity sink. A plugin that streams calls this for each `AgentActivityEvent`
   *  it parses out of its CLI; a plugin that cannot stream simply never calls it. Observation-only:
   *  it must never affect the run's outcome, cost, or timing. Runtime-only and optional — like
   *  `signal`, this schema is never parsed, so the handle rides the inferred type (the single
   *  source of truth) with no parse hazard. `z.custom` carries the type without runtime parsing. */
  on_activity: z.custom<(event: AgentActivityEvent) => void>().optional(),
});
export type AgentRunRequest = z.infer<typeof AgentRunRequestSchema>;

// Per-call token breakdown. Plugins fill what their CLI reports.
export const TokenUsageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cache_read_tokens: z.number().int().nonnegative().default(0),
  cache_creation_tokens: z.number().int().nonnegative().default(0),
  total_tokens: z.number().int().nonnegative(),
});
export type TokenUsage = z.infer<typeof TokenUsageSchema>;

// Full per-call usage (tokens + model context).
export const AgentRunUsageSchema = z.object({
  tokens: TokenUsageSchema,
  model_id: z.string().nullable().default(null),
  service_tier: z.string().nullable().default(null),
});
export type AgentRunUsage = z.infer<typeof AgentRunUsageSchema>;

// A single quota/rate-limit window (e.g. Claude's 5-hour session, 7-day weekly).
export const QuotaWindowSchema = z.object({
  window_type: z.string(),
  resets_at: z.number().int().nullable().default(null),
  is_exhausted: z.boolean().default(false),
  used_percentage: z.number().nonnegative().nullable().default(null),
});
export type QuotaWindow = z.infer<typeof QuotaWindowSchema>;

// Overall quota status across all windows.
export const QuotaStatusSchema = z.object({
  windows: z.array(QuotaWindowSchema).default([]),
  is_rate_limited: z.boolean().default(false),
  earliest_reset_at: z.number().int().nullable().default(null),
});
export type QuotaStatus = z.infer<typeof QuotaStatusSchema>;

export const AgentRunResultSchema = z.object({
  content: z.string(),
  cost_usd: z.number().nullable(),
  duration_ms: z.number().int(),
  /** Per-call usage details. null if the CLI doesn't report them. */
  usage: AgentRunUsageSchema.nullable().default(null),
});
export type AgentRunResult = z.infer<typeof AgentRunResultSchema>;

export const AgentCapabilitiesSchema = z.object({
  model_id: z.string(),
  supports_usage_reporting: z.boolean().default(false),
  supports_quota_reporting: z.boolean().default(false),
  // Whether the plugin emits live AgentActivityEvents via AgentRunRequest.on_activity.
  // When false, the run behaves identically — Core just has no live feed for it.
  supports_activity_streaming: z.boolean().default(false),
  context_window: z.number().int().positive().nullable().default(null),
});
export type AgentCapabilities = z.infer<typeof AgentCapabilitiesSchema>;

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
  // Tri-state mergeability, mirroring `checks_state` — a host computes mergeability asynchronously, so
  // "not yet computed" is a real, distinct answer, NOT a conflict. `unknown` must never be read as
  // `conflicting`: a freshly-pushed branch reads `unknown` for a few seconds before the host resolves it.
  merge_state: z.enum(["mergeable", "conflicting", "unknown"]),
  checks_state: z.enum(["passing", "failing", "pending", "none"]),
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
