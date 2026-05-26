import { describe, expect, it } from "vitest";

import {
  ActionClassSchema,
  ActionClasses,
  BlockedDetailsSchema,
  ExternalRefSchema,
  PermissionTable,
  RelatedItemSchema,
  ReviewStateSchema,
  StateTransitionSchema,
  SubStateSchema,
  SubStates,
  TaskDecisionSchema,
  TaskSchema,
  TaskStateSchema,
  TaskStates,
  TaskWorkspaceSchema,
  TeamMemberRoles,
  TeamMemberSchema,
  ValidTransitions,
} from "../../../src/schemas/task.js";

// ── Enums ──────────────────────────────────────────────────────────────────────

describe("TaskStateSchema", () => {
  const validStates = [
    "requirements_gathering",
    "queued",
    "active",
    "blocked",
    "review_pending",
    "completed",
    "failed",
  ];

  it("accepts all 7 valid states", () => {
    for (const state of validStates) {
      expect(TaskStateSchema.parse(state)).toBe(state);
    }
  });

  it("has exactly 7 values", () => {
    expect(TaskStateSchema.options).toHaveLength(7);
  });

  it("rejects invalid values", () => {
    expect(() => TaskStateSchema.parse("running")).toThrow();
    expect(() => TaskStateSchema.parse("")).toThrow();
    expect(() => TaskStateSchema.parse(42)).toThrow();
  });
});

describe("SubStateSchema", () => {
  it("accepts valid sub-states", () => {
    for (const sub of ["working", "code"]) {
      expect(SubStateSchema.parse(sub)).toBe(sub);
    }
  });

  it("rejects invalid values", () => {
    expect(() => SubStateSchema.parse("review")).toThrow();
    expect(() => SubStateSchema.parse("supervising")).toThrow();
  });
});

describe("ActionClassSchema", () => {
  it("has exactly 10 values", () => {
    expect(ActionClassSchema.options).toHaveLength(10);
  });

  it("accepts all valid values", () => {
    const classes = [
      "read",
      "write",
      "test",
      "git_local",
      "git_remote",
      "communicate",
      "merge",
      "deploy",
      "task_manage",
      "ask_human",
    ];
    for (const cls of classes) {
      expect(ActionClassSchema.parse(cls)).toBe(cls);
    }
  });
});

// ── Sub-schemas ────────────────────────────────────────────────────────────────

describe("ExternalRefSchema", () => {
  it("parses valid data", () => {
    const valid = { type: "test_issue", repo: "owner/repo", id: "42" };
    expect(ExternalRefSchema.parse(valid)).toEqual(valid);
  });

  it("rejects non-string id", () => {
    expect(() => ExternalRefSchema.parse({ type: "test_issue", repo: "a/b", id: 42 })).toThrow();
  });

  it("rejects missing id", () => {
    expect(() => ExternalRefSchema.parse({ type: "test_issue", repo: "a/b" })).toThrow();
  });

  it("accepts any string as type (open, not enum)", () => {
    expect(ExternalRefSchema.parse({ type: "jira_ticket", repo: "a/b", id: "VE-123" })).toBeDefined();
    expect(ExternalRefSchema.parse({ type: "manual", repo: "a/b", id: "1" })).toBeDefined();
  });

  it("accepts pr_decorations with all 4 fields", () => {
    const result = ExternalRefSchema.parse({
      type: "github_issue",
      repo: "owner/repo",
      id: "42",
      url: "https://github.com/owner/repo/issues/42",
      pr_decorations: {
        title_prefix: "#42:",
        title_suffix: "[urgent]",
        description_prefix: "Context: sprint-12",
        description_suffix: "Closes #42",
      },
    });
    expect(result.pr_decorations?.title_prefix).toBe("#42:");
    expect(result.pr_decorations?.title_suffix).toBe("[urgent]");
    expect(result.pr_decorations?.description_prefix).toBe("Context: sprint-12");
    expect(result.pr_decorations?.description_suffix).toBe("Closes #42");
  });

  it("parses without pr_decorations (backward compatible)", () => {
    const result = ExternalRefSchema.parse({
      type: "github_issue",
      repo: "owner/repo",
      id: "42",
    });
    expect(result.pr_decorations).toBeUndefined();
  });

  it("accepts partial pr_decorations (only title_prefix)", () => {
    const result = ExternalRefSchema.parse({
      type: "github_issue",
      repo: "owner/repo",
      id: "42",
      pr_decorations: { title_prefix: "#42:" },
    });
    expect(result.pr_decorations?.title_prefix).toBe("#42:");
    expect(result.pr_decorations?.title_suffix).toBeUndefined();
    expect(result.pr_decorations?.description_suffix).toBeUndefined();
  });

  it("accepts empty pr_decorations object", () => {
    const result = ExternalRefSchema.parse({
      type: "github_issue",
      repo: "owner/repo",
      id: "42",
      pr_decorations: {},
    });
    expect(result.pr_decorations).toBeDefined();
    expect(result.pr_decorations?.title_prefix).toBeUndefined();
  });

  it("accepts empty string in decoration field (schema allows, application treats as absent)", () => {
    const result = ExternalRefSchema.parse({
      type: "github_issue",
      repo: "owner/repo",
      id: "42",
      pr_decorations: { title_prefix: "", description_suffix: "" },
    });
    expect(result.pr_decorations?.title_prefix).toBe("");
    expect(result.pr_decorations?.description_suffix).toBe("");
  });
});

