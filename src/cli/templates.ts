// ── Core Config Templates ────────────────────────────────────────────────────

export const DAEMON_TEMPLATE = `# Daemon configuration for The Engineer
# All fields are optional — defaults shown as comments

# --- Capacity ---
# max_concurrent: 1                   # Number of concurrent tasks (default: 1)

# --- Tick loop ---
# tick_interval_ms: 5000              # Main loop tick interval in ms

# --- Preemption ---
# preemption_threshold: 20            # Priority gap to trigger preemption
# preemption_timeout_ms: 60000        # Time to checkpoint before forced swap (ms)

# --- Stuck/runaway detection ---
# stuck_threshold_ms: 1800000         # 30 min — flag task as stuck
# max_active_duration_ms: 28800000    # 8 hours — max time for a single task

# --- Priority aging (starvation prevention) ---
# aging_threshold_ms: 86400000        # 24 hours before aging kicks in
# aging_increment: 5                  # Priority bump per aging interval
# aging_interval_ms: 86400000         # How often to age (24 hours)
# aging_cap: 75                       # Maximum priority after aging (1-100)

# --- Shutdown ---
# shutdown_timeout_ms: 30000          # Time to drain active tasks on shutdown

# --- Trigger polling ---
# trigger_poll_interval_ms: 30000     # How often to poll triggers
# seen_keys_ttl_ms: 86400000          # TTL for dedup keys (24 hours)

# --- Logging ---
# logging:
#   level: info                       # trace | debug | info | warn | error | fatal
#   dir: logs                         # Relative to ENGINEER_HOME or absolute
#   max_size_bytes: 524288000         # 500 MB per file
#   max_files: 7                      # 7-day retention
#   console: false                    # Also log to stdout

# --- Plugin lifecycle ---
# plugins:
#   dirs:
#     - src/plugins                   # Plugin discovery directories
#   health_check_interval_ms: 60000   # How often to health-check plugins
#   health_check_timeout_ms: 5000     # Timeout per health check
#   consecutive_failures_threshold: 3  # Failures before marking plugin as failed
`;

export const ORCHESTRATOR_TEMPLATE = `# Orchestrator configuration for The Engineer
# All fields are optional — defaults shown as comments

# --- Fast path (trivial task shortcut) ---
# fast_path:
#   enabled: true                     # Enable fast-path for trivial tasks
#   max_files: 2                      # Max files changed to qualify
#   skip_demo: true                   # Skip demo prep for fast-path tasks
#   max_estimated_minutes: 30         # Max estimated time to qualify

# --- Notifications ---
# notification:
#   milestone_based: true             # Notify only on milestones (not every step)
#   suppress_window_ms: 300000        # 5 min — suppress duplicate notifications
#   batch_window_ms: 120000           # 2 min — batch rapid notifications
#   fast_path_collapse: true          # Collapse fast-path to single notification
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
#   batch_window_ms: 30000            # 30 sec — batch questions before asking
#   max_batch_size: 5

# --- Task decomposition ---
# decomposition:
#   auto_threshold_ms: 14400000       # 4 hours — auto-decompose above this
#   suggest_threshold_ms: 7200000     # 2 hours — suggest decomposition
#   min_child_size_ms: 1800000        # 30 min — minimum child task size

# --- Demo gate ---
# demo:
#   always_create: true               # Always create demo artifact
#   tui_base_project: null            # Base project for TUI demos

# --- Phase pipeline ---
# phases:
#   checkpoint_on_transition: true    # Checkpoint on every phase transition
#   periodic_checkpoint_interval_ms: 900000  # 15 min periodic checkpoints
#   max_loopbacks_before_alert: 3     # Alert after N phase loopbacks

# --- Journal ---
# journal:
#   aggregate_file_reads: true        # Aggregate file read entries
`;

export const SAFETY_TEMPLATE = `# Safety configuration for The Engineer
# Hot-reloadable — changes take effect without restart.
# All fields are optional — conservative defaults applied when missing.

# --- Cost limits ---
# cost_limits:
#   api:
#     per_task:
#       cost_usd: null                # No per-task limit (null = unlimited)
#       auto_resume_on_reset: false
#     daily:
#       cost_usd: null                # No daily limit
#       auto_resume_on_reset: false
#     monthly:
#       cost_usd: null                # No monthly limit
#       auto_resume_on_reset: false
#   cli: {}                           # Per-CLI-provider limits (keyed by provider name)

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
#   decisions: {}                     # Per-decision autonomy levels
#   repo_overrides: {}                # Per-repo overrides

# --- Response timeouts ---
# response_timeout:
#   blocked:
#     stages:
#       - name: reminder
#         after_ms: 14400000          # 4 hours
#         action: send_reminder
#         repeat: true
#         repeat_interval_ms: 14400000
#       - name: self_unblock_check
#         after_ms: 28800000          # 8 hours
#         action: evaluate_self_unblock
#       - name: escalation
#         after_ms: 172800000         # 48 hours
#         action: escalation_alert
#   review_pending:
#     reminder_after_ms: 86400000     # 24 hours
#     repeat_interval_ms: 86400000

# --- Merge policy ---
# merge:
#   auto_merge:
#     default: false                  # Don't auto-merge by default
#     repos: {}                       # Per-repo overrides: { "owner/repo": true }
`;

export const WORKSPACE_TEMPLATE = `# Workspace configuration for The Engineer
# All fields are optional — defaults shown as comments

# workspace_root: "~/.engineer/workspaces/"  # Where git worktrees are created
# branch_prefix: "engineer/"                 # Prefix for created branches
# slug_max_length: 30                        # Max length for branch slug
# fetch_before_create: true                  # Fetch remote before creating worktree
# default_base_branch: main                  # Default base branch for PRs

# --- PR settings ---
# pr:
#   default_merge_strategy: squash           # squash | merge | rebase
#   delete_branch_after_merge: true
#   branch_retention_days: null              # null = no retention limit

# --- Cleanup ---
# cleanup:
#   preserve_branch_on_failure: true
#   preserve_branch_on_cancel: false

# --- Child task PR strategy ---
# child_pr_strategy: merge_into_parent       # merge_into_parent | individual_prs

# --- Multi-repo ---
# multi_repo:
#   enabled: true
#   max_repos_per_task: 5
`;

export const PEOPLE_TEMPLATE = `# People configuration for The Engineer
# Hot-reloadable — changes take effect without restart.
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
# Polls GitHub Issues API for new and assigned issues

repos:
  - owner: your-github-username            # <-- replace
    name: your-repo-name                   # <-- replace
    # poll_interval: "30s"                 # Override default polling interval
    # labels: ["engineer"]                 # Only trigger on issues with these labels

# github_token: "\${GITHUB_TOKEN}"         # GitHub personal access token (env var)
`;

export const TELEGRAM_COMM_TEMPLATE = `# Telegram communication plugin
# Sends notifications and receives commands via Telegram bot

bot_token: "\${TELEGRAM_BOT_TOKEN}"        # <-- set env var
chat_id: "\${TELEGRAM_CHAT_ID}"            # <-- set env var

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

export const CLAUDE_CODE_LLM_TEMPLATE = `# Claude Code LLM plugin
# Uses Claude CLI for LLM completions

# model: claude-sonnet-4-20250514       # Model to use
# max_tokens: 16384                       # Max output tokens per completion
# cli_path: claude                        # Path to claude CLI binary
`;

export const BASH_TOOL_TEMPLATE = `# Bash tool plugin
# Executes shell commands in task workspaces

# --- Optional settings ---
# env_passthrough: []                     # Extra env vars to pass through
# max_output_bytes: 10485760              # 10 MB output limit
# command_timeout_ms: 300000              # 5 min command timeout
`;

// ── Example Templates (fully documented reference files) ─────────────────────
// Like .env.example — every field visible, documented, with defaults and valid options.
// Written to ~/.engineer/example-templates/ during `engineer init`.

export const EXAMPLE_DAEMON = `# ┌─────────────────────────────────────────────────────────────────────────────┐
# │  DAEMON CONFIGURATION — Full Reference                                    │
# │  Copy to ~/.engineer/config/daemon.yaml and customize.                    │
# │  All fields are optional — defaults are applied automatically.            │
# └─────────────────────────────────────────────────────────────────────────────┘

