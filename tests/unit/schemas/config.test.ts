import { describe, expect, it } from "vitest";

import {
  AutonomyBoundariesSchema,
  AutonomyDecisionSchema,
  AutonomyLevelSchema,
  AutonomyLevels,
  CostLimitValueSchema,
  CostLimitsSchema,
  DaemonConfigSchema,
  DigestConfigSchema,
  MergePolicySchema,
  MultiRepoConfigSchema,
  NotificationConfigSchema,
  OrchestratorConfigSchema,
  PrConfigSchema,
  ProviderLimitSchema,
  QuestionBatchingConfigSchema,
  QuietHoursConfigSchema,
  ResponseTimeoutSchema,
  SafetyConfigSchema,
  ScopeBoundariesSchema,
  TelemetryConfigSchema,
  TimeoutStageActions,
  TimeoutStageSchema,
  WorkspaceConfigSchema,
  WorkspaceReaperConfigSchema,
} from "../../../src/schemas/config.js";

// ── Daemon Config ───────────────────────────────────────────────────────────────

describe("DaemonConfigSchema", () => {
  it("produces valid config from empty input", () => {
    const config = DaemonConfigSchema.parse({});
    expect(config.tick_interval_ms).toBe(5_000);
    expect(config.preemption_threshold).toBe(20);
    expect(config.preemption_timeout_ms).toBe(60_000);
    expect(config.stuck_threshold_ms).toBe(1_800_000);
    expect(config.max_active_duration_ms).toBe(28_800_000);
    expect(config.shutdown_timeout_ms).toBe(30_000);
    expect(config.trigger_poll_interval_ms).toBe(30_000);
    expect(config.seen_keys_ttl_ms).toBe(86_400_000);
  });

  it("produces valid logging defaults from empty input", () => {
    const config = DaemonConfigSchema.parse({});
    expect(config.logging.level).toBe("info");
    expect(config.logging.dir).toBe("logs");
    expect(config.logging.max_size_bytes).toBe(524_288_000);
    expect(config.logging.max_files).toBe(7);
    expect(config.logging.console).toBe(false);
  });

  it("produces valid plugins defaults from empty input", () => {
    const config = DaemonConfigSchema.parse({});
    expect(config.plugins.dirs).toEqual([]);
    expect(config.plugins.health_check_interval_ms).toBe(60_000);
    expect(config.plugins.health_check_timeout_ms).toBe(5_000);
    expect(config.plugins.consecutive_failures_threshold).toBe(3);
  });

  it("produces valid workspace_reaper defaults from empty input", () => {
    const config = DaemonConfigSchema.parse({});
    expect(config.workspace_reaper.enabled).toBe(true);
    expect(config.workspace_reaper.interval_ms).toBe(3_600_000);
  });

  it("produces telemetry defaults from empty input (off, default endpoint and ui_base)", () => {
    const config = DaemonConfigSchema.parse({});
    expect(config.telemetry.enabled).toBe(false);
    expect(config.telemetry.endpoint).toBe("http://localhost:4318");
    expect(config.telemetry.ui_base).toBe("http://localhost:16686");
  });

  it("allows partial override while keeping other defaults", () => {
    const config = DaemonConfigSchema.parse({ tick_interval_ms: 10_000 });
    expect(config.tick_interval_ms).toBe(10_000);
    expect(config.preemption_threshold).toBe(20);
    expect(config.logging.level).toBe("info");
  });

  it("rejects non-positive durations", () => {
    expect(() => DaemonConfigSchema.parse({ tick_interval_ms: 0 })).toThrow();
    expect(() => DaemonConfigSchema.parse({ tick_interval_ms: -1 })).toThrow();
  });

  it("accepts valid logging level", () => {
    const config = DaemonConfigSchema.parse({ logging: { level: "debug" } });
    expect(config.logging.level).toBe("debug");
  });

  it("rejects invalid logging level", () => {
    expect(() => DaemonConfigSchema.parse({ logging: { level: "verbose" } })).toThrow();
  });
});

