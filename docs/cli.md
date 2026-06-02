# CLI Reference

The Engineer is operated through the `engineer` CLI — daily-use commands (`start`, `stop`, `status`, `logs`), diagnostics (`doctor`), and per-task debugging (`why`, `retry`).

## Installing the CLI

```bash
pnpm run setup
```

`pnpm run setup` installs dependencies, builds to `dist/`, and links the `engineer` command globally. It confirms before acting and is safe to re-run. If pnpm's own global bin directory has never been configured, the script offers to run `pnpm setup` for you, then tells you to restart your terminal.

After setup, `engineer` works from any directory. Re-run `pnpm run setup` (or just `pnpm run build`) after changing code.

> **Dev mode:** use `pnpm dev <command>` to run the CLI without building or linking.

## Development Resets

`scripts/reset.sh` rebuilds from scratch for fast iteration — it stops the daemon, rebuilds, relinks the CLI, clears the data directory, and starts fresh.

```bash
./scripts/reset.sh                            # Full wipe, then interactive setup
./scripts/reset.sh <seed-dir>                 # Full wipe, then seeded setup from <seed-dir>
./scripts/reset.sh --persist-data             # Keep the database, workspaces, and .env
./scripts/reset.sh --persist-data <seed-dir>  # Same, seeded from <seed-dir>
```

The seed directory is optional. With no seed, `engineer start` runs its interactive first-run setup; with a seed, setup is read from the directory's YAML files with no prompts (see [First Run](#first-run)). A seed argument that does not exist or cannot be read is a hard error.

**Seed-directory convention:** `seed-example/` is tracked as a generic reference for the layout. Personal seeds live in gitignored `seed-example-<name>/` directories — copy `seed-example/`, fill in real values, and pass the directory to `reset.sh` or `engineer start --seed`.

## ENGINEER_HOME

Every command reads and writes to a single data directory. Resolution order:

1. `--home <path>` flag (highest priority)
2. `ENGINEER_HOME` environment variable
3. `~/.engineer` (default)

Directory structure (created automatically on first `engineer start`):

```
~/.engineer/
  .env                # Secrets (KEY=VALUE, 0o600 permissions)
  config/             # YAML config files
    plugins/          # Plugin-specific configs
  data/               # SQLite database
  logs/               # Daemon log files (rolling JSON)
  run/                # PID file
  traces/             # agent prompt/response blobs (content-addressable)
  workspaces/         # Git worktrees for task isolation
  example-templates/  # Fully documented config references
```

Source: [`src/cli/home.ts`](../src/cli/home.ts)

## Global Options

| Option | Description |
|--------|-------------|
| `--home <path>` | Override ENGINEER_HOME |
| `--verbose` | Debug-level logging |
| `--json` | Output in JSON format |
| `--version` | Print version |
| `--help` | Print help for any command |

## First Run

```bash
engineer start
```

That's it. On first run, `start` detects there's no config and launches guided setup:

1. **Environment detection** — scans PATH for coding agent CLIs (`claude`, `opencode`, `gemini`, `bash`), checks env vars
2. **Plugin selection** — one prompt per adapter type (agent, trigger, communication, git hosting), grouped by category, with detection status shown
3. **Per-plugin config** — prompts for required fields (repos to watch, etc.)
4. **People Directory** — configures the owner (the single person The Engineer reaches) and optional additional people. For each person: name, identifier, roles, and a handle for each selected communication channel (derived from plugin manifests). Generates `people.yaml` with real values instead of placeholders.
5. **Secret collection** — prompts for token values with masked input (e.g., `GITHUB_TOKEN`). Tokens already set in your shell are captured and persisted to `~/.engineer/.env` automatically. Permissions: `0o600`.
6. **Confirmation** — summary of selections, Y/n
7. **Config written** — YAML files to `~/.engineer/config/`, secrets to `~/.engineer/.env`
8. **Daemon starts** — pre-flight checks, bootstrap, tick loop begins

**Non-interactive setup** (CI, automation, teams):

```bash
engineer start --seed ./seed-example/
```

Seeds both plugin configs and core configs from the provided directory. No prompts. The seed directory structure:

```
seed-example/
  plugins/          # Plugin YAML configs (required)
  configs/          # Core YAML configs: people.yaml, daemon.yaml, etc. (optional — falls back to templates)
```

Validates that `plugins/` exists and has `.yaml` files. If `configs/` is present, uses those files; otherwise generates core configs from templates. Verifies all `${VAR}` references resolve after setup — fails loudly if tokens are missing.

**Dry run** (see what would happen without writing):

```bash
engineer start --dry-run
```

## Commands

### start

The single entry point. Handles first-run setup, config loading, pre-flight checks, and daemon startup.

```bash
engineer start                           # Foreground (Ctrl+C to stop)
engineer start --daemon                  # Background (detached process)
engineer start --verbose                 # Debug logging
engineer start --dry-run                 # Show what would happen, don't start
engineer start --seed ./seed-example/    # Non-interactive setup from seed directory
```