# ── Capacity ──────────────────────────────────────────────────────────────────
max_concurrent: 1                         # How many tasks run in parallel (default: 1)

# ── Tick Loop ─────────────────────────────────────────────────────────────────
tick_interval_ms: 5000                    # Main loop interval in ms (default: 5000)

# ── Preemption ────────────────────────────────────────────────────────────────
preemption_threshold: 20                  # Priority gap to trigger preemption (default: 20)
preemption_timeout_ms: 60000              # Time to checkpoint before forced swap (default: 60000)

# ── Stuck/Runaway Detection ──────────────────────────────────────────────────
stuck_threshold_ms: 1800000               # Flag task as stuck after 30 min (default: 1800000)
max_active_duration_ms: 28800000          # Kill task after 8 hours (default: 28800000)

# ── Priority Aging (starvation prevention) ───────────────────────────────────
aging_threshold_ms: 86400000              # Wait 24h before aging starts (default: 86400000)
aging_increment: 5                        # Priority bump per aging cycle (default: 5)
aging_interval_ms: 86400000               # Aging cycle length — 24h (default: 86400000)
aging_cap: 75                             # Max priority after aging, 1-100 (default: 75)

# ── Shutdown ──────────────────────────────────────────────────────────────────
shutdown_timeout_ms: 30000                # Drain timeout on SIGTERM (default: 30000)

# ── Trigger Polling ──────────────────────────────────────────────────────────
trigger_poll_interval_ms: 30000           # How often to poll triggers (default: 30000)
seen_keys_ttl_ms: 86400000                # Dedup key TTL — 24h (default: 86400000)

# ── Logging ──────────────────────────────────────────────────────────────────
logging:
  level: info                             # trace | debug | info | warn | error | fatal (default: info)
  dir: logs                               # Relative to ENGINEER_HOME or absolute (default: logs)
  max_size_bytes: 524288000               # Max log file size — 500 MB (default: 524288000)
  max_files: 7                            # Rolling file count — 7 days (default: 7)
  console: false                          # Also log to stdout (default: false)

# ── Plugin Lifecycle ─────────────────────────────────────────────────────────
plugins:
  dirs:                                   # Plugin discovery directories
    - src/plugins                         # (default: ["src/plugins"])
  health_check_interval_ms: 60000         # Health check frequency (default: 60000)
  health_check_timeout_ms: 5000           # Timeout per health check (default: 5000)
  consecutive_failures_threshold: 3       # Failures before marking failed (default: 3)
`;

export const EXAMPLE_ORCHESTRATOR = `# ┌─────────────────────────────────────────────────────────────────────────────┐
# │  ORCHESTRATOR CONFIGURATION — Full Reference                              │
# │  Copy to ~/.engineer/config/orchestrator.yaml and customize.              │
# │  All fields are optional — defaults are applied automatically.            │
# └─────────────────────────────────────────────────────────────────────────────┘

# ── Fast Path (trivial task shortcut) ────────────────────────────────────────
fast_path:
  enabled: true                           # Enable fast-path for trivial tasks (default: true)
  max_files: 2                            # Max files changed to qualify (default: 2)
  skip_demo: true                         # Skip demo prep for fast-path (default: true)
  max_estimated_minutes: 30               # Max estimated time to qualify (default: 30)

# ── Notifications ────────────────────────────────────────────────────────────
notification:
  milestone_based: true                   # Notify only on milestones (default: true)
  suppress_window_ms: 300000              # Suppress duplicate notifications — 5 min (default: 300000)
  batch_window_ms: 120000                 # Batch rapid notifications — 2 min (default: 120000)
  fast_path_collapse: true                # Collapse fast-path to single notification (default: true)
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
  batch_window_ms: 30000                  # Batch window — 30 sec (default: 30000)
  max_batch_size: 5                       # Max questions per batch (default: 5)

# ── Task Decomposition ──────────────────────────────────────────────────────
decomposition:
  auto_threshold_ms: 14400000             # Auto-decompose above 4 hours (default: 14400000)
  suggest_threshold_ms: 7200000           # Suggest decomposition above 2 hours (default: 7200000)
  min_child_size_ms: 1800000              # Minimum child task size — 30 min (default: 1800000)

