import { z } from "zod";

// ── Retry Configuration ────────────────────────────────────────────────────

export const RetryConfigSchema = z.object({
  /** How often to retry failed outreach attempts while tasks remain active. Default: 30 seconds. */
  outreach_retry_interval_ms: z
    .number()
    .int()
    .positive()
    .default(30_000)
    .describe("Interval between outreach retry attempts. Default: 30 seconds."),

  /** Maximum retry attempts per contact per task before giving up. Default: unlimited. */
  max_outreach_retry_attempts: z
    .number()
    .int()
    .positive()
    .nullable()
    .default(null)
    .describe("Max retry attempts per contact. null = unlimited while task is active."),

  /** Enable adaptive backoff for repeated failures to the same contact. */
  adaptive_backoff_enabled: z
    .boolean()
    .default(true)
    .describe("Use exponential backoff for repeated failures to same contact."),

  /** Maximum backoff interval in milliseconds. Default: 5 minutes. */
  max_backoff_interval_ms: z
    .number()
    .int()
    .positive()
    .default(300_000)
    .describe("Maximum retry interval with adaptive backoff. Default: 5 minutes."),
});
export type RetryConfig = z.infer<typeof RetryConfigSchema>;

// ── Retry State ────────────────────────────────────────────────────────────

export const RetryContactSchema = z.object({
  /** Person ID that owns this contact. */
  person_id: z.string(),

  /** Communication channel (e.g., "telegram", "github"). */
  channel: z.string(),

  /** Contact handle/address within the channel. */
  handle: z.string(),
});
export type RetryContact = z.infer<typeof RetryContactSchema>;

export const RetryAttemptSchema = z.object({
  /** ISO timestamp of the retry attempt. */
  attempted_at: z.string(),

  /** Whether this retry attempt succeeded. */
  success: z.boolean(),

  /** Error message if the attempt failed. */
  error_message: z.string().nullable().default(null),

  /** Whether the error was marked as retryable by the adapter. */
  retryable: z.boolean().nullable().default(null),

  /** Plugin-specified retry delay in milliseconds. */
  retry_after_ms: z.number().int().positive().nullable().default(null),
});
export type RetryAttempt = z.infer<typeof RetryAttemptSchema>;

export const RetryScheduleEntrySchema = z.object({
  /** Unique identifier for this retry entry. */
  id: z.string(),

  /** Task ID that needs outreach retry. */
  task_id: z.string(),

  /** Contact to retry. */
  contact: RetryContactSchema,

  /** Original notification that failed to deliver. */
  notification: z.object({
    kind: z.string(),
    content: z.string(),
    message_type: z.string(),
  }),

  /** ISO timestamp when retry was first scheduled. */
  scheduled_at: z.string(),

  /** ISO timestamp of next retry attempt. */
  next_retry_at: z.string(),

  /** Number of retry attempts made so far. */
  attempt_count: z.number().int().min(0).default(0),

  /** History of retry attempts. */
  attempts: z.array(RetryAttemptSchema).default([]),

  /** Whether this retry schedule is paused. */
  paused: z.boolean().default(false),

  /** Current backoff interval in milliseconds. */
  current_backoff_ms: z.number().int().positive().default(30_000),
});
export type RetryScheduleEntry = z.infer<typeof RetryScheduleEntrySchema>;

export const RetryStateSchema = z.object({
  /** Active retry schedules keyed by entry ID. */
  schedules: z.record(z.string(), RetryScheduleEntrySchema).default({}),

  /** Last cleanup timestamp to prevent unbounded growth. */
  last_cleanup_at: z.string().nullable().default(null),
});
export type RetryState = z.infer<typeof RetryStateSchema>;

// ── Utility Types ──────────────────────────────────────────────────────────

/** Input for scheduling a new retry. */
export const ScheduleRetryInputSchema = z.object({
  task_id: z.string(),
  contact: RetryContactSchema,
  notification: z.object({
    kind: z.string(),
    content: z.string(),
    message_type: z.string(),
  }),
  initial_failure_reason: z.string().optional(),
});
export type ScheduleRetryInput = z.infer<typeof ScheduleRetryInputSchema>;

/** Result of a retry attempt. */
export const RetryAttemptResultSchema = z.object({
  success: z.boolean(),
  error_message: z.string().nullable().default(null),
  retryable: z.boolean().nullable().default(null),
  retry_after_ms: z.number().int().positive().nullable().default(null),
  should_continue: z.boolean(),
});
export type RetryAttemptResult = z.infer<typeof RetryAttemptResultSchema>;