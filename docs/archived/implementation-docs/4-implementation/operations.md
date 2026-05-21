# Deployment & Operations

How The Engineer runs, how users interact with it, and how it manages itself operationally. Covers data directory layout, logging, process management, OS service integration, CLI interface, health checks (`doctor`), and first-run experience.

Part of **Layer 4** — see [`../layers.md`](../layers.md). Built on: daemon design from [`../2-components/daemon-scheduler.md`](../2-components/daemon-scheduler.md), startup/shutdown protocols from [`../3-interactions/protocols.md`](../3-interactions/protocols.md) (P1, P15), config system from [`layout.md`](layout.md), and plugin lifecycle from [`plugins.md`](plugins.md). Adopts two patterns from the [OpenClaw review](openclaw-review.md): `doctor` command and rolling file logging.

---

## Data Directory Structure

### Decision #109: `~/.engineer/` as Unified Root

All runtime data lives under a single root directory. One place to find everything, one directory to back up or remove.

```
~/.engineer/
  config/             # Config files (Decisions #91-#92)
    daemon.yaml
    orchestrator.yaml
    safety.yaml
    workspace.yaml
    people.yaml
    plugins/
      github-trigger.yaml
      telegram-comm.yaml
      github-comm.yaml
      github-hosting.yaml
      claude-code-llm.yaml
      bash-tool.yaml
  data/               # Persistent data (survives upgrades)
    engineer.db       # SQLite database (tasks, events, sessions, knowledge)
  logs/               # Rolling log files (see § Logging)
    engineer.log      # Current log file
    engineer.2026-03-09.log   # Rotated daily
  workspaces/         # Git worktrees for task isolation (WorkspaceConfig default)
  run/                # Runtime state (ephemeral, recreated on start)
    engineer.pid      # PID file for daemon management
```

### Path Resolution

**`ENGINEER_HOME`** env var overrides the root directory. Default: `~/.engineer/`.

