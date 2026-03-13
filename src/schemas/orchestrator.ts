import { z } from "zod";

// ── Phase Enum ──────────────────────────────────────────────────────────────────

export const PhaseSchema = z.enum([
  "intake_analysis",
  "research",
  "planning",
  "execution",
  "self_review",
  "demo_prep",
  "integration",
]);
export type Phase = z.infer<typeof PhaseSchema>;

/** Constant enum values for Phase. Use instead of raw strings. */
export const Phases = PhaseSchema.enum;

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

// ── Phase Outputs ───────────────────────────────────────────────────────────────

export const IntakeAnalysisOutputSchema = z.object({
  complexity: z.enum(["trivial", "simple", "moderate", "complex", "epic"]),
  estimated_phases: z.array(PhaseSchema),
  ambiguities: z.array(z.string()),
  fast_path: z.boolean(),
  decomposition_likely: z.boolean(),
});
export type IntakeAnalysisOutput = z.infer<typeof IntakeAnalysisOutputSchema>;

export const ResearchOutputSchema = z.object({
  relevant_files: z.array(z.string()),
  relevant_modules: z.array(z.string()),
  conventions: z.array(z.record(z.unknown())),
  existing_patterns: z.array(z.string()),
  dependencies: z.array(z.string()),
});
export type ResearchOutput = z.infer<typeof ResearchOutputSchema>;

export const FileChangeSchema = z.object({
  file: z.string(),
  change_type: z.enum(["create", "modify", "delete"]),
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
  decomposition_plan: z.lazy(() => LLMDecompositionPlanSchema).nullable(),
});
export type PlanningOutput = z.infer<typeof PlanningOutputSchema>;

export const ExecutionOutputSchema = z.object({
  files_changed: z.array(z.string()),
  tests_written: z.array(z.string()),
  test_results: z.object({
    passed: z.number().int(),
    failed: z.number().int(),
    skipped: z.number().int(),
  }),
  build_status: z.enum(["passing", "failing", "unknown"]),
});
export type ExecutionOutput = z.infer<typeof ExecutionOutputSchema>;

export const SelfReviewFindingSchema = z.object({
  type: z.enum(["style", "logic", "performance", "security", "maintainability"]),
  file: z.string(),
  description: z.string(),
  fixed: z.boolean(),
});
export type SelfReviewFinding = z.infer<typeof SelfReviewFindingSchema>;

export const SelfReviewOutputSchema = z.object({
  findings: z.array(SelfReviewFindingSchema),
  refactoring_applied: z.array(z.string()),
  quality_assessment: z.enum(["ship_it", "needs_work", "fundamental_issues"]),
});
export type SelfReviewOutput = z.infer<typeof SelfReviewOutputSchema>;

export const DemoPrepOutputSchema = z.object({
  artifacts: z.array(
    z.object({
      type: z.enum(["screenshot", "recording", "tui", "preview_url"]),
      location: z.string(),
      permanent: z.boolean(),
    }),
  ),
  pr_number: z.number().int().positive(),
  pr_description: z.string(),
});
export type DemoPrepOutput = z.infer<typeof DemoPrepOutputSchema>;

export const IntegrationOutputSchema = z.object({
  children_verified: z.array(z.string()),
  integration_tests: z.object({
    passed: z.number().int(),
    failed: z.number().int(),
  }),
  conflicts_found: z.array(z.string()),
  resolution_actions: z.array(z.string()),
});
export type IntegrationOutput = z.infer<typeof IntegrationOutputSchema>;

// ── Phase Output Map ────────────────────────────────────────────────────────────

