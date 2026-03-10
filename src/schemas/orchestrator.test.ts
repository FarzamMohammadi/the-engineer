import { describe, expect, it } from "vitest";

import {
  CommEventSchema,
  DecompositionChildSchema,
  DecompositionPlanSchema,
  DemoPrepOutputSchema,
  ExecutionOutputSchema,
  FileChangeSchema,
  IntakeAnalysisOutputSchema,
  IntegrationOutputSchema,
  PhaseOutputSchema,
  PhaseSchema,
  PlanningOutputSchema,
  QuestionBatchSchema,
  QuestionSchema,
  ResearchOutputSchema,
  RiskSchema,
  SafetyQuerySchema,
  SafetyVerdictSchema,
  SelfReviewFindingSchema,
  SelfReviewOutputSchema,
  TrivialCriteriaSchema,
} from "./orchestrator.js";

// ── Phase Enum ──────────────────────────────────────────────────────────────────

describe("PhaseSchema", () => {
  const validPhases = [
    "intake_analysis",
    "research",
    "planning",
    "execution",
    "self_review",
    "demo_prep",
    "integration",
  ];

  it("has exactly 7 values", () => {
    expect(PhaseSchema.options).toHaveLength(7);
  });

  it("accepts all valid phases (with underscores)", () => {
    for (const phase of validPhases) {
      expect(PhaseSchema.parse(phase)).toBe(phase);
    }
  });

  it("rejects hyphenated versions", () => {
    expect(() => PhaseSchema.parse("intake-analysis")).toThrow();
    expect(() => PhaseSchema.parse("self-review")).toThrow();
    expect(() => PhaseSchema.parse("demo-prep")).toThrow();
  });

  it("rejects invalid values", () => {
    expect(() => PhaseSchema.parse("coding")).toThrow();
  });
});

// ── Phase Output Envelope ───────────────────────────────────────────────────────

describe("PhaseOutputSchema", () => {
  const validOutput = {
    phase: "research",
    task_id: "01ABC",
    timestamp: "2026-03-10T12:00:00.000Z",
    data: { relevant_files: [] },
    confidence: "high",
    open_questions: [],
  };

  it("parses valid output", () => {
    expect(PhaseOutputSchema.parse(validOutput)).toEqual(validOutput);
  });

  it("validates phase against PhaseSchema", () => {
    expect(() => PhaseOutputSchema.parse({ ...validOutput, phase: "invalid" })).toThrow();
  });

  it("accepts all confidence levels", () => {
    for (const conf of ["high", "medium", "low"]) {
      expect(PhaseOutputSchema.parse({ ...validOutput, confidence: conf }).confidence).toBe(conf);
    }
  });

  it("rejects invalid confidence", () => {
    expect(() => PhaseOutputSchema.parse({ ...validOutput, confidence: "very_high" })).toThrow();
  });
});

// ── Phase Outputs ───────────────────────────────────────────────────────────────

describe("IntakeAnalysisOutputSchema", () => {
  it("parses valid output", () => {
    const output = IntakeAnalysisOutputSchema.parse({
      complexity: "moderate",
      estimated_phases: ["intake_analysis", "research", "planning", "execution", "self_review"],
      ambiguities: ["Which auth provider?"],
      fast_path: false,
      decomposition_likely: false,
    });
    expect(output.complexity).toBe("moderate");
  });

  it("accepts all complexity levels", () => {
    for (const c of ["trivial", "simple", "moderate", "complex", "epic"]) {
      expect(
        IntakeAnalysisOutputSchema.parse({
          complexity: c,
          estimated_phases: [],
          ambiguities: [],
          fast_path: false,
          decomposition_likely: false,
        }).complexity,
      ).toBe(c);
    }
  });

  it("validates estimated_phases against PhaseSchema", () => {
    expect(() =>
      IntakeAnalysisOutputSchema.parse({
        complexity: "simple",
        estimated_phases: ["invalid_phase"],
        ambiguities: [],
        fast_path: true,
        decomposition_likely: false,
      }),
    ).toThrow();
  });
});

describe("ResearchOutputSchema", () => {
  it("parses valid output", () => {
    const output = ResearchOutputSchema.parse({
      relevant_files: ["src/auth.ts", "src/middleware.ts"],
      relevant_modules: ["auth"],
      conventions: [{ pattern: "middleware", description: "Express-style" }],
      existing_patterns: ["middleware pattern"],
      dependencies: ["express"],
    });
    expect(output.relevant_files).toHaveLength(2);
  });
});

describe("FileChangeSchema", () => {
  it("parses valid data", () => {
    const fc = FileChangeSchema.parse({
      file: "src/auth.ts",
      change_type: "modify",
      description: "Add OAuth handler",
    });
    expect(fc.change_type).toBe("modify");
  });

  it("accepts all change types", () => {
    for (const ct of ["create", "modify", "delete"]) {
      expect(
        FileChangeSchema.parse({ file: "x", change_type: ct, description: "y" }).change_type,
      ).toBe(ct);
    }
  });
});

