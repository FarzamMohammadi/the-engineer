# Orchestrator Type Schemas

Phase outputs, communication types, and decomposition plan. Source: [`../../2-components/orchestrator.md`](../../2-components/orchestrator.md).

**Persistence:** Zod only — these types are serialized into checkpoint JSON when persisted. They live in memory during Orchestrator execution.

**Validation pattern:** Phase outputs are LLM-generated. Use `.safeParse()` with fallback, not hard `.parse()` gates. Schemas document the expected shape; the code handles deviations gracefully.

---

## Phase Enum

```typescript
const PhaseSchema = z.enum([
  "intake_analysis",
  "research",
  "planning",
  "execution",
  "self_review",
  "demo_prep",
  "integration",
]);
type Phase = z.infer<typeof PhaseSchema>;
```

> **Reconciliation:** L2 used hyphens (`intake-analysis`, `self-review`, `demo-prep`). Normalized to underscores for TypeScript identifier compatibility.

---

## Phase Outputs

Each phase produces structured output that feeds the next. These are the "intermediate representations" from the compiler analogy.

### PhaseOutput Envelope

```typescript
const PhaseOutputSchema = z.object({
  phase: PhaseSchema,
  task_id: z.string(),
  timestamp: z.string().datetime(),
  data: z.record(z.unknown()),         // phase-specific — typed schemas below
  confidence: z.enum(["high", "medium", "low"]),
  open_questions: z.array(z.string()),
});
type PhaseOutput = z.infer<typeof PhaseOutputSchema>;
```

### Intake Analysis Output

```typescript
const IntakeAnalysisOutputSchema = z.object({
  complexity: z.enum(["trivial", "simple", "moderate", "complex", "epic"]),
  estimated_phases: z.array(PhaseSchema),
  ambiguities: z.array(z.string()),
  fast_path: z.boolean(),
  decomposition_likely: z.boolean(),
});
type IntakeAnalysisOutput = z.infer<typeof IntakeAnalysisOutputSchema>;
```

### Research Output

```typescript
const ResearchOutputSchema = z.object({
  relevant_files: z.array(z.string()),
  relevant_modules: z.array(z.string()),
  conventions: z.array(z.record(z.unknown())), // KnowledgeEntry-shaped, to be stored
  existing_patterns: z.array(z.string()),
  dependencies: z.array(z.string()),
});
type ResearchOutput = z.infer<typeof ResearchOutputSchema>;
```

### Planning Output

```typescript
const FileChangeSchema = z.object({
  file: z.string(),
  change_type: z.enum(["create", "modify", "delete"]),
  description: z.string(),
});

const RiskSchema = z.object({
  risk: z.string(),
  mitigation: z.string(),
});

const PlanningOutputSchema = z.object({
  approach: z.string(),
  file_changes: z.array(FileChangeSchema),
  risks: z.array(RiskSchema),
  decomposition_plan: z.record(z.unknown()).nullable(), // DecompositionPlan shape, see below
});
type PlanningOutput = z.infer<typeof PlanningOutputSchema>;
```

### Execution Output

```typescript
const ExecutionOutputSchema = z.object({
  files_changed: z.array(z.string()),
  tests_written: z.array(z.string()),
  test_results: z.object({
    passed: z.number().int(),
    failed: z.number().int(),
    skipped: z.number().int(),
  }),
  build_status: z.enum(["passing", "failing"]),
});
type ExecutionOutput = z.infer<typeof ExecutionOutputSchema>;
```

### Self-Review Output

```typescript
const SelfReviewFindingSchema = z.object({
  type: z.enum(["style", "logic", "performance", "security", "maintainability"]),
  file: z.string(),
  description: z.string(),
  fixed: z.boolean(),
});

const SelfReviewOutputSchema = z.object({
  findings: z.array(SelfReviewFindingSchema),
  refactoring_applied: z.array(z.string()),
  quality_assessment: z.enum(["ship_it", "needs_work", "fundamental_issues"]),
});
type SelfReviewOutput = z.infer<typeof SelfReviewOutputSchema>;
```

### Demo Prep Output

