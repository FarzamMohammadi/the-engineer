import { describe, expect, it } from "vitest";

import {
  AdapterErrorSchema,
  AdapterErrorSeverities,
  AdapterErrorSeveritySchema,
  AdapterTypeSchema,
  AdapterTypes,
  BranchProtectionSchema,
  CommentResultSchema,
  ContactInfoSchema,
  ContactSchema,
  FormattedMessageSchema,
  HealthStatusSchema,
  InboundMessageSchema,
  InferenceRequestSchema,
  InferenceResultSchema,
  InitResultSchema,
  IssueOptionsSchema,
  IssueResultSchema,
  IssueUpdatesSchema,
  LLMCapabilitiesSchema,
  MergeResultSchema,
  MergeStrategySchema,
  MessageTypeSchema,
  MessageTypes,
  NotificationLevelSchema,
  NotificationLevels,
  PROptionsSchema,
  PRResultSchema,
  PRStatusSchema,
  PRUpdatesSchema,
  PersonSchema,
  PluginHealthRecordSchema,
  PluginHealthStateSchema,
  PluginHealthStates,
  PluginManifestSchema,
  ReconciliationResultSchema,
  RegistrationResultSchema,
  ReviewStatusSchema,
  ReviewerStateSchema,
  SendResultSchema,
  SyncMetadataSchema,
  TargetSchema,
  TaskReconciliationInputSchema,
  TriggerEventSchema,
} from "../../../src/schemas/adapters.js";

// ── Universal Adapter Contract ──────────────────────────────────────────────────

describe("AdapterTypeSchema", () => {
  it("has exactly 4 values", () => {
    expect(AdapterTypeSchema.options).toHaveLength(4);
  });

  it("accepts all valid values", () => {
    for (const type of ["trigger", "communication", "llm", "git_hosting"]) {
      expect(AdapterTypeSchema.parse(type)).toBe(type);
    }
  });

  it("rejects invalid values", () => {
    expect(() => AdapterTypeSchema.parse("webhook")).toThrow();
  });
});

describe("PluginManifestSchema", () => {
  const minimal = {
    id: "github-trigger",
    type: AdapterTypes.trigger,
    version: "1.0.0",
    name: "GitHub Issues Trigger",
    description: "Polls GitHub for new issues",
  };

  it("parses with required fields and applies defaults", () => {
    const manifest = PluginManifestSchema.parse(minimal);
    expect(manifest.id).toBe("github-trigger");
    expect(manifest.config_schema).toEqual({});
    expect(manifest.critical).toBe(true);
    expect(manifest.entry).toBe("index.ts");
    expect(manifest.adapter_meta).toEqual({});
  });

  it("allows override of defaults", () => {
    const manifest = PluginManifestSchema.parse({
      ...minimal,
      critical: false,
      entry: "main.ts",
    });
    expect(manifest.critical).toBe(false);
    expect(manifest.entry).toBe("main.ts");
  });

  it("rejects invalid adapter type", () => {
    expect(() => PluginManifestSchema.parse({ ...minimal, type: "webhook" })).toThrow();
  });

  it("rejects missing required fields", () => {
    const { id: _id, ...noId } = minimal;
    expect(() => PluginManifestSchema.parse(noId)).toThrow();
  });
});

describe("InitResultSchema", () => {
  it("parses valid data", () => {
    expect(InitResultSchema.parse({ success: true, message: null })).toEqual({
      success: true,
      message: null,
    });
  });

  it("accepts error message", () => {
    const result = InitResultSchema.parse({ success: false, message: "Auth failed" });
    expect(result.message).toBe("Auth failed");
  });
});

describe("HealthStatusSchema", () => {
  it("parses valid data with nullable fields", () => {
    expect(HealthStatusSchema.parse({ healthy: true, message: null, details: null })).toBeDefined();
    expect(
      HealthStatusSchema.parse({
        healthy: false,
        message: "Rate limited",
        details: { until: "14:30" },
      }),
    ).toBeDefined();
  });
});

describe("AdapterErrorSeveritySchema", () => {
  it("has exactly 3 values", () => {
    expect(AdapterErrorSeveritySchema.options).toHaveLength(3);
  });
});

describe("AdapterErrorSchema", () => {
  const validError = {
    code: "rate_limited",
    message: "Too many requests",
    retryable: true,
    retry_after_ms: 5000,
    severity: AdapterErrorSeverities.warning,
  };

  it("parses valid error", () => {
    expect(AdapterErrorSchema.parse(validError)).toEqual(validError);
  });

  it("accepts null retry_after_ms", () => {
    const result = AdapterErrorSchema.parse({ ...validError, retry_after_ms: null });
    expect(result.retry_after_ms).toBeNull();
  });
});