describe("RiskSchema", () => {
  it("parses valid data", () => {
    expect(
      RiskSchema.parse({ risk: "API breaking change", mitigation: "Version the endpoint" }),
    ).toBeDefined();
  });
});

describe("PlanningOutputSchema", () => {
  it("parses valid output", () => {
    const output = PlanningOutputSchema.parse({
      approach: "Add OAuth middleware",
      file_changes: [{ file: "src/auth.ts", change_type: "create", description: "OAuth handler" }],
      risks: [{ risk: "Token expiry", mitigation: "Refresh logic" }],
      decomposition_plan: null,
    });
    expect(output.file_changes).toHaveLength(1);
  });

  it("accepts decomposition_plan as record", () => {
    const output = PlanningOutputSchema.parse({
      approach: "Complex task",
      file_changes: [],
      risks: [],
      decomposition_plan: { parent_task_id: "01ABC", children: [] },
    });
    expect(output.decomposition_plan).toBeDefined();
  });
});

describe("ExecutionOutputSchema", () => {
  it("parses valid output", () => {
    const output = ExecutionOutputSchema.parse({
      files_changed: ["src/auth.ts"],
      tests_written: ["src/auth.test.ts"],
      test_results: { passed: 10, failed: 0, skipped: 1 },
      build_status: "passing",
    });
    expect(output.test_results.passed).toBe(10);
  });

  it("accepts both build statuses", () => {
    for (const status of ["passing", "failing"]) {
      expect(
        ExecutionOutputSchema.parse({
          files_changed: [],
          tests_written: [],
          test_results: { passed: 0, failed: 0, skipped: 0 },
          build_status: status,
        }).build_status,
      ).toBe(status);
    }
  });
});

describe("SelfReviewFindingSchema", () => {
  it("parses valid data", () => {
    const finding = SelfReviewFindingSchema.parse({
      type: "security",
      file: "src/auth.ts",
      description: "SQL injection risk",
      fixed: true,
    });
    expect(finding.type).toBe("security");
  });

  it("accepts all finding types", () => {
    for (const type of ["style", "logic", "performance", "security", "maintainability"]) {
      expect(
        SelfReviewFindingSchema.parse({ type, file: "x", description: "y", fixed: false }).type,
      ).toBe(type);
    }
  });
});

describe("SelfReviewOutputSchema", () => {
  it("parses valid output", () => {
    const output = SelfReviewOutputSchema.parse({
      findings: [{ type: "style", file: "x.ts", description: "Naming", fixed: true }],
      refactoring_applied: ["Renamed variable"],
      quality_assessment: "ship_it",
    });
    expect(output.quality_assessment).toBe("ship_it");
  });

  it("accepts all quality assessments", () => {
    for (const qa of ["ship_it", "needs_work", "fundamental_issues"]) {
      expect(
        SelfReviewOutputSchema.parse({
          findings: [],
          refactoring_applied: [],
          quality_assessment: qa,
        }).quality_assessment,
      ).toBe(qa);
    }
  });
});

describe("DemoPrepOutputSchema", () => {
  it("parses valid output", () => {
    const output = DemoPrepOutputSchema.parse({
      artifacts: [{ type: "screenshot", location: "/tmp/demo.png", permanent: false }],
      pr_number: 42,
      pr_description: "## Summary\nAdded OAuth",
    });
    expect(output.artifacts).toHaveLength(1);
  });

  it("accepts all artifact types", () => {
    for (const type of ["screenshot", "recording", "tui", "preview_url"]) {
      expect(
        DemoPrepOutputSchema.parse({
          artifacts: [{ type, location: "/tmp/x", permanent: true }],
          pr_number: 1,
          pr_description: "x",
        }).artifacts[0]?.type,
      ).toBe(type);
    }
  });
});

describe("IntegrationOutputSchema", () => {
  it("parses valid output", () => {
    const output = IntegrationOutputSchema.parse({
      children_verified: ["01ABC", "01DEF"],
      integration_tests: { passed: 5, failed: 0 },
      conflicts_found: [],
      resolution_actions: [],
    });
    expect(output.children_verified).toHaveLength(2);
  });
});

// ── Communication Types ─────────────────────────────────────────────────────────

describe("CommEventSchema", () => {
  it("parses valid event", () => {
    const event = CommEventSchema.parse({
      type: "milestone",
      task_id: "01ABC",
      channel: "telegram",
      urgency: "immediate",
      content: "Task completed!",
      metadata: {},
    });
    expect(event.type).toBe("milestone");
  });

  it("accepts all event types", () => {
    for (const type of ["milestone", "question", "status_update", "alert", "digest"]) {
      expect(
        CommEventSchema.parse({
          type,
          task_id: "x",
          channel: "y",
          urgency: "batched",
          content: "z",
          metadata: {},
        }).type,
      ).toBe(type);
    }
  });

  it("accepts all urgency levels", () => {
    for (const urgency of ["immediate", "batched", "digest"]) {
      expect(
        CommEventSchema.parse({
          type: "alert",
          task_id: "x",
          channel: "y",
          urgency,
          content: "z",
          metadata: {},
        }).urgency,
      ).toBe(urgency);
    }
  });
});

