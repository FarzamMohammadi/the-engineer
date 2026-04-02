# Configuration

The Engineer uses YAML configuration files stored in `~/.engineer/config/`. All fields are optional — sensible defaults are applied via Zod schema validation when fields are missing.

## Config Files

| File | Purpose | Hot-Reload |
|------|---------|------------|
| [daemon.yaml](daemon.md) | Daemon runtime: concurrency, tick loop, logging, polling | No |
| [orchestrator.yaml](orchestrator.md) | RRPIR pipeline, notifications, decomposition, phases | No |
| [safety.yaml](safety.md) | Cost limits, scope boundaries, autonomy, merge policy | **Yes** |
| [workspace.yaml](workspace.md) | Git operations, branch naming, PR settings, cleanup | No |
| [people.yaml](people.md) | People directory: roles, contacts, notification preferences | **Yes** |

Plugin-specific configs live in `~/.engineer/config/plugins/` and are documented in [docs/plugins/](../plugins/).

## How Config Loading Works

On `engineer start`, all config files are loaded from `~/.engineer/config/` (or the directory specified by `--config` flag / `ENGINEER_CONFIG_DIR` env var). Missing files are not errors — Zod defaults apply for every field.

The load order:
1. Read YAML file (if it exists)
2. Parse through Zod schema (applies defaults, validates types)
3. Return typed config object

If a config directory is explicitly specified but doesn't exist, the daemon fails loudly. If using the default `~/.engineer/config/` path, missing files silently use defaults.

## Hot-Reloadable Configs

**safety.yaml** and **people.yaml** are hot-reloadable — changes take effect without restarting the daemon. A file watcher detects changes with a 500ms debounce. All other config files require a daemon restart.

## Environment Variable References

Config values can reference environment variables using `${VAR_NAME}` syntax. Variables are resolved at load time from the process environment and `~/.engineer/.env`.

```yaml
bot_token: "${TELEGRAM_BOT_TOKEN}"
```

## Duration Strings

Some fields accept human-readable duration strings that are parsed to milliseconds:

- `"5s"` = 5,000 ms
- `"30m"` = 1,800,000 ms
- `"8h"` = 28,800,000 ms
- `"1d"` = 86,400,000 ms

Check individual field documentation for which fields support this.

## First Run: `engineer init`

Running `engineer init` or `engineer start --seed <dir>` creates the config directory with starter files. Example templates with full documentation for every field are written to `~/.engineer/example-templates/` for reference.

## Source of Truth

All config schemas are defined in `src/schemas/config.ts` using Zod. The schema definitions are the authoritative source — these docs are derived from them.