describe("RegistrationResultSchema", () => {
  it("parses valid data", () => {
    const result = RegistrationResultSchema.parse({
      success: true,
      plugin_id: "github-trigger",
      message: null,
    });
    expect(result.plugin_id).toBe("github-trigger");
  });
});

// ── Trigger Adapter ─────────────────────────────────────────────────────────────

describe("TriggerEventSchema", () => {
  const validEvent = {
    idempotency_key: "github:issue:owner/repo:47",
    source: "github-trigger",
    event_type: "issue_opened",
    external_ref: {
      type: "github_issue",
      repo: "owner/repo",
      id: "47",
      url: "https://github.com/owner/repo/issues/47",
    },
    title: "Fix dark mode",
    body: "The dark mode toggle doesn't work",
    repo: "owner/repo",
    clone_url: "https://github.com/owner/repo.git",
    thoughts_id: "issue-47",
    metadata: { labels: ["bug"] },
  };

  it("parses valid event", () => {
    expect(TriggerEventSchema.parse(validEvent)).toEqual(validEvent);
  });

  it("accepts null body and metadata", () => {
    const result = TriggerEventSchema.parse({ ...validEvent, body: null, metadata: null });
    expect(result.body).toBeNull();
    expect(result.metadata).toBeNull();
  });

  // SECURITY: clone_url must be HTTPS to prevent token injection into arbitrary URLs
  it("rejects http:// clone_url", () => {
    expect(() => TriggerEventSchema.parse({ ...validEvent, clone_url: "http://github.com/owner/repo.git" })).toThrow(
      "clone_url must use HTTPS",
    );
  });

  it("rejects non-URL clone_url", () => {
    expect(() => TriggerEventSchema.parse({ ...validEvent, clone_url: "not-a-url" })).toThrow();
  });

  it("rejects ssh clone_url", () => {
    expect(() => TriggerEventSchema.parse({ ...validEvent, clone_url: "git@github.com:owner/repo.git" })).toThrow();
  });
});

// ── Communication Adapter ───────────────────────────────────────────────────────

describe("MessageTypeSchema", () => {
  it("has exactly 5 values", () => {
    expect(MessageTypeSchema.options).toHaveLength(5);
  });

  it("accepts all valid values", () => {
    for (const type of ["notification", "question", "status_response", "milestone", "alert"]) {
      expect(MessageTypeSchema.parse(type)).toBe(type);
    }
  });
});

describe("TargetSchema", () => {
  it("parses valid data", () => {
    expect(TargetSchema.parse({ user_id: "farzam", channel: "telegram" })).toBeDefined();
  });

  it("accepts null channel", () => {
    const result = TargetSchema.parse({ user_id: "farzam", channel: null });
    expect(result.channel).toBeNull();
  });
});

describe("FormattedMessageSchema", () => {
  it("parses valid data with nested metadata", () => {
    const msg = FormattedMessageSchema.parse({
      content: "Task completed!",
      metadata: { task_id: "01ABC", type: MessageTypes.milestone },
    });
    expect(msg.metadata.type).toBe(MessageTypes.milestone);
  });

  it("rejects invalid message type in metadata", () => {
    expect(() =>
      FormattedMessageSchema.parse({
        content: "test",
        metadata: { task_id: null, type: "invalid_type" },
      }),
    ).toThrow();
  });
});

describe("SendResultSchema", () => {
  it("parses successful result", () => {
    const result = SendResultSchema.parse({
      success: true,
      message_id: "msg_123",
      error: null,
    });
    expect(result.success).toBe(true);
  });

  it("parses failed result with AdapterError", () => {
    const result = SendResultSchema.parse({
      success: false,
      message_id: null,
      error: {
        code: "rate_limited",
        message: "Too many requests",
        retryable: true,
        retry_after_ms: 5000,
        severity: AdapterErrorSeverities.warning,
      },
    });
    expect(result.error?.code).toBe("rate_limited");
  });
});