# ── Demo Gate ────────────────────────────────────────────────────────────────
demo:
  always_create: true                     # Always create demo artifact (default: true)
  tui_base_project: null                  # Base project for TUI demos (default: null)

# ── Phase Pipeline ───────────────────────────────────────────────────────────
phases:
  checkpoint_on_transition: true          # Checkpoint on every phase transition (default: true)
  periodic_checkpoint_interval_ms: 900000 # Periodic checkpoint — 15 min (default: 900000)
  max_loopbacks_before_alert: 3           # Alert after N phase loopbacks (default: 3)

# ── Journal ──────────────────────────────────────────────────────────────────
journal:
  aggregate_file_reads: true              # Aggregate file read journal entries (default: true)
`;

export const EXAMPLE_SAFETY = `# ┌─────────────────────────────────────────────────────────────────────────────┐
# │  SAFETY CONFIGURATION — Full Reference                                    │
# │  Copy to ~/.engineer/config/safety.yaml and customize.                    │
# │  HOT-RELOADABLE — changes take effect without restart.                    │
# │  All fields are optional — conservative defaults applied.                 │
# └─────────────────────────────────────────────────────────────────────────────┘

# ── Cost Limits ──────────────────────────────────────────────────────────────
cost_limits:
  api:
    per_task:
      cost_usd: null                      # Per-task USD limit, null = unlimited (default: null)
      auto_resume_on_reset: false         # Auto-resume when limit resets (default: false)
    daily:
      cost_usd: null                      # Daily USD limit (default: null)
      auto_resume_on_reset: false
    monthly:
      cost_usd: null                      # Monthly USD limit (default: null)
      auto_resume_on_reset: false
  cli: {}                                 # Per-CLI-provider limits, keyed by provider name

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
# Per-decision autonomy levels. Keys are decision type names.
# Each decision can be: always_ask | threshold | always_decide
autonomy:
  decisions: {}                           # Per-decision overrides (default: {})
  repo_overrides: {}                      # Per-repo autonomy overrides (default: {})

# ── Response Timeouts ────────────────────────────────────────────────────────
response_timeout:
  blocked:
    stages:
      - name: reminder
        after_ms: 14400000                # Send reminder after 4 hours
        action: send_reminder
        repeat: true
        repeat_interval_ms: 14400000      # Repeat every 4 hours
      - name: self_unblock_check
        after_ms: 28800000                # Try self-unblock after 8 hours
        action: evaluate_self_unblock
      - name: escalation
        after_ms: 172800000               # Escalate after 48 hours
        action: escalation_alert
  review_pending:
    reminder_after_ms: 86400000           # Remind after 24 hours (default: 86400000)
    repeat_interval_ms: 86400000          # Repeat every 24 hours (default: 86400000)

# ── Merge Policy ─────────────────────────────────────────────────────────────
merge:
  auto_merge:
    default: false                        # Auto-merge PRs by default (default: false)
    repos: {}                             # Per-repo overrides: { "owner/repo": true }
`;

export const EXAMPLE_WORKSPACE = `# ┌─────────────────────────────────────────────────────────────────────────────┐
# │  WORKSPACE CONFIGURATION — Full Reference                                 │
# │  Copy to ~/.engineer/config/workspace.yaml and customize.                 │
# │  All fields are optional — defaults are applied automatically.            │
# └─────────────────────────────────────────────────────────────────────────────┘

workspace_root: "~/.engineer/workspaces/" # Where git worktrees are created (default: "~/.engineer/workspaces/")
branch_prefix: "engineer/"                # Prefix for created branches (default: "engineer/")
slug_max_length: 30                       # Max length for branch slug (default: 30)
fetch_before_create: true                 # Fetch remote before creating worktree (default: true)
default_base_branch: main                 # Default base branch for PRs (default: main)
git_token_env: GIT_TOKEN                  # Env var name for git auth token (default: GIT_TOKEN)

# ── PR Settings ──────────────────────────────────────────────────────────────
pr:
  default_merge_strategy: squash          # squash | merge | rebase (default: squash)
  delete_branch_after_merge: true         # Delete branch after PR merge (default: true)
  branch_retention_days: null             # Days to keep branches, null = forever (default: null)

