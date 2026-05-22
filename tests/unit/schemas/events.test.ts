import { describe, expect, it } from "vitest";

import { MergeStrategies, MessageTypes } from "../../../src/schemas/adapters.js";
import {
  ActionRejectedPayloadSchema,
  CommMessageReceivedPayloadSchema,
  CommMessageSentPayloadSchema,
  CostIncurredPayloadSchema,
  CostLimitReachedPayloadSchema,
  EventSchema,
  EventTypeSchema,
  EventTypes,
  GitBranchCreatedPayloadSchema,
  GitCommittedPayloadSchema,
  GitMergeCompletedPayloadSchema,
  GitPrMergedPayloadSchema,
  GitPrOpenedPayloadSchema,
  GitPrUpdatedPayloadSchema,
  GitPushedPayloadSchema,
  HealthStuckDetectedPayloadSchema,
  HealthTriggerFailurePayloadSchema,
  PreemptionReadyPayloadSchema,
  PreemptionRequestedPayloadSchema,
  ReviewPollCompletedPayloadSchema,
  SubscriptionSchema,
  TaskChildrenAllDonePayloadSchema,
  TaskCreatedPayloadSchema,
  TaskFeedbackReceivedPayloadSchema,
  TaskStateChangedPayloadSchema,
  TimeoutAlertPayloadSchema,
  TimeoutReminderPayloadSchema,
  TimeoutSelfUnblockCheckPayloadSchema,
  TriggerNewEventPayloadSchema,
  WorkspaceCleanedPayloadSchema,
  WorkspaceCreatedPayloadSchema,
  WorkspaceMergeConflictPayloadSchema,
  WorkspaceVerifiedPayloadSchema,
  eventPayloadSchemas,
} from "../../../src/schemas/events.js";
import { Phases } from "../../../src/schemas/orchestrator.js";
import { ActionClasses, TaskStates } from "../../../src/schemas/task.js";

// ── Event Envelope ─────────────────────────────────────────────────────────────

describe("EventSchema", () => {
  const validEvent = {
    id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    sequence: 1,
    type: EventTypes["task.created"],
    source: "task_engine",
    task_id: "01TASK",
    timestamp: "2026-03-10T12:00:00.000Z",
    payload: { task_id: "01TASK", title: "Fix bug" },
  };

  it("parses a valid event", () => {
    expect(EventSchema.parse(validEvent)).toEqual(validEvent);
  });

  it("accepts null task_id for system-level events", () => {
    const systemEvent = {
      ...validEvent,
      task_id: null,
      type: EventTypes["system.cleanup_completed"],
    };
    expect(EventSchema.parse(systemEvent)).toBeDefined();
  });

  it("rejects missing required fields", () => {
    const { id: _id, ...noId } = validEvent;
    expect(() => EventSchema.parse(noId)).toThrow();
  });

  it("rejects invalid timestamp", () => {
    expect(() => EventSchema.parse({ ...validEvent, timestamp: "bad" })).toThrow();
  });

  it("rejects non-integer sequence", () => {
    expect(() => EventSchema.parse({ ...validEvent, sequence: 1.5 })).toThrow();
  });
});

// ── Subscription ───────────────────────────────────────────────────────────────

describe("SubscriptionSchema", () => {
  it("parses valid subscription", () => {
    const valid = { subscriber_id: "task_engine", event_type: "task.*", filter: null };
    expect(SubscriptionSchema.parse(valid)).toEqual(valid);
  });

  it("accepts filter object", () => {
    const withFilter = {
      subscriber_id: "safety_layer",
      event_type: "cost.incurred",
      filter: { task_id: "01TASK" },
    };
    expect(SubscriptionSchema.parse(withFilter)).toBeDefined();
  });
});

// ── EventTypeSchema ────────────────────────────────────────────────────────────

describe("EventTypeSchema", () => {
  it("accepts all valid event types", () => {
    for (const type of EventTypeSchema.options) {
      expect(EventTypeSchema.parse(type)).toBe(type);
    }
  });

  it("rejects unknown event types", () => {
    expect(() => EventTypeSchema.parse("task.deleted")).toThrow();
    expect(() => EventTypeSchema.parse("")).toThrow();
  });
});

// ── Payload Schemas ────────────────────────────────────────────────────────────

describe("TaskCreatedPayloadSchema", () => {
  it("parses valid data", () => {
    const valid = {
      task_id: "01TASK",
      parent_id: null,
      title: "Fix auth bug",
      external_ref: { type: "github_issue", repo: "owner/repo", id: "42" },
      idempotency_key: "github:issue:owner/repo:42",
      source: "trigger.github",
      priority: 50,
      repo: "owner/repo",
    };
    expect(TaskCreatedPayloadSchema.parse(valid)).toEqual(valid);
  });

  it("rejects missing fields", () => {
    expect(() => TaskCreatedPayloadSchema.parse({})).toThrow();
  });
});

