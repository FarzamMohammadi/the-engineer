/**
 * Plugin SDK Boundary — the single import point for plugin authors.
 *
 * Everything a plugin needs to implement an adapter contract lives here.
 * This is the future `packages/plugin-sdk/` extraction point.
 *
 * Does NOT export: Event Bus, Database, Config, or any Core internals.
 */

// === Adapter Base ===
export { BaseAdapter } from "./base.js";

// === Adapter Contracts ===
export { TriggerAdapter } from "./trigger.js";
export { CommunicationAdapter } from "./communication.js";
export { LLMAdapter } from "./llm.js";
export { ToolAdapter } from "./tool.js";
export { GitHostingAdapter } from "./git-hosting.js";

// === Error Helpers ===
export { AdapterMethodError, createAdapterError } from "./errors.js";

// === Shared Types (from schemas) ===
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
  IssueOptionsSchema,
  IssueResultSchema,
  IssueUpdatesSchema,
  MessageTypeSchema,
  ReconciliationResultSchema,
  SendResultSchema,
  SyncMetadataSchema,
  TargetSchema,
  TaskReconciliationInputSchema,
  type FormattedMessage,
  type InboundMessage,
  type IssueOptions,
  type IssueResult,
  type IssueUpdates,
  type MessageType,
  type ReconciliationResult,
  type SendResult,
  type SyncMetadata,
  type Target,
  type TaskReconciliationInput,
  // LLM
  InferenceRequestSchema,
  InferenceResultSchema,
  InferenceUsageSchema,
  LLMCapabilitiesSchema,
  QuotaStatusSchema,
  QuotaWindowSchema,
  TokenUsageSchema,
  type InferenceRequest,
  type InferenceResult,
  type InferenceUsage,
  type LLMCapabilities,
  type QuotaStatus,
  type QuotaWindow,
  type TokenUsage,
  // Tool
  SideEffectSchema,
  SideEffectTypeSchema,
  ToolDescriptionSchema,
  ToolExecutionContextSchema,
  ToolResultSchema,
  type SideEffect,
  type SideEffectType,
  type ToolDescription,
  type ToolExecutionContext,
  type ToolResult,
  // Git Hosting
  BranchProtectionSchema,
  CommentResultSchema,
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

// === Event Payload Types (for plugins that need them) ===
export type { TaskStateChangedPayload } from "../schemas/events.js";
