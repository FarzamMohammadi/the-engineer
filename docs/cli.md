# CLI Reference

The Engineer is operated through the `engineer` CLI. All commands share a common data directory (`ENGINEER_HOME`) and global options.

## ENGINEER_HOME

Every command reads and writes to a single data directory. Resolution order:

1. `--home <path>` flag (highest priority)
2. `ENGINEER_HOME` environment variable
3. `~/.engineer` (default)

Directory structure (created by `engineer init`):

```
~/.engineer/
  config/             # YAML config files
    plugins/          # Plugin-specific configs
  data/               # SQLite database
  logs/               # Daemon log files (rolling JSON)
  run/                # PID file
  workspaces/         # Git worktrees for task isolation
```

Source: [`src/cli/home.ts`](../src/cli/home.ts)

## Global Options

| Option | Description |
|--------|-------------|
| `--home <path>` | Override ENGINEER_HOME |
| `--verbose` | Debug-level logging |
| `--version` | Print version |
| `--help` | Print help for any command |

## First-Run Walkthrough

```bash
# 1. Create directory structure + 11 template config files
engineer init

# 2. Edit configs — at minimum, set API keys and target repos
#    Core: daemon.yaml, orchestrator.yaml, safety.yaml, workspace.yaml, people.yaml
#    Plugins: github-trigger.yaml, telegram-comm.yaml, etc.
vim ~/.engineer/config/daemon.yaml

# 3. Validate configs parse correctly against schemas
engineer config validate

# 4. Run full health check (10 categories)
engineer doctor

# 5. Start the daemon
engineer start                   # Foreground (recommended for first run)
engineer start --daemon          # Background (detached process)
```

`init` is safe to run multiple times — it skips existing files unless `--force` is passed.

## Commands

### init

Creates the directory structure and writes 11 template config files with commented defaults.

```bash
engineer init                    # Skip existing files
engineer init --force            # Overwrite existing configs
```

**Template files created:** 5 core configs (`daemon.yaml`, `orchestrator.yaml`, `safety.yaml`, `workspace.yaml`, `people.yaml`) + 6 plugin configs in `config/plugins/`. Core configs are fully commented (Zod defaults apply). Plugin configs have required fields uncommented with placeholders.

Source: [`src/cli/commands/init.ts`](../src/cli/commands/init.ts), [`src/cli/templates.ts`](../src/cli/templates.ts)

### doctor

Runs 10 independent health check categories. No daemon required — works standalone.

```bash
engineer doctor                  # Run all 10 categories
```

**Exit codes:** `0` = all pass, `1` = failures found, `2` = warnings only.

| # | Category | What it checks |
|---|----------|----------------|
| 1 | Node.js Runtime | `process.version >= 22.0.0` |
| 2 | Data Directory | ENGINEER_HOME exists, writable, subdirs present |
| 3 | Config Files | All 5 YAML configs parse and pass Zod validation |
| 4 | Required Secrets | All `${ENV_VAR}` references in configs resolve |
| 5 | Database | SQLite file accessible |
| 6 | Plugin Manifests | `engineer.plugin.yaml` files parse correctly |
| 7 | GitHub Connectivity | *Stub — Phase 14b* |
| 8 | Telegram Connectivity | *Stub — Phase 14c* |
| 9 | Workspace | Git binary available, workspace dir exists |
| 10 | Risky Config | Warnings for auto-merge enabled, missing cost limits |

Categories 1-6 also run automatically as pre-flight checks on `engineer start`.

Source: [`src/cli/commands/doctor.ts`](../src/cli/commands/doctor.ts)

### config validate

Validates all config files against their Zod schemas.

```bash
engineer config validate         # Reports per-file pass/fail
```

Source: [`src/cli/commands/config-validate.ts`](../src/cli/commands/config-validate.ts)

### start

Boots the daemon. Foreground by default — the process stays alive and logs to stdout.

```bash
engineer start                   # Foreground (Ctrl+C to stop)
engineer start --daemon          # Background (detached process)
engineer start --verbose         # Debug logging
```

**Startup sequence:** auto-create dirs → load config → pre-flight checks (doctor 1-6) → bootstrap all components → start tick loop.

**Signal handling:** `SIGTERM` and `SIGINT` trigger graceful shutdown — active tasks transition to `queued`, PID file is cleaned up.

**Background mode** (`--daemon`): spawns a detached child process and exits. Use `engineer status` to check, `engineer stop` to stop.

Source: [`src/cli/commands/start.ts`](../src/cli/commands/start.ts), [`src/cli/bootstrap.ts`](../src/cli/bootstrap.ts)

### stop

Sends `SIGTERM` to the running daemon and waits for clean exit.

```bash
engineer stop                    # Default 30s timeout
engineer stop --timeout 60000   # Custom timeout in ms
```

Source: [`src/cli/commands/stop.ts`](../src/cli/commands/stop.ts)

### status

Shows whether the daemon is running and, if a database exists, task queue depth.

```bash
engineer status
```

Reads SQLite directly (read-only) — no IPC to the daemon. Plugin health display is deferred to Phase 14b.

Source: [`src/cli/commands/status.ts`](../src/cli/commands/status.ts)

### logs

Tails the daemon log file.

```bash
engineer logs                    # Last 50 lines, pretty-printed
engineer logs --json             # Raw JSON (pino format)
engineer logs --lines 100        # Last 100 lines
engineer logs --follow           # Stream new entries (like tail -f)
```

Source: [`src/cli/commands/logs.ts`](../src/cli/commands/logs.ts)

### install

Generates OS service configuration for running the daemon at login.

```bash
engineer install                 # Detects platform automatically
```

- **macOS**: generates launchd plist at `~/Library/LaunchAgents/com.engineer.daemon.plist`
- **Linux**: generates systemd unit at `~/.config/systemd/user/engineer.service`

Prints the generated file and registration instructions — does not auto-register.

Source: [`src/cli/commands/install.ts`](../src/cli/commands/install.ts)