# ── Cleanup ──────────────────────────────────────────────────────────────────
cleanup:
  preserve_branch_on_failure: true        # Keep branch when task fails (default: true)
  preserve_branch_on_cancel: false        # Keep branch when task cancelled (default: false)

# ── Child Task PR Strategy ───────────────────────────────────────────────────
child_pr_strategy: merge_into_parent      # merge_into_parent | individual_prs (default: merge_into_parent)

# ── Multi-Repo ───────────────────────────────────────────────────────────────
multi_repo:
  enabled: true                           # Enable multi-repo tasks (default: true)
  max_repos_per_task: 5                   # Max repos per task (default: 5)
`;

export const EXAMPLE_PEOPLE = `# ┌─────────────────────────────────────────────────────────────────────────────┐
# │  PEOPLE CONFIGURATION — Full Reference                                    │
# │  Copy to ~/.engineer/config/people.yaml and customize.                    │
# │  HOT-RELOADABLE — changes take effect without restart.                    │
# │  Defines contacts for communication (questions, notifications, reviews).  │
# └─────────────────────────────────────────────────────────────────────────────┘

people:
  - id: farzam                            # REQUIRED — unique identifier
    name: Farzam Mohammadi                # REQUIRED — display name
    roles:                                # REQUIRED — at least one role
      - owner                             #   owner | reviewer | contributor
    contacts:                             # REQUIRED — at least one contact
      - channel: telegram                 #   REQUIRED — channel name
        handle: "farzam_tg"               #   REQUIRED — handle on that channel
      - channel: github
        handle: "FarzamMohammadi"
    preferences:                          # optional — defaults shown below
      notification_level: milestones      #   all | milestones | critical (default: milestones)
      quiet_hours: null                   #   null or: { start: "22:00", end: "08:00" }

  # Add more people as needed:
  # - id: reviewer1
  #   name: Jane Smith
  #   roles: [reviewer]
  #   contacts:
  #     - channel: github
  #       handle: "janesmith"
  #   preferences:
  #     notification_level: critical
  #     quiet_hours:
  #       start: "23:00"
  #       end: "07:00"
`;

export const EXAMPLE_GITHUB_TRIGGER = `# ┌─────────────────────────────────────────────────────────────────────────────┐
# │  GITHUB TRIGGER PLUGIN — Full Reference                                   │
# │  Copy to ~/.engineer/config/plugins/github-trigger.yaml and customize.    │
# │  Polls GitHub Issues API for new and assigned issues.                     │
# └─────────────────────────────────────────────────────────────────────────────┘

repos:                                    # REQUIRED — at least one repo to watch
  - owner: FarzamMohammadi                # REQUIRED — GitHub username or org
    name: my-project                      # REQUIRED — repository name
    # poll_interval: "30s"                # optional — override default polling interval
    # labels: ["engineer"]                # optional — only trigger on issues with these labels

github_token: "\${GITHUB_TOKEN}"           # REQUIRED — GitHub personal access token (env var)
`;

export const EXAMPLE_TELEGRAM_COMM = `# ┌─────────────────────────────────────────────────────────────────────────────┐
# │  TELEGRAM COMMUNICATION PLUGIN — Full Reference                           │
# │  Copy to ~/.engineer/config/plugins/telegram-comm.yaml and customize.     │
# │  Sends notifications via Telegram bot.                                    │
# └─────────────────────────────────────────────────────────────────────────────┘

bot_token: "\${TELEGRAM_BOT_TOKEN}"        # REQUIRED — Telegram bot token (env var)
chat_id: "\${TELEGRAM_CHAT_ID}"            # REQUIRED — Telegram chat ID (env var)

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

export const EXAMPLE_CLAUDE_CODE_LLM = `# ┌─────────────────────────────────────────────────────────────────────────────┐
# │  CLAUDE CODE LLM PLUGIN — Full Reference                                 │
# │  Copy to ~/.engineer/config/plugins/claude-code-llm.yaml and customize.  │
# │  Uses Claude CLI for LLM completions.                                    │
# └─────────────────────────────────────────────────────────────────────────────┘

# All fields are optional — defaults shown below.
model: claude-sonnet-4-20250514         # Model to use (default: claude-sonnet-4-20250514)
max_tokens: 16384                         # Max output tokens per completion (default: 16384)
cli_path: claude                          # Path to claude CLI binary (default: claude)
`;

