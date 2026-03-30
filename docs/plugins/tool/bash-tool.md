# Bash Shell Tool

Executes shell commands via `spawn("bash", ["-c", cmd])` inside task workspaces. This is the Engineer's hands -- every file read, write, test run, and git operation goes through this plugin.

The plugin enforces workspace confinement, environment sanitization, output limits, command timeouts, and blocked command patterns. These are safety boundaries, not suggestions.

## Requirements

| Type | Name | Notes |
|------|------|-------|
| binary | `bash` | Must be available on `PATH`. Health check verifies this. |

No environment variables or accounts required. The plugin runs with whatever permissions the Engineer process has.

## Capabilities

The tool exposes a single `bash` action with four action classes:

| Action Class | Description |
|-------------|-------------|
| `read` | File reads, directory listings, code search |
| `write` | File creation, modification, deletion within workspace |
| `test` | Running test suites, linters, build commands |
| `git-local` | Local git operations (commit, branch, diff, log) |

The action class is declared for the Action Pipeline's permission gates. The actual command is unrestricted within the workspace, subject to blocked patterns.

## Configuration

Config file: `~/.engineer/config/plugins/bash-tool.yaml`

```yaml
# All fields are optional -- defaults shown below.
env_passthrough: []                  # Extra env vars to forward to child processes (default: [])
max_output_bytes: 10485760           # Output limit in bytes -- 10 MB (default: 10485760)
command_timeout_ms: 300000           # Command timeout in ms -- 5 min (default: 300000)
blocked_patterns: [...]              # Regex patterns that block commands (see defaults below)
audit_commands: true                 # Include full command text in side_effects (default: true)
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `env_passthrough` | `string[]` | `[]` | Additional environment variables to forward to child processes, beyond the built-in allowlist. Known secret vars (`GITHUB_TOKEN`, `TELEGRAM_BOT_TOKEN`, etc.) are silently stripped even if listed here. |
| `max_output_bytes` | `integer` | `10485760` (10 MB) | Maximum combined stdout+stderr size. Process is killed if exceeded. |
| `command_timeout_ms` | `integer` | `300000` (5 min) | Maximum execution time. Process receives SIGTERM, then SIGKILL after 5s grace. |
| `blocked_patterns` | `string[]` | See below | Case-insensitive regex patterns. If any pattern matches the command string, execution is blocked. |
| `audit_commands` | `boolean` | `true` | When true, the full command text is included in `side_effects` for audit logging. |

### Default Blocked Patterns

These patterns are applied by default and block commands that match:

**Credential/secret exfiltration:**
- `curl.*\benv\b` -- curl piping environment variables
- `wget.*\benv\b` -- wget piping environment variables
- `cat.*/etc/shadow` -- reading shadow password file
- `cat.*/etc/passwd` -- reading passwd file

**Destructive operations outside workspace:**
- `rm\s+-rf\s+/` -- recursive delete from root
- `rm\s+-rf\s+~` -- recursive delete from home
- `mkfs\.` -- filesystem formatting
- `dd\s+if=` -- raw disk writes

**Process/system manipulation:**
- `kill\s+-9` -- force kill processes
- `killall` -- kill by name
- `shutdown` -- system shutdown
- `reboot` -- system reboot

**Network exfiltration:**
- `nc\s+-l` -- netcat listener
- `\bncat\b` -- ncat
- `\bsocat\b` -- socat

**Environment variable dumping (secrets):**
- `^\s*\benv\b\s*$` -- bare `env` command
- `\bprintenv\b` -- printenv
- `^\s*set\s*$` -- bare `set` command
- `^\s*export\s*$` -- bare `export` command

You can override `blocked_patterns` in config to replace the defaults entirely. There is no way to append -- if you set this field, you own the full list.

## How It Works

**Workspace confinement (Decision #108, Rule 3).** Every command runs with `cwd` set to the task's workspace path. Symlinks are resolved via `realpathSync` before execution to prevent directory traversal escapes.

**Environment sanitization (Decision #108, Rule 4).** Child processes receive only allowlisted environment variables:
- `PATH`, `HOME`, `NODE_ENV`, `LANG`, `TERM`
- `GIT_AUTHOR_NAME`, `GIT_COMMITTER_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_EMAIL`
- `GIT_SSH_COMMAND`, `GIT_TERMINAL_PROMPT`
- Plus any variables listed in `env_passthrough` (minus known secrets)

Everything else -- `GITHUB_TOKEN`, `TELEGRAM_BOT_TOKEN`, API keys -- is not forwarded.

**Signal forwarding (Decision #108, Rule 2).** When a command times out or output exceeds the limit:
1. `SIGTERM` is sent to the child process
2. A 5-second grace period allows cleanup
3. If the process is still running, `SIGKILL` is sent

On plugin shutdown, all active child processes receive the same SIGTERM-then-SIGKILL sequence.

**Command validation.** Before spawning, the command string is tested against all `blocked_patterns` (case-insensitive regex). If any pattern matches, execution is rejected immediately with a `command_blocked` error. The blocked command is recorded in `side_effects`.

**Output collection.** stdout and stderr are interleaved into a single buffer. If the combined size exceeds `max_output_bytes`, the process is killed and the partial output is returned with an `output_limit` error.

**Result structure.** Every execution returns:
- `success`: whether exit code was 0
- `output`: combined stdout+stderr text
- `side_effects`: array with command details (command text, exit code, timeout/limit flags)
- `error`: structured adapter error on failure (`command_failed`, `timeout`, `output_limit`, `command_blocked`, `spawn_error`)

**Initialization safety.** During config parsing, if `env_passthrough` contains known secret variable names (from the central `SECRET_ENV_VARS` list), those entries are silently removed and a warning is returned. The plugin still initializes successfully.

## Limitations

- No shell state persistence between commands. Each execution spawns a fresh `bash -c` process. Environment variables, aliases, and working directory changes do not carry over.
- No interactive input. `stdin` is immediately closed. Commands that prompt for input will hang until timeout.
- Blocked patterns are regex-based and can be circumvented by creative shell quoting or indirection. They are a safety net, not a security boundary. The real confinement comes from workspace `cwd` and environment sanitization.
- Output interleaves stdout and stderr. There is no way to get them separately.
- The 10 MB output limit applies to the raw buffer. Commands producing large output (e.g., verbose test suites) should pipe through `tail` or redirect to a file.
- `blocked_patterns` replacement is all-or-nothing. Setting the field in config replaces the entire default list.

## Related Plugins

| Plugin | Relationship |
|--------|-------------|
| `claude-code-llm` / `opencode-llm` / `gemini-cli-llm` | LLM plugins decide what commands to run. Bash Tool executes them. |
| `github-hosting` | Handles remote git operations (PRs, merges). Bash Tool handles local git (`commit`, `branch`, `diff`). |
