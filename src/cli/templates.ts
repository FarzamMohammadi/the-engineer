// ── Core Config Templates ────────────────────────────────────────────────────

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

# --- Priority aging (prevents low-priority tasks from waiting forever) ---
# aging_threshold_ms: "1d"            # How long a queued task waits before aging starts (default: 1d)
# aging_increment: 5                  # Priority points added each aging cycle (higher = sooner scheduled)
# aging_interval_ms: "1d"             # How often aging bumps priority (default: 1d)
# aging_cap: 75                       # Max priority via aging, 1-100 (leaves 76-100 for urgent tasks)

# --- Shutdown ---
# shutdown_timeout_ms: "30s"          # Time to drain active tasks on shutdown (default: 30s)

# --- Trigger polling ---
# trigger_poll_interval_ms: "30s"     # How often to poll triggers (default: 30s)
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
`;

export const ORCHESTRATOR_TEMPLATE = `# Orchestrator configuration for The Engineer
# All fields are optional — defaults shown as comments
# Duration fields accept human-readable strings: "5s", "30m", "8h", "1d"

# --- RRPIR methodology ---
# rrpir:
#   max_requirements_loops: 5         # Max requirement-gathering loops (default: 5)
#   include_thoughts_in_pr: true      # Include thoughts in PR description (default: true)

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

# --- Task decomposition ---
# decomposition:
#   auto_threshold_ms: "4h"           # Auto-decompose above this (default: 4h)
#   suggest_threshold_ms: "2h"        # Suggest decomposition (default: 2h)
#   min_child_size_ms: "30m"          # Minimum child task size (default: 30m)

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
# Hot-reloadable — changes take effect without restart.
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
#   cli: {}                           # Per-CLI-provider limits (keyed by plugin ID, e.g. "claude-code-llm")

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
`;

export const WORKSPACE_TEMPLATE = `# Workspace configuration for The Engineer
# All fields are optional — defaults shown as comments

# workspace_root: "~/.engineer/workspaces/"  # Where git worktrees are created
# branch_prefix: "engineer/"                 # Prefix for created branches
# slug_max_length: 30                        # Max length for branch slug
# fetch_before_create: true                  # Fetch remote before creating worktree
# default_base_branch: main                  # Default base branch for PRs
# git_token_env: GIT_TOKEN                   # Env var name for git auth token (default: GIT_TOKEN)
#                                            # Using GitHub? Set this to GITHUB_TOKEN, or alias:
#                                            # export GIT_TOKEN=$GITHUB_TOKEN

# --- PR settings ---
# pr:
#   default_merge_strategy: squash           # squash | merge | rebase
#   delete_branch_after_merge: true
#   branch_retention_days: null              # Days to retain branches after merge. null = preserve indefinitely.

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

github_token: "\${GITHUB_TOKEN}"           # <-- set env var
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

export const CLAUDE_CODE_LLM_TEMPLATE = `# Claude Code LLM plugin
# Uses Claude CLI for LLM completions

# model: claude-sonnet-4-20250514       # Model to use
# max_tokens: 16384                       # Max output tokens per completion
# cli_path: claude                        # Path to claude CLI binary
`;

export const OPENCODE_LLM_TEMPLATE = `# OpenCode LLM plugin
# Multi-provider LLM reasoning via OpenCode CLI
# Supports Anthropic, OpenAI, Google, and more — configure model as provider/model

# model: opencode/gemini-3.1-pro             # Model in provider/model format
# cli_path: opencode                         # Path to opencode CLI binary
`;

export const GEMINI_CLI_LLM_TEMPLATE = `# Gemini CLI LLM plugin
# Uses Google Gemini CLI for LLM completions
# Free tier — no cost tracking (cost_usd always null)

# model: gemini-2.5-pro                      # Model to use
# cli_path: gemini                           # Path to gemini CLI binary
`;

export const BASH_TOOL_TEMPLATE = `# Bash tool plugin
# Executes shell commands in task workspaces
# Duration fields accept human-readable strings: "5s", "30m", "8h"

# --- Optional settings ---
# env_passthrough: []                     # Extra env vars to pass through
# max_output_bytes: 10485760              # 10 MB output limit
# command_timeout_ms: "5m"                # Command timeout (default: 5m)
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

# ── Priority Aging (starvation prevention) ───────────────────────────────────
aging_threshold_ms: "1d"                  # Wait before aging starts (default: 1d)
aging_increment: 5                        # Priority bump per aging cycle (default: 5)
aging_interval_ms: "1d"                   # Aging cycle length (default: 1d)
aging_cap: 75                             # Max priority via aging, 1-100 (leaves 76-100 for urgent tasks)

# ── Shutdown ──────────────────────────────────────────────────────────────────
shutdown_timeout_ms: "30s"                # Drain timeout on SIGTERM (default: 30s)

# ── Trigger Polling ──────────────────────────────────────────────────────────
trigger_poll_interval_ms: "30s"           # How often to poll triggers (default: 30s)
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
`;