describe("TelemetryConfigSchema", () => {
  it("produces valid defaults from empty input (off, default endpoint and ui_base)", () => {
    const config = TelemetryConfigSchema.parse({});
    expect(config.enabled).toBe(false);
    expect(config.endpoint).toBe("http://localhost:4318");
    expect(config.ui_base).toBe("http://localhost:16686");
  });

  it("accepts enabled with a custom endpoint and ui_base", () => {
    const config = TelemetryConfigSchema.parse({
      enabled: true,
      endpoint: "http://collector:4318",
      ui_base: "http://collector:16686",
    });
    expect(config.enabled).toBe(true);
    expect(config.endpoint).toBe("http://collector:4318");
    expect(config.ui_base).toBe("http://collector:16686");
  });

  it("rejects a non-boolean enabled and a non-string endpoint", () => {
    expect(() => TelemetryConfigSchema.parse({ enabled: "yes" })).toThrow();
    expect(() => TelemetryConfigSchema.parse({ endpoint: 4318 })).toThrow();
  });
});

// ── Orchestrator Config ─────────────────────────────────────────────────────────

describe("QuietHoursConfigSchema", () => {
  it("produces valid defaults from empty input", () => {
    const config = QuietHoursConfigSchema.parse({});
    expect(config.enabled).toBe(false);
    expect(config.start).toBe("22:00");
    expect(config.end).toBe("08:00");
    expect(config.timezone).toBe("UTC");
    expect(config.allow_alerts).toBe(true);
  });
});

describe("DigestConfigSchema", () => {
  it("produces valid defaults from empty input", () => {
    const config = DigestConfigSchema.parse({});
    expect(config.enabled).toBe(false);
    expect(config.schedule).toBe("0 9 * * *");
    expect(config.channel).toBe("telegram");
    expect(config.include).toEqual(["completed", "blocked", "failed"]);
  });
});

describe("NotificationConfigSchema", () => {
  it("produces valid defaults from empty input", () => {
    const config = NotificationConfigSchema.parse({});
    expect(config.milestone_based).toBe(true);
    expect(config.suppress_window_ms).toBe(300_000);
    expect(config.batch_window_ms).toBe(120_000);
    expect(config.quiet_hours.enabled).toBe(false);
    expect(config.digest.enabled).toBe(false);
  });
});

describe("QuestionBatchingConfigSchema", () => {
  it("produces valid defaults from empty input", () => {
    const config = QuestionBatchingConfigSchema.parse({});
    expect(config.enabled).toBe(true);
    expect(config.batch_window_ms).toBe(30_000);
    expect(config.max_batch_size).toBe(5);
  });
});

describe("OrchestratorConfigSchema", () => {
  it("produces valid config from empty input with all nested defaults", () => {
    const config = OrchestratorConfigSchema.parse({});
    expect(config.review.lenses).toEqual(["self-review"]);
    expect(config.notification.milestone_based).toBe(true);
    expect(config.question_batching.enabled).toBe(true);
  });

  it("defaults the live-activity feed on", () => {
    const config = OrchestratorConfigSchema.parse({});
    expect(config.observability.live_activity).toBe(true);
  });

  it("allows disabling the live-activity feed", () => {
    const config = OrchestratorConfigSchema.parse({ observability: { live_activity: false } });
    expect(config.observability.live_activity).toBe(false);
  });

  it("allows partial nested override", () => {
    const config = OrchestratorConfigSchema.parse({
      review: { lenses: ["self-review", "security"] },
    });
    expect(config.review.lenses).toEqual(["self-review", "security"]);
    expect(config.notification.milestone_based).toBe(true);
  });
});

// ── Workspace Config ────────────────────────────────────────────────────────────

describe("PrConfigSchema", () => {
  it("produces valid defaults from empty input", () => {
    const config = PrConfigSchema.parse({});
    expect(config.default_merge_strategy).toBe("squash");
    expect(config.branch_retention_days).toBe(0);
    expect(config.skip_pr_creation).toEqual({ default: false, repos: {} });
  });

  it("accepts branch_retention_days of 0, a positive integer, or null — but not negative", () => {
    expect(PrConfigSchema.parse({ branch_retention_days: 0 }).branch_retention_days).toBe(0);
    expect(PrConfigSchema.parse({ branch_retention_days: 7 }).branch_retention_days).toBe(7);
    expect(PrConfigSchema.parse({ branch_retention_days: null }).branch_retention_days).toBeNull();
    expect(() => PrConfigSchema.parse({ branch_retention_days: -1 })).toThrow();
  });

  it("accepts skip_pr_creation with default override", () => {
    const config = PrConfigSchema.parse({ skip_pr_creation: { default: true } });
    expect(config.skip_pr_creation.default).toBe(true);
    expect(config.skip_pr_creation.repos).toEqual({});
  });

  it("accepts skip_pr_creation with per-repo overrides", () => {
    const config = PrConfigSchema.parse({
      skip_pr_creation: { default: false, repos: { "owner/repo": true } },
    });
    expect(config.skip_pr_creation.default).toBe(false);
    expect(config.skip_pr_creation.repos["owner/repo"]).toBe(true);
  });
});

