// ── Core Config Templates ────────────────────────────────────────────────────
// Default YAML configs written to ~/.engineer/config/ on first-run setup.
// Source-of-truth for shipped defaults — edit here, not the generated files.

export const DAEMON_TEMPLATE = `# Daemon configuration for The Engineer
# All fields are optional — defaults shown as comments
# Duration fields accept human-readable strings: "5s", "30m", "8h", "1d"

# --- Capacity ---
# max_concurrent: 1                   # Concurrent tasks (default: 1). Increase only after testing stability.

# --- Tick loop ---
# tick_interval_ms: "5s"              # Main loop tick interval (default: 5s)

# --- Preemption (swap a running task for a higher-priority one) ---
# preemption_threshold: 20            # Min priority gap to trigger preemption (p70 preempts p50, but not p55)
# preemption_timeout_ms: "1m"         # Grace period to checkpoint before forced swap (default: 1m)

# --- Stuck/runaway detection (auto-flag tasks that seem hung) ---
# stuck_threshold_ms: "30m"           # No progress for this long → flag as stuck (default: 30m)
# max_active_duration_ms: "8h"        # Hard cap on total task runtime (default: 8h)

# --- Shutdown ---
# shutdown_timeout_ms: "30s"          # Time to drain active tasks on shutdown (default: 30s)

# --- Retry policy (per-category backoff for task-level retries) ---
# retry_policy:
#   crash:
#     backoff_minutes: [1, 5, 15, 30, 30]  # Backoff schedule in minutes
#     max_attempts: 5                       # Terminal after this many crashes
#   agent_unavailable:
#     backoff_minutes: [2, 5, 10, 15, 15]  # Backoff schedule in minutes
#     max_attempts: 5                       # Terminal after this many unavailability cycles

# --- Trigger polling ---
# trigger_poll_interval_ms: "30s"     # How often to poll triggers (default: 30s)
# response_poll_interval_ms: "5s"     # How often to poll responses (default: 5s)
# seen_keys_ttl_ms: "1d"              # How long to remember trigger events for dedup (default: 1d)

# --- Logging ---
# logging:
#   level: info                       # trace | debug | info | warn | error | fatal
#   dir: logs                         # Relative to ENGINEER_HOME (~/.engineer/) or absolute
#   max_size_bytes: 524288000         # 500 MB per file
#   max_files: 7                      # 7-day retention
#   console: false                    # Also log to stdout

# --- Plugin lifecycle ---
# plugins:
#   dirs:
#     - ~/.engineer/plugins            # Plugin discovery directories (auto-populated by engineer start)
#   health_check_interval_ms: "1m"    # How often to health-check plugins (default: 1m)
#   health_check_timeout_ms: "5s"     # Timeout per health check (default: 5s)
#   consecutive_failures_threshold: 3  # Failures before marking plugin as failed

# --- Data lifecycle (automatic cleanup) ---
# data_lifecycle:
#   enabled: true                      # Enable automatic data cleanup (default: true)
#   interval_ms: "1h"                  # Cleanup check interval (default: 1h)
#   retention:
#     events:
#       max_age_days: 90               # Event retention in days (default: 90)
#     observations:
#       max_age_days: 90
#     journal_entries:
#       max_age_days: 90
#     checkpoints:
#       max_age_days: 90

# --- Database tuning ---
# database:
#   cache_size_mb: 64                  # SQLite cache size in MB (default: 64)

# --- Event bus ---
# subscriber_warn_threshold_ms: 50    # Warn if a subscriber callback takes longer than this (default: 50)

# --- Review polling (circuit breaker for git hosting API failures) ---
# review_polling:
#   failure_window_ms: "5m"              # Time window for failure counting (default: 5m)
#   max_failures_before_pause: 3         # Failures in window before pausing polling (default: 3)

# --- AI-as-Judge evaluation ---
# evaluation:
#   enabled: false                       # Run independent evaluation after each task (default: false)
#                                        # Two CLI sessions: blind plan + comparison verdict
#                                        # Results at ~/.engineer/evaluations/
`;