describe("InboundMessageSchema", () => {
  it("parses valid data", () => {
    const msg = InboundMessageSchema.parse({
      source: "telegram",
      sender: "@farzam",
      content: "What's the status?",
      timestamp: "2026-03-10T12:00:00.000Z",
      reply_to: null,
      platform_metadata: { chat_id: 12345 },
    });
    expect(msg.source).toBe("telegram");
  });

  it("rejects invalid timestamp", () => {
    expect(() =>
      InboundMessageSchema.parse({
        source: "telegram",
        sender: "@farzam",
        content: "test",
        timestamp: "not-a-date",
        reply_to: null,
        platform_metadata: {},
      }),
    ).toThrow();
  });
});

describe("SyncMetadataSchema", () => {
  it("parses valid data with nullable fields", () => {
    const meta = SyncMetadataSchema.parse({
      task_title: "Fix auth",
      external_ref: null,
      sub_state: null,
      reason: null,
    });
    expect(meta.task_title).toBe("Fix auth");
  });
});

describe("IssueOptionsSchema", () => {
  it("parses valid data", () => {
    const opts = IssueOptionsSchema.parse({
      title: "New issue",
      body: "Description",
      labels: ["bug"],
      assignees: ["farzam"],
      parent_issue: 42,
    });
    expect(opts.parent_issue).toBe(42);
  });

  it("accepts null arrays and parent", () => {
    const opts = IssueOptionsSchema.parse({
      title: "x",
      body: "y",
      labels: null,
      assignees: null,
      parent_issue: null,
    });
    expect(opts.labels).toBeNull();
  });

  it("rejects non-positive parent_issue", () => {
    expect(() =>
      IssueOptionsSchema.parse({
        title: "x",
        body: "y",
        labels: null,
        assignees: null,
        parent_issue: 0,
      }),
    ).toThrow();
  });
});

describe("IssueResultSchema", () => {
  it("parses valid data", () => {
    expect(IssueResultSchema.parse({ number: 42, url: "https://github.com/..." })).toBeDefined();
  });
});

describe("IssueUpdatesSchema", () => {
  it("parses with all null fields", () => {
    const updates = IssueUpdatesSchema.parse({
      state: null,
      labels_add: null,
      labels_remove: null,
      body: null,
    });
    expect(updates.state).toBeNull();
  });

  it("accepts valid state values", () => {
    expect(IssueUpdatesSchema.parse({ state: "open", labels_add: null, labels_remove: null, body: null }).state).toBe(
      "open",
    );
    expect(
      IssueUpdatesSchema.parse({
        state: "closed",
        labels_add: null,
        labels_remove: null,
        body: null,
      }).state,
    ).toBe("closed");
  });

  it("rejects invalid state", () => {
    expect(() =>
      IssueUpdatesSchema.parse({
        state: "merged",
        labels_add: null,
        labels_remove: null,
        body: null,
      }),
    ).toThrow();
  });
});

describe("TaskReconciliationInputSchema", () => {
  it("parses valid data", () => {
    expect(
      TaskReconciliationInputSchema.parse({
        task_id: "01ABC",
        external_ref: { type: "github_issue", repo: "owner/repo", id: "42" },
        expected_state: "active",
        expected_label: "engineer:active",
      }),
    ).toBeDefined();
  });
});

describe("ReconciliationResultSchema", () => {
  it("parses valid data with errors array", () => {
    const result = ReconciliationResultSchema.parse({
      reconciled: 2,
      errors: [{ task_id: "01ABC", reason: "issue_not_found" }],
    });
    expect(result.reconciled).toBe(2);
    expect(result.errors).toHaveLength(1);
  });
});

// ── LLM Adapter ─────────────────────────────────────────────────────────────────

describe("InferenceRequestSchema", () => {
  it("parses valid request", () => {
    const req = InferenceRequestSchema.parse({
      prompt: "Explain this code",
    });
    expect(req.prompt).toBe("Explain this code");
  });

  it("system_prompt defaults to null when omitted", () => {
    const req = InferenceRequestSchema.parse({
      prompt: "test",
    });
    expect(req.system_prompt).toBeNull();
  });

  it("accepts explicit system_prompt string", () => {
    const req = InferenceRequestSchema.parse({
      prompt: "test",
      system_prompt: "You are a code reviewer.",
    });
    expect(req.system_prompt).toBe("You are a code reviewer.");
  });

  it("cwd defaults to null when omitted", () => {
    const req = InferenceRequestSchema.parse({
      prompt: "test",
    });
    expect(req.cwd).toBeNull();
  });

  it("accepts explicit cwd string", () => {
    const req = InferenceRequestSchema.parse({
      prompt: "test",
      cwd: "/tmp/worktree/42",
    });
    expect(req.cwd).toBe("/tmp/worktree/42");
  });
});

