import { z } from "zod";

import { PersonSchema } from "./adapters.js";

// ── Config Version ──────────────────────────────────────────────────────────────

/** Current config schema version. */
export const CURRENT_CONFIG_VERSION = 1;

export const ConfigVersionSchema = z.object({
  version: z.number().int().positive().default(CURRENT_CONFIG_VERSION),
});
export type ConfigVersion = z.infer<typeof ConfigVersionSchema>;

// ── Data Lifecycle Config ────────────────────────────────────────────────────────

export const TableRetentionSchema = z.object({
  max_age_days: z.number().int().positive().default(90),
});
export type TableRetention = z.infer<typeof TableRetentionSchema>;

export const DataLifecycleConfigSchema = z.object({
  enabled: z.boolean().default(true),
  interval_ms: z.number().int().positive().default(3_600_000), // 1 hour
  retention: z
    .object({
      events: TableRetentionSchema.default({}),
      observations: TableRetentionSchema.default({ max_age_days: 90 }),
      journal_entries: TableRetentionSchema.default({}),
      checkpoints: TableRetentionSchema.default({}),
    })
    .default({}),
});
export type DataLifecycleConfig = z.infer<typeof DataLifecycleConfigSchema>;

// ── Database Config ─────────────────────────────────────────────────────────────

export const DatabaseTuningConfigSchema = z.object({
  cache_size_mb: z.number().int().positive().default(64),
});
export type DatabaseTuningConfig = z.infer<typeof DatabaseTuningConfigSchema>;

// ── Daemon Config ───────────────────────────────────────────────────────────────
// Loaded from daemon.yaml. Startup-only — not hot-reloadable.

export const DaemonConfigSchema = z.object({
  // Capacity (concurrency-ready: default 1 = single-core era)
  max_concurrent: z
    .number()
    .int()
    .positive()
    .default(1)
    .describe(
      "Number of tasks the daemon runs in parallel. Start with 1; increase after testing stability.",
    ),

  // Tick loop
  tick_interval_ms: z
    .number()
    .int()
    .positive()
    .default(5_000)
    .describe(
      "Main daemon loop interval. Each tick polls triggers, checks scheduling, and runs housekeeping. Default: 5 seconds.",
    ),

  // Preemption
  preemption_threshold: z
    .number()
    .int()
    .positive()
    .default(20)
    .describe(
      "Minimum priority gap to trigger preemption. A p70 task preempts a p50 task (gap=20), but not a p55 task (gap=15).",
    ),
  preemption_timeout_ms: z
    .number()
    .int()
    .positive()
    .default(60_000)
    .describe(
      "Grace period for a preempted task to checkpoint before forced swap. Default: 1 minute.",
    ),

  // Stuck/runaway detection
  stuck_threshold_ms: z
    .number()
    .int()
    .positive()
    .default(1_800_000)
    .describe(
      "Duration of no progress after which a task is flagged as stuck. Default: 30 minutes.",
    ),
  max_active_duration_ms: z
    .number()
    .int()
    .positive()
    .default(28_800_000)
    .describe("Hard cap on total wall-clock time a task can remain active. Default: 8 hours."),

  // Priority aging (starvation prevention)
  aging_threshold_ms: z
    .number()
    .int()
    .positive()
    .default(86_400_000)
    .describe("How long a queued task waits before priority aging begins. Default: 1 day."),
  aging_increment: z
    .number()
    .int()
    .positive()
    .default(5)
    .describe(
      "Priority points added each aging cycle. Higher values promote starved tasks faster. Default: 5.",
    ),
  aging_interval_ms: z
    .number()
    .int()
    .positive()
    .default(86_400_000)
    .describe("Time between priority aging bumps after the threshold is reached. Default: 1 day."),
  aging_cap: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(75)
    .describe(
      "Maximum priority reachable via aging (1-100). Leaves 76-100 for manually urgent tasks.",
    ),

  // Shutdown
  shutdown_timeout_ms: z
    .number()
    .int()
    .positive()
    .default(30_000)
    .describe(
      "Time to wait for active tasks to checkpoint during graceful shutdown. Default: 30 seconds.",
    ),

  // Trigger polling (Decision #74)
  trigger_poll_interval_ms: z
    .number()
    .int()
    .positive()
    .default(30_000)
    .describe("How often the daemon polls trigger adapters for new work. Default: 30 seconds."),
  seen_keys_ttl_ms: z
    .number()
    .int()
    .positive()
    .default(86_400_000)
    .describe(
      "How long trigger dedup keys are remembered. Events older than this may re-trigger. Default: 1 day.",
    ),

  // Logging (Decision #111)
  logging: z
    .object({
      level: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
      dir: z
        .string()
        .default("logs")
        .describe(
          "Log directory. Relative paths resolve against ENGINEER_HOME (~/.engineer/). Absolute paths used as-is.",
        ),
      max_size_bytes: z.number().int().positive().default(524_288_000),
      max_files: z.number().int().positive().default(7),
      console: z.boolean().default(false),
    })
    .default({}),

  // Plugin lifecycle (Decision #107)
  plugins: z
    .object({
      dirs: z.array(z.string()).default([]),
      health_check_interval_ms: z.number().int().positive().default(60_000),
      health_check_timeout_ms: z.number().int().positive().default(5_000),
      consecutive_failures_threshold: z.number().int().positive().default(3),
    })
    .default({}),

  // Data lifecycle (R10)
  data_lifecycle: DataLifecycleConfigSchema.default({}),

  // Database tuning (R10)
  database: DatabaseTuningConfigSchema.default({}),

  // EventBus subscriber slow-callback warning threshold in ms (R10)
  subscriber_warn_threshold_ms: z
    .number()
    .int()
    .min(0)
    .default(50)
    .describe("Warn if an EventBus subscriber callback exceeds this duration (ms). 0 = disabled."),

  // Review polling circuit breaker (Lens H)
  review_polling: z
    .object({
      failure_window_ms: z
        .number()
        .int()
        .positive()
        .default(300_000)
        .describe(
          "Time window for counting review API failures before pausing polling. Default: 5 minutes.",
        ),
      max_failures_before_pause: z
        .number()
        .int()
        .positive()
        .default(3)
        .describe(
          "Number of review API failures within the failure window before pausing polling. Default: 3.",
        ),
    })
    .default({}),
});
export type DaemonConfig = z.infer<typeof DaemonConfigSchema>;