export const ORCHESTRATOR_TEMPLATE = `# Orchestrator configuration for The Engineer
# All fields are optional — defaults shown as comments
# Duration fields accept human-readable strings: "5s", "30m", "8h", "1d"

# --- Notifications ---
# notification:
#   milestone_based: true             # Notify only on milestones (not every step)
#   suppress_window_ms: "5m"          # Suppress duplicate notifications (default: 5m)
#   batch_window_ms: "2m"             # Batch rapid notifications (default: 2m)
#   quiet_hours:
#     enabled: false
#     start: "22:00"
#     end: "08:00"
#     timezone: UTC
#     allow_alerts: true
#   digest:
#     enabled: false
#     schedule: "0 9 * * *"
#     channel: telegram
#     include: [completed, blocked, failed]

# --- Question batching ---
# question_batching:
#   enabled: true
#   batch_window_ms: "30s"            # Batch questions before asking (default: 30s)
#   max_batch_size: 5

# --- Demo gate ---
# demo:
#   always_create: true               # Always create demo artifact
#   tui_base_project: null            # Base project for TUI demos

# --- Phase pipeline ---
# phases:
#   checkpoint_on_transition: true    # Checkpoint on every phase transition
#   periodic_checkpoint_interval_ms: "15m"  # Periodic checkpoints (default: 15m)
#   max_loopbacks_before_alert: 3     # Alert after N phase loopbacks

# --- Journal ---
# journal:
#   aggregate_file_reads: true        # Aggregate file read entries
`;

export const SAFETY_TEMPLATE = `# Safety configuration for The Engineer
# Changes take effect on the next daemon restart.
# All fields are optional — conservative defaults applied when missing.
# Duration fields accept human-readable strings: "5s", "30m", "8h", "1d"

# --- Cost limits ---
# Uncomment and adjust to prevent runaway spending.
cost_limits:
  api:
    per_task:
      cost_usd: 5.0                   # Per-task USD limit (null = unlimited)
    daily:
      cost_usd: 25.0                  # Daily USD limit
    monthly:
      cost_usd: 250.0                 # Monthly USD limit
#   cli: {}                           # Per-CLI-provider limits (keyed by plugin ID, e.g. "claude-code-agent")

# --- Scope boundaries ---
# scope:
#   repos:
#     allowed: null                   # null = all repos allowed
#   branches:
#     create_pattern: "engineer/.*"   # Branch name pattern for created branches
#     push_to: ["engineer/*"]         # Allowed push targets
#     merge_to: ["main"]             # Allowed merge targets
#   files:
#     exclude_patterns:               # Files never touched
#       - ".env*"
#       - "secrets/**"
#       - "*.pem"
#       - "*.key"
#   external:
#     allowed_domains: null           # null = all domains allowed

# --- Autonomy ---
# autonomy:
#   decisions: {}                     # Per-category overrides (keys are free-form, e.g. "code_style")
#   repo_overrides: {}                # Per-repo overrides

# --- Response timeouts ---
# response_timeout:
#   blocked:
#     stages:
#       - name: reminder
#         after_ms: "4h"
#         action: send_reminder
#         repeat: true
#         repeat_interval_ms: "4h"
#       - name: self_unblock_check
#         after_ms: "8h"
#         action: evaluate_self_unblock
#       - name: escalation
#         after_ms: "2d"
#         action: escalation_alert
#   review_pending:
#     reminder_after_ms: "1d"
#     repeat_interval_ms: "1d"

# --- Merge policy ---
# merge:
#   auto_merge_after_approval:
#     default: false                  # Don't auto-merge by default
#     repos: {}                       # Per-repo overrides: { "owner/repo": true }
#   enable_comment_approval: false    # Allow /approve PR comments as approval (solo-dev workflow)
#   exclude_thoughts_on_merge: false  # Remove thoughts/ from branch before merge
`;

export const WORKSPACE_TEMPLATE = `# Workspace configuration for The Engineer
# All fields are optional — defaults shown as comments

# workspace_root: "~/.engineer/workspaces/"  # Where git worktrees are created
# branch_prefix: "engineer/"                 # Prefix for created branches
# slug_max_length: 30                        # Max length for branch slug
# default_base_branch: main                  # Default base branch for PRs

# --- PR settings ---
# pr:
#   default_merge_strategy: squash           # squash | merge | rebase
#   delete_branch_after_merge: true
#   branch_retention_days: null              # Days to retain branches after merge. null = preserve indefinitely.

# --- Cleanup ---
# cleanup:
#   preserve_branch_on_failure: true
#   preserve_branch_on_cancel: false

# --- Multi-repo ---
# multi_repo:
#   enabled: true
#   max_repos_per_task: 5
`;

