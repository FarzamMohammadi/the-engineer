import { createHash } from "node:crypto";
import { z } from "zod";

// ── Session ────────────────────────────────────────────────────────────────────

export const SessionEndReasonSchema = z.enum(["completed", "preempted", "crashed", "new_session"]);
export type SessionEndReason = z.infer<typeof SessionEndReasonSchema>;

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

export const CheckpointReasonSchema = z.enum([
  "phase_transition",
  "preemption",
  "pre_costly_op",
  "periodic",
]);
export type CheckpointReason = z.infer<typeof CheckpointReasonSchema>;

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

// ── KnowledgeEntry ─────────────────────────────────────────────────────────────

export const KnowledgeScopeSchema = z.enum(["repo", "user"]);
export type KnowledgeScope = z.infer<typeof KnowledgeScopeSchema>;

export const KnowledgeConfidenceSchema = z.enum(["observed", "inferred", "told"]);
export type KnowledgeConfidence = z.infer<typeof KnowledgeConfidenceSchema>;

export const KnowledgeDomainSchema = z.enum([
  "conventions",
  "patterns",
  "gotchas",
  "domain",
  "tooling",
  "preferences",
]);
export type KnowledgeDomain = z.infer<typeof KnowledgeDomainSchema>;

export const KnowledgeEvidenceSchema = z.object({
  task_id: z.string(),
  description: z.string(),
});
export type KnowledgeEvidence = z.infer<typeof KnowledgeEvidenceSchema>;

export const KnowledgeEntrySchema = z.object({
  // Identity — content hash, NOT ULID
  id: z.string(),

  // Scope
  scope: KnowledgeScopeSchema,
  repo_scope: z.string().nullable(),
  domain: KnowledgeDomainSchema,

  // Content
  key: z.string(),
  body: z.string(),
  confidence: KnowledgeConfidenceSchema,
  evidence: z.array(KnowledgeEvidenceSchema),

  // Lifecycle
  created_at: z.string().datetime(),
  last_confirmed: z.string().datetime(),
  superseded_by: z.string().nullable(),

  // Provenance
  source_task_id: z.string(),
  source_phase: z.string(),
});
export type KnowledgeEntry = z.infer<typeof KnowledgeEntrySchema>;

// ── Knowledge ID generation ────────────────────────────────────────────────────

export function knowledgeId(
  scope: string,
  repoScope: string | null,
  key: string,
  body: string,
): string {
  // 128-bit (32 hex chars) — sufficient collision resistance for expected cardinality (thousands, not billions)
  // repo_scope included to isolate knowledge per repository — same content in different repos gets distinct IDs
  return createHash("sha256")
    .update(`${scope}:${repoScope ?? ""}:${key}:${body}`)
    .digest("hex")
    .slice(0, 32);
}