```typescript
const DemoPrepOutputSchema = z.object({
  artifacts: z.array(z.object({
    type: z.enum(["screenshot", "recording", "tui", "preview_url"]),
    location: z.string(),
    permanent: z.boolean(),
  })),
  pr_number: z.number().int().positive(),
  pr_description: z.string(),
});
type DemoPrepOutput = z.infer<typeof DemoPrepOutputSchema>;
```

### Integration Output

```typescript
const IntegrationOutputSchema = z.object({
  children_verified: z.array(z.string()),
  integration_tests: z.object({
    passed: z.number().int(),
    failed: z.number().int(),
  }),
  conflicts_found: z.array(z.string()),
  resolution_actions: z.array(z.string()),
});
type IntegrationOutput = z.infer<typeof IntegrationOutputSchema>;
```

### Phase Output Type Map

```typescript
type PhaseOutputMap = {
  intake_analysis: IntakeAnalysisOutput;
  research: ResearchOutput;
  planning: PlanningOutput;
  execution: ExecutionOutput;
  self_review: SelfReviewOutput;
  demo_prep: DemoPrepOutput;
  integration: IntegrationOutput;
};
```

---

## Communication Types

### CommEvent

```typescript
const CommEventSchema = z.object({
  type: z.enum(["milestone", "question", "status_update", "alert", "digest"]),
  task_id: z.string(),
  channel: z.string(),                 // "telegram", "github_pr", "github_issue"
  urgency: z.enum(["immediate", "batched", "digest"]),
  content: z.string(),
  metadata: z.record(z.unknown()),
});
type CommEvent = z.infer<typeof CommEventSchema>;
```

### QuestionBatch

```typescript
const QuestionSchema = z.object({
  id: z.string(),
  question: z.string(),
  options: z.array(z.string()).nullable(),
  category: z.string(),               // autonomy category
  urgency: z.enum(["blocking", "informational"]),
});

const QuestionBatchSchema = z.object({
  task_id: z.string(),
  questions: z.array(QuestionSchema),
  batch_window_ms: z.number().int(),   // milliseconds
});
type QuestionBatch = z.infer<typeof QuestionBatchSchema>;
```

---

## Decomposition Plan

```typescript
const DecompositionChildSchema = z.object({
  title: z.string(),
  description: z.string(),
  estimated_time_ms: z.number().int(), // milliseconds
  depends_on: z.array(z.number().int()), // indices into the children array
  acceptance_criteria: z.array(z.string()),
});

const DecompositionPlanSchema = z.object({
  parent_task_id: z.string(),
  rationale: z.string(),
  children: z.array(DecompositionChildSchema),
  dependency_graph: z.string(),        // human-readable: "1->2->(3,4 parallel)->5"
  total_estimated_ms: z.number().int(),
  parallelizable: z.boolean(),
});
type DecompositionPlan = z.infer<typeof DecompositionPlanSchema>;
```

---

## Trivial Criteria (Fast-Path)

```typescript
const TrivialCriteriaSchema = z.object({
  single_file: z.boolean(),
  no_ambiguity: z.boolean(),
  no_new_dependencies: z.boolean(),
  no_architectural: z.boolean(),
  no_tests_needed: z.boolean(),
  estimated_time_under_limit: z.boolean(),
});
type TrivialCriteria = z.infer<typeof TrivialCriteriaSchema>;
```

---

## Safety Query / Verdict

Used by the Orchestrator to consult the Safety Layer.

```typescript
const SafetyQuerySchema = z.object({
  type: z.enum(["can_i", "should_i_ask", "cost_check"]),
  context: z.object({
    task_id: z.string(),
    repo: z.string(),
    action_class: z.string().nullable(),
    decision_category: z.string().nullable(),
    details: z.record(z.unknown()),
  }),
});
type SafetyQuery = z.infer<typeof SafetyQuerySchema>;

const SafetyVerdictSchema = z.object({
  allowed: z.boolean(),
  action: z.enum(["proceed", "ask_human", "deny"]),
  reason: z.string(),
  warnings: z.array(z.string()).nullable(),
});
type SafetyVerdict = z.infer<typeof SafetyVerdictSchema>;
```