describe("TeamMemberSchema", () => {
  it("parses valid data", () => {
    const valid = { person_id: "farzam", role: TeamMemberRoles.author, context: "project owner" };
    expect(TeamMemberSchema.parse(valid)).toEqual(valid);
  });

  it("rejects invalid role", () => {
    expect(() => TeamMemberSchema.parse({ person_id: "x", role: "manager", context: "y" })).toThrow();
  });
});

describe("RelatedItemSchema", () => {
  it("parses valid data", () => {
    const valid = { type: "issue", ref: "#42", relevance: "related bug" };
    expect(RelatedItemSchema.parse(valid)).toEqual(valid);
  });

  it("rejects invalid type", () => {
    expect(() => RelatedItemSchema.parse({ type: "unknown", ref: "x", relevance: "y" })).toThrow();
  });
});

describe("TaskDecisionSchema", () => {
  it("parses valid data", () => {
    const valid = {
      what: "Use Zod",
      why: "Runtime validation",
      alternatives_considered: ["io-ts", "yup"],
      decided_by: "human",
      timestamp: "2026-03-10T12:00:00.000Z",
    };
    expect(TaskDecisionSchema.parse(valid)).toEqual(valid);
  });

  it("rejects invalid timestamp", () => {
    expect(() =>
      TaskDecisionSchema.parse({
        what: "x",
        why: "y",
        alternatives_considered: [],
        decided_by: "agent",
        timestamp: "not-a-date",
      }),
    ).toThrow();
  });

  it("rejects invalid decided_by", () => {
    expect(() =>
      TaskDecisionSchema.parse({
        what: "x",
        why: "y",
        alternatives_considered: [],
        decided_by: "system",
        timestamp: "2026-03-10T12:00:00.000Z",
      }),
    ).toThrow();
  });
});

describe("TaskWorkspaceSchema", () => {
  it("parses valid data with nullable worktree_path", () => {
    expect(
      TaskWorkspaceSchema.parse({
        repo: "owner/repo",
        branch: "engineer/47-dark-mode",
        base_branch: "main",
        worktree_path: null,
        thoughts_dir: null,
      }),
    ).toBeDefined();

    expect(
      TaskWorkspaceSchema.parse({
        repo: "owner/repo",
        branch: "engineer/47-dark-mode",
        base_branch: "main",
        worktree_path: "/tmp/worktree",
        thoughts_dir: "thoughts/2026-03-23-issue-42",
      }),
    ).toBeDefined();
  });

  it("rejects data missing base_branch", () => {
    expect(() =>
      TaskWorkspaceSchema.parse({
        repo: "owner/repo",
        branch: "engineer/47-dark-mode",
        worktree_path: null,
        thoughts_dir: null,
      }),
    ).toThrow();
  });
});