describe("WorkspaceReaperConfigSchema", () => {
  it("produces valid defaults from empty input", () => {
    const config = WorkspaceReaperConfigSchema.parse({});
    expect(config.enabled).toBe(true);
    expect(config.interval_ms).toBe(3_600_000);
  });

  it("rejects a non-positive interval", () => {
    expect(() => WorkspaceReaperConfigSchema.parse({ interval_ms: 0 })).toThrow();
  });
});

describe("MultiRepoConfigSchema", () => {
  it("produces valid defaults from empty input", () => {
    const config = MultiRepoConfigSchema.parse({});
    expect(config.enabled).toBe(true);
    expect(config.max_repos_per_task).toBe(5);
  });
});

describe("WorkspaceConfigSchema", () => {
  it("produces valid config from empty input with all nested defaults", () => {
    const config = WorkspaceConfigSchema.parse({});
    expect(config.workspace_root).toBe("~/.engineer/workspaces/");
    expect(config.branch_prefix).toBe("engineer/");
    expect(config.slug_max_length).toBe(30);
    expect(config.default_base_branch).toBe("main");
    expect(config.pr.default_merge_strategy).toBe("squash");
    expect(config.pr.branch_retention_days).toBe(0);
    expect(config.multi_repo.enabled).toBe(true);
  });
});

// ── Safety Config ───────────────────────────────────────────────────────────────

describe("CostLimitValueSchema", () => {
  it("produces valid defaults from empty input", () => {
    const config = CostLimitValueSchema.parse({});
    expect(config.cost_usd).toBeNull();
  });

  it("accepts positive cost_usd", () => {
    const config = CostLimitValueSchema.parse({ cost_usd: 10.5 });
    expect(config.cost_usd).toBe(10.5);
  });

  it("rejects non-positive cost_usd", () => {
    expect(() => CostLimitValueSchema.parse({ cost_usd: 0 })).toThrow();
    expect(() => CostLimitValueSchema.parse({ cost_usd: -1 })).toThrow();
  });
});

describe("ProviderLimitSchema", () => {
  it("produces valid defaults from empty input", () => {
    const config = ProviderLimitSchema.parse({});
    expect(config.daily_requests).toBeNull();
  });
});

describe("CostLimitsSchema", () => {
  it("produces valid defaults from empty input", () => {
    const config = CostLimitsSchema.parse({});
    expect(config.per_task.cost_usd).toBeNull();
    expect(config.daily.cost_usd).toBeNull();
    expect(config.monthly.cost_usd).toBeNull();
    expect(config.providers).toEqual({});
  });
});

describe("ScopeBoundariesSchema", () => {
  it("produces valid defaults from empty input", () => {
    const config = ScopeBoundariesSchema.parse({});
    expect(config.repos.allowed).toBeNull();
    expect(config.branches.create_pattern).toBe("engineer/.*");
    expect(config.branches.push_to).toEqual(["engineer/*"]);
    expect(config.branches.merge_to).toEqual(["main"]);
    expect(config.files.exclude_patterns).toEqual([".env*", "secrets/**", "*.pem", "*.key"]);
    expect(config.external.allowed_domains).toBeNull();
  });
});

describe("AutonomyLevelSchema", () => {
  it("has exactly 3 values", () => {
    expect(AutonomyLevelSchema.options).toHaveLength(3);
  });

  it("accepts all valid values", () => {
    for (const level of ["always_ask", "threshold", "always_decide"]) {
      expect(AutonomyLevelSchema.parse(level)).toBe(level);
    }
  });

  it("rejects invalid values", () => {
    expect(() => AutonomyLevelSchema.parse("auto")).toThrow();
  });
});

describe("AutonomyDecisionSchema", () => {
  it("produces valid defaults from empty input", () => {
    const config = AutonomyDecisionSchema.parse({});
    expect(config.level).toBe(AutonomyLevels.always_ask);
    expect(config.threshold).toBeNull();
    expect(config.description).toBe("");
  });
});