describe("InferenceResultSchema", () => {
  it("parses valid result with cost", () => {
    const result = InferenceResultSchema.parse({
      content: "Here is the explanation...",
      cost_usd: 0.015,
      duration_ms: 1200,
    });
    expect(result.cost_usd).toBe(0.015);
    expect(result.duration_ms).toBe(1200);
  });

  it("accepts null cost_usd", () => {
    const result = InferenceResultSchema.parse({
      content: "output",
      cost_usd: null,
      duration_ms: 500,
    });
    expect(result.cost_usd).toBeNull();
  });
});

describe("LLMCapabilitiesSchema", () => {
  it("parses valid capabilities", () => {
    const caps = LLMCapabilitiesSchema.parse({
      model_id: "claude-sonnet-4-5-20250514",
    });
    expect(caps.model_id).toBe("claude-sonnet-4-5-20250514");
  });

  it("rejects missing model_id", () => {
    expect(() => LLMCapabilitiesSchema.parse({})).toThrow();
  });
});

// ── Git Hosting Adapter ─────────────────────────────────────────────────────────

describe("MergeStrategySchema", () => {
  it("has exactly 3 values", () => {
    expect(MergeStrategySchema.options).toHaveLength(3);
  });

  it("accepts all valid values", () => {
    for (const strategy of ["merge", "squash", "rebase"]) {
      expect(MergeStrategySchema.parse(strategy)).toBe(strategy);
    }
  });
});

describe("PROptionsSchema", () => {
  const validPR = {
    repo: "owner/repo",
    branch: "engineer/47-dark-mode",
    base: "main",
    title: "Fix dark mode",
    body: "PR description",
    draft: true,
    labels: ["bug"],
    reviewers: ["farzam"],
  };

  it("parses valid PR options", () => {
    expect(PROptionsSchema.parse(validPR)).toEqual(validPR);
  });

  it("accepts null labels and reviewers", () => {
    const result = PROptionsSchema.parse({ ...validPR, labels: null, reviewers: null });
    expect(result.labels).toBeNull();
    expect(result.reviewers).toBeNull();
  });
});

describe("PRResultSchema", () => {
  it("parses valid data", () => {
    const result = PRResultSchema.parse({ pr_number: 42, url: "https://github.com/..." });
    expect(result.pr_number).toBe(42);
  });

  it("rejects non-positive pr_number", () => {
    expect(() => PRResultSchema.parse({ pr_number: 0, url: "x" })).toThrow();
  });
});

describe("PRUpdatesSchema", () => {
  it("parses with all null fields", () => {
    const updates = PRUpdatesSchema.parse({
      title: null,
      body: null,
      draft: null,
      labels_add: null,
      labels_remove: null,
    });
    expect(updates.title).toBeNull();
  });

  it("parses draft transition (Draft → Ready)", () => {
    const updates = PRUpdatesSchema.parse({
      title: null,
      body: null,
      draft: false,
      labels_add: null,
      labels_remove: null,
    });
    expect(updates.draft).toBe(false);
  });
});

describe("MergeResultSchema", () => {
  it("parses successful merge", () => {
    const result = MergeResultSchema.parse({
      merge_sha: "abc123",
      success: true,
      error: null,
    });
    expect(result.merge_sha).toBe("abc123");
  });

  it("parses failed merge with AdapterError", () => {
    const result = MergeResultSchema.parse({
      merge_sha: "",
      success: false,
      error: {
        code: "merge_conflict",
        message: "Conflicts in 2 files",
        retryable: false,
        retry_after_ms: null,
        severity: AdapterErrorSeverities.error,
      },
    });
    expect(result.error?.code).toBe("merge_conflict");
  });
});

describe("PRStatusSchema", () => {
  it("parses valid status", () => {
    const status = PRStatusSchema.parse({
      number: 42,
      state: "open",
      draft: true,
      mergeable: false,
      checks_state: "passing",
      url: "https://github.com/...",
    });
    expect(status.state).toBe("open");
  });

  it("accepts all valid state values", () => {
    for (const state of ["open", "closed", "merged"]) {
      expect(
        PRStatusSchema.parse({
          number: 1,
          state,
          draft: false,
          mergeable: true,
          checks_state: "passing",
          url: "x",
        }).state,
      ).toBe(state);
    }
  });
});