describe("TaskStateChangedPayloadSchema", () => {
  it("parses valid data with task state enums", () => {
    const valid = {
      task_id: "01TASK",
      from_state: TaskStates.requirements_gathering,
      from_sub: null,
      to_state: TaskStates.queued,
      to_sub: null,
      reason: "Task validated",
      triggered_by: "task_engine",
    };
    expect(TaskStateChangedPayloadSchema.parse(valid)).toEqual(valid);
  });

  it("validates against TaskState enum", () => {
    expect(() =>
      TaskStateChangedPayloadSchema.parse({
        task_id: "01TASK",
        from_state: "running",
        from_sub: null,
        to_state: TaskStates.queued,
        to_sub: null,
        reason: "test",
        triggered_by: "test",
      }),
    ).toThrow();
  });

  it("validates sub-states against SubState enum", () => {
    expect(() =>
      TaskStateChangedPayloadSchema.parse({
        task_id: "01TASK",
        from_state: TaskStates.active,
        from_sub: "invalid_sub",
        to_state: TaskStates.blocked,
        to_sub: null,
        reason: "test",
        triggered_by: "test",
      }),
    ).toThrow();
  });
});

describe("TaskChildrenAllDonePayloadSchema", () => {
  it("parses valid data", () => {
    const valid = {
      parent_task_id: "01PARENT",
      child_ids: ["01A", "01B"],
      all_succeeded: true,
      failed_ids: [],
    };
    expect(TaskChildrenAllDonePayloadSchema.parse(valid)).toEqual(valid);
  });
});

describe("TaskFeedbackReceivedPayloadSchema", () => {
  it("parses valid data", () => {
    const valid = {
      task_id: "01TASK",
      stage: "code",
      feedback_type: "approved",
      reviewer: "farzam",
      content: null,
      pr_number: 42,
    };
    expect(TaskFeedbackReceivedPayloadSchema.parse(valid)).toEqual(valid);
  });
});

describe("ActionRejectedPayloadSchema", () => {
  it("validates action_class against ActionClass enum", () => {
    const valid = {
      task_id: "01TASK",
      action_class: ActionClasses.write,
      gate: "task_engine",
      reason: "Not in active state",
      details: null,
      requested_by: "orchestrator",
    };
    expect(ActionRejectedPayloadSchema.parse(valid)).toEqual(valid);

    expect(() => ActionRejectedPayloadSchema.parse({ ...valid, action_class: "delete" })).toThrow();
  });
});

describe("CostIncurredPayloadSchema", () => {
  it("parses cost event with spend", () => {
    const input = {
      task_id: "01TASK",
      repo: "owner/repo",
      provider_id: "claude-sonnet",
      operation: "code_generation",
      spend_usd: 0.015,
      duration_ms: 1200,
    };
    expect(CostIncurredPayloadSchema.parse(input)).toEqual({
      ...input,
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
      cache_read_tokens: null,
      model_id: null,
    });
  });

  it("parses cost event with null spend and duration", () => {
    const input = {
      task_id: "01TASK",
      repo: "owner/repo",
      provider_id: "claude-code",
      operation: "reasoning",
      spend_usd: null,
      duration_ms: null,
    };
    expect(CostIncurredPayloadSchema.parse(input)).toEqual({
      ...input,
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
      cache_read_tokens: null,
      model_id: null,
    });
  });
});

describe("CostLimitReachedPayloadSchema", () => {
  it("parses valid data", () => {
    const valid = {
      task_id: "01TASK",
      limit_type: "per_task",
      limit_scope: null,
      current_spend: 5.0,
      limit_value: 5.0,
      resets_at: null,
    };
    expect(CostLimitReachedPayloadSchema.parse(valid)).toEqual(valid);
  });
});

describe("PreemptionRequestedPayloadSchema", () => {
  it("parses valid data", () => {
    const valid = {
      target_task_id: "01OLD",
      preempting_task_id: "01NEW",
      reason: "Higher priority task",
      priority_delta: 20,
    };
    expect(PreemptionRequestedPayloadSchema.parse(valid)).toEqual(valid);
  });
});

describe("PreemptionReadyPayloadSchema", () => {
  it("parses valid data", () => {
    const valid = {
      task_id: "01TASK",
      checkpoint_id: "01CHK",
      phase: Phases.execution,
      atomic_op: "llm_call",
    };
    expect(PreemptionReadyPayloadSchema.parse(valid)).toEqual(valid);
  });
});

