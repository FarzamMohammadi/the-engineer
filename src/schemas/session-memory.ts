import { z } from "zod";

// ── Session ────────────────────────────────────────────────────────────────────

export const SessionEndReasonSchema = z.enum([
  "completed",
  "preempted",
  "crashed",
  "new_session",
  "decomposed",
  "review_pending",
  "blocked",
]);
export type SessionEndReason = z.infer<typeof SessionEndReasonSchema>;

/** Constant enum values for SessionEndReason. Use instead of raw strings. */
export const SessionEndReasons = SessionEndReasonSchema.enum;

export const SessionSchema = z.object({
  id: z.string(),
  task_id: z.string(),
  started_at: z.string().datetime(),
  ended_at: z.string().datetime().nullable(),
  end_reason: SessionEndReasonSchema.nullable(),
  previous_session_id: z.string().nullable(),
  resumed_from_checkpoint: z.string().nullable(),
});
export type Session = z.infer<typeof SessionSchema>;

// ── JournalEntry ───────────────────────────────────────────────────────────────

export const JournalEntryTypeSchema = z.enum([
  "action",
  "finding",
  "decision",
  "error",
  "communication",
  "phase_change",
  "checkpoint_marker",
]);
export type JournalEntryType = z.infer<typeof JournalEntryTypeSchema>;

/** Constant enum values for JournalEntryType. Use instead of raw strings. */
export const JournalEntryTypes = JournalEntryTypeSchema.enum;

export const JournalEntrySchema = z.object({
  id: z.string(),
  session_id: z.string(),
  task_id: z.string(),
  timestamp: z.string().datetime(),
  phase: z.string(),

  type: JournalEntryTypeSchema,

  // Content
  summary: z.string(),
  detail: z.string().nullable(),

  // Type-specific fields (nullable — only populated for matching type)
  action_type: z.string().nullable(),
  finding_type: z.string().nullable(),
  decision_key: z.string().nullable(),
  error_detail: z.string().nullable(),
  comm_target: z.string().nullable(),

  // Queryability
  tags: z.array(z.string()),
});
export type JournalEntry = z.infer<typeof JournalEntrySchema>;

// ── Checkpoint ─────────────────────────────────────────────────────────────────

export const CheckpointReasonSchema = z.enum(["phase_transition", "preemption", "pre_costly_op", "periodic"]);
export type CheckpointReason = z.infer<typeof CheckpointReasonSchema>;

/** Constant enum values for CheckpointReason. Use instead of raw strings. */
export const CheckpointReasons = CheckpointReasonSchema.enum;

export const CheckpointSchema = z.object({
  id: z.string(),
  session_id: z.string(),
  task_id: z.string(),

  // Position
  phase: z.string(),
  phase_progress: z.string(),

  // Context window reconstruction
  context_summary: z.string(),
  key_findings: z.array(z.string()),
  open_questions: z.array(z.string()),
  next_action: z.string(),

  // References (pointers, not copies)
  last_event_id: z.string(),
  workspace_ref: z
    .object({
      branch: z.string(),
      last_commit: z.string(),
    })
    .nullable(),

  // Metadata
  reason: CheckpointReasonSchema,
  timestamp: z.string().datetime(),
  journal_offset: z.number().int(),
});
export type Checkpoint = z.infer<typeof CheckpointSchema>;
