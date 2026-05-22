# Configuration

The Engineer uses YAML configuration files stored in `~/.engineer/config/`. All fields are optional — sensible defaults are applied via Zod schema validation when fields are missing.

## Config Files

| File | Purpose |
|------|---------|
| [daemon.yaml](daemon.md) | Daemon runtime: concurrency, tick loop, logging, polling |
| [orchestrator.yaml](orchestrator.md) | RRPIR pipeline, notifications, decomposition, phases |
| [safety.yaml](safety.md) | Cost limits, scope boundaries, autonomy, merge policy |
| [workspace.yaml](workspace.md) | Git operations, branch naming, PR settings, cleanup |
| [people.yaml](people.md) | People directory: roles, contacts, notification preferences |

Plugin-specific configs live in `~/.engineer/config/plugins/` and are documented in [docs/plugins/](../plugins/).

## How Config Loading Works

On `engineer start`, all config files are loaded from `~/.engineer/config/` (or the directory specified by the `--config-dir` flag / `ENGINEER_CONFIG_DIR` env var). Missing files are not errors — Zod defaults apply for every field.

The load order:
1. Read YAML file (if it exists)
2. Parse through Zod schema (applies defaults, validates types)
3. Return typed config object

If a config directory is explicitly specified but doesn't exist, the daemon fails loudly. If using the default `~/.engineer/config/` path, missing files silently use defaults.

## Applying Config Changes

All config files are read once at startup. Edit a file, then run `engineer stop` and `engineer start` for the change to take effect. There is no runtime hot-reload.

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

## First Run

The first `engineer start` invocation walks you through interactive setup and writes the config directory. Use `engineer start --seed <dir>` to seed configuration non-interactively from a saved seed directory. Either path also writes fully documented example templates to `~/.engineer/example-templates/` for reference.

## Source of Truth

All config schemas are defined in `src/schemas/config.ts` using Zod. The schema definitions are the authoritative source — these docs are derived from them.