describe("QuestionSchema", () => {
  it("parses valid question", () => {
    const q = QuestionSchema.parse({
      id: "q_01",
      question: "Which auth provider?",
      options: ["OAuth", "API Key", "JWT"],
      category: "architecture",
      urgency: "blocking",
    });
    expect(q.options).toHaveLength(3);
  });

  it("accepts null options", () => {
    const q = QuestionSchema.parse({
      id: "q_02",
      question: "What's the deadline?",
      options: null,
      category: "planning",
      urgency: "informational",
    });
    expect(q.options).toBeNull();
  });
});

describe("QuestionBatchSchema", () => {
  it("parses valid batch", () => {
    const batch = QuestionBatchSchema.parse({
      task_id: "01ABC",
      questions: [
        {
          id: "q_01",
          question: "Which auth?",
          options: null,
          category: "arch",
          urgency: "blocking",
        },
      ],
      batch_window_ms: 30_000,
    });
    expect(batch.questions).toHaveLength(1);
  });
});

// ── Decomposition ───────────────────────────────────────────────────────────────

describe("DecompositionChildSchema", () => {
  it("parses valid child", () => {
    const child = DecompositionChildSchema.parse({
      title: "Implement auth endpoint",
      description: "POST /auth/login",
      estimated_time_ms: 3_600_000,
      depends_on: [0],
      acceptance_criteria: ["Returns JWT", "Validates credentials"],
    });
    expect(child.depends_on).toEqual([0]);
  });
});

describe("DecompositionPlanSchema", () => {
  it("parses valid plan", () => {
    const plan = DecompositionPlanSchema.parse({
      parent_task_id: "01ABC",
      rationale: "Too complex for single task",
      children: [
        {
          title: "Sub-task 1",
          description: "First part",
          estimated_time_ms: 1_800_000,
          depends_on: [],
          acceptance_criteria: ["Compiles"],
        },
      ],
      dependency_graph: "1->2->(3,4 parallel)->5",
      total_estimated_ms: 7_200_000,
      parallelizable: true,
    });
    expect(plan.children).toHaveLength(1);
    expect(plan.parallelizable).toBe(true);
  });
});

// ── Trivial Criteria ────────────────────────────────────────────────────────────

describe("TrivialCriteriaSchema", () => {
  it("parses valid criteria (all true = trivial)", () => {
    const criteria = TrivialCriteriaSchema.parse({
      single_file: true,
      no_ambiguity: true,
      no_new_dependencies: true,
      no_architectural: true,
      no_tests_needed: true,
      estimated_time_under_limit: true,
    });
    expect(criteria.single_file).toBe(true);
  });

  it("parses valid criteria (non-trivial)", () => {
    const criteria = TrivialCriteriaSchema.parse({
      single_file: false,
      no_ambiguity: false,
      no_new_dependencies: true,
      no_architectural: false,
      no_tests_needed: false,
      estimated_time_under_limit: false,
    });
    expect(criteria.single_file).toBe(false);
  });

  it("rejects missing fields", () => {
    expect(() => TrivialCriteriaSchema.parse({ single_file: true })).toThrow();
  });
});

// ── Safety Query / Verdict ──────────────────────────────────────────────────────

describe("SafetyQuerySchema", () => {
  it("parses valid query", () => {
    const query = SafetyQuerySchema.parse({
      type: "can_i",
      context: {
        task_id: "01ABC",
        repo: "owner/repo",
        action_class: "write",
        decision_category: null,
        details: { file: "src/auth.ts" },
      },
    });
    expect(query.type).toBe("can_i");
  });

  it("accepts all query types", () => {
    for (const type of ["can_i", "should_i_ask", "cost_check"]) {
      expect(
        SafetyQuerySchema.parse({
          type,
          context: {
            task_id: "x",
            repo: "y",
            action_class: null,
            decision_category: null,
            details: {},
          },
        }).type,
      ).toBe(type);
    }
  });
});

describe("SafetyVerdictSchema", () => {
  it("parses valid verdict", () => {
    const verdict = SafetyVerdictSchema.parse({
      allowed: true,
      action: "proceed",
      reason: "Within scope",
      warnings: null,
    });
    expect(verdict.action).toBe("proceed");
  });

  it("accepts all action types", () => {
    for (const action of ["proceed", "ask_human", "deny"]) {
      expect(
        SafetyVerdictSchema.parse({
          allowed: action === "proceed",
          action,
          reason: "test",
          warnings: null,
        }).action,
      ).toBe(action);
    }
  });

  it("accepts warnings array", () => {
    const verdict = SafetyVerdictSchema.parse({
      allowed: true,
      action: "proceed",
      reason: "OK but watch out",
      warnings: ["Approaching cost limit"],
    });
    expect(verdict.warnings).toHaveLength(1);
  });
});