export type PhaseOutputMap = {
  intake_analysis: IntakeAnalysisOutput;
  research: ResearchOutput;
  planning: PlanningOutput;
  execution: ExecutionOutput;
  self_review: SelfReviewOutput;
  demo_prep: DemoPrepOutput;
  integration: IntegrationOutput;
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

// ── Decomposition ───────────────────────────────────────────────────────────────

export const DecompositionChildSchema = z.object({
  title: z.string(),
  description: z.string(),
  estimated_time_ms: z.number().int(),
  depends_on: z.array(z.number().int()),
  acceptance_criteria: z.array(z.string()),
});
export type DecompositionChild = z.infer<typeof DecompositionChildSchema>;

export const DecompositionPlanSchema = z.object({
  parent_task_id: z.string(),
  rationale: z.string(),
  children: z.array(DecompositionChildSchema),
  dependency_graph: z.string(),
  total_estimated_ms: z.number().int(),
  parallelizable: z.boolean(),
});
export type DecompositionPlan = z.infer<typeof DecompositionPlanSchema>;

/** LLM-facing decomposition plan (parent_task_id excluded — set by Orchestrator). */
export const LLMDecompositionPlanSchema = z.object({
  rationale: z.string(),
  children: z.array(DecompositionChildSchema),
  dependency_graph: z.string(),
  total_estimated_ms: z.number().int(),
  parallelizable: z.boolean(),
});
export type LLMDecompositionPlan = z.infer<typeof LLMDecompositionPlanSchema>;

// ── Trivial Criteria (Fast-Path) ────────────────────────────────────────────────

export const TrivialCriteriaSchema = z.object({
  single_file: z.boolean(),
  no_ambiguity: z.boolean(),
  no_new_dependencies: z.boolean(),
  no_architectural: z.boolean(),
  no_tests_needed: z.boolean(),
  estimated_time_under_limit: z.boolean(),
});
export type TrivialCriteria = z.infer<typeof TrivialCriteriaSchema>;

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

// ── Agent Loop Types ────────────────────────────────────────────────────────────

/** Actions the LLM can request during the agent loop. Discriminated union on `action`. */
export const AgentActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("read_file"),
    params: z.object({ path: z.string() }),
    thinking: z.string().optional(),
  }),
  z.object({
    action: z.literal("write_file"),
    params: z.object({ path: z.string(), content: z.string() }),
    thinking: z.string().optional(),
  }),
  z.object({
    action: z.literal("edit_file"),
    params: z.object({ path: z.string(), old_string: z.string(), new_string: z.string() }),
    thinking: z.string().optional(),
  }),
  z.object({
    action: z.literal("search_files"),
    params: z.object({ pattern: z.string(), path: z.string().optional() }),
    thinking: z.string().optional(),
  }),
  z.object({
    action: z.literal("search_content"),
    params: z.object({
      pattern: z.string(),
      path: z.string().optional(),
      glob: z.string().optional(),
    }),
    thinking: z.string().optional(),
  }),
  z.object({
    action: z.literal("run_command"),
    params: z.object({ command: z.string() }),
    thinking: z.string().optional(),
  }),
  z.object({
    action: z.literal("done"),
    result: z.record(z.unknown()),
    thinking: z.string().optional(),
  }),
]);
export type AgentAction = z.infer<typeof AgentActionSchema>;

/** All possible action names for type-safe checks. */
export const AGENT_ACTION_NAMES = [
  "read_file",
  "write_file",
  "edit_file",
  "search_files",
  "search_content",
  "run_command",
  "done",
] as const;
export type AgentActionName = (typeof AGENT_ACTION_NAMES)[number];

/** Result of executing an agent action. */
export const ActionResultSchema = z.object({
  success: z.boolean(),
  output: z.string(),
  error: z.string().optional(),
});
export type ActionResult = z.infer<typeof ActionResultSchema>;

/** Per-phase tool restrictions (maps to D141 Permission Table). */
export const PhaseToolConfigSchema = z.object({
  allowed_actions: z.array(z.string()),
  max_iterations: z.number().int().positive(),
  action_classes: z.array(z.string()),
});
export type PhaseToolConfig = z.infer<typeof PhaseToolConfigSchema>;