// ── Orchestrator Config ─────────────────────────────────────────────────────────
// Loaded from orchestrator.yaml. Startup-only — not hot-reloadable.

export const FastPathConfigSchema = z.object({
  enabled: z.boolean().default(true),
  max_files: z.number().int().positive().default(2),
  skip_demo: z.boolean().default(true),
  max_estimated_minutes: z.number().int().positive().default(30),
});
export type FastPathConfig = z.infer<typeof FastPathConfigSchema>;

export const QuietHoursConfigSchema = z.object({
  enabled: z.boolean().default(false),
  start: z.string().default("22:00"),
  end: z.string().default("08:00"),
  timezone: z
    .string()
    .default("UTC")
    .describe("IANA timezone identifier (e.g. 'America/New_York', 'Europe/London', 'UTC')."),
  allow_alerts: z.boolean().default(true),
});
export type QuietHoursConfig = z.infer<typeof QuietHoursConfigSchema>;

export const DigestConfigSchema = z.object({
  enabled: z.boolean().default(false),
  schedule: z.string().default("0 9 * * *"),
  channel: z.string().default("telegram"),
  include: z.array(z.string()).default(["completed", "blocked", "failed"]),
});
export type DigestConfig = z.infer<typeof DigestConfigSchema>;

export const NotificationConfigSchema = z.object({
  milestone_based: z.boolean().default(true),
  suppress_window_ms: z.number().int().positive().default(300_000),
  batch_window_ms: z.number().int().positive().default(120_000),
  quiet_hours: QuietHoursConfigSchema.default({}),
  digest: DigestConfigSchema.default({}),
  fast_path_collapse: z.boolean().default(true),
});
export type NotificationConfig = z.infer<typeof NotificationConfigSchema>;

