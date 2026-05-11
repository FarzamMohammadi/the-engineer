import { describe, expect, it } from "vitest";

import {
  ApiSpendSchema,
  CapacitySchema,
  CliProviderUsageSchema,
  CostAccumulatorsSchema,
  DaemonHealthSchema,
  DaemonStateSchema,
  DispatchSchema,
  EventSubscriptionSchema,
  PendingPreemptionSchema,
  PreemptionStatusSchema,
  PreemptionStatuses,
  PrioritySchema,
  PrioritySourceSchema,
  PrioritySources,
  QueueEntrySchema,
  SafetySnapshotSchema,
  SafetyStateSchema,
  TriggerStateSchema,
  WorkspaceStateSchema,
  WorktreeInfoSchema,
} from "../../../src/schemas/ephemeral.js";
import { Phases } from "../../../src/schemas/orchestrator.js";
import {
  CheckpointReasons,
  KnowledgeConfidences,
  KnowledgeDomains,
  KnowledgeScopes,
} from "../../../src/schemas/session-memory.js";
import { CascadePolicies, SubStates, TaskStates } from "../../../src/schemas/task.js";

// ── Daemon State ────────────────────────────────────────────────────────────────

describe("CapacitySchema", () => {
  it("parses valid data", () => {
    const cap = CapacitySchema.parse({ max_concurrent: 1, working_tasks: [] });
    expect(cap.max_concurrent).toBe(1);
  });

  it("accepts working tasks", () => {
    const cap = CapacitySchema.parse({ max_concurrent: 3, working_tasks: ["01ABC", "01DEF"] });
    expect(cap.working_tasks).toHaveLength(2);
  });

  it("rejects non-positive max_concurrent", () => {
    expect(() => CapacitySchema.parse({ max_concurrent: 0, working_tasks: [] })).toThrow();
  });
});

describe("PrioritySourceSchema", () => {
  it("has exactly 3 values", () => {
    expect(PrioritySourceSchema.options).toHaveLength(3);
  });

  it("accepts all valid values", () => {
    for (const source of ["explicit", "default", "aged"]) {
      expect(PrioritySourceSchema.parse(source)).toBe(source);
    }
  });
});

describe("PrioritySchema", () => {
  const validPriority = {
    value: 50,
    source: PrioritySources.default,
    base_value: 50,
    assigned_at: "2026-03-10T12:00:00.000Z",
  };

  it("parses valid data", () => {
    expect(PrioritySchema.parse(validPriority)).toEqual(validPriority);
  });

  it("enforces value bounds 1-100", () => {
    expect(() => PrioritySchema.parse({ ...validPriority, value: 0 })).toThrow();
    expect(() => PrioritySchema.parse({ ...validPriority, value: 101 })).toThrow();
    expect(PrioritySchema.parse({ ...validPriority, value: 1 }).value).toBe(1);
    expect(PrioritySchema.parse({ ...validPriority, value: 100 }).value).toBe(100);
  });

  it("enforces base_value bounds 1-100", () => {
    expect(() => PrioritySchema.parse({ ...validPriority, base_value: 0 })).toThrow();
    expect(() => PrioritySchema.parse({ ...validPriority, base_value: 101 })).toThrow();
  });
});

describe("QueueEntrySchema", () => {
  it("parses valid data with nested priority", () => {
    const entry = QueueEntrySchema.parse({
      task_id: "01ABC",
      priority: {
        value: 50,
        source: PrioritySources.default,
        base_value: 50,
        assigned_at: "2026-03-10T12:00:00.000Z",
      },
      queued_at: "2026-03-10T12:00:00.000Z",
      eligible: true,
    });
    expect(entry.priority.value).toBe(50);
  });
});

describe("TriggerStateSchema", () => {
  it("parses valid data", () => {
    const state = TriggerStateSchema.parse({
      plugin_id: "github-trigger",
      poll_interval_ms: 30_000,
      last_poll: null,
      consecutive_failures: 0,
    });
    expect(state.last_poll).toBeNull();
  });

  it("accepts non-null last_poll", () => {
    const state = TriggerStateSchema.parse({
      plugin_id: "github-trigger",
      poll_interval_ms: 30_000,
      last_poll: "2026-03-10T12:00:00.000Z",
      consecutive_failures: 2,
    });
    expect(state.consecutive_failures).toBe(2);
  });
});

