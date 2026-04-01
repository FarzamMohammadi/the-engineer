# Claude Code LLM

The Claude Code LLM plugin is the default and most full-featured LLM option. It spawns the Claude CLI (`claude`) as a child process with `--print --output-format stream-json --verbose`, parses the NDJSON output for result events, and returns content, cost, and detailed token usage (including cache breakdown).

This is the recommended choice if you have a Claude Pro/Max subscription or API access. It is the only LLM plugin that supports quota reporting -- it reads your OAuth credentials to query Anthropic's usage API for real utilization percentages across quota windows.

## Requirements

| Requirement | Details |
|---|---|
| **`claude` CLI** | Install the Claude Code CLI and authenticate before starting The Engineer. The plugin runs `claude --version` as a health check. |
| **Authentication** | Log in via `claude` before first use. OAuth credentials are read from the OS keychain (macOS) or `~/.claude/.credentials.json` (Linux/Windows) for quota reporting. |

No environment variables are needed -- the Claude CLI handles its own authentication. The plugin is marked `critical: true`.

## Capabilities

- Full inference with system prompt support (`--system-prompt` flag)
- Prompt piped via stdin to avoid OS argument length limits
- Usage reporting: input/output tokens, cache read/creation tokens, total tokens, service tier, model ID
- Cost reporting: `total_cost_usd` or `cost_usd` from the CLI result event
- Quota reporting via Anthropic's OAuth usage API (five_hour, seven_day, and model-specific windows)
- Rate limit detection from `rate_limit_event` stream events
- Environment sanitization -- only allowlisted env vars forwarded to the subprocess (no secrets leak)
- Uses `--setting-sources user` to prevent loading project-level CLAUDE.md from the working directory
- Uses `--dangerously-skip-permissions` for non-interactive tool use (read/write/bash)
- Active process tracking with SIGTERM on shutdown
- 200,000 token context window reported

## Configuration

Config file: `~/.engineer/config/plugins/claude-code-llm.yaml`

| Field | Type | Default | Required | Description |
|---|---|---|---|---|
| `model` | `string` | `claude-sonnet-4-20250514` | No | Model identifier passed to `--model`. |
| `max_tokens` | `number` | `16384` | No | Maximum output tokens per completion. |
| `cli_path` | `string` | `claude` | No | Path to the Claude CLI binary. Change if it is not on your PATH. |

### Minimal config

All fields have defaults. An empty config file works:

```yaml
# Claude Code LLM plugin
# Uses Claude CLI for LLM completions
```

### Full config

```yaml
model: claude-sonnet-4-20250514
max_tokens: 16384
cli_path: claude
```

## How It Works

**Inference**: The plugin spawns `claude --print --output-format stream-json --verbose --model <model> --setting-sources user --dangerously-skip-permissions` with an optional `--system-prompt` flag. The prompt is written to stdin, then stdin is closed. The CLI streams NDJSON events to stdout.

**Output parsing**: The parser (`parseCliOutput`) scans for two event types:
- `type: "result"` -- the final output containing content (string or `{text}` object), `total_cost_usd`, and `usage` (token counts, cache stats, service tier). The `modelUsage` field provides the actual model ID.
- `type: "rate_limit_event"` -- quota window status (allowed/exhausted) with reset timestamps.

**Quota reporting**: `getQuotaStatus()` first tries the Anthropic OAuth usage API (`/api/oauth/usage`). The OAuth token is read from the OS credential store (macOS Keychain via `security find-generic-password`, or `~/.claude/.credentials.json` on other platforms). The token is piped to curl via stdin so it never appears in the process list. Results are cached for 30 minutes to respect Anthropic's aggressive per-token rate limits. If the API call fails, cached `rate_limit_event` data from the last inference call is used as a fallback.

**Environment isolation**: A strict allowlist controls which env vars reach the subprocess. Only system essentials (HOME, PATH, SHELL, LANG, TERM, TMPDIR), XDG dirs, Node.js config, TLS/proxy settings, and locale vars (LC_*) are forwarded. GITHUB_TOKEN, TELEGRAM_BOT_TOKEN, and other secrets are blocked.

## Limitations

- Requires the Claude CLI to be installed and authenticated separately -- the plugin does not handle login.
- Quota API access depends on having valid OAuth credentials in the Claude Code credential store. API key users will not get quota percentages (only rate_limit_event fallback).
- The 30-minute quota cache means utilization percentages can be stale during heavy usage.
- `max_tokens` is defined in config but not currently passed as a CLI flag (the Claude CLI manages its own output limits).
- Non-zero exit codes from the CLI trigger output salvage: if valid NDJSON was produced, the result is used. Signal kills (SIGTERM/SIGKILL) are not retried.
- No per-invocation timeout — the daemon's `max_active_duration_ms` and stuck detection handle runaway tasks at the right level.

## Related Plugins

| Plugin | Relationship |
|---|---|
| **opencode-llm** | Alternative LLM plugin supporting multiple providers (Anthropic, OpenAI, Google) via one CLI. |
| **gemini-cli-llm** | Alternative LLM plugin using Google's free Gemini CLI. No cost tracking. |

Only one LLM plugin is active at a time. The Daemon uses the configured LLM plugin for all Orchestrator phase inference.