**Startup sequence:** first-run detection → setup if needed → load `.env` → capture shell env vars to `.env` → load config → pre-flight [doctor](#doctor) checks (the no-config subset) → bootstrap all components → start tick loop → launch dashboard (React SPA on port 3847).

**Signal handling:** `SIGTERM` and `SIGINT` trigger graceful shutdown — active tasks transition to `queued`, plugins shut down, PID file cleaned up.

Source: [`src/cli/commands/start/start.ts`](../src/cli/commands/start/start.ts), [`src/cli/commands/start/bootstrap.ts`](../src/cli/commands/start/bootstrap.ts)

### stop

Graceful shutdown. Sends `SIGTERM` to the daemon and waits for clean exit.

```bash
engineer stop                            # Default 30s timeout
engineer stop --timeout 1m              # Custom timeout
```

Source: [`src/cli/commands/stop.ts`](../src/cli/commands/stop.ts)

### status

Shows whether the daemon is running and lists non-terminal tasks with their 8-character ID prefix, state, title, and age. Use the printed prefix with `why` or `retry`. Reads SQLite directly (read-only, no IPC).

```bash
engineer status                          # Non-terminal tasks (active, queued, blocked, etc.)
engineer status --all                    # Include completed, failed, and cancelled tasks
```

Example output:

```
  The Engineer: running (PID 25725)
  Tasks: 1 active, 1 queued

    active  01HXYZ12  Add OAuth scope toggle              3m ago
    queued  01HXYW98  Fix README link rot                  7m ago
```

Source: [`src/cli/commands/status.ts`](../src/cli/commands/status.ts)

### logs

Tails the daemon log file.

```bash
engineer logs                            # Last 50 lines, pretty-printed
engineer logs --raw                      # Raw JSON (no pretty-printing)
engineer logs --lines 100               # Last 100 lines
engineer logs --follow                   # Stream new entries (like tail -f)
```

Source: [`src/cli/commands/logs.ts`](../src/cli/commands/logs.ts)

### doctor

Runs independent health check categories. No daemon required — works standalone.

```bash
engineer doctor
```

**Exit codes:** `0` = all pass, `1` = failures found, `2` = warnings only.

| Category | What it checks |
|----------|----------------|
| Node.js Runtime | `process.version >= 22.0.0` |
| Data Directory | ENGINEER_HOME exists, writable, subdirs present |
| Config Files | Every core YAML config parses and passes Zod validation |
| Required Secrets | All `${ENV_VAR}` references in configs resolve + `.env` file permissions |
| Database | SQLite file accessible |
| Plugin Manifests | Plugin config files parse correctly |
| Workspace | Git binary available, workspace dir exists |
| External Dependencies | agent CLIs on PATH |
| People Directory | An owner is configured, the single-user constraint is respected, and the owner's channels have an installed communication plugin (needs loaded config) |
| Risky Config | Warnings for auto-merge enabled, missing cost limits, high concurrency (needs loaded config) |

The People Directory and Risky Config categories need a loaded config bundle, so they run only when
config loads. On `engineer start`, a pre-flight subset runs automatically before the daemon boots —
every category above except Workspace, People Directory, and Risky Config.

Source: [`src/cli/commands/doctor.ts`](../src/cli/commands/doctor.ts)

### why

Displays a timeline of significant events for a task — state transitions, events, journal entries, and cost. Opens the database read-only; no daemon required. Accepts a full task ID or a unique prefix (e.g., the 8-char prefix from `engineer status`).

```bash
engineer why <task-id>                   # Human-readable timeline
engineer why 01HXYZ12                    # Works with ID prefix
engineer why <task-id> --json            # Machine-readable JSON output
```

Source: [`src/cli/commands/why.ts`](../src/cli/commands/why.ts)

### retry

Re-queues a `blocked` or `failed` task so the daemon picks it up on the next scheduling cycle. Resets both per-category retry counters (crash, agent-unavailable) and clears `not_before` so the retry cycle starts fresh. Direct database access — usable even when the daemon is stopped. Accepts a full task ID or a unique prefix.

```bash
engineer retry <task-id>                 # Re-queue a blocked or failed task
engineer retry 01HXYZ12                  # Works with ID prefix
engineer retry <task-id> --json          # Machine-readable JSON output
```

Use this when:

- A task is `blocked` because external input is now available (e.g., you answered a clarifying question outside the chat).
- A task is `failed` because the [retry policy](configuration/daemon.md#retry-policy) exhausted its automatic budget, or because the [hard cap](configuration/daemon.md#stuck-detection) on total active time triggered. Address the root cause first, then retry.

Source: [`src/cli/commands/retry.ts`](../src/cli/commands/retry.ts)

## Configuration

Config files live in `~/.engineer/config/`. Generated on first run with conservative defaults. Edit YAML directly — most changes take effect on next daemon restart.

**Core configs:**
- `daemon.yaml` — tick interval, concurrency, plugin health settings
- `orchestrator.yaml` — RRPIR phases, notifications
- `safety.yaml` — cost limits, autonomy level, merge policy
- `workspace.yaml` — worktree root, branch prefix, PR defaults, cleanup
- `people.yaml` — the owner and their contact channels for communication

**Plugin configs** (`config/plugins/`):
- One YAML file per enabled plugin (e.g., `github-trigger.yaml`, `claude-code-agent.yaml`)
- A plugin is enabled if and only if its config YAML exists
- Secrets use `${ENV_VAR}` references — actual values live in `.env`

**Secrets** (`~/.engineer/.env`):
- Collected during first-run setup with masked input, or add manually
- Format: `KEY=VALUE` (one per line, `#` for comments)
- **Auto-persistence:** On every `engineer start`, env vars from your shell that match `${VAR}` references in configs are automatically captured and written to `.env`. This ensures tokens survive across terminal sessions and background daemon restarts.
- Environment variables already set in your shell take precedence over `.env` values
- File permissions: `0o600` (owner read/write only) — `engineer doctor` warns if too open
- Plugin configs reference secrets as `${GITHUB_TOKEN}` — resolved at startup from `.env` or env vars

**Example templates** (`example-templates/`):
- Fully documented reference for every config field
- Written on first run — always safe to regenerate

To reconfigure: `engineer stop`, edit YAML files, `engineer start`.

To start fresh: `rm -rf ~/.engineer && engineer start`.