describe("ReviewerStateSchema", () => {
  it("parses valid data", () => {
    const state = ReviewerStateSchema.parse({ username: "farzam", state: "approved" });
    expect(state.state).toBe("approved");
  });

  it("accepts all valid state values", () => {
    for (const s of ["approved", "changes_requested", "commented", "pending"]) {
      expect(ReviewerStateSchema.parse({ username: "x", state: s }).state).toBe(s);
    }
  });
});

describe("ReviewStatusSchema", () => {
  it("parses valid status with reviewers array", () => {
    const status = ReviewStatusSchema.parse({
      approved: true,
      approvals: 1,
      changes_requested: false,
      reviewers: [{ username: "farzam", state: "approved" }],
    });
    expect(status.reviewers).toHaveLength(1);
  });
});

describe("CommentResultSchema", () => {
  it("parses valid data", () => {
    expect(CommentResultSchema.parse({ comment_id: "123", url: "https://..." })).toBeDefined();
  });
});

describe("BranchProtectionSchema", () => {
  it("parses valid data", () => {
    const prot = BranchProtectionSchema.parse({
      protected: true,
      required_reviews: 1,
      required_checks: ["ci"],
      restrictions: null,
    });
    expect(prot.required_reviews).toBe(1);
  });
});

// ── People Directory ────────────────────────────────────────────────────────────

describe("NotificationLevelSchema", () => {
  it("has exactly 3 values", () => {
    expect(NotificationLevelSchema.options).toHaveLength(3);
  });

  it("accepts all valid values", () => {
    for (const level of ["all", "milestones", "critical"]) {
      expect(NotificationLevelSchema.parse(level)).toBe(level);
    }
  });
});

describe("ContactSchema", () => {
  it("parses valid data", () => {
    expect(ContactSchema.parse({ channel: "telegram", handle: "@farzam" })).toBeDefined();
  });
});

describe("PersonSchema", () => {
  const validPerson = {
    id: "farzam",
    name: "Farzam Mohammadi",
    roles: ["owner", "reviewer"],
    contacts: [
      { channel: "telegram", handle: "@farzam" },
      { channel: "github", handle: "farzam" },
    ],
    preferences: {
      notification_level: NotificationLevels.milestones,
      quiet_hours: null,
    },
  };

  it("parses valid person", () => {
    const person = PersonSchema.parse(validPerson);
    expect(person.contacts).toHaveLength(2);
  });

  it("accepts quiet_hours", () => {
    const person = PersonSchema.parse({
      ...validPerson,
      preferences: {
        notification_level: NotificationLevels.all,
        quiet_hours: { start: "22:00", end: "08:00" },
      },
    });
    expect(person.preferences.quiet_hours?.start).toBe("22:00");
  });

  it("rejects invalid notification_level", () => {
    expect(() =>
      PersonSchema.parse({
        ...validPerson,
        preferences: { notification_level: "none", quiet_hours: null },
      }),
    ).toThrow();
  });
});

describe("ContactInfoSchema", () => {
  it("parses valid data", () => {
    expect(
      ContactInfoSchema.parse({
        channel: "telegram",
        handle: "@farzam",
        plugin_id: "telegram-comm",
      }),
    ).toBeDefined();
  });
});

// ── Plugin Health ───────────────────────────────────────────────────────────────

describe("PluginHealthStateSchema", () => {
  it("has exactly 3 values", () => {
    expect(PluginHealthStateSchema.options).toHaveLength(3);
  });

  it("accepts all valid values", () => {
    for (const state of ["healthy", "unhealthy", "failed"]) {
      expect(PluginHealthStateSchema.parse(state)).toBe(state);
    }
  });
});

describe("PluginHealthRecordSchema", () => {
  it("parses valid data with defaults", () => {
    const record = PluginHealthRecordSchema.parse({
      plugin_id: "github-trigger",
      state: PluginHealthStates.healthy,
      last_check_at: "2026-03-10T12:00:00.000Z",
      last_healthy_at: "2026-03-10T12:00:00.000Z",
      last_error: null,
    });
    expect(record.consecutive_failures).toBe(0);
  });

  it("accepts override of consecutive_failures default", () => {
    const record = PluginHealthRecordSchema.parse({
      plugin_id: "github-trigger",
      state: PluginHealthStates.unhealthy,
      consecutive_failures: 3,
      last_check_at: null,
      last_healthy_at: null,
      last_error: "Connection refused",
    });
    expect(record.consecutive_failures).toBe(3);
    expect(record.last_error).toBe("Connection refused");
  });
});