export const PEOPLE_TEMPLATE = `# People configuration for The Engineer
# Changes take effect on the next daemon restart.
# Defines contacts for communication (questions, notifications, reviews).

people:
  - id: owner                              # <-- replace with your identifier
    name: Your Name                        # <-- replace
    roles: [owner]
    contacts:
      - channel: telegram
        handle: "your_telegram_username"   # <-- replace
      - channel: github
        handle: "your-github-username"     # <-- replace
    preferences:
      notification_level: milestones       # all | milestones | critical
      quiet_hours: null                    # or: { start: "22:00", end: "08:00" }
`;

// ── Plugin Config Templates ─────────────────────────────────────────────────

export const GITHUB_TRIGGER_TEMPLATE = `# GitHub Issues trigger plugin
# Polls GitHub Issues API for open issues

repos:
  - owner: your-github-username            # <-- replace
    name: your-repo-name                   # <-- replace

github_token: "\${GITHUB_TOKEN}"           # <-- set env var

# Work selection defaults to labels: ["engineer"]. Override below to customize.
# labels: ["engineer", "bug"]              # only trigger on issues with these labels
# assignee: "your-github-username"         # only trigger on issues assigned to this user
#   (to select by assignee ONLY, set labels: [] alongside assignee)
`;

export const TELEGRAM_COMM_TEMPLATE = `# Telegram communication plugin
# Sends notifications and receives commands via Telegram bot
# Chat IDs are resolved automatically via /start handshake — no TELEGRAM_CHAT_ID needed.

bot_token: "\${TELEGRAM_BOT_TOKEN}"        # <-- set env var

# --- Optional settings ---
# parse_mode: MarkdownV2                  # MarkdownV2 | Markdown | HTML
# disable_link_preview: true
`;

export const GITHUB_COMM_TEMPLATE = `# GitHub communication plugin
# Comments on issues and PRs, manages labels

github_token: "\${GITHUB_TOKEN}"           # <-- set env var

# --- Optional settings ---
# label_prefix: "engineer:"              # Prefix for issue labels (default: "engineer:")
`;

export const GITHUB_HOSTING_TEMPLATE = `# GitHub git hosting plugin
# Creates PRs, manages branches, handles reviews

github_token: "\${GITHUB_TOKEN}"           # <-- set env var

# --- Optional settings ---
# default_merge_strategy: squash          # squash | merge | rebase (default: squash)
`;

export const CLAUDE_CODE_AGENT_TEMPLATE = `# Claude Code agent plugin
# Drives the Claude Code CLI as an autonomous coding agent

# model: claude-sonnet-4-6              # Model to use
# cli_path: claude                        # Path to claude CLI binary
`;

export const OPENCODE_AGENT_TEMPLATE = `# OpenCode agent plugin
# Multi-provider autonomous coding agent via OpenCode CLI
# Supports Anthropic, OpenAI, Google, and more — configure model as provider/model

# model: opencode/gemini-3.1-pro             # Model in provider/model format
# cli_path: opencode                         # Path to opencode CLI binary
`;

export const GEMINI_CLI_AGENT_TEMPLATE = `# Gemini CLI agent plugin
# Drives Google's Gemini CLI as an autonomous coding agent
# Free tier — no cost tracking (cost_usd always null)

# model: gemini-2.5-pro                      # Model to use
# cli_path: gemini                           # Path to gemini CLI binary
`;

// ── Example Templates (fully documented reference files) ─────────────────────
// Like .env.example — every field visible, documented, with defaults and valid options.
// Written to ~/.engineer/example-templates/ during first-run setup.

