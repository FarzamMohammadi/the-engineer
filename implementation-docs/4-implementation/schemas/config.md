# Config Schemas

Concrete Zod schemas for all config files. These schemas validate YAML config files loaded at startup and during hot-reload. Defaults are embedded in schemas via `.default()` — config files only need to override what they want to change.

Part of **Layer 4** — resolves reconciliation item R14 (config types deferred from Session 24). Source types: [`../../2-components/orchestrator.md`](../../2-components/orchestrator.md), [`../../2-components/workspace-manager.md`](../../2-components/workspace-manager.md), [`../../2-components/daemon-scheduler.md`](../../2-components/daemon-scheduler.md), [`../../2-components/safety-layer.md`](../../2-components/safety-layer.md).

Config system design: [`../layout.md`](../layout.md).

---

## Conventions

- All duration fields are milliseconds (`z.number().int().positive()`). Config files use human-readable strings (`"4h"`, `"30s"`) parsed at load time via the `ms` package (Decision #97).
- Every field has a `.default()` value. A missing config file = system runs with all defaults.
- Secrets use `${ENV_VAR_NAME}` syntax, resolved before Zod validation.
- These schemas follow the Zod-first convention from [`README.md`](README.md) — named type aliases are mandatory.

---

## DaemonConfig

Loaded from `daemon.yaml`. Startup-only — not hot-reloadable.

Extends the 10-field schema from [`ephemeral.md`](ephemeral.md) with trigger polling and dedup key TTL.

```typescript
const DaemonConfigSchema = z.object({
  // --- Tick loop ---
  tick_interval_ms: z.number().int().positive().default(5_000),           // 5 seconds

  // --- Preemption ---
  preemption_threshold: z.number().int().positive().default(20),          // priority gap to trigger preemption
  preemption_timeout_ms: z.number().int().positive().default(60_000),     // 1 min to checkpoint before forced

  // --- Stuck/runaway detection ---
  stuck_threshold_ms: z.number().int().positive().default(1_800_000),     // 30 min no progress
  max_active_duration_ms: z.number().int().positive().default(28_800_000),// 8 hours absolute cap

  // --- Priority aging (starvation prevention) ---
  aging_threshold_ms: z.number().int().positive().default(86_400_000),    // 24 hours before aging starts
  aging_increment: z.number().int().positive().default(5),                // priority bump per interval
  aging_interval_ms: z.number().int().positive().default(86_400_000),     // 24 hours between bumps
  aging_cap: z.number().int().min(1).max(100).default(75),                // max priority from aging

  // --- Shutdown ---
  shutdown_timeout_ms: z.number().int().positive().default(30_000),       // 30 seconds graceful shutdown

  // --- Trigger polling (Decision #74) ---
  trigger_poll_interval_ms: z.number().int().positive().default(30_000),  // 30 seconds
  seen_keys_ttl_ms: z.number().int().positive().default(86_400_000),     // 24 hours — dedup key retention

  // --- Plugin lifecycle (Decision #107) ---
  plugins: z.object({
    dirs: z.array(z.string()).default(["src/plugins"]),                   // plugin discovery paths
    health_check_interval_ms: z.number().int().positive().default(60_000), // 60 seconds between checks
    health_check_timeout_ms: z.number().int().positive().default(5_000),  // 5 seconds per health check
    consecutive_failures_threshold: z.number().int().positive().default(3), // failures before "failed" state
  }).default({}),
});
type DaemonConfig = z.infer<typeof DaemonConfigSchema>;
```

**New fields vs Session 24:**
- `trigger_poll_interval_ms` — Default polling interval for TriggerAdapter plugins. Per-plugin overrides possible in plugin config.
- `seen_keys_ttl_ms` — How long to remember trigger idempotency keys.

**New field from Session 26:**
- `plugins` — Plugin lifecycle configuration (Decision #107): discovery paths, health check interval/timeout, failure threshold. See [`../plugins.md`](../plugins.md) § Plugin Lifecycle.
- `seen_keys_ttl_ms` — How long to remember trigger idempotency keys. Keys older than this are evicted from the in-memory `seen_trigger_keys` map (Decision #74, ephemeral.md).

---

## OrchestratorConfig

Loaded from `orchestrator.yaml`. Startup-only — not hot-reloadable.

Source: [`../../2-components/orchestrator.md`](../../2-components/orchestrator.md) § Configuration Schema (lines 876-939). 7 sections.

```typescript
// --- Fast-path (trivial task detection, Gap #1) ---

const FastPathConfigSchema = z.object({
  enabled: z.boolean().default(true),
  max_files: z.number().int().positive().default(2),
  skip_demo: z.boolean().default(true),
  max_estimated_minutes: z.number().int().positive().default(30),
});
type FastPathConfig = z.infer<typeof FastPathConfigSchema>;

// --- Notification cadence (Gaps #4, #15) ---

const QuietHoursConfigSchema = z.object({
  enabled: z.boolean().default(false),
  start: z.string().default("22:00"),             // HH:MM (time-of-day, not duration)
  end: z.string().default("08:00"),
  timezone: z.string().default("UTC"),
  allow_alerts: z.boolean().default(true),        // alert-urgency messages bypass quiet hours
});
type QuietHoursConfig = z.infer<typeof QuietHoursConfigSchema>;

const DigestConfigSchema = z.object({
  enabled: z.boolean().default(false),
  schedule: z.string().default("0 9 * * *"),      // cron expression
  channel: z.string().default("telegram"),
  include: z.array(z.string()).default(["completed", "blocked", "failed"]),
});
type DigestConfig = z.infer<typeof DigestConfigSchema>;

const NotificationConfigSchema = z.object({
  milestone_based: z.boolean().default(true),
  suppress_window_ms: z.number().int().positive().default(300_000),   // 5 min — dedup window
  batch_window_ms: z.number().int().positive().default(120_000),      // 2 min — batched message accumulation
  quiet_hours: QuietHoursConfigSchema.default({}),
  digest: DigestConfigSchema.default({}),
  fast_path_collapse: z.boolean().default(true),                      // collapse fast-path notifications into one message
});
type NotificationConfig = z.infer<typeof NotificationConfigSchema>;

// --- Question batching (Gap #18) ---

const QuestionBatchingConfigSchema = z.object({
  enabled: z.boolean().default(true),
  batch_window_ms: z.number().int().positive().default(30_000),      // 30 sec
  max_batch_size: z.number().int().positive().default(5),
});
type QuestionBatchingConfig = z.infer<typeof QuestionBatchingConfigSchema>;

// --- Task decomposition (Gap #23) ---

const DecompositionConfigSchema = z.object({
  auto_threshold_ms: z.number().int().positive().default(14_400_000),  // 4 hours — auto-decompose above this
  suggest_threshold_ms: z.number().int().positive().default(7_200_000),// 2 hours — suggest decomposition
  min_child_size_ms: z.number().int().positive().default(1_800_000),   // 30 min — smallest child task
});
type DecompositionConfig = z.infer<typeof DecompositionConfigSchema>;

// Note: decomposition approval_required is in SafetyConfig autonomy boundaries
// as "task_decomposition" category. Single source of truth.

// --- Demo artifacts (Gap #16) ---

const DemoConfigSchema = z.object({
  always_create: z.boolean().default(true),
  tui_base_project: z.string().nullable().default(null),             // path to base TUI project template
});
type DemoConfig = z.infer<typeof DemoConfigSchema>;

// --- Phase pipeline ---

const PhasesConfigSchema = z.object({
  checkpoint_on_transition: z.boolean().default(true),
  periodic_checkpoint_interval_ms: z.number().int().positive().default(900_000), // 15 min
  max_loopbacks_before_alert: z.number().int().positive().default(3),
});
type PhasesConfig = z.infer<typeof PhasesConfigSchema>;

// --- Journal ---

const JournalConfigSchema = z.object({
  aggregate_file_reads: z.boolean().default(true),        // collapse consecutive file reads into one entry
});
type JournalConfig = z.infer<typeof JournalConfigSchema>;

// --- Full OrchestratorConfig ---

const OrchestratorConfigSchema = z.object({
  fast_path: FastPathConfigSchema.default({}),
  notification: NotificationConfigSchema.default({}),
  question_batching: QuestionBatchingConfigSchema.default({}),
  decomposition: DecompositionConfigSchema.default({}),
  demo: DemoConfigSchema.default({}),
  phases: PhasesConfigSchema.default({}),
  journal: JournalConfigSchema.default({}),
});
type OrchestratorConfig = z.infer<typeof OrchestratorConfigSchema>;
```

### Field Mapping from L2

| L2 field (orchestrator.md) | Concrete schema field | Change |
|---|---|---|
| `fast_path.enabled` | `fast_path.enabled` | — |
| `fast_path.max_files` | `fast_path.max_files` | — |
| `fast_path.skip_demo` | `fast_path.skip_demo` | — |
| `fast_path.max_estimated_minutes` | `fast_path.max_estimated_minutes` | Kept as minutes (not ms) — this is an estimate threshold, not a duration |
| `notification.suppress_window` (duration) | `notification.suppress_window_ms` (int) | Duration → ms (Decision #86) |
| `notification.batch_window` (duration) | `notification.batch_window_ms` (int) | Duration → ms |
| `notification.quiet_hours.*` | `notification.quiet_hours.*` | start/end remain as HH:MM strings (time-of-day) |
| `notification.digest.*` | `notification.digest.*` | schedule is cron string |
| `notification.fast_path_collapse` | `notification.fast_path_collapse` | — |
| `question_batching.batch_window` (duration) | `question_batching.batch_window_ms` (int) | Duration → ms |
| `decomposition.auto_threshold` (duration) | `decomposition.auto_threshold_ms` (int) | Duration → ms |
| `decomposition.suggest_threshold` (duration) | `decomposition.suggest_threshold_ms` (int) | Duration → ms |
| `decomposition.min_child_size` (duration) | `decomposition.min_child_size_ms` (int) | Duration → ms |
| `demo.*` | `demo.*` | — |
| `phases.periodic_checkpoint_interval` (duration) | `phases.periodic_checkpoint_interval_ms` (int) | Duration → ms |
| `phases.*` (others) | `phases.*` | — |
| `journal.aggregate_file_reads` | `journal.aggregate_file_reads` | — |

---

## WorkspaceConfig

Loaded from `workspace.yaml`. Startup-only — not hot-reloadable.

Source: [`../../2-components/workspace-manager.md`](../../2-components/workspace-manager.md) § Configuration Schema (lines 536-572).

**Supersedes** the 6-field partial `WorkspaceConfigSchema` in [`ephemeral.md`](ephemeral.md). That schema was a subset — this is the complete design from L2.

```typescript
// --- PR defaults ---

const PrConfigSchema = z.object({
  default_merge_strategy: z.enum(["squash", "merge", "rebase"]).default("squash"),
  delete_branch_after_merge: z.boolean().default(true),
  branch_retention_days: z.number().int().positive().nullable().default(null), // null = delete immediately
});
type PrConfig = z.infer<typeof PrConfigSchema>;

// --- Cleanup ---

const CleanupConfigSchema = z.object({
  preserve_branch_on_failure: z.boolean().default(true),     // evidence preservation
  preserve_branch_on_cancel: z.boolean().default(false),
});
type CleanupConfig = z.infer<typeof CleanupConfigSchema>;

// --- Multi-repo ---

const MultiRepoConfigSchema = z.object({
  enabled: z.boolean().default(true),
  max_repos_per_task: z.number().int().positive().default(5),
});
type MultiRepoConfig = z.infer<typeof MultiRepoConfigSchema>;

// --- Full WorkspaceConfig ---

const WorkspaceConfigSchema = z.object({
  // Paths
  workspace_root: z.string().default("~/.engineer/workspaces/"),

  // Branch naming
  branch_prefix: z.string().default("engineer/"),
  slug_max_length: z.number().int().positive().default(30),

  // Git behavior
  fetch_before_create: z.boolean().default(true),
  default_base_branch: z.string().default("main"),

  // PR defaults
  pr: PrConfigSchema.default({}),

  // Cleanup
  cleanup: CleanupConfigSchema.default({}),

  // Child task PR strategy
  child_pr_strategy: z.enum(["merge_into_parent", "individual_prs"]).default("merge_into_parent"),

  // Multi-repo
  multi_repo: MultiRepoConfigSchema.default({}),
});
type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>;
```

### Changes from Session 24 Partial Schema

| Session 24 field | Action | Why |
|---|---|---|
| `workspace_root` | Kept | — |
| `branch_prefix` | Kept | — |
| `branch_pattern` | **Removed** | L2 uses implicit convention `{prefix}{issue_number}-{slug}`, not a configurable pattern |
| `cleanup_on_complete` | **Restructured** | Absorbed into `cleanup` sub-object as `preserve_branch_on_failure` / `preserve_branch_on_cancel` per L2 design |
| `keep_failed_branches` | **Restructured** | → `cleanup.preserve_branch_on_failure` |
| `branch_retention_days` | **Moved** | → `pr.branch_retention_days` (it's a post-merge concern) |

### New Fields from L2

| Field | Default | Source |
|---|---|---|
| `slug_max_length` | 30 | workspace-manager.md line 545 |
| `fetch_before_create` | true | workspace-manager.md line 548 |
| `default_base_branch` | "main" | workspace-manager.md line 549 |
| `pr.default_merge_strategy` | "squash" | workspace-manager.md line 553 |
| `pr.delete_branch_after_merge` | true | workspace-manager.md line 554 |
| `cleanup.preserve_branch_on_cancel` | false | workspace-manager.md line 561 |
| `child_pr_strategy` | "merge_into_parent" | workspace-manager.md line 565 |
| `multi_repo.enabled` | true | workspace-manager.md line 569 |
| `multi_repo.max_repos_per_task` | 5 | workspace-manager.md line 570 |

---

## SafetyConfig

Loaded from `safety.yaml`. **Hot-reloadable** — changes take effect without restart.

Already fully defined in [`ephemeral.md`](ephemeral.md) § Safety Config (Runtime). No changes needed. Reproduced here for reference only — `ephemeral.md` remains the source.

Five sections: `cost_limits` (CostLimitsSchema), `scope` (ScopeBoundariesSchema), `autonomy` (AutonomyBoundariesSchema), `response_timeout` (ResponseTimeoutSchema), `merge` (MergePolicySchema).

---

## PeopleDirectory

Loaded from `people.yaml`. **Hot-reloadable** — changes take effect without restart.

Already defined in [`adapters.md`](adapters.md) § People Directory (PersonSchema, ContactSchema, NotificationLevelSchema). No changes needed — `adapters.md` remains the source.

```yaml
# Example people.yaml
people:
  - id: farzam
    name: Farzam Mohammadi
    roles: [owner, reviewer]
    contacts:
      - channel: telegram
        handle: "@farzam"
      - channel: github
        handle: "farzam"
    preferences:
      notification_level: milestones
      quiet_hours: null
```

---

## Plugin Config

Per-plugin config files in `plugins/` subdirectory. Validated against the plugin's declared `config_schema` from its `PluginManifest` (see [`adapters.md`](adapters.md) § PluginManifestSchema).

Each plugin declares its config shape. The Registry validates user config against this shape at registration time.

```yaml
# Example plugins/github-trigger.yaml
repos:
  - owner: farzam
    name: my-app
    poll_interval: "30s"
  - owner: farzam
    name: another-repo
    poll_interval: "1m"

# Example plugins/claude-code-llm.yaml
provider: claude
model: claude-sonnet-4-20250514
max_tokens: 8192
```

Plugin config schemas are not defined here — they're defined by each plugin and validated at runtime by the Registry. This is by design: plugins own their config shape.

---

## Config File Summary

| File | Schema Source | Hot-Reloadable | Owner |
|------|-------------|----------------|-------|
| `daemon.yaml` | `DaemonConfigSchema` (this file) | No | Daemon |
| `orchestrator.yaml` | `OrchestratorConfigSchema` (this file) | No | Orchestrator |
| `safety.yaml` | `SafetyConfigSchema` ([ephemeral.md](ephemeral.md)) | Yes | Safety Layer |
| `workspace.yaml` | `WorkspaceConfigSchema` (this file) | No | Workspace Manager |
| `people.yaml` | `PersonSchema[]` ([adapters.md](adapters.md)) | Yes | People Directory |
| `plugins/*.yaml` | Per-plugin `config_schema` | No | Registry + Plugin |