export const QuestionBatchingConfigSchema = z.object({
  enabled: z.boolean().default(true),
  batch_window_ms: z.number().int().positive().default(30_000),
  max_batch_size: z.number().int().positive().default(5),
});
export type QuestionBatchingConfig = z.infer<typeof QuestionBatchingConfigSchema>;

export const DecompositionConfigSchema = z.object({
  auto_threshold_ms: z.number().int().positive().default(14_400_000),
  suggest_threshold_ms: z.number().int().positive().default(7_200_000),
  min_child_size_ms: z.number().int().positive().default(1_800_000),
});
export type DecompositionConfig = z.infer<typeof DecompositionConfigSchema>;

export const DemoConfigSchema = z.object({
  always_create: z.boolean().default(true),
  tui_base_project: z.string().nullable().default(null),
});
export type DemoConfig = z.infer<typeof DemoConfigSchema>;

export const PhasesConfigSchema = z.object({
  checkpoint_on_transition: z.boolean().default(true),
  periodic_checkpoint_interval_ms: z.number().int().positive().default(900_000),
  max_loopbacks_before_alert: z.number().int().positive().default(3),
});
export type PhasesConfig = z.infer<typeof PhasesConfigSchema>;

export const JournalConfigSchema = z.object({
  aggregate_file_reads: z.boolean().default(true),
});
export type JournalConfig = z.infer<typeof JournalConfigSchema>;

export const OrchestratorConfigSchema = z.object({
  fast_path: FastPathConfigSchema.default({}),
  notification: NotificationConfigSchema.default({}),
  question_batching: QuestionBatchingConfigSchema.default({}),
  decomposition: DecompositionConfigSchema.default({}),
  demo: DemoConfigSchema.default({}),
  phases: PhasesConfigSchema.default({}),
  journal: JournalConfigSchema.default({}),
});
export type OrchestratorConfig = z.infer<typeof OrchestratorConfigSchema>;

// ── Workspace Config ────────────────────────────────────────────────────────────
// Loaded from workspace.yaml. Startup-only — not hot-reloadable.

export const PrConfigSchema = z.object({
  default_merge_strategy: z
    .enum(["squash", "merge", "rebase"])
    .default("squash")
    .describe(
      "How PRs are merged: squash (single commit), merge (merge commit), or rebase. Default: squash.",
    ),
  delete_branch_after_merge: z
    .boolean()
    .default(true)
    .describe("Delete the task branch after its PR is merged. Default: true."),
  branch_retention_days: z
    .number()
    .int()
    .positive()
    .nullable()
    .default(null)
    .describe(
      "Days to retain merged branches before cleanup. Null means no automatic deletion. Default: null.",
    ),
});
export type PrConfig = z.infer<typeof PrConfigSchema>;

export const CleanupConfigSchema = z.object({
  preserve_branch_on_failure: z
    .boolean()
    .default(true)
    .describe("Keep the task branch when a task fails, for debugging. Default: true."),
  preserve_branch_on_cancel: z
    .boolean()
    .default(false)
    .describe("Keep the task branch when a task is cancelled. Default: false."),
});
export type CleanupConfig = z.infer<typeof CleanupConfigSchema>;

export const MultiRepoConfigSchema = z.object({
  enabled: z
    .boolean()
    .default(true)
    .describe(
      "Allow tasks to span multiple repositories. Safe to leave enabled even for single-repo setups.",
    ),
  max_repos_per_task: z
    .number()
    .int()
    .positive()
    .default(5)
    .describe("Maximum number of repositories a single task can span. Default: 5."),
});
export type MultiRepoConfig = z.infer<typeof MultiRepoConfigSchema>;