export const EXAMPLE_DAEMON = `# ┌─────────────────────────────────────────────────────────────────────────────┐
# │  DAEMON CONFIGURATION — Full Reference                                    │
# │  Copy to ~/.engineer/config/daemon.yaml and customize.                    │
# │  All fields are optional — defaults are applied automatically.            │
# │  Duration fields accept human-readable strings: "5s", "30m", "8h", "1d"  │
# └─────────────────────────────────────────────────────────────────────────────┘

# ── Capacity ──────────────────────────────────────────────────────────────────
max_concurrent: 1                         # Concurrent tasks (default: 1). Increase only after testing stability.

# ── Tick Loop ─────────────────────────────────────────────────────────────────
tick_interval_ms: "5s"                    # Main loop interval (default: 5s)

# ── Preemption ────────────────────────────────────────────────────────────────
preemption_threshold: 20                  # Min priority gap to preempt (p70 preempts p50, but not p55)
preemption_timeout_ms: "1m"               # Time to checkpoint before forced swap (default: 1m)

# ── Stuck/Runaway Detection ──────────────────────────────────────────────────
stuck_threshold_ms: "30m"                 # Flag task as stuck (default: 30m)
max_active_duration_ms: "8h"              # Kill task after this duration (default: 8h)

# ── Shutdown ──────────────────────────────────────────────────────────────────
shutdown_timeout_ms: "30s"                # Drain timeout on SIGTERM (default: 30s)

# ── Retry Policy (per-category backoff for task-level retries) ──────────────
retry_policy:
  crash:                                  # Orchestrator crash retries
    backoff_minutes: [1, 5, 15, 30, 30]   # Backoff schedule in minutes (default: [1, 5, 15, 30, 30])
    max_attempts: 5                       # Terminal after this many crashes (default: 5)
  agent_unavailable:                      # Agent adapter unavailability retries
    backoff_minutes: [2, 5, 10, 15, 15]   # Backoff schedule in minutes (default: [2, 5, 10, 15, 15])
    max_attempts: 5                       # Terminal after this many unavailability cycles (default: 5)

# ── Trigger Polling ──────────────────────────────────────────────────────────
trigger_poll_interval_ms: "30s"           # How often to poll triggers (default: 30s)
response_poll_interval_ms: "5s"           # How often to poll responses (default: 5s)
seen_keys_ttl_ms: "1d"                    # Dedup key TTL (default: 1d)

# ── Logging ──────────────────────────────────────────────────────────────────
logging:
  level: info                             # trace | debug | info | warn | error | fatal (default: info)
  dir: logs                               # Relative to ENGINEER_HOME (~/.engineer/) or absolute (default: logs)
  max_size_bytes: 524288000               # Max log file size — 500 MB (default: 524288000)
  max_files: 7                            # Rolling file count — 7 days (default: 7)
  console: false                          # Also log to stdout (default: false)

# ── Plugin Lifecycle ─────────────────────────────────────────────────────────
plugins:
  dirs: []                                  # Additional plugin directories (default: [], ~/.engineer/plugins/ always scanned)
  health_check_interval_ms: "1m"          # Health check frequency (default: 1m)
  health_check_timeout_ms: "5s"           # Timeout per health check (default: 5s)
  consecutive_failures_threshold: 3       # Failures before marking failed (default: 3)

# ── Data Lifecycle (automatic cleanup) ──────────────────────────────────────
data_lifecycle:
  enabled: true                           # Enable automatic data cleanup (default: true)
  interval_ms: "1h"                       # Cleanup check interval (default: 1h)
  retention:
    events:
      max_age_days: 90                    # Event retention in days (default: 90)
    observations:
      max_age_days: 90                    # Observation retention in days (default: 90)
    journal_entries:
      max_age_days: 90                    # Journal retention in days (default: 90)
    checkpoints:
      max_age_days: 90                    # Checkpoint retention in days (default: 90)

# ── Database Tuning ─────────────────────────────────────────────────────────
database:
  cache_size_mb: 64                       # SQLite cache size in MB (default: 64)

# ── Event Bus ───────────────────────────────────────────────────────────────
subscriber_warn_threshold_ms: 50          # Warn if a subscriber callback exceeds this (ms). 0 = disabled. (default: 50)

# ── Review Polling (circuit breaker for git hosting API failures) ───────────
review_polling:
  failure_window_ms: "5m"                 # Time window for failure counting (default: 5m)
  max_failures_before_pause: 3            # Failures in window before pausing polling (default: 3)

# ── AI-as-Judge Evaluation ──────────────────────────────────────────────────
# Run an independent evaluation after each task completes. Two CLI sessions:
# Session 1 (blind plan): given only the ticket, plans how it would approach the task.
# Session 2 (comparison): compares its blind plan against The Engineer's actual output.
# Results stored at ~/.engineer/evaluations/{task-id}/
evaluation:
  enabled: false                            # Enable evaluation (default: false). Turn on to measure quality.
`;