describe("ReviewStateSchema", () => {
  it("parses valid data", () => {
    const input = {
      pr_number: 42,
      pr_state: "ready" as const,
      demo_artifacts: [{ type: "screenshot" as const, location: "/tmp/demo.png", permanent: false }],
      feedback_rounds: [{ stage: "code" as const, comments: ["looks good"], applied: true }],
    };
    expect(ReviewStateSchema.parse(input)).toEqual({
      ...input,
      accommodated_comment_ids: [],
      accommodated_review_state: null,
    });
  });

  it("accepts null pr fields", () => {
    const input = {
      pr_number: null,
      pr_state: null,
      demo_artifacts: [],
      feedback_rounds: [],
    };
    expect(ReviewStateSchema.parse(input)).toEqual({
      ...input,
      accommodated_comment_ids: [],
      accommodated_review_state: null,
    });
  });

  it("preserves accommodated fields when provided", () => {
    const input = {
      pr_number: 42,
      pr_state: "ready" as const,
      demo_artifacts: [],
      feedback_rounds: [],
      accommodated_comment_ids: ["comment-1", "comment-2"],
      accommodated_review_state: "changes_requested",
    };
    expect(ReviewStateSchema.parse(input)).toEqual(input);
  });
});

describe("BlockedDetailsSchema", () => {
  it("parses valid data with nested contacted array", () => {
    const valid = {
      reason: "Need API credentials",
      efforts_made: ["Checked docs", "Searched codebase"],
      contacted: [{ person: "farzam", channel: "telegram", timestamp: "2026-03-10T12:00:00.000Z" }],
      needed: "AWS credentials for staging",
      waiting_for: "Farzam to share credentials",
    };
    expect(BlockedDetailsSchema.parse(valid)).toEqual(valid);
  });
});

// ── TaskSchema ─────────────────────────────────────────────────────────────────

describe("TaskSchema", () => {
  const minimalTask = {
    id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    external_ref: null,
    idempotency_key: "test:minimal",
    state: TaskStates.requirements_gathering,
    sub_state: null,
    phase: null,
    title: "Fix auth bug",
    description: "Users can't log in",
    source_text: "Issue body text",
    acceptance_criteria: ["Users can log in"],
    team: [],
    related: [],
    decisions: [],
    repo: null,
    workspace: null,
    review: null,
    blocked: null,
    return_to_phase: null,
    loopback_count: 0,
    requirements_loop_count: 0,
    skip_research: false,
    priority: 50,
    llm_tokens: 0,
    llm_cost_usd: 0,
    compute_time_ms: 0,
    created_at: "2026-03-10T12:00:00.000Z",
    started_at: null,
    completed_at: null,
    last_transition_at: "2026-03-10T12:00:00.000Z",
    clone_url: null,
    thoughts_id: null,
    not_before: null,
    consecutive_crash_count: 0,
    consecutive_llm_unavailable_count: 0,
    session_id: null,
  };

  it("parses a minimal valid task", () => {
    expect(TaskSchema.parse(minimalTask)).toEqual(minimalTask);
  });

  it("rejects invalid state", () => {
    expect(() => TaskSchema.parse({ ...minimalTask, state: "running" })).toThrow();
  });

  it("rejects missing required fields", () => {
    const { title: _title, ...noTitle } = minimalTask;
    expect(() => TaskSchema.parse(noTitle)).toThrow();
  });

  it("rejects invalid timestamp format", () => {
    expect(() => TaskSchema.parse({ ...minimalTask, created_at: "yesterday" })).toThrow();
  });

  it("defaults priority to 50 when omitted", () => {
    const { priority: _priority, ...noPriority } = minimalTask;
    expect(TaskSchema.parse(noPriority).priority).toBe(50);
  });

  it("rejects priority below 1 (DB CHECK lower bound)", () => {
    expect(() => TaskSchema.parse({ ...minimalTask, priority: 0 })).toThrow();
    expect(() => TaskSchema.parse({ ...minimalTask, priority: -10 })).toThrow();
  });

  it("rejects priority above 100 (DB CHECK upper bound)", () => {
    expect(() => TaskSchema.parse({ ...minimalTask, priority: 101 })).toThrow();
    expect(() => TaskSchema.parse({ ...minimalTask, priority: 1000 })).toThrow();
  });
});

// ── StateTransitionSchema ──────────────────────────────────────────────────────