export const WorkspaceConfigSchema = z.object({
  workspace_root: z
    .string()
    .default("~/.engineer/workspaces/")
    .describe(
      "Directory where git worktrees are created. Supports ~ expansion. Default: ~/.engineer/workspaces/",
    ),
  branch_prefix: z
    .string()
    .default("engineer/")
    .describe("Prefix for all branches created by The Engineer. Default: engineer/"),
  slug_max_length: z
    .number()
    .int()
    .positive()
    .default(30)
    .describe("Maximum character length for the task slug portion of branch names. Default: 30."),
  fetch_before_create: z
    .boolean()
    .default(true)
    .describe(
      "Fetch from remote before creating a worktree, ensuring the base branch is up to date. Default: true.",
    ),
  default_base_branch: z
    .string()
    .default("main")
    .describe("Default base branch for PRs when not specified by the task. Default: main."),
  git_token_env: z
    .string()
    .default("GIT_TOKEN")
    .describe(
      "Name of the environment variable holding the git authentication token. Set to GITHUB_TOKEN if using GitHub. Default: GIT_TOKEN.",
    ),
  pr: PrConfigSchema.default({}),
  cleanup: CleanupConfigSchema.default({}),
  child_pr_strategy: z
    .enum(["merge_into_parent", "individual_prs"])
    .default("merge_into_parent")
    .describe(
      "How child task branches integrate: merge_into_parent (single PR) or individual_prs (one PR per child). Default: merge_into_parent.",
    ),
  multi_repo: MultiRepoConfigSchema.default({}),
});
export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>;

// ── Safety Config (hot-reloadable) ──────────────────────────────────────────────
// Loaded from safety.yaml. Hot-reloadable — changes take effect without restart.
//
// **Logging contract (Phase 3):** The config loader MUST log a warning when
// safety.yaml is missing or when default values are used. Conservative defaults
// ensure safe startup, but operators should always configure safety explicitly.

export const CostLimitValueSchema = z.object({
  cost_usd: z
    .number()
    .positive()
    .nullable()
    .default(null)
    .describe("USD spending limit. null = unlimited (no limit enforced)."),
});
export type CostLimitValue = z.infer<typeof CostLimitValueSchema>;

export const ProviderLimitSchema = z.object({
  daily_requests: z
    .number()
    .int()
    .positive()
    .nullable()
    .default(null)
    .describe("Max CLI requests per day. null = unlimited."),
});
export type ProviderLimit = z.infer<typeof ProviderLimitSchema>;

export const CostLimitsSchema = z.object({
  per_task: CostLimitValueSchema.default({}),
  daily: CostLimitValueSchema.default({}),
  monthly: CostLimitValueSchema.default({}),
  providers: z
    .record(ProviderLimitSchema)
    .default({})
    .describe("Per-provider limits. Keys are plugin IDs (e.g. 'claude-code-llm')."),
});
export type CostLimits = z.infer<typeof CostLimitsSchema>;

export const ScopeBoundariesSchema = z.object({
  repos: z
    .object({
      allowed: z.array(z.string()).nullable().default(null),
    })
    .default({}),
  branches: z
    .object({
      create_pattern: z.string().default("engineer/.*"),
      push_to: z.array(z.string()).default(["engineer/*"]),
      merge_to: z.array(z.string()).default(["main"]),
    })
    .default({}),
  files: z
    .object({
      exclude_patterns: z.array(z.string()).default([".env*", "secrets/**", "*.pem", "*.key"]),
    })
    .default({}),
  external: z
    .object({
      allowed_domains: z.array(z.string()).nullable().default(null),
    })
    .default({}),
});
export type ScopeBoundaries = z.infer<typeof ScopeBoundariesSchema>;

export const AutonomyLevelSchema = z.enum(["always_ask", "threshold", "always_decide"]);
export type AutonomyLevel = z.infer<typeof AutonomyLevelSchema>;

/** Constant enum values for AutonomyLevel. Use instead of raw strings. */
export const AutonomyLevels = AutonomyLevelSchema.enum;

export const AutonomyDecisionSchema = z.object({
  level: AutonomyLevelSchema.default("always_ask"),
  threshold: z.string().nullable().default(null),
  description: z.string().default(""),
});
export type AutonomyDecision = z.infer<typeof AutonomyDecisionSchema>;