describe("TimeoutReminderPayloadSchema", () => {
  it("parses valid data", () => {
    const valid = {
      task_id: "01TASK",
      blocked_since: "2026-03-10T10:00:00.000Z",
      elapsed_ms: 7200000,
      channel: "telegram",
      question_summary: "Need API credentials",
    };
    expect(TimeoutReminderPayloadSchema.parse(valid)).toEqual(valid);
  });
});

describe("TimeoutSelfUnblockCheckPayloadSchema", () => {
  it("parses valid data", () => {
    const valid = {
      task_id: "01TASK",
      blocked_since: "2026-03-10T10:00:00.000Z",
      elapsed_ms: 14400000,
      decision_category: "technical",
      can_self_unblock: false,
    };
    expect(TimeoutSelfUnblockCheckPayloadSchema.parse(valid)).toEqual(valid);
  });
});

describe("TimeoutAlertPayloadSchema", () => {
  it("parses valid data", () => {
    const valid = {
      task_id: "01TASK",
      blocked_since: "2026-03-10T10:00:00.000Z",
      elapsed_ms: 86400000,
      escalation: "owner_notified",
    };
    expect(TimeoutAlertPayloadSchema.parse(valid)).toEqual(valid);
  });
});

describe("TriggerNewEventPayloadSchema", () => {
  it("parses valid data", () => {
    const valid = {
      idempotency_key: "github:owner/repo:issue:42",
      source: "github_trigger",
      event_type: "issue_opened",
      external_ref: { type: "github_issue", repo: "owner/repo", id: "42" },
      title: "Fix auth bug",
      body: "Users can't log in after recent deploy",
      repo: "owner/repo",
      clone_url: "https://github.com/owner/repo.git",
      metadata: { labels: ["bug", "auth"] },
    };
    expect(TriggerNewEventPayloadSchema.parse(valid)).toEqual(valid);
  });
});

describe("WorkspaceCreatedPayloadSchema", () => {
  it("parses valid data", () => {
    const valid = {
      task_id: "01TASK",
      repo: "owner/repo",
      branch: "engineer/42-auth",
      worktree_path: "/tmp/worktrees/42",
      base_branch: "main",
      base_commit: "abc123def456",
    };
    expect(WorkspaceCreatedPayloadSchema.parse(valid)).toEqual(valid);
  });
});

describe("WorkspaceVerifiedPayloadSchema", () => {
  it("parses valid data", () => {
    const valid = {
      task_id: "01TASK",
      status: "valid",
      current_commit: "abc123",
      recovery_action: null,
    };
    expect(WorkspaceVerifiedPayloadSchema.parse(valid)).toEqual(valid);
  });
});

describe("WorkspaceCleanedPayloadSchema", () => {
  it("parses valid data", () => {
    const valid = { task_id: "01TASK", branch_preserved: true };
    expect(WorkspaceCleanedPayloadSchema.parse(valid)).toEqual(valid);
  });
});

describe("WorkspaceMergeConflictPayloadSchema", () => {
  it("parses valid data", () => {
    const valid = {
      task_id: "01TASK",
      source_branch: "engineer/42-auth",
      target_branch: "main",
      conflicting_files: ["src/auth.ts", "src/middleware.ts"],
    };
    expect(WorkspaceMergeConflictPayloadSchema.parse(valid)).toEqual(valid);
  });
});

describe("GitBranchCreatedPayloadSchema", () => {
  it("parses valid data", () => {
    const valid = {
      task_id: "01TASK",
      repo: "owner/repo",
      branch: "engineer/42-auth",
      from_ref: "main",
      commit_sha: "abc123",
    };
    expect(GitBranchCreatedPayloadSchema.parse(valid)).toEqual(valid);
  });
});

describe("GitCommittedPayloadSchema", () => {
  it("parses valid data", () => {
    const valid = {
      task_id: "01TASK",
      repo: "owner/repo",
      sha: "abc123",
      message: "fix: auth middleware",
      files_changed: 3,
    };
    expect(GitCommittedPayloadSchema.parse(valid)).toEqual(valid);
  });
});

describe("GitPushedPayloadSchema", () => {
  it("parses valid data", () => {
    const valid = {
      task_id: "01TASK",
      repo: "owner/repo",
      branch: "engineer/42-auth",
      remote: "origin",
      commits: 2,
      head_sha: "abc123",
    };
    expect(GitPushedPayloadSchema.parse(valid)).toEqual(valid);
  });
});

describe("GitPrOpenedPayloadSchema", () => {
  it("parses valid data", () => {
    const valid = {
      task_id: "01TASK",
      repo: "owner/repo",
      pr_number: 42,
      draft: true,
      title: "fix: auth middleware",
      url: "https://github.com/owner/repo/pull/42",
      base_branch: "main",
      head_branch: "engineer/42-auth",
    };
    expect(GitPrOpenedPayloadSchema.parse(valid)).toEqual(valid);
  });
});