describe("PreemptionStatusSchema", () => {
  it("has exactly 2 values", () => {
    expect(PreemptionStatusSchema.options).toHaveLength(2);
  });

  it("accepts all valid values", () => {
    for (const status of ["requested", "checkpointing"]) {
      expect(PreemptionStatusSchema.parse(status)).toBe(status);
    }
  });
});

describe("PendingPreemptionSchema", () => {
  it("parses valid data", () => {
    const preemption = PendingPreemptionSchema.parse({
      target_task_id: "01ABC",
      replacement_task_id: "01DEF",
      requested_at: "2026-03-10T12:00:00.000Z",
      status: PreemptionStatuses.requested,
    });
    expect(preemption.status).toBe(PreemptionStatuses.requested);
  });
});

describe("DaemonHealthSchema", () => {
  it("parses valid data", () => {
    const health = DaemonHealthSchema.parse({
      started_at: "2026-03-10T12:00:00.000Z",
      last_heartbeat: "2026-03-10T12:05:00.000Z",
      tasks_completed: 42,
    });
    expect(health.tasks_completed).toBe(42);
  });
});

describe("DaemonStateSchema", () => {
  const minimalDaemonState = {
    capacity: { max_concurrent: 1, working_tasks: [] },
    queue: [],
    triggers: [],
    seen_trigger_keys: {},
    pending_preemption: null,
    health: {
      started_at: "2026-03-10T12:00:00.000Z",
      last_heartbeat: "2026-03-10T12:00:00.000Z",
      tasks_completed: 0,
    },
    config: {},
  };

  it("parses minimal state (config defaults apply)", () => {
    const state = DaemonStateSchema.parse(minimalDaemonState);
    expect(state.config.tick_interval_ms).toBe(5_000);
    expect(state.queue).toHaveLength(0);
  });

  it("accepts seen_trigger_keys as record of timestamps", () => {
    const state = DaemonStateSchema.parse({
      ...minimalDaemonState,
      seen_trigger_keys: {
        "github:issue:owner/repo:47": 1_710_072_000_000,
        "github:issue:owner/repo:48": 1_710_072_060_000,
      },
    });
    expect(Object.keys(state.seen_trigger_keys)).toHaveLength(2);
  });

  it("accepts pending preemption", () => {
    const state = DaemonStateSchema.parse({
      ...minimalDaemonState,
      pending_preemption: {
        target_task_id: "01ABC",
        replacement_task_id: "01DEF",
        requested_at: "2026-03-10T12:00:00.000Z",
        status: PreemptionStatuses.checkpointing,
      },
    });
    expect(state.pending_preemption?.status).toBe(PreemptionStatuses.checkpointing);
  });
});

// ── Dispatch ────────────────────────────────────────────────────────────────────