export const EXAMPLE_ORCHESTRATOR = `# ┌─────────────────────────────────────────────────────────────────────────────┐
# │  ORCHESTRATOR CONFIGURATION — Full Reference                              │
# │  Copy to ~/.engineer/config/orchestrator.yaml and customize.              │
# │  All fields are optional — defaults are applied automatically.            │
# │  Duration fields accept human-readable strings: "5s", "30m", "8h", "1d"  │
# └─────────────────────────────────────────────────────────────────────────────┘

# ── RRPIR Methodology ────────────────────────────────────────────────────────
rrpir:
  max_requirements_loops: 5               # Max requirement-gathering loops (default: 5)
  include_thoughts_in_pr: true            # Include thoughts in PR description (default: true)

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

# ── Task Decomposition ──────────────────────────────────────────────────────
decomposition:
  auto_threshold_ms: "4h"                 # Auto-decompose above this (default: 4h)
  suggest_threshold_ms: "2h"              # Suggest decomposition above this (default: 2h)
  min_child_size_ms: "30m"                # Minimum child task size (default: 30m)

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
# │  HOT-RELOADABLE — changes take effect without restart.                    │
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
  cli: {}                                 # Per-CLI-provider limits, keyed by plugin ID (e.g. "claude-code-llm")

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
                                          # Generic default works with any git host.
                                          # For GitHub: export GIT_TOKEN=$GITHUB_TOKEN

# ── PR Settings ──────────────────────────────────────────────────────────────
pr:
  default_merge_strategy: squash          # squash | merge | rebase (default: squash)
  delete_branch_after_merge: true         # Delete branch after PR merge (default: true)
  branch_retention_days: null             # Days to retain branches after merge. null = preserve indefinitely (default: null).

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

export const EXAMPLE_OPENCODE_LLM = `# ┌─────────────────────────────────────────────────────────────────────────────┐
# │  OPENCODE LLM PLUGIN — Full Reference                                    │
# │  Copy to ~/.engineer/config/plugins/opencode-llm.yaml and customize.     │
# │  Multi-provider LLM via OpenCode CLI (Anthropic, OpenAI, Google, etc.)   │
# └─────────────────────────────────────────────────────────────────────────────┘

# All fields are optional — defaults shown below.
model: opencode/gemini-3.1-pro             # Model in provider/model format (default: opencode/gemini-3.1-pro)
cli_path: opencode                         # Path to opencode CLI binary (default: opencode)
`;

export const EXAMPLE_GEMINI_CLI_LLM = `# ┌─────────────────────────────────────────────────────────────────────────────┐
# │  GEMINI CLI LLM PLUGIN — Full Reference                                  │
# │  Copy to ~/.engineer/config/plugins/gemini-cli-llm.yaml and customize.   │
# │  Uses Google Gemini CLI for LLM completions. Free tier, no cost data.    │
# └─────────────────────────────────────────────────────────────────────────────┘

# All fields are optional — defaults shown below.
model: gemini-2.5-pro                       # Model to use (default: gemini-2.5-pro)
cli_path: gemini                            # Path to gemini CLI binary (default: gemini)
`;

export const EXAMPLE_BASH_TOOL = `# ┌─────────────────────────────────────────────────────────────────────────────┐
# │  BASH TOOL PLUGIN — Full Reference                                       │
# │  Copy to ~/.engineer/config/plugins/bash-tool.yaml and customize.        │
# │  Executes shell commands in task workspaces.                              │
# │  Duration fields accept human-readable strings: "5s", "30m", "8h"        │
# └─────────────────────────────────────────────────────────────────────────────┘

# All fields are optional — defaults shown below.
env_passthrough: []                       # Extra env vars to pass through (default: [])
max_output_bytes: 10485760                # Output limit — 10 MB (default: 10485760)
command_timeout_ms: "5m"                  # Command timeout (default: 5m)
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
  { relativePath: "config/plugins/opencode-llm.yaml", content: OPENCODE_LLM_TEMPLATE },
  { relativePath: "config/plugins/gemini-cli-llm.yaml", content: GEMINI_CLI_LLM_TEMPLATE },
  { relativePath: "config/plugins/bash-tool.yaml", content: BASH_TOOL_TEMPLATE },
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
  { relativePath: "example-templates/opencode-llm.yaml", content: EXAMPLE_OPENCODE_LLM },
  { relativePath: "example-templates/gemini-cli-llm.yaml", content: EXAMPLE_GEMINI_CLI_LLM },
  { relativePath: "example-templates/bash-tool.yaml", content: EXAMPLE_BASH_TOOL },
];
