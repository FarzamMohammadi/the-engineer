import { z } from "zod";

// ── Phase Enum ──────────────────────────────────────────────────────────────────

export const PhaseSchema = z.enum([
  "requirements_gathering",
  "research",
  "planning",
  "execution",
  "self_review",
  "demo_prep",
]);
export type Phase = z.infer<typeof PhaseSchema>;

/** Constant enum values for Phase. Use instead of raw strings. */
export const Phases = PhaseSchema.enum;

// ── Complexity Enum ────────────────────────────────────────────────────────────────

export const ComplexitySchema = z.enum(["trivial", "moderate", "complex"]);
export type Complexity = z.infer<typeof ComplexitySchema>;

/** Constant enum values for Complexity. Use instead of raw strings. */
export const Complexities = ComplexitySchema.enum;

// ── Phase Directory Constants ────────────────────────────────────────────────────

/**
 * Subdirectory names inside the thoughts/ directory — one per RRPIR phase.
 * Shared between WorkspaceManager (directory creation) and Orchestrator (file routing).
 */
export const PHASE_DIRECTORIES = [
  "requirements",
  "research",
  "planning",
  "implementation",
  "review",
  "demo-prep",
] as const;

// ── Phase Output Envelope ───────────────────────────────────────────────────────

export const PhaseOutputSchema = z.object({
  phase: PhaseSchema,
  task_id: z.string(),
  timestamp: z.string().datetime(),
  data: z.record(z.unknown()),
  confidence: z.enum(["high", "medium", "low"]),
  open_questions: z.array(z.string()),
});
export type PhaseOutput = z.infer<typeof PhaseOutputSchema>;

// ── Session Result (file-based phase routing) ───────────────────────────────────

/** Schema for session-result.json — the structured file each phase writes for routing. */
export const SessionResultSchema = z.object({
  status: z.enum(["ready", "need_more_info", "error"]),
  next_phase: PhaseSchema,
  summary: z.string(),
  complexity: ComplexitySchema.default("moderate"),
});
export type SessionResult = z.infer<typeof SessionResultSchema>;

// ── Phase Outputs (metadata-only for CLI-native phases) ─────────────────────────

export const RequirementsGatheringOutputSchema = z.object({
  deliverable_path: z.string(),
  status: z.enum(["ready", "need_more_info"]),
  contact: z.string().nullable(),
  question: z.string().nullable(),
  assessment: z.string().nullable(),
});
export type RequirementsGatheringOutput = z.infer<typeof RequirementsGatheringOutputSchema>;

export const ResearchOutputSchema = z.object({
  deliverable_path: z.string(),
  status: z.enum(["ready", "need_more_info"]),
  contact: z.string().nullable(),
  question: z.string().nullable(),
  complexity_hint: z.string().nullable(),
});
export type ResearchOutput = z.infer<typeof ResearchOutputSchema>;

export const FileChangeSchema = z.object({
  file: z.string(),
  change_type: z.string(),
  description: z.string(),
});
export type FileChange = z.infer<typeof FileChangeSchema>;

export const RiskSchema = z.object({
  risk: z.string(),
  mitigation: z.string(),
});
export type Risk = z.infer<typeof RiskSchema>;

export const PlanningOutputSchema = z.object({
  approach: z.string(),
  file_changes: z.array(FileChangeSchema),
  risks: z.array(RiskSchema),
});
export type PlanningOutput = z.infer<typeof PlanningOutputSchema>;

export const ExecutionOutputSchema = z.object({
  files_changed: z.array(z.string()),
  tests_written: z.array(z.string()).default([]),
  test_results: z.record(z.unknown()).default({}),
  build_status: z.string().default("unknown"),
});
export type ExecutionOutput = z.infer<typeof ExecutionOutputSchema>;

export const SelfReviewFindingSchema = z.object({
  type: z.string(),
  file: z.string(),
  description: z.string(),
  fixed: z.boolean(),
});
export type SelfReviewFinding = z.infer<typeof SelfReviewFindingSchema>;

export const SelfReviewOutputSchema = z.object({
  findings: z.array(SelfReviewFindingSchema),
  refactoring_applied: z.array(z.string()),
  quality_assessment: z.string(),
});
export type SelfReviewOutput = z.infer<typeof SelfReviewOutputSchema>;

export const DemoPrepOutputSchema = z.object({
  artifacts: z.array(z.record(z.unknown())).default([]),
  pr_number: z.number().optional(),
  pr_description: z.string().default(""),
});
export type DemoPrepOutput = z.infer<typeof DemoPrepOutputSchema>;

// ── Phase Output Map ────────────────────────────────────────────────────────────

export type PhaseOutputMap = {
  requirements_gathering: RequirementsGatheringOutput;
  research: ResearchOutput;
  planning: PlanningOutput;
  execution: ExecutionOutput;
  self_review: SelfReviewOutput;
  demo_prep: DemoPrepOutput;
};

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