describe("DispatchSchema", () => {
  const minimalTask = {
    id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    external_ref: null,
    state: TaskStates.active,
    sub_state: SubStates.working,
    phase: Phases.execution,
    parent_id: null,
    children: [],
    cascade_policy: CascadePolicies.pause_siblings,
    title: "Fix auth bug",
    description: "Users can't log in",
    source_text: "Issue body",
    acceptance_criteria: [],
    team: [],
    related: [],
    decisions: [],
    child_summaries: [],
    repo: null,
    workspace: null,
    review: null,
    blocked: null,
    return_to_phase: null,
    priority: 50,
    llm_tokens: 0,
    llm_cost_usd: 0,
    compute_time_ms: 0,
    created_at: "2026-03-10T12:00:00.000Z",
    started_at: "2026-03-10T12:01:00.000Z",
    completed_at: null,
    last_transition_at: "2026-03-10T12:01:00.000Z",
    clone_url: null,
    thoughts_id: null,
    session_id: "01SESSION",
  };

  it("parses valid dispatch with null resume_from", () => {
    const dispatch = DispatchSchema.parse({
      task: minimalTask,
      resume_from: null,
      knowledge: { repo: [], user: [] },
    });
    expect(dispatch.task.id).toBe("01ARZ3NDEKTSV4RRFFQ69G5FAV");
    expect(dispatch.resume_from).toBeNull();
  });

  it("parses dispatch with checkpoint", () => {
    const checkpoint = {
      id: "01CKPT",
      session_id: "01SESSION",
      task_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      phase: Phases.execution,
      phase_progress: "50% through file changes",
      context_summary: "Implementing OAuth",
      key_findings: ["Found existing middleware"],
      open_questions: [],
      next_action: "Write tests",
      last_event_id: "01EVT",
      workspace_ref: { branch: "engineer/47-auth", last_commit: "abc123" },
      reason: CheckpointReasons.phase_transition,
      timestamp: "2026-03-10T12:30:00.000Z",
      journal_offset: 42,
    };

    const dispatch = DispatchSchema.parse({
      task: minimalTask,
      resume_from: checkpoint,
      knowledge: { repo: [], user: [] },
    });
    expect(dispatch.resume_from?.phase).toBe("execution");
  });

  it("parses dispatch with knowledge entries", () => {
    const knowledge = {
      id: "abcdef1234567890abcdef1234567890",
      scope: KnowledgeScopes.repo,
      repo_scope: "owner/repo",
      domain: KnowledgeDomains.conventions,
      key: "naming",
      body: "Use camelCase",
      confidence: KnowledgeConfidences.observed,
      evidence: [{ task_id: "01ABC", description: "Seen in codebase" }],
      created_at: "2026-03-10T12:00:00.000Z",
      last_confirmed: "2026-03-10T12:00:00.000Z",
      superseded_by: null,
      source_task_id: "01ABC",
      source_phase: Phases.research,
    };

    const dispatch = DispatchSchema.parse({
      task: minimalTask,
      resume_from: null,
      knowledge: { repo: [knowledge], user: [] },
    });
    expect(dispatch.knowledge.repo).toHaveLength(1);
  });
});

// ── Safety Accumulators ─────────────────────────────────────────────────────────

describe("ApiSpendSchema", () => {
  it("parses valid data", () => {
    const spend = ApiSpendSchema.parse({
      per_task: {
        "01ABC": { cost_usd: 0.5 },
        "01DEF": { cost_usd: 1.2 },
      },
      daily: { cost_usd: 1.7, window_start: "2026-03-10T00:00:00.000Z" },
      monthly: { cost_usd: 25.0, window_start: "2026-03-01T00:00:00.000Z" },
      global: { cost_usd: 100.0 },
    });
    expect(Object.keys(spend.per_task)).toHaveLength(2);
  });
});

describe("CliProviderUsageSchema", () => {
  it("parses valid data", () => {
    const usage = CliProviderUsageSchema.parse({
      requests_used: 50,
      tokens_used: 100_000,
      last_known_remaining: 45_000,
      last_known_reset: "2026-03-11T00:00:00.000Z",
    });
    expect(usage.requests_used).toBe(50);
  });

  it("accepts null remaining and reset", () => {
    const usage = CliProviderUsageSchema.parse({
      requests_used: 10,
      tokens_used: 20_000,
      last_known_remaining: null,
      last_known_reset: null,
    });
    expect(usage.last_known_remaining).toBeNull();
  });
});

describe("CostAccumulatorsSchema", () => {
  it("parses valid data with nested structures", () => {
    const accumulators = CostAccumulatorsSchema.parse({
      api_spend: {
        per_task: {},
        daily: { cost_usd: 0, window_start: "2026-03-10T00:00:00.000Z" },
        monthly: { cost_usd: 0, window_start: "2026-03-01T00:00:00.000Z" },
        global: { cost_usd: 0 },
      },
      cli_usage: {
        "claude-code": {
          requests_used: 10,
          tokens_used: 50_000,
          last_known_remaining: null,
          last_known_reset: null,
        },
      },
    });
    expect(accumulators.cli_usage["claude-code"]?.requests_used).toBe(10);
  });
});

describe("SafetySnapshotSchema", () => {
  it("parses valid snapshot", () => {
    const snapshot = SafetySnapshotSchema.parse({
      accumulators: {
        api_spend: {
          per_task: {},
          daily: { cost_usd: 5.0, window_start: "2026-03-10T00:00:00.000Z" },
          monthly: { cost_usd: 50.0, window_start: "2026-03-01T00:00:00.000Z" },
          global: { cost_usd: 200.0 },
        },
        cli_usage: {},
      },
      last_event_sequence: 42,
      snapshot_at: "2026-03-10T12:00:00.000Z",
    });
    expect(snapshot.last_event_sequence).toBe(42);
  });
});

