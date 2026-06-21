/**
 * Plugin SDK Boundary — the single import point for plugin authors.
 *
 * Everything a plugin needs to implement an adapter contract lives here.
 * This is the future `packages/plugin-sdk/` extraction point.
 *
 * Does NOT export: Event Bus, Database, Config, or any Core internals.
 */

// ── Adapter Base ────────────────────────────────────────────────────────────
export { type AdapterObserver, BaseAdapter, type PluginContext, type StateStore } from "./base.js";

// ── Adapter Contracts ───────────────────────────────────────────────────────
export { TriggerAdapter } from "./trigger.js";
export { CommunicationAdapter } from "./communication.js";
export { AgentAdapter } from "./agent.js";
export { GitHostingAdapter } from "./git-hosting.js";

// ── Error Helpers ───────────────────────────────────────────────────────────
export { AdapterMethodError, createAdapterError } from "./errors.js";

// ── Shared Types (from schemas) ─────────────────────────────────────────────
export {
  // Universal
  AdapterErrorSchema,
  AdapterErrorSeveritySchema,
  AdapterTypeSchema,
  HealthStatusSchema,
  InitResultSchema,
  PluginManifestSchema,
  type AdapterError,
  type AdapterErrorSeverity,
  type AdapterType,
  type HealthStatus,
  type InitResult,
  type PluginManifest,
  // Trigger
  TriggerEventSchema,
  type TriggerEvent,
  // Communication
  FormattedMessageSchema,
  InboundMessageSchema,
  MessageTypeSchema,
  ReconciliationResultSchema,
  SendResultSchema,
  SyncMetadataSchema,
  TargetSchema,
  TaskReconciliationInputSchema,
  TicketOptionsSchema,
  TicketResultSchema,
  TicketUpdatesSchema,
  type FormattedMessage,
  type InboundMessage,
  type MessageType,
  type ReconciliationResult,
  type SendResult,
  type SyncMetadata,
  type Target,
  type TaskReconciliationInput,
  type TicketOptions,
  type TicketResult,
  type TicketUpdates,
  // Agent
  AgentActivityEventSchema,
  AgentCapabilitiesSchema,
  AgentRunRequestSchema,
  AgentRunResultSchema,
  AgentRunUsageSchema,
  QuotaStatusSchema,
  QuotaWindowSchema,
  TokenUsageSchema,
  type AgentActivityEvent,
  type AgentCapabilities,
  type AgentRunRequest,
  type AgentRunResult,
  type AgentRunUsage,
  type QuotaStatus,
  type QuotaWindow,
  type TokenUsage,
  // Git Hosting
  BranchProtectionSchema,
  CommentResultSchema,
  MergeFailureReasonSchema,
  MergeResultSchema,
  MergeStrategySchema,
  PRCommentSchema,
  PROptionsSchema,
  PRResultSchema,
  PRStatusSchema,
  PRUpdatesSchema,
  ReviewStatusSchema,
  ReviewerStateSchema,
  type BranchProtection,
  type CommentResult,
  type MergeFailureReason,
  type MergeResult,
  type MergeStrategy,
  type PRComment,
  type PROptions,
  type PRResult,
  type PRStatus,
  type PRUpdates,
  type ReviewStatus,
  type ReviewerState,
} from "../schemas/adapters.js";

// ── Git Hosting Events (the typed PR-event vocabulary detectPrEvents produces) ──
export {
  PrEventSchema,
  PrEventTypeSchema,
  PrEventTypes,
  type PrCommentsEvent,
  type PrEvent,
  type PrEventType,
} from "../schemas/git-hosting-events.js";

// ── Event Payload Types (for plugins that need them) ──────────────────────
export type { TaskStateChangedPayload } from "../schemas/events.js";