export const EXAMPLE_ORCHESTRATOR = `# ┌─────────────────────────────────────────────────────────────────────────────┐
# │  ORCHESTRATOR CONFIGURATION — Full Reference                              │
# │  Copy to ~/.engineer/config/orchestrator.yaml and customize.              │
# │  All fields are optional — defaults are applied automatically.            │
# │  Duration fields accept human-readable strings: "5s", "30m", "8h", "1d"  │
# └─────────────────────────────────────────────────────────────────────────────┘

# ── Notifications ────────────────────────────────────────────────────────────
notification:
  milestone_based: true                   # Notify only on milestones (default: true)
  suppress_window_ms: "5m"                # Suppress duplicate notifications (default: 5m)
  batch_window_ms: "2m"                   # Batch rapid notifications (default: 2m)
  quiet_hours:
    enabled: false                        # Enable quiet hours (default: false)
    start: "22:00"                        # Quiet period start time (default: "22:00")
    end: "08:00"                          # Quiet period end time (default: "08:00")
    timezone: UTC                         # Timezone for quiet hours (default: UTC)
    allow_alerts: true                    # Allow critical alerts during quiet hours (default: true)
  digest:
    enabled: false                        # Enable digest summaries (default: false)
    schedule: "0 9 * * *"                 # Cron schedule for digest (default: "0 9 * * *")
    channel: telegram                     # Channel for digest delivery (default: telegram)
    include:                              # Task states to include in digest
      - completed                         # (default: [completed, blocked, failed])
      - blocked
      - failed

# ── Question Batching ───────────────────────────────────────────────────────
question_batching:
  enabled: true                           # Batch questions before asking (default: true)
  batch_window_ms: "30s"                  # Batch window (default: 30s)
  max_batch_size: 5                       # Max questions per batch (default: 5)

# ── Demo Gate ────────────────────────────────────────────────────────────────
demo:
  always_create: true                     # Always create demo artifact (default: true)
  tui_base_project: null                  # Base project for TUI demos (default: null)

# ── Phase Pipeline ───────────────────────────────────────────────────────────
phases:
  checkpoint_on_transition: true          # Checkpoint on every phase transition (default: true)
  periodic_checkpoint_interval_ms: "15m"  # Periodic checkpoint interval (default: 15m)
  max_loopbacks_before_alert: 3           # Alert after N phase loopbacks (default: 3)

# ── Journal ──────────────────────────────────────────────────────────────────
journal:
  aggregate_file_reads: true              # Aggregate file read journal entries (default: true)
`;

export const EXAMPLE_SAFETY = `# ┌─────────────────────────────────────────────────────────────────────────────┐
# │  SAFETY CONFIGURATION — Full Reference                                    │
# │  Copy to ~/.engineer/config/safety.yaml and customize.                    │
# │  Changes take effect on the next daemon restart.                          │
# │  All fields are optional — conservative defaults applied.                 │
# │  Duration fields accept human-readable strings: "5s", "30m", "8h", "1d"  │
# └─────────────────────────────────────────────────────────────────────────────┘

# ── Cost Limits ──────────────────────────────────────────────────────────────
cost_limits:
  api:
    per_task:
      cost_usd: 5.0                       # Per-task USD limit, null = unlimited (default: null)
    daily:
      cost_usd: 25.0                      # Daily USD limit (default: null)
    monthly:
      cost_usd: 250.0                     # Monthly USD limit (default: null)
  cli: {}                                 # Per-CLI-provider limits, keyed by plugin ID (e.g. "claude-code-agent")

# ── Scope Boundaries ────────────────────────────────────────────────────────
scope:
  repos:
    allowed: null                         # Allowed repos, null = all (default: null)
  branches:
    create_pattern: "engineer/.*"         # Regex for created branch names (default: "engineer/.*")
    push_to:                              # Allowed push targets (default: ["engineer/*"])
      - "engineer/*"
    merge_to:                             # Allowed merge targets (default: ["main"])
      - "main"
  files:
    exclude_patterns:                     # Files never touched (default list shown)
      - ".env*"
      - "secrets/**"
      - "*.pem"
      - "*.key"
  external:
    allowed_domains: null                 # Allowed external domains, null = all (default: null)

# ── Autonomy ─────────────────────────────────────────────────────────────────
# Per-category autonomy levels. Keys are free-form names (e.g. "code_style", "architecture").
# Each decision can be: always_ask | threshold | always_decide
autonomy:
  decisions: {}                           # Per-category overrides; unknown keys default to always_ask
  repo_overrides: {}                      # Per-repo autonomy overrides (default: {})

# ── Response Timeouts ────────────────────────────────────────────────────────
response_timeout:
  blocked:
    stages:
      - name: reminder
        after_ms: "4h"                    # Send reminder after 4 hours
        action: send_reminder
        repeat: true
        repeat_interval_ms: "4h"          # Repeat every 4 hours
      - name: self_unblock_check
        after_ms: "8h"                    # Try self-unblock after 8 hours
        action: evaluate_self_unblock
      - name: escalation
        after_ms: "2d"                    # Escalate after 48 hours
        action: escalation_alert
  review_pending:
    reminder_after_ms: "1d"               # Remind after 24 hours (default: 1d)
    repeat_interval_ms: "1d"              # Repeat every 24 hours (default: 1d)

# ── Merge Policy ─────────────────────────────────────────────────────────────
merge:
  auto_merge_after_approval:
    default: false                        # Auto-merge PRs after approval (default: false)
    repos: {}                             # Per-repo overrides, e.g.:
    # repos:
    #   owner/internal-docs: true         # Auto-merge for low-risk repos
  enable_comment_approval: false          # Allow /approve PR comments as approval (solo-dev workflow)
  exclude_thoughts_on_merge: false        # Remove thoughts/ from branch before merge
`;