// ── Safety State ────────────────────────────────────────────────────────────────

describe("SafetyStateSchema", () => {
  it("parses valid state with config defaults and accumulators", () => {
    const state = SafetyStateSchema.parse({
      config: {},
      accumulators: {
        api_spend: {
          per_task: {},
          daily: { cost_usd: 0, window_start: "2026-03-10T00:00:00.000Z" },
          monthly: { cost_usd: 0, window_start: "2026-03-01T00:00:00.000Z" },
          global: { cost_usd: 0 },
        },
        cli_usage: {},
      },
      intercepted_event_types: ["cost.incurred", "cost.limit_reached"],
    });
    // SafetyConfigSchema defaults apply
    expect(state.config.merge.auto_merge_after_approval.default).toBe(false);
    expect(state.intercepted_event_types).toHaveLength(2);
  });
});

// ── Workspace State ─────────────────────────────────────────────────────────────

describe("WorktreeInfoSchema", () => {
  it("parses valid data", () => {
    const info = WorktreeInfoSchema.parse({
      task_id: "01ABC",
      repo: "owner/repo",
      branch: "engineer/47-dark-mode",
      worktree_path: "/tmp/worktrees/47-dark-mode",
      created_at: "2026-03-10T12:00:00.000Z",
      status: "active",
    });
    expect(info.status).toBe("active");
  });

  it("accepts all status values", () => {
    for (const status of ["active", "idle", "verifying"]) {
      expect(
        WorktreeInfoSchema.parse({
          task_id: "x",
          repo: "y",
          branch: "z",
          worktree_path: "/tmp/z",
          created_at: "2026-03-10T12:00:00.000Z",
          status,
        }).status,
      ).toBe(status);
    }
  });

  it("rejects invalid status", () => {
    expect(() =>
      WorktreeInfoSchema.parse({
        task_id: "x",
        repo: "y",
        branch: "z",
        worktree_path: "/tmp/z",
        created_at: "2026-03-10T12:00:00.000Z",
        status: "deleted",
      }),
    ).toThrow();
  });
});

describe("WorkspaceStateSchema", () => {
  it("parses valid state with config defaults", () => {
    const state = WorkspaceStateSchema.parse({
      config: {},
      active_worktrees: {},
    });
    // WorkspaceConfigSchema defaults apply
    expect(state.config.workspace_root).toBe("~/.engineer/workspaces/");
    expect(state.config.branch_prefix).toBe("engineer/");
  });

  it("accepts active worktrees", () => {
    const state = WorkspaceStateSchema.parse({
      config: {},
      active_worktrees: {
        "01ABC": {
          task_id: "01ABC",
          repo: "owner/repo",
          branch: "engineer/47-dark-mode",
          worktree_path: "/tmp/worktrees/47",
          created_at: "2026-03-10T12:00:00.000Z",
          status: "active",
        },
      },
    });
    expect(Object.keys(state.active_worktrees)).toHaveLength(1);
  });
});

// ── Event Bus Subscriptions ─────────────────────────────────────────────────────

describe("EventSubscriptionSchema", () => {
  it("parses valid subscription", () => {
    const sub = EventSubscriptionSchema.parse({
      subscriber_id: "safety-layer",
      event_type: "cost.*",
      filter: null,
      callback: () => undefined,
    });
    expect(sub.subscriber_id).toBe("safety-layer");
  });

  it("accepts any callback value (z.unknown)", () => {
    // Function reference
    expect(
      EventSubscriptionSchema.parse({
        subscriber_id: "x",
        event_type: "y",
        filter: null,
        callback: async () => undefined,
      }),
    ).toBeDefined();
    // Even non-function (schema documents shape, doesn't validate callback)
    expect(
      EventSubscriptionSchema.parse({
        subscriber_id: "x",
        event_type: "y",
        filter: null,
        callback: "not-a-function",
      }),
    ).toBeDefined();
  });

  it("accepts filter object", () => {
    const sub = EventSubscriptionSchema.parse({
      subscriber_id: "orchestrator",
      event_type: "task.state_changed",
      filter: { task_id: "01ABC" },
      callback: () => undefined,
    });
    expect(sub.filter).toEqual({ task_id: "01ABC" });
  });
});
