import { z } from "zod";

// ── Session ────────────────────────────────────────────────────────────────────

export const SessionEndReasonSchema = z.enum(["completed", "preempted", "crashed", "blocked"]);
export type SessionEndReason = z.infer<typeof SessionEndReasonSchema>;

/** Constant enum values for SessionEndReason. Use instead of raw strings. */
export const SessionEndReasons = SessionEndReasonSchema.enum;

export const SessionSchema = z.object({
  id: z.string(),
  task_id: z.string(),
  started_at: z.string().datetime(),
  ended_at: z.string().datetime().nullable(),
  end_reason: SessionEndReasonSchema.nullable(),
});
export type Session = z.infer<typeof SessionSchema>;

// ── JournalEntry ───────────────────────────────────────────────────────────────

export const JournalEntryTypeSchema = z.enum(["error", "phase_change", "checkpoint_marker"]);
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
  error_detail: z.string().nullable(),

  // Queryability
  tags: z.array(z.string()),
});
export type JournalEntry = z.infer<typeof JournalEntrySchema>;

// ── Checkpoint ─────────────────────────────────────────────────────────────────

export const CheckpointReasonSchema = z.enum(["phase_transition", "preemption"]);
export type CheckpointReason = z.infer<typeof CheckpointReasonSchema>;

/** Constant enum values for CheckpointReason. Use instead of raw strings. */
export const CheckpointReasons = CheckpointReasonSchema.enum;

export const CheckpointSchema = z.object({
  id: z.string(),
  session_id: z.string(),
  task_id: z.string(),

  // Position — phase + sub_phase form the resume cursor; the two counters let the iteration caps
  // survive a preempt-and-resume. phase_progress is the human one-liner alongside them.
  phase: z.string(),
  sub_phase: z.string().nullable(),
  phase_iteration: z.number().int(),
  total_reworks: z.number().int(),
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