export const EXAMPLE_WORKSPACE = `# ┌─────────────────────────────────────────────────────────────────────────────┐
# │  WORKSPACE CONFIGURATION — Full Reference                                 │
# │  Copy to ~/.engineer/config/workspace.yaml and customize.                 │
# │  All fields are optional — defaults are applied automatically.            │
# └─────────────────────────────────────────────────────────────────────────────┘

workspace_root: "~/.engineer/workspaces/" # Where git worktrees are created (default: "~/.engineer/workspaces/")
branch_prefix: "engineer/"                # Prefix for created branches (default: "engineer/")
slug_max_length: 30                       # Max length for branch slug (default: 30)
default_base_branch: main                 # Default base branch for PRs (default: main)

# ── PR Settings ──────────────────────────────────────────────────────────────
pr:
  default_merge_strategy: squash          # squash | merge | rebase (default: squash)
  delete_branch_after_merge: true         # Delete branch after PR merge (default: true)
  branch_retention_days: null             # Days to retain branches after merge. null = preserve indefinitely (default: null).

# ── Cleanup ──────────────────────────────────────────────────────────────────
cleanup:
  preserve_branch_on_failure: true        # Keep branch when task fails (default: true)
  preserve_branch_on_cancel: false        # Keep branch when task cancelled (default: false)

# ── Multi-Repo ───────────────────────────────────────────────────────────────
multi_repo:
  enabled: true                           # Enable multi-repo tasks (default: true)
  max_repos_per_task: 5                   # Max repos per task (default: 5)
`;

export const EXAMPLE_PEOPLE = `# ┌─────────────────────────────────────────────────────────────────────────────┐
# │  PEOPLE CONFIGURATION — Full Reference                                    │
# │  Copy to ~/.engineer/config/people.yaml and customize.                    │
# │  Changes take effect on the next daemon restart.                          │
# │  Defines contacts for communication (questions, notifications, reviews).  │
# └─────────────────────────────────────────────────────────────────────────────┘

people:
  - id: farzam                            # REQUIRED — unique identifier
    name: Farzam Mohammadi                # REQUIRED — display name
    roles:                                # REQUIRED — at least one role
      - owner                             #   owner | reviewer (reviewer = /approve only, no outreach)
    contacts:                             # REQUIRED — at least one contact
      - channel: telegram                 #   REQUIRED — channel name
        handle: "farzam_tg"               #   REQUIRED — handle on that channel
      - channel: github
        handle: "FarzamMohammadi"
    preferences:                          # optional — defaults shown below
      notification_level: milestones      #   all | milestones | critical (default: milestones)
      quiet_hours: null                   #   null or: { start: "22:00", end: "08:00" }

# v1 is single-user: The Engineer reaches only the owner. The schema accepts more
# entries, but extra people are never contacted — a startup/doctor warning fires when
# more than one is configured. The "reviewer" role grants /approve authorization
# without outreach. See docs/constraints.md.
`;