export const EXAMPLE_BASH_TOOL = `# ┌─────────────────────────────────────────────────────────────────────────────┐
# │  BASH TOOL PLUGIN — Full Reference                                       │
# │  Copy to ~/.engineer/config/plugins/bash-tool.yaml and customize.        │
# │  Executes shell commands in task workspaces.                              │
# └─────────────────────────────────────────────────────────────────────────────┘

# All fields are optional — defaults shown below.
env_passthrough: []                       # Extra env vars to pass through (default: [])
max_output_bytes: 10485760                # Output limit — 10 MB (default: 10485760)
command_timeout_ms: 300000                # Command timeout — 5 min (default: 300000)
`;

// ── Template Manifest ───────────────────────────────────────────────────────

export interface TemplateFile {
  relativePath: string;
  content: string;
}

/** All template files in the order they should be created. */
export const ALL_TEMPLATES: TemplateFile[] = [
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
  { relativePath: "config/plugins/claude-code-llm.yaml", content: CLAUDE_CODE_LLM_TEMPLATE },
  { relativePath: "config/plugins/bash-tool.yaml", content: BASH_TOOL_TEMPLATE },
];

/** Seed templates — fully documented configs for seed/ directory (used by `engineer prepare`). */
export const SEED_TEMPLATES: TemplateFile[] = [
  // Core configs — same paths as ALL_TEMPLATES, but with full documentation
  { relativePath: "config/daemon.yaml", content: EXAMPLE_DAEMON },
  { relativePath: "config/orchestrator.yaml", content: EXAMPLE_ORCHESTRATOR },
  { relativePath: "config/safety.yaml", content: EXAMPLE_SAFETY },
  { relativePath: "config/workspace.yaml", content: EXAMPLE_WORKSPACE },
  { relativePath: "config/people.yaml", content: EXAMPLE_PEOPLE },
  // Plugin configs
  { relativePath: "config/plugins/github-trigger.yaml", content: EXAMPLE_GITHUB_TRIGGER },
  { relativePath: "config/plugins/telegram-comm.yaml", content: EXAMPLE_TELEGRAM_COMM },
  { relativePath: "config/plugins/github-comm.yaml", content: EXAMPLE_GITHUB_COMM },
  { relativePath: "config/plugins/github-hosting.yaml", content: EXAMPLE_GITHUB_HOSTING },
  { relativePath: "config/plugins/claude-code-llm.yaml", content: EXAMPLE_CLAUDE_CODE_LLM },
  { relativePath: "config/plugins/bash-tool.yaml", content: EXAMPLE_BASH_TOOL },
];

/** Fully documented example templates — written to ~/.engineer/example-templates/. */
export const ALL_EXAMPLE_TEMPLATES: TemplateFile[] = [
  { relativePath: "example-templates/daemon.yaml", content: EXAMPLE_DAEMON },
  { relativePath: "example-templates/orchestrator.yaml", content: EXAMPLE_ORCHESTRATOR },
  { relativePath: "example-templates/safety.yaml", content: EXAMPLE_SAFETY },
  { relativePath: "example-templates/workspace.yaml", content: EXAMPLE_WORKSPACE },
  { relativePath: "example-templates/people.yaml", content: EXAMPLE_PEOPLE },
  { relativePath: "example-templates/github-trigger.yaml", content: EXAMPLE_GITHUB_TRIGGER },
  { relativePath: "example-templates/telegram-comm.yaml", content: EXAMPLE_TELEGRAM_COMM },
  { relativePath: "example-templates/github-comm.yaml", content: EXAMPLE_GITHUB_COMM },
  { relativePath: "example-templates/github-hosting.yaml", content: EXAMPLE_GITHUB_HOSTING },
  { relativePath: "example-templates/claude-code-llm.yaml", content: EXAMPLE_CLAUDE_CODE_LLM },
  { relativePath: "example-templates/bash-tool.yaml", content: EXAMPLE_BASH_TOOL },
];