export const AutonomyBoundariesSchema = z.object({
  decisions: z
    .record(AutonomyDecisionSchema)
    .default({})
    .describe(
      "Per-category autonomy overrides. Keys are free-form category names (e.g. 'code_style', 'architecture'). Unknown categories default to always_ask.",
    ),
  repo_overrides: z
    .record(
      z.object({
        decisions: z.record(AutonomyDecisionSchema.partial()).default({}),
      }),
    )
    .default({}),
});
export type AutonomyBoundaries = z.infer<typeof AutonomyBoundariesSchema>;

export const TimeoutStageActionSchema = z.enum([
  "send_reminder",
  "evaluate_self_unblock",
  "escalation_alert",
]);
export type TimeoutStageAction = z.infer<typeof TimeoutStageActionSchema>;

/** Constant enum values for TimeoutStageAction. Use instead of raw strings. */
export const TimeoutStageActions = TimeoutStageActionSchema.enum;

export const TimeoutStageSchema = z.object({
  name: z
    .string()
    .describe("Human-readable stage name (e.g. 'reminder', 'self_unblock_check', 'escalation')."),
  after_ms: z
    .number()
    .int()
    .positive()
    .describe(
      "Milliseconds after the task entered the blocked state before this stage fires. Accepts duration strings in config (e.g. '4h', '2d').",
    ),
  action: TimeoutStageActionSchema.describe("Action to take when this timeout stage fires."),
  repeat: z
    .boolean()
    .nullable()
    .default(null)
    .describe("Whether this stage re-fires on a recurring interval. null = no repeat."),
  repeat_interval_ms: z
    .number()
    .int()
    .positive()
    .nullable()
    .default(null)
    .describe(
      "Interval between repeated firings (ms). Only used when repeat is true. Accepts duration strings in config (e.g. '4h').",
    ),
});
export type TimeoutStage = z.infer<typeof TimeoutStageSchema>;

export const ResponseTimeoutSchema = z.object({
  blocked: z
    .object({
      stages: z.array(TimeoutStageSchema).default([
        {
          name: "reminder",
          after_ms: 14_400_000,
          action: "send_reminder",
          repeat: true,
          repeat_interval_ms: 14_400_000,
        },
        {
          name: "self_unblock_check",
          after_ms: 28_800_000,
          action: "evaluate_self_unblock",
          repeat: null,
          repeat_interval_ms: null,
        },
        {
          name: "escalation",
          after_ms: 172_800_000,
          action: "escalation_alert",
          repeat: null,
          repeat_interval_ms: null,
        },
      ]),
    })
    .default({}),
  review_pending: z
    .object({
      reminder_after_ms: z
        .number()
        .int()
        .positive()
        .default(86_400_000)
        .describe(
          "Time before first review reminder. Accepts duration strings in config (e.g. '1d'). Default: 1 day.",
        ),
      repeat_interval_ms: z
        .number()
        .int()
        .positive()
        .default(86_400_000)
        .describe(
          "Interval between repeated review reminders. Accepts duration strings in config (e.g. '1d'). Default: 1 day.",
        ),
    })
    .default({}),
});
export type ResponseTimeout = z.infer<typeof ResponseTimeoutSchema>;

export const MergePolicySchema = z.object({
  auto_merge_after_approval: z
    .object({
      default: z.boolean().default(false),
      repos: z.record(z.boolean()).default({}),
    })
    .default({}),
});
export type MergePolicy = z.infer<typeof MergePolicySchema>;

export const SafetyConfigSchema = z.object({
  cost_limits: CostLimitsSchema.default({}),
  scope: ScopeBoundariesSchema.default({}),
  autonomy: AutonomyBoundariesSchema.default({}),
  response_timeout: ResponseTimeoutSchema.default({}),
  merge: MergePolicySchema.default({}),
});
export type SafetyConfig = z.infer<typeof SafetyConfigSchema>;

// ── People Config (people.yaml wrapper) ──────────────────────────────────────────
// Wraps PersonSchema[] for YAML file structure: `people: [...]`
// Hot-reloadable — changes take effect without restart.

export const PeopleConfigSchema = z.object({
  people: z.array(PersonSchema).default([]),
});
export type PeopleConfig = z.infer<typeof PeopleConfigSchema>;