export const EXAMPLE_GITHUB_TRIGGER = `# ┌─────────────────────────────────────────────────────────────────────────────┐
# │  GITHUB TRIGGER PLUGIN — Full Reference                                   │
# │  Copy to ~/.engineer/config/plugins/github-trigger.yaml and customize.    │
# │  Polls GitHub Issues API for new and assigned issues.                     │
# └─────────────────────────────────────────────────────────────────────────────┘

repos:                                    # REQUIRED — at least one repo to watch
  - owner: FarzamMohammadi                # REQUIRED — GitHub username or org
    name: my-project                      # REQUIRED — repository name

github_token: "\${GITHUB_TOKEN}"           # REQUIRED — GitHub personal access token (env var)

# ── Work selection — defaults to labels: ["engineer"] ────────────────────────
# labels: ["engineer", "bug"]             # trigger only on issues with these labels
# assignee: "the-engineer-bot"            # trigger only on issues assigned to this user
#   (to select by assignee ONLY, set labels: [] alongside assignee)
# Poll cadence is set on the plugin manifest (poll_interval_ms), not here.
`;

export const EXAMPLE_TELEGRAM_COMM = `# ┌─────────────────────────────────────────────────────────────────────────────┐
# │  TELEGRAM COMMUNICATION PLUGIN — Full Reference                           │
# │  Copy to ~/.engineer/config/plugins/telegram-comm.yaml and customize.     │
# │  Sends notifications via Telegram bot.                                    │
# │  Chat IDs resolved automatically via /start handshake.                    │
# └─────────────────────────────────────────────────────────────────────────────┘

bot_token: "\${TELEGRAM_BOT_TOKEN}"        # REQUIRED — Telegram bot token (env var)
# No TELEGRAM_CHAT_ID needed — each user sends /start to the bot,
# and the plugin captures the username → chat_id mapping automatically.

# ── Optional Settings ────────────────────────────────────────────────────────
parse_mode: MarkdownV2                    # MarkdownV2 | Markdown | HTML (default: MarkdownV2)
disable_link_preview: true                # Disable link previews (default: true)
`;

export const EXAMPLE_GITHUB_COMM = `# ┌─────────────────────────────────────────────────────────────────────────────┐
# │  GITHUB COMMUNICATION PLUGIN — Full Reference                            │
# │  Copy to ~/.engineer/config/plugins/github-comm.yaml and customize.      │
# │  Comments on issues and PRs, manages labels.                             │
# └─────────────────────────────────────────────────────────────────────────────┘

github_token: "\${GITHUB_TOKEN}"           # REQUIRED — GitHub personal access token (env var)

# ── Optional Settings ────────────────────────────────────────────────────────
label_prefix: "engineer:"                 # Prefix for issue labels (default: "engineer:")
`;

export const EXAMPLE_GITHUB_HOSTING = `# ┌─────────────────────────────────────────────────────────────────────────────┐
# │  GITHUB GIT HOSTING PLUGIN — Full Reference                              │
# │  Copy to ~/.engineer/config/plugins/github-hosting.yaml and customize.   │
# │  Creates PRs, manages branches, handles reviews.                         │
# └─────────────────────────────────────────────────────────────────────────────┘

github_token: "\${GITHUB_TOKEN}"           # REQUIRED — GitHub personal access token (env var)

# ── Optional Settings ────────────────────────────────────────────────────────
default_merge_strategy: squash            # squash | merge | rebase (default: squash)
`;

export const EXAMPLE_CLAUDE_CODE_AGENT = `# ┌─────────────────────────────────────────────────────────────────────────────┐
# │  CLAUDE CODE AGENT PLUGIN — Full Reference                               │
# │  Copy to ~/.engineer/config/plugins/claude-code-agent.yaml and customize.│
# │  Drives the Claude Code CLI as an autonomous coding agent.               │
# └─────────────────────────────────────────────────────────────────────────────┘

# All fields are optional — defaults shown below.
model: claude-sonnet-4-6                # Model to use (default: claude-sonnet-4-6)
cli_path: claude                          # Path to claude CLI binary (default: claude)
`;