describe("AutonomyBoundariesSchema", () => {
  it("produces valid defaults from empty input", () => {
    const config = AutonomyBoundariesSchema.parse({});
    expect(config.decisions).toEqual({});
    expect(config.repo_overrides).toEqual({});
  });

  it("accepts decisions with custom categories", () => {
    const config = AutonomyBoundariesSchema.parse({
      decisions: {
        merge: {
          level: AutonomyLevels.always_ask,
          threshold: null,
          description: "Merge decisions",
        },
      },
    });
    expect(config.decisions["merge"]?.level).toBe(AutonomyLevels.always_ask);
  });

  it("accepts repo_overrides with partial decisions", () => {
    const config = AutonomyBoundariesSchema.parse({
      repo_overrides: {
        "owner/repo": {
          decisions: {
            merge: { level: AutonomyLevels.always_decide },
          },
        },
      },
    });
    expect(config.repo_overrides["owner/repo"]?.decisions["merge"]?.level).toBe(AutonomyLevels.always_decide);
  });
});

describe("TimeoutStageSchema", () => {
  it("parses valid stage", () => {
    const stage = TimeoutStageSchema.parse({
      name: "reminder",
      after_ms: 14_400_000,
      action: TimeoutStageActions.send_reminder,
    });
    expect(stage.name).toBe("reminder");
    expect(stage.repeat).toBeNull();
    expect(stage.repeat_interval_ms).toBeNull();
  });

  it("rejects non-positive after_ms", () => {
    expect(() => TimeoutStageSchema.parse({ name: "x", after_ms: 0, action: "y" })).toThrow();
  });
});

describe("ResponseTimeoutSchema", () => {
  it("produces valid defaults from empty input", () => {
    const config = ResponseTimeoutSchema.parse({});
    expect(config.blocked.stages).toHaveLength(3);
    expect(config.blocked.stages[0]?.name).toBe("reminder");
    expect(config.blocked.stages[0]?.after_ms).toBe(14_400_000);
    expect(config.blocked.stages[1]?.name).toBe("self_unblock_check");
    expect(config.blocked.stages[2]?.name).toBe("escalation");
    expect(config.blocked.stages[2]?.after_ms).toBe(172_800_000);
    expect(config.review_pending.reminder_after_ms).toBe(86_400_000);
    expect(config.review_pending.repeat_interval_ms).toBe(86_400_000);
  });
});

describe("MergePolicySchema", () => {
  it("produces valid defaults from empty input", () => {
    const config = MergePolicySchema.parse({});
    expect(config.auto_merge_after_approval.default).toBe(false);
    expect(config.auto_merge_after_approval.repos).toEqual({});
  });

  it("accepts per-repo overrides", () => {
    const config = MergePolicySchema.parse({
      auto_merge_after_approval: { repos: { "owner/repo": true } },
    });
    expect(config.auto_merge_after_approval.repos["owner/repo"]).toBe(true);
    expect(config.auto_merge_after_approval.default).toBe(false);
  });
});

describe("SafetyConfigSchema", () => {
  it("produces valid config from empty input (conservative defaults)", () => {
    const config = SafetyConfigSchema.parse({});
    // Cost limits default to null (unlimited but tracked)
    expect(config.cost_limits.per_task.cost_usd).toBeNull();
    expect(config.cost_limits.daily.cost_usd).toBeNull();
    expect(config.cost_limits.providers).toEqual({});
    // Scope defaults to safe patterns
    expect(config.scope.branches.create_pattern).toBe("engineer/.*");
    expect(config.scope.files.exclude_patterns).toContain(".env*");
    expect(config.scope.files.exclude_patterns).toContain("*.key");
    // Autonomy defaults to always_ask (safest)
    expect(config.autonomy.decisions).toEqual({});
    // Merge defaults to no auto-merge
    expect(config.merge.auto_merge_after_approval.default).toBe(false);
    // Response timeout has 3 default stages
    expect(config.response_timeout.blocked.stages).toHaveLength(3);
  });

  it("allows full override of all sections", () => {
    const config = SafetyConfigSchema.parse({
      cost_limits: {
        per_task: { cost_usd: 5 },
        daily: { cost_usd: 50 },
        monthly: { cost_usd: 200 },
      },
      merge: { auto_merge_after_approval: { default: true } },
    });
    expect(config.cost_limits.per_task.cost_usd).toBe(5);
    expect(config.merge.auto_merge_after_approval.default).toBe(true);
  });
});