describe("GitPrUpdatedPayloadSchema", () => {
  it("parses valid data", () => {
    const valid = {
      task_id: "01TASK",
      repo: "owner/repo",
      pr_number: 42,
      draft: false,
      previous_draft: true,
      update_type: "marked_ready",
    };
    expect(GitPrUpdatedPayloadSchema.parse(valid)).toEqual(valid);
  });
});

describe("GitPrMergedPayloadSchema", () => {
  it("parses valid data", () => {
    const valid = {
      task_id: "01TASK",
      repo: "owner/repo",
      pr_number: 42,
      merge_strategy: MergeStrategies.squash,
      merge_sha: "abc123",
      into_branch: "main",
    };
    expect(GitPrMergedPayloadSchema.parse(valid)).toEqual(valid);
  });
});

describe("GitMergeCompletedPayloadSchema", () => {
  it("parses valid data", () => {
    const valid = {
      task_id: "01TASK",
      repo: "owner/repo",
      source_branch: "engineer/42-auth",
      target_branch: "main",
      merge_sha: "abc123",
      strategy: MergeStrategies.merge,
    };
    expect(GitMergeCompletedPayloadSchema.parse(valid)).toEqual(valid);
  });
});

describe("HealthStuckDetectedPayloadSchema", () => {
  it("parses valid data", () => {
    const valid = {
      task_id: "01TASK",
      condition: "no_journal_entries",
      threshold_ms: 600000,
      elapsed_ms: 720000,
      last_activity: "2026-03-10T11:48:00.000Z",
    };
    expect(HealthStuckDetectedPayloadSchema.parse(valid)).toEqual(valid);
  });
});

describe("HealthTriggerFailurePayloadSchema", () => {
  it("parses valid data", () => {
    const valid = {
      trigger_id: "github_trigger",
      consecutive_failures: 5,
      threshold: 3,
      last_error: "rate limited",
      last_success: "2026-03-10T11:00:00.000Z",
    };
    expect(HealthTriggerFailurePayloadSchema.parse(valid)).toEqual(valid);
  });
});

describe("CommMessageReceivedPayloadSchema", () => {
  it("parses valid data", () => {
    const valid = {
      source: "telegram",
      sender: "farzam",
      content: "What's the status of task 42?",
      reply_to: null,
      task_id: null,
      platform_metadata: { chat_id: 123456 },
    };
    expect(CommMessageReceivedPayloadSchema.parse(valid)).toEqual(valid);
  });

  it("requires platform_metadata (not nullable)", () => {
    expect(() =>
      CommMessageReceivedPayloadSchema.parse({
        source: "telegram",
        sender: "farzam",
        content: "hello",
        reply_to: null,
        task_id: null,
      }),
    ).toThrow();
  });
});

describe("CommMessageSentPayloadSchema", () => {
  it("parses valid data", () => {
    const valid = {
      task_id: "01TASK",
      target: "farzam",
      message_type: MessageTypes.question,
      content_summary: "Asked about API credentials",
      channel: "telegram",
    };
    expect(CommMessageSentPayloadSchema.parse(valid)).toEqual(valid);
  });
});

describe("ReviewPollCompletedPayloadSchema", () => {
  it("parses valid data", () => {
    const valid = {
      task_id: "01TASK",
      pr_number: 51,
      repo: "acme/webapp",
      aggregate_state: "approved",
      approvals: 1,
      changes_requested_count: 0,
      comment_count: 2,
      reviewer_count: 1,
      pr_draft: false,
      dedup_skipped: false,
    };
    expect(ReviewPollCompletedPayloadSchema.parse(valid)).toEqual(valid);
  });
});

// ── eventPayloadSchemas exhaustiveness ─────────────────────────────────────────

describe("eventPayloadSchemas", () => {
  it("has an entry for every EventType", () => {
    const schemaKeys = new Set(Object.keys(eventPayloadSchemas));
    const enumValues = new Set(EventTypeSchema.options);

    expect(schemaKeys.size).toBe(enumValues.size);
    for (const type of enumValues) {
      expect(schemaKeys.has(type)).toBe(true);
    }
  });

  it("every schema can validate an object", () => {
    for (const [_type, schema] of Object.entries(eventPayloadSchemas)) {
      const result = schema.safeParse({});
      // Empty object should fail validation (all schemas have required fields)
      expect(result.success).toBe(false);
      // But the schema itself should be a valid Zod schema
      expect(typeof schema.parse).toBe("function");
    }
  });
});