describe("StateTransitionSchema", () => {
  it("parses valid transition", () => {
    const valid = {
      id: "01ABC",
      task_id: "01XYZ",
      from_state: TaskStates.requirements_gathering,
      to_state: TaskStates.queued,
      from_sub: null,
      to_sub: null,
      reason: "Task validated",
      timestamp: "2026-03-10T12:00:00.000Z",
      triggered_by: "task_engine",
    };
    expect(StateTransitionSchema.parse(valid)).toEqual(valid);
  });

  it("validates state enums", () => {
    expect(() =>
      StateTransitionSchema.parse({
        id: "01ABC",
        task_id: "01XYZ",
        from_state: "invalid",
        to_state: TaskStates.queued,
        from_sub: null,
        to_sub: null,
        reason: "test",
        timestamp: "2026-03-10T12:00:00.000Z",
        triggered_by: "test",
      }),
    ).toThrow();
  });
});

// ── ValidTransitions ───────────────────────────────────────────────────────────

describe("ValidTransitions", () => {
  it("has no duplicate entries", () => {
    const keys = ValidTransitions.map(
      (t) =>
        `${t.from}:${("from_sub" in t ? t.from_sub : undefined) ?? ""}→${t.to}:${("to_sub" in t ? t.to_sub : undefined) ?? ""}`,
    );
    const unique = new Set(keys);
    expect(unique.size).toBe(keys.length);
  });

  it("completed is never a 'from' state", () => {
    const fromStates = new Set<string>(ValidTransitions.map((t) => t.from));
    expect(fromStates.has(TaskStates.completed)).toBe(false);
  });

  it("failed can only transition to queued (owner retry)", () => {
    const failedEdges = ValidTransitions.filter((t) => t.from === TaskStates.failed);
    expect(failedEdges).toHaveLength(1);
    expect(failedEdges[0]!.to).toBe(TaskStates.queued);
  });

  it("intake is never a 'to' state", () => {
    const toStates = new Set<string>(ValidTransitions.map((t) => t.to));
    expect(toStates.has(TaskStates.requirements_gathering)).toBe(false);
  });

  it("active 'from' entries always have from_sub specified", () => {
    const activeFrom = ValidTransitions.filter((t) => t.from === TaskStates.active);
    for (const t of activeFrom) {
      expect("from_sub" in t ? t.from_sub : undefined).toBeDefined();
    }
  });

  it("active 'to' entries always have to_sub specified", () => {
    const activeTo = ValidTransitions.filter((t) => t.to === TaskStates.active);
    for (const t of activeTo) {
      expect("to_sub" in t ? t.to_sub : undefined).toBeDefined();
    }
  });
});

// ── PermissionTable ────────────────────────────────────────────────────────────

describe("PermissionTable", () => {
  it("covers all valid (state, sub_state) pairs", () => {
    const expectedPairs = [
      [TaskStates.requirements_gathering, null],
      [TaskStates.queued, null],
      [TaskStates.active, SubStates.working],
      [TaskStates.review_pending, SubStates.code],
      [TaskStates.blocked, null],
      [TaskStates.completed, null],
      [TaskStates.failed, null],
    ];

    const actualPairs = PermissionTable.map((e) => [e.state, e.sub_state]);
    expect(actualPairs).toEqual(expectedPairs);
  });

  it("completed state has no allowed actions", () => {
    const completed = PermissionTable.find((e) => e.state === TaskStates.completed);
    expect(completed?.allowed).toEqual([]);
  });

  it("failed state only allows communicate", () => {
    const failed = PermissionTable.find((e) => e.state === TaskStates.failed);
    expect(failed?.allowed).toEqual([ActionClasses.communicate]);
  });

  it("active.working has the most permissions", () => {
    const working = PermissionTable.find((e) => e.state === TaskStates.active && e.sub_state === SubStates.working);
    expect(working?.allowed.length).toBeGreaterThan(5);
  });

  it("review_pending.code has conditional merge permission", () => {
    const code = PermissionTable.find((e) => e.state === TaskStates.review_pending && e.sub_state === SubStates.code);
    expect(code?.conditional).toBeDefined();
    expect(code?.conditional?.merge).toBeDefined();
  });

  it("all allowed values are valid ActionClass values", () => {
    const validClasses = new Set(ActionClassSchema.options);
    for (const entry of PermissionTable) {
      for (const action of entry.allowed) {
        expect(validClasses.has(action)).toBe(true);
      }
    }
  });
});
