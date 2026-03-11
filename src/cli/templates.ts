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
`;

// ── Plugin Config Templates ─────────────────────────────────────────────────

export const GITHUB_TRIGGER_TEMPLATE = `# GitHub Issues trigger plugin
# Polls GitHub Issues API for new and assigned issues

repos:
  - owner: your-github-username            # <-- replace
    name: your-repo-name                   # <-- replace
    # poll_interval: "30s"                 # Override default polling interval
    # labels: ["engineer"]                 # Only trigger on issues with these labels

# token: "\${GITHUB_TOKEN}"               # GitHub personal access token (env var)
`;

export const TELEGRAM_COMM_TEMPLATE = `# Telegram communication plugin
# Sends notifications and receives commands via Telegram bot

bot_token: "\${TELEGRAM_BOT_TOKEN}"        # <-- set env var
chat_id: "\${TELEGRAM_CHAT_ID}"            # <-- set env var

# --- Optional settings ---
# parse_mode: Markdown                    # Markdown | HTML
# disable_link_preview: true
`;

export const GITHUB_COMM_TEMPLATE = `# GitHub communication plugin
# Comments on issues and PRs, manages labels

token: "\${GITHUB_TOKEN}"                  # <-- set env var

# --- Optional settings ---
# comment_prefix: "[The Engineer]"        # Prefix for all comments
# sync_labels: true                       # Sync task state to issue labels
`;

export const GITHUB_HOSTING_TEMPLATE = `# GitHub git hosting plugin
# Creates PRs, manages branches, handles reviews

token: "\${GITHUB_TOKEN}"                  # <-- set env var

# --- Optional settings ---
# draft_first: true                       # Create PRs as draft initially
# request_reviewers: true                 # Auto-request reviewers from CODEOWNERS
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