export const EXAMPLE_OPENCODE_AGENT = `# ┌─────────────────────────────────────────────────────────────────────────────┐
# │  OPENCODE AGENT PLUGIN — Full Reference                                  │
# │  Copy to ~/.engineer/config/plugins/opencode-agent.yaml and customize.   │
# │  Multi-provider agent via OpenCode CLI (Anthropic, OpenAI, Google, etc.) │
# └─────────────────────────────────────────────────────────────────────────────┘

# All fields are optional — defaults shown below.
model: opencode/gemini-3.1-pro             # Model in provider/model format (default: opencode/gemini-3.1-pro)
cli_path: opencode                         # Path to opencode CLI binary (default: opencode)
`;

export const EXAMPLE_GEMINI_CLI_AGENT = `# ┌─────────────────────────────────────────────────────────────────────────────┐
# │  GEMINI CLI AGENT PLUGIN — Full Reference                                │
# │  Copy to ~/.engineer/config/plugins/gemini-cli-agent.yaml and customize. │
# │  Drives Google's Gemini CLI as an autonomous coding agent (free tier).   │
# └─────────────────────────────────────────────────────────────────────────────┘

# All fields are optional — defaults shown below.
model: gemini-2.5-pro                       # Model to use (default: gemini-2.5-pro)
cli_path: gemini                            # Path to gemini CLI binary (default: gemini)
`;

// ── Template Manifest ───────────────────────────────────────────────────────

/** A bundled template — relative path under ENGINEER_HOME and the file content to write. */
export interface TemplateFile {
  readonly relativePath: string;
  readonly content: string;
}

/** All template files in the order they should be created. */
export const ALL_TEMPLATES: readonly TemplateFile[] = [
  // Core configs
  { relativePath: "config/daemon.yaml", content: DAEMON_TEMPLATE },
  { relativePath: "config/orchestrator.yaml", content: ORCHESTRATOR_TEMPLATE },
  { relativePath: "config/safety.yaml", content: SAFETY_TEMPLATE },
  { relativePath: "config/workspace.yaml", content: WORKSPACE_TEMPLATE },
  { relativePath: "config/people.yaml", content: PEOPLE_TEMPLATE },
  // Plugin configs
  { relativePath: "config/plugins/github-trigger.yaml", content: GITHUB_TRIGGER_TEMPLATE },
  { relativePath: "config/plugins/telegram-comm.yaml", content: TELEGRAM_COMM_TEMPLATE },
  { relativePath: "config/plugins/github-comm.yaml", content: GITHUB_COMM_TEMPLATE },
  { relativePath: "config/plugins/github-hosting.yaml", content: GITHUB_HOSTING_TEMPLATE },
  { relativePath: "config/plugins/claude-code-agent.yaml", content: CLAUDE_CODE_AGENT_TEMPLATE },
  { relativePath: "config/plugins/opencode-agent.yaml", content: OPENCODE_AGENT_TEMPLATE },
  { relativePath: "config/plugins/gemini-cli-agent.yaml", content: GEMINI_CLI_AGENT_TEMPLATE },
];

/** Fully documented example templates — written to ~/.engineer/example-templates/. */
export const ALL_EXAMPLE_TEMPLATES: readonly TemplateFile[] = [
  { relativePath: "example-templates/daemon.yaml", content: EXAMPLE_DAEMON },
  { relativePath: "example-templates/orchestrator.yaml", content: EXAMPLE_ORCHESTRATOR },
  { relativePath: "example-templates/safety.yaml", content: EXAMPLE_SAFETY },
  { relativePath: "example-templates/workspace.yaml", content: EXAMPLE_WORKSPACE },
  { relativePath: "example-templates/people.yaml", content: EXAMPLE_PEOPLE },
  { relativePath: "example-templates/github-trigger.yaml", content: EXAMPLE_GITHUB_TRIGGER },
  { relativePath: "example-templates/telegram-comm.yaml", content: EXAMPLE_TELEGRAM_COMM },
  { relativePath: "example-templates/github-comm.yaml", content: EXAMPLE_GITHUB_COMM },
  { relativePath: "example-templates/github-hosting.yaml", content: EXAMPLE_GITHUB_HOSTING },
  { relativePath: "example-templates/claude-code-agent.yaml", content: EXAMPLE_CLAUDE_CODE_AGENT },
  { relativePath: "example-templates/opencode-agent.yaml", content: EXAMPLE_OPENCODE_AGENT },
  { relativePath: "example-templates/gemini-cli-agent.yaml", content: EXAMPLE_GEMINI_CLI_AGENT },
];