**`ENGINEER_CONFIG_DIR`** (Decision #92) overrides just the config directory. This is the only granular override — everything else derives from `ENGINEER_HOME`.

**Precedence:**

| Path | Resolution |
|------|-----------|
| Config dir | `ENGINEER_CONFIG_DIR` → `ENGINEER_HOME/config/` → `~/.engineer/config/` |
| Data dir | `ENGINEER_HOME/data/` → `~/.engineer/data/` |
| Logs dir | `ENGINEER_HOME/logs/` → `~/.engineer/logs/` (overridable via `logging.dir` in daemon.yaml) |
| Workspaces dir | `workspace_root` from workspace.yaml → `ENGINEER_HOME/workspaces/` → `~/.engineer/workspaces/` |
| Runtime dir | `ENGINEER_HOME/run/` → `~/.engineer/run/` |

### Why Unified Root Over XDG

- XDG scatters files across `~/.local/share/`, `~/.local/state/`, `~/.config/`, `~/.cache/` — harder to inspect, back up, and uninstall
- `~/.engineer/` is one `rm -rf` to clean up, one `ls` to inspect
- Matches proven patterns: Cargo (`~/.cargo/`), Rustup (`~/.rustup/`), pnpm
- macOS doesn't follow XDG anyway (`~/Library/Application Support/`)
- Config already lives at `~/.engineer/config/` (Decision #92) — this extends the same pattern
- For v1 with a single user on a developer machine, simplicity wins

### Directory Purposes

| Directory | Contents | Lifecycle |
|-----------|----------|-----------|
| `config/` | YAML config files, plugin configs | User-managed. Survives upgrades. |
| `data/` | SQLite database file | System-managed. Survives upgrades. Back up this. |
| `logs/` | Rolling JSON log files | System-managed. Auto-pruned by retention policy. |
| `workspaces/` | Git worktrees, one per active task | System-managed. Cleaned up on task completion. |
| `run/` | PID file | Ephemeral. Recreated on each start. |

---

## Logging

### Decision #110: pino + pino-roll for Structured Rolling Logs

Operational logging uses **pino** with **pino-roll** for rolling file output. This is separate from and complementary to the Event Bus audit trail.

**Why pino:**
- Fastest Node.js structured logger — 5-10x faster than winston
- JSON-native output — matches our structured data approach
- Worker-thread transport — never blocks the main event loop
- `pino-roll` transport — daily rotation and size caps built-in
- Lightweight: pino is ~60KB, no transitive dependencies beyond `pino-std-serializers`

**Why not winston:** Heavier, slower, and designed for a different era (pre-structured logging). pino's JSON-native approach is a better fit for a system that already thinks in structured data (Zod schemas, typed events).

### Log Format

Single log file with structured JSON entries. Each entry includes a `component` tag for subsystem filtering.

```json
{"level":30,"time":1709913600000,"component":"daemon","msg":"Main loop tick","tick":42}
{"level":30,"time":1709913600100,"component":"registry","msg":"Health check passed","plugin_id":"github-trigger"}
{"level":30,"time":1709913600200,"component":"orchestrator","task_id":"task_abc123","msg":"Phase transition","from":"research","to":"planning"}
{"level":40,"time":1709913600300,"component":"safety","task_id":"task_abc123","msg":"Cost approaching limit","current_usd":8.50,"limit_usd":10.00}
{"level":50,"time":1709913600400,"component":"registry","msg":"Plugin health check failed","plugin_id":"telegram-comm","error":"Connection refused"}
```

**Component tags:** `daemon`, `registry`, `orchestrator`, `task-engine`, `safety`, `session-memory`, `workspace-manager`, `event-bus`, `people-directory`, `config`, `cli`. One tag per Core component, plus `config` for config system and `cli` for CLI commands.

**Why single file over per-component files:** Cross-component correlation is critical for debugging. When the Daemon schedules a task, the Orchestrator picks it up, and the Safety Layer evaluates scope — that's three components in one flow. Single file with `jq` filtering (`jq 'select(.component == "daemon")'`) gives both the full picture and focused views.

### Rolling Strategy

- **Daily rotation:** New file each day (`engineer.2026-03-09.log`)
- **Size cap:** 500MB per file — if exceeded before rotation, a new file starts
- **Retention:** 7 files (7 days of logs at default rotation)
- **Never blocks:** pino's async worker-thread transport guarantees that I/O failures or slow writes never block the Daemon's main loop

### Relationship to Event Bus

| | Operational Logging (pino) | Event Bus Audit Trail |
|---|---|---|
| **Purpose** | Debugging, performance, operations | System state, actions, decisions |
| **Content** | Trace-level detail, timing, errors | Structured events (30 event types) |
| **Format** | JSON log entries | EventEnvelope with typed payloads |
| **Storage** | Rolling files (auto-pruned) | SQLite (persistent, queryable) |
| **On failure** | Degraded debugging, system continues | System halt (Decision #53) |
| **Audience** | Operator debugging an issue | System itself (replay, reconciliation) |

They are complementary. The Event Bus is the source of truth for what happened. Logging is the debug tool for why something went wrong.

### Decision #111: Logging Configuration

New `logging` section in `DaemonConfig`:

```yaml
# In daemon.yaml
logging:
  level: info                        # trace | debug | info | warn | error | fatal
  dir: logs                          # relative to ENGINEER_HOME, or absolute path
  max_size_bytes: 524288000          # 500MB per file
  max_files: 7                       # 7-day retention (daily rotation)
  console: false                     # also log to stdout (useful for dev/debugging)
```

**Zod schema:**

```typescript
const LoggingConfigSchema = z.object({
  level: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  dir: z.string().default("logs"),                                      // relative to ENGINEER_HOME
  max_size_bytes: z.number().int().positive().default(524_288_000),     // 500MB
  max_files: z.number().int().positive().default(7),                    // 7-day retention
  console: z.boolean().default(false),                                  // also log to stdout
});
type LoggingConfig = z.infer<typeof LoggingConfigSchema>;
```

**`dir` field:** Relative paths resolve against `ENGINEER_HOME`. Absolute paths are used as-is. Default `"logs"` resolves to `~/.engineer/logs/`.

**`console` field:** When `true`, log output goes to both the file and stdout. Useful during development (`engineer start` in foreground) or when running under an OS service manager that captures stdout. Default `false` — file-only in production.

---

## Daemon Process Management

### Decision #112: Foreground Default, PID File, Single Instance

**How it runs:**

- `engineer start` runs the daemon **foreground** by default — stdout visible, Ctrl+C to stop. Best for development, debugging, and running under OS service managers.
- `engineer start --daemon` forks to background — detaches stdio, writes PID file, returns control to the terminal.
- PID file at `{ENGINEER_HOME}/run/engineer.pid` tracks the running daemon.

**Why foreground by default:**
- Development and debugging are the most common use cases during v1
- OS service managers (launchd, systemd) expect foreground processes — they handle backgrounding
- Background mode (`--daemon`) is available when needed, but foreground is the safer default

### Signal Handling

Formalizes the signal behavior designed in P15 (Crash Recovery & System Restart):

| Signal | Behavior |
|--------|----------|
| SIGTERM | Graceful shutdown: checkpoint Active.Working task → transition to Queued → reverse plugin shutdown → exit 0 |
| SIGINT | Same as SIGTERM (Ctrl+C in foreground mode) |
| SIGHUP | Ignored for v1. Future: trigger config hot-reload. |

**Graceful shutdown sequence (P15 implementation):**

```
1. Daemon receives SIGTERM/SIGINT
2. Set "shutting down" flag — reject new work, stop trigger polling
3. If a task is Active.Working:
   a. Signal Orchestrator to checkpoint (same as preemption flow)
   b. Wait up to shutdown_timeout_ms (default 30s) for checkpoint
   c. On checkpoint: transition task Queued (resumable on restart)
   d. On timeout: force-terminate — work since last checkpoint is lost
4. Shut down plugins in reverse initialization order (Decision #106):
   Trigger → Git Hosting → Tool → LLM → Communication
5. Close Event Bus (flush pending events to SQLite)
6. Close database connection
7. Remove PID file
8. Exit 0
```

### Single Instance Enforcement

Only one daemon process can run at a time. Enforced via PID file:

```
On startup:
1. Check if PID file exists at {ENGINEER_HOME}/run/engineer.pid
2. If exists:
   a. Read PID from file
   b. Check if process is alive: process.kill(pid, 0)
   c. If alive: verify it's The Engineer (not PID reuse)
      - macOS: ps -p {pid} -o command= | check for "engineer"
      - Linux: read /proc/{pid}/cmdline | check for "engineer"
   d. If alive AND is The Engineer: refuse to start
      "The Engineer is already running (PID {pid}). Use 'engineer stop' first."
   e. If dead or not The Engineer: stale PID file
      Remove stale PID file, log warning, continue startup
3. Write current PID to file
4. On shutdown: remove PID file (step 7 of graceful shutdown)
```

### Exit Codes

| Code | Meaning | When |
|------|---------|------|
| 0 | Clean shutdown | SIGTERM/SIGINT graceful shutdown completed |
| 1 | Startup failure | Config invalid, critical plugin failed, database inaccessible, pre-flight check failed |
| 2 | Runtime crash | Unhandled exception, uncaught promise rejection |

**Unhandled exceptions:** The daemon registers `process.on('uncaughtException')` and `process.on('unhandledRejection')` handlers. These log the error, attempt a graceful shutdown, and exit with code 2.

### Decision #113: OS Service Integration via `engineer install`

`engineer install` generates OS-specific service configuration files and prints registration instructions. It does NOT auto-register — the user runs the registration commands themselves.

**Why generate + instructions, not auto-register:**
- Registering system services has implications (starts on login, auto-restarts) the user should consciously choose
- Avoids permission issues — no `sudo` needed
- The user can review the generated file before registering

### macOS (launchd)

Generates a plist at `~/Library/LaunchAgents/com.the-engineer.daemon.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.the-engineer.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>/path/to/engineer</string>
    <string>start</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/username</string>
  <key>KeepAlive</key>
  <true/>
  <key>RunAtLoad</key>
  <false/>
  <key>StandardOutPath</key>
  <string>/Users/username/.engineer/logs/launchd-stdout.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/username/.engineer/logs/launchd-stderr.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ENGINEER_HOME</key>
    <string>/Users/username/.engineer</string>
  </dict>
</dict>
</plist>
```

Prints instructions:
```
Generated: ~/Library/LaunchAgents/com.the-engineer.daemon.plist

To register (start now and on login):
  launchctl load ~/Library/LaunchAgents/com.the-engineer.daemon.plist

To unregister:
  launchctl unload ~/Library/LaunchAgents/com.the-engineer.daemon.plist
```

**Notes:**
- `KeepAlive: true` — launchd auto-restarts on crash
- `RunAtLoad: false` — doesn't start on login by default (user can change to `true` in the plist)
- Paths are resolved at generation time using the current user's home directory and `ENGINEER_HOME`

### Linux (systemd)

Generates a unit file at `~/.config/systemd/user/engineer.service`:

```ini
[Unit]
Description=The Engineer - Autonomous Software Engineering Agent
After=network-online.target

[Service]
Type=simple
ExecStart=/path/to/engineer start
ExecStop=/path/to/engineer stop
WorkingDirectory=%h
Restart=on-failure
RestartSec=5
Environment=ENGINEER_HOME=%h/.engineer

[Install]
WantedBy=default.target
```

Prints instructions:
```
Generated: ~/.config/systemd/user/engineer.service

To register and start:
  systemctl --user daemon-reload
  systemctl --user enable --now engineer.service

To check status:
  systemctl --user status engineer.service

To stop and unregister:
  systemctl --user disable --now engineer.service
```

**Notes:**
- User-level systemd (`--user`) — no root/sudo needed
- `Restart=on-failure` with `RestartSec=5` — auto-restart on crash with 5-second delay
- `%h` expands to the user's home directory

### Windows

Out of scope for v1. Documented in [`../future-considerations.md`](../future-considerations.md).

---

## CLI Interface

### Decision #114: commander as CLI Framework

**commander** is the CLI framework for The Engineer.

**Why commander:**
- Most established Node.js CLI framework — 26k GitHub stars, TypeScript support
- Used by OpenClaw (validated pattern)
- Auto-generated help text, subcommand support, option parsing
- Single dependency, stable API, actively maintained
- Built-in version display from package.json

**Alternatives rejected:**
- **citty** — Newer (unjs ecosystem), zero-dependency, but less mature and smaller community
- **yargs** — Heavier API surface, different paradigm (builder pattern vs fluent chain)
- **Custom** — Reinventing well-solved problems with no benefit

### Decision #115: CLI Command Inventory

Flat command structure for v1. The binary is named `engineer` (registered in `package.json` `bin` field).

### Daemon Lifecycle Commands

**`engineer start`**

Start the daemon process.

```
Usage: engineer start [options]

Options:
  --daemon    Fork to background (default: foreground)
  --verbose   Set log level to debug
```

Behavior:
1. Resolve `ENGINEER_HOME` and all paths
2. Auto-create directories if missing (first-run detection)
3. Initialize SQLite database if missing (run migrations)
4. Run pre-flight checks (fast subset of `doctor`)
5. Check single-instance enforcement (PID file)
6. Execute P1 System Startup protocol
7. Enter main daemon loop

**`engineer stop`**

Stop the running daemon.

```
Usage: engineer stop [options]

Options:
  --timeout <ms>    Shutdown timeout in ms (default: from daemon.yaml shutdown_timeout_ms)
```

Behavior:
1. Read PID from `{ENGINEER_HOME}/run/engineer.pid`
2. If no PID file or process not running: print message, exit 0
3. Send SIGTERM to the daemon process
4. Wait for process exit up to timeout
5. If process exits cleanly: print confirmation, exit 0
6. If timeout: print warning ("Daemon did not stop within {timeout}ms. Process may still be running."), exit 1

**`engineer status`**

Show daemon status.

```
Usage: engineer status
```

Output (when running):
```
The Engineer: running (PID 12345)
  Uptime:        2h 34m
  Active task:   #47 — Implement user authentication
  Queue:         3 tasks (priorities: 90, 70, 50)
  Plugins:       5 healthy, 0 unhealthy, 0 failed
  Last log:      2026-03-09 14:23:01 — "Scheduled task #47 for execution"
```

Output (when stopped):
```
The Engineer: stopped
  Last run:      2026-03-09 12:00:00 (2h 34m ago)
```

Implementation: reads PID file for running status, queries SQLite database for task and queue info, reads last log entry.

**`engineer logs`**

Tail the log file with human-readable formatting.

```
Usage: engineer logs [options]

Options:
  --json       Show raw JSON instead of pretty-printed output
  --lines <n>  Number of lines to show (default: 50)
  --follow     Follow mode — stream new entries (default: true)
```

Default behavior: pipes the current log file through `pino-pretty` for human-readable output in follow mode. Equivalent to `tail -f ~/.engineer/logs/engineer.log | pino-pretty`.

With `--json`: shows raw JSON entries (useful for piping to `jq`).

### Setup & Diagnostics Commands

**`engineer init`**

Create directory structure and generate template config files.

```
Usage: engineer init [options]

Options:
  --force    Overwrite existing config files (default: skip existing)
```

See § First-Run Experience for full details.

**`engineer doctor`**

Run health check suite.

```
Usage: engineer doctor
```

See § Health Check (`doctor`) for full details.

**`engineer install`**

Generate OS service configuration files.

```
Usage: engineer install
```

See § OS Service Integration for full details.

### Config Command

**`engineer config validate`**

Validate all config files without starting the daemon.

```
Usage: engineer config validate
```

Behavior:
1. Load and parse all YAML config files
2. Resolve `${ENV_VAR}` references
3. Parse duration strings
4. Validate against Zod schemas
5. Print results per file (pass/fail with error details)
6. Exit 0 if all valid, exit 1 if any invalid

### Global Options

Available on all commands:

| Option | Description |
|--------|-------------|
| `--home <path>` | Override `ENGINEER_HOME` (takes precedence over env var) |
| `--verbose` | Set log level to `debug` and enable console output |
| `--version` | Print version and exit |
| `--help` | Print help and exit |

### Source Directory Addition

CLI commands live in `src/cli/`:

```
src/cli/
  index.ts              # commander program setup, global options
  commands/
    start.ts            # engineer start
    stop.ts             # engineer stop
    status.ts           # engineer status
    logs.ts             # engineer logs
    init.ts             # engineer init
    doctor.ts           # engineer doctor
    install.ts          # engineer install
    config-validate.ts  # engineer config validate
```

### Future Commands

Not in v1 but the flat structure accommodates without breaking changes:

- `engineer task list` — List tasks with status
- `engineer task create` — Create a task manually
- `engineer task inspect <id>` — Show detailed task info
- `engineer plugin list` — Show registered plugins and health

---

## Health Check (`doctor`)

### Decision #116: `doctor` Command Design

`engineer doctor` is an independent health check command that validates the entire system. Adopted from the [OpenClaw review](openclaw-review.md) pattern (`openclaw doctor` with 30+ checks).

### Design Principles

- **Independent command** — runs without starting the daemon, can be run anytime
- **Pre-flight subset** — `engineer start` runs fast checks (categories 1-6) automatically before starting the daemon loop
- **Actionable output** — every failure includes what to do about it
- **Exit codes** — machine-readable result for scripts and CI

### Check Categories

| # | Category | What It Checks | Speed |
|---|----------|---------------|-------|
| 1 | Node.js runtime | `process.version >= 22.0.0` | Fast |
| 2 | Data directory | `ENGINEER_HOME` writable, all subdirectories exist or can be created | Fast |
| 3 | Config files | Parse + Zod validate all YAML configs in `config/` | Fast |
| 4 | Required secrets | All `${ENV_VAR}` references in config files resolve to defined env vars | Fast |
| 5 | Database | SQLite file accessible, schema version matches expected (migrations current) | Fast |
| 6 | Plugin manifests | All `engineer.plugin.yaml` files parse, validate, and have valid entry points | Fast |
| 7 | GitHub connectivity | API token valid (GET /user), rate limit status, configured repos accessible | Network |
| 8 | Telegram connectivity | Bot token valid (getMe), allowed chat IDs reachable | Network |
| 9 | Workspace | Directory writable, `git` binary available and version adequate, sufficient disk space | Fast |
| 10 | Risky config warnings | Auto-merge enabled, high autonomy settings, aggressive cost limits, low safety thresholds | Fast |

### Pre-Flight vs Full Doctor

| | Pre-flight (on `engineer start`) | Full (`engineer doctor`) |
|---|---|---|
| **Categories** | 1-6 (fast only) | 1-10 (all) |
| **Duration** | < 1 second | A few seconds (network checks) |
| **On failure** | Abort startup, print error, exit 1 | Print results, exit 1 |
| **When to use** | Automatic — every startup | Manual — after install, config changes, debugging |

### Output Format

Colored terminal output, grouped by category:

```
The Engineer — System Health Check

  Node.js Runtime
    ✓ Node.js v22.14.0 (>= 22.0.0 required)

  Data Directory
    ✓ ~/.engineer/ exists and is writable
    ✓ All subdirectories present

  Config Files
    ✓ daemon.yaml — valid
    ✓ orchestrator.yaml — valid
    ✓ safety.yaml — valid
    ✓ workspace.yaml — valid
    ✓ people.yaml — valid

  Required Secrets
    ✓ GITHUB_TOKEN — defined
    ✓ TELEGRAM_BOT_TOKEN — defined

  Database
    ✓ engineer.db accessible
    ✓ Schema version: 1 (current)

  Plugin Manifests
    ✓ github-trigger — valid
    ✓ telegram-comm — valid
    ✓ claude-code-llm — valid
    ✓ bash-tool — valid
    ✓ github-hosting — valid
    ✓ github-comm — valid

  GitHub Connectivity
    ✓ API token valid (user: farzam)
    ✓ Rate limit: 4892/5000 remaining
    ✓ farzam/my-app — accessible
    ✓ farzam/another-repo — accessible

  Telegram Connectivity
    ✓ Bot token valid (bot: @EngineerBot)
    ✓ Chat ID 123456789 — reachable

  Workspace
    ✓ ~/.engineer/workspaces/ writable
    ✓ git 2.45.0 available
    ✓ Disk space: 45.2 GB free

  Risky Config Warnings
    ⚠ Auto-merge is enabled (safety.yaml merge.auto_merge: true)
    ⚠ High autonomy: task_decomposition set to "always_decide"

Summary: 22 passed, 2 warnings, 0 failed
```

### Exit Codes

| Code | Meaning |
|------|---------|
| 0 | All checks passed (warnings are OK) |
| 1 | One or more checks failed |
| 2 | Warnings only (no failures) |

### Actionable Failure Messages

Every failure includes a clear remediation:

```
  Required Secrets
    ✗ GITHUB_TOKEN — not defined
      → Set the GITHUB_TOKEN environment variable:
        export GITHUB_TOKEN=ghp_your_token_here
      → Or add to your shell profile (~/.zshrc, ~/.bashrc)
```

---

## First-Run Experience

### Decision #117: Auto-Create Directories, Fail-With-Instructions

**First-run detection:** No `{ENGINEER_HOME}/data/engineer.db` exists.

**On first `engineer start`:**

```
1. Detect first run (no engineer.db)
2. Auto-create directory structure:
   {ENGINEER_HOME}/config/
   {ENGINEER_HOME}/config/plugins/
   {ENGINEER_HOME}/data/
   {ENGINEER_HOME}/logs/
   {ENGINEER_HOME}/run/
   {ENGINEER_HOME}/workspaces/
3. Initialize SQLite database (run migration 001_initial.sql)
4. Run pre-flight checks (categories 1-6)
5. If required secrets missing:
   Print clear instructions for each missing secret
   Exit 1
6. If config files missing:
   System runs with Zod defaults (Decision #93)
   Log info: "Using default configuration. Run 'engineer init' to generate config templates."
7. If all passes:
   Start daemon normally
```

**No interactive wizard for v1.** The recommended setup workflow:

```bash
# 1. Generate template configs (optional — start creates dirs automatically)
engineer init

# 2. Edit config files
$EDITOR ~/.engineer/config/plugins/github-trigger.yaml

# 3. Set required environment variables
export GITHUB_TOKEN=ghp_...
export TELEGRAM_BOT_TOKEN=...

# 4. Validate everything
engineer doctor

# 5. Start
engineer start
```

**Why no wizard:**
- Adds significant code for a v1 system with one user
- Config files are the source of truth — editing YAML is the real workflow
- `engineer doctor` is the guided validation tool
- Fail-with-instructions is more debuggable than a wizard that silently chose wrong defaults

### Decision #118: `engineer init` Command

Creates directory structure and generates template config files with inline comments explaining each field.

**Behavior:**

```
1. Create directory structure (same as auto-create in Decision #117)
2. Generate template config files:
   - daemon.yaml (all fields commented out, defaults shown)
   - orchestrator.yaml (all fields commented out)
   - safety.yaml (all fields commented out)
   - workspace.yaml (all fields commented out)
   - people.yaml (minimal working example — people array with placeholder)
   - plugins/github-trigger.yaml (template with required fields)
   - plugins/telegram-comm.yaml (template with required fields)
   - plugins/github-comm.yaml (template with required fields)
   - plugins/github-hosting.yaml (template with required fields)
   - plugins/claude-code-llm.yaml (template with required fields)
   - plugins/bash-tool.yaml (template with optional fields)
3. Print what was created and next steps
```

**Safety:**
- **Safe to run multiple times** — existing files are NOT overwritten
- `--force` flag: overwrite existing files (for regenerating templates after an upgrade)
- If a file already exists: skip it and print "(exists, skipped)"

**Template style:**

Core configs have all fields commented out (Zod defaults apply). Plugin configs have required fields uncommented with placeholder values.

```yaml
# Daemon configuration for The Engineer
# All fields are optional — defaults shown as comments
# Documentation: implementation-docs/4-implementation/operations.md

# --- Tick loop ---
# tick_interval_ms: 5000              # Main loop tick interval (ms)

# --- Preemption ---
# preemption_threshold: 20            # Priority gap to trigger preemption
# preemption_timeout_ms: 60000        # Time to checkpoint before forced (ms)

# --- Stuck/runaway detection ---
# stuck_threshold_ms: 1800000         # 30 min — no progress alert
# max_active_duration_ms: 28800000    # 8 hours — absolute cap alert

# --- Priority aging ---
# aging_threshold_ms: 86400000        # 24 hours before aging starts
# aging_increment: 5                  # Priority bump per interval
# aging_interval_ms: 86400000         # 24 hours between bumps
# aging_cap: 75                       # Max priority from aging

# --- Shutdown ---
# shutdown_timeout_ms: 30000          # Graceful shutdown timeout (ms)

# --- Trigger polling ---
# trigger_poll_interval_ms: 30000     # Default trigger poll interval (ms)
# seen_keys_ttl_ms: 86400000          # Dedup key retention (24 hours)

# --- Logging ---
# logging:
#   level: info                       # trace | debug | info | warn | error | fatal
#   dir: logs                         # Relative to ENGINEER_HOME or absolute
#   max_size_bytes: 524288000         # 500MB per file
#   max_files: 7                      # 7-day retention
#   console: false                    # Also log to stdout

# --- Plugin lifecycle ---
# plugins:
#   dirs:
#     - src/plugins                   # Plugin discovery paths
#   health_check_interval_ms: 60000   # 60s between health checks
#   health_check_timeout_ms: 5000     # 5s per health check
#   consecutive_failures_threshold: 3  # Failures before "failed" state
```

```yaml
# GitHub Issues trigger plugin
# Polls GitHub Issues API for new and assigned issues
# Required: at least one repo to monitor

repos:
  - owner: your-github-username       # ← replace
    name: your-repo-name              # ← replace
    # poll_interval: "30s"            # Override default polling interval
```

**Output:**

```
Created ~/.engineer/config/
Created ~/.engineer/config/plugins/
Created ~/.engineer/data/
Created ~/.engineer/logs/
Created ~/.engineer/run/
Created ~/.engineer/workspaces/

Generated config files:
  config/daemon.yaml
  config/orchestrator.yaml
  config/safety.yaml
  config/workspace.yaml
  config/people.yaml
  config/plugins/github-trigger.yaml
  config/plugins/telegram-comm.yaml
  config/plugins/github-comm.yaml
  config/plugins/github-hosting.yaml
  config/plugins/claude-code-llm.yaml
  config/plugins/bash-tool.yaml

Next steps:
  1. Edit config files:  $EDITOR ~/.engineer/config/plugins/github-trigger.yaml
  2. Set env variables:  export GITHUB_TOKEN=ghp_...
  3. Validate setup:     engineer doctor
  4. Start:              engineer start
```

---

## Dependencies Added This Session

| Package | Purpose | Category |
|---------|---------|----------|
| `pino` | Structured logging | Runtime |
| `pino-roll` | Rolling file transport for pino | Runtime |
| `pino-pretty` | Human-readable log formatting for `engineer logs` | Dev |
| `commander` | CLI framework | Runtime |

> Joins packages from Sessions 23, 25, and 26: `better-sqlite3`, `zod`, `tsx`, `tsdown`, `@biomejs/biome`, `vitest`, `yaml`, `ms`, `lefthook`, `zod-to-json-schema`.
