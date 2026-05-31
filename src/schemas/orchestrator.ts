import { z } from "zod";

// ── Complexity Enum ────────────────────────────────────────────────────────────────

export const ComplexitySchema = z.enum(["trivial", "moderate", "complex"]);
export type Complexity = z.infer<typeof ComplexitySchema>;

/** Constant enum values for Complexity. Use instead of raw strings. */
export const Complexities = ComplexitySchema.enum;

// ── Phase Directory Constants ────────────────────────────────────────────────────

/**
 * Subdirectory names inside the thoughts/ directory — one per pipeline phase.
 * Shared between WorkspaceManager (directory creation) and the pipeline sub-phases (file routing).
 */
export const PHASE_DIRECTORIES = ["requirements", "research", "planning", "execution", "review", "delivery"] as const;

// ── Communication Types ─────────────────────────────────────────────────────────

export const CommEventSchema = z.object({
  type: z.enum(["milestone", "question", "status_update", "alert", "digest"]),
  task_id: z.string(),
  channel: z.string(),
  urgency: z.enum(["immediate", "batched", "digest"]),
  content: z.string(),
  metadata: z.record(z.unknown()),
});
export type CommEvent = z.infer<typeof CommEventSchema>;

export const QuestionSchema = z.object({
  id: z.string(),
  question: z.string(),
  options: z.array(z.string()).nullable(),
  category: z.string(),
  urgency: z.enum(["blocking", "informational"]),
});
export type Question = z.infer<typeof QuestionSchema>;

export const QuestionBatchSchema = z.object({
  task_id: z.string(),
  questions: z.array(QuestionSchema),
  batch_window_ms: z.number().int(),
});
export type QuestionBatch = z.infer<typeof QuestionBatchSchema>;

// ── Safety Query / Verdict ──────────────────────────────────────────────────────

export const SafetyQuerySchema = z.object({
  type: z.enum(["can_i", "should_i_ask", "cost_check"]),
  context: z.object({
    task_id: z.string(),
    repo: z.string(),
    action_class: z.string().nullable(),
    decision_category: z.string().nullable(),
    details: z.record(z.unknown()),
  }),
});
export type SafetyQuery = z.infer<typeof SafetyQuerySchema>;

export const SafetyVerdictSchema = z.object({
  allowed: z.boolean(),
  action: z.enum(["proceed", "ask_human", "deny"]),
  reason: z.string(),
  warnings: z.array(z.string()).nullable(),
});
export type SafetyVerdict = z.infer<typeof SafetyVerdictSchema>;
