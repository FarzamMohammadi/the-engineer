# Claude Code Agent

The Claude Code agent plugin is the default and most full-featured agent option. It spawns the Claude CLI (`claude`) as a child process with `--print --output-format stream-json --verbose`, parses the NDJSON output for result events, and returns content, cost, and detailed token usage (including cache breakdown).

This is the recommended choice if you have a Claude Pro/Max subscription or API access. It is the only agent plugin that supports quota reporting -- it reads your OAuth credentials to query Anthropic's usage API for real utilization percentages across quota windows.

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

Config file: `~/.engineer/config/plugins/claude-code-agent.yaml`

| Field | Type | Default | Required | Description |
|---|---|---|---|---|
| `model` | `string` | `claude-sonnet-4-6` | No | Model identifier passed to `--model`. |
| `cli_path` | `string` | `claude` | No | Path to the Claude CLI binary. Change if it is not on your PATH. |
| `command_timeout_ms` | `number` | `7200000` | No | Maximum time per CLI invocation (default 2 hours). Lower if you want a hard cap on phase duration. |
| `max_cli_output_bytes` | `number` | `500000000` | No | Maximum bytes of CLI stdout before the process is killed (default 500 MB). Guards against runaway output exhausting memory. |

### Minimal config

All fields have defaults. An empty config file works:

```yaml
# Claude Code Agent plugin
# Drives the Claude Code CLI as an autonomous coding agent
```

### Full config

```yaml
model: claude-sonnet-4-6
cli_path: claude
command_timeout_ms: 7200000
max_cli_output_bytes: 500000000
```

## How It Works

**Inference**: The plugin spawns `claude --print --output-format stream-json --verbose --model <model> --setting-sources user --dangerously-skip-permissions` with an optional `--system-prompt` flag. The prompt is written to stdin, then stdin is closed. The CLI streams NDJSON events to stdout.

**Output parsing**: The parser (`parseCliOutput`) scans for two event types:
- `type: "result"` -- the final output containing content (string or `{text}` object), `total_cost_usd`, and `usage` (token counts, cache stats, service tier). The `modelUsage` field provides the actual model ID.
- `type: "rate_limit_event"` -- quota window status (allowed/exhausted) with reset timestamps.

**Run outcome**: A result event is a *success* only when it does not report an error. The plugin honors `is_error: true` regardless of what `subtype` says -- a dropped API connection emits `{"subtype": "success", "is_error": true, "result": "API Error: Connection closed mid-response..."}`, and reading `subtype` alone reported that as a successful run. An errored result event fails the run at both decision sites (clean exit and non-zero-exit salvage), carrying the engine's own message so the cause is named rather than surfacing later as a missing `session-result.json`.

**Retry classification**: A failed run is reported to Core as an `AdapterMethodError` whose `retryable` flag says whether it is worth another attempt. Transient infrastructure failures -- dropped connection, socket reset, timeout, rate limit, and status codes (429/5xx) in an error context -- are retryable, and Core's agent-step retry loop absorbs them automatically. The list is an allowlist: anything unrecognized (an authentication failure, a rejected action) is terminal and escalates rather than looping. A clean exit with no result event at all is a truncated stream, so it is also retryable. Engine-specific error shapes stay inside the plugin; Core reads only `retryable`.

**Quota reporting**: `getQuotaStatus()` first tries the Anthropic OAuth usage API (`/api/oauth/usage`). The OAuth token is read from the OS credential store (macOS Keychain via `security find-generic-password`, or `~/.claude/.credentials.json` on other platforms). The token is piped to curl via stdin so it never appears in the process list. Results are cached for 30 minutes to respect Anthropic's aggressive per-token rate limits. If the API call fails, cached `rate_limit_event` data from the last inference call is used as a fallback.

**Environment isolation**: A strict allowlist controls which env vars reach the subprocess. Only system essentials (HOME, PATH, SHELL, LANG, TERM, TMPDIR), XDG dirs, Node.js config, TLS/proxy settings, and locale vars (LC_*) are forwarded. GITHUB_TOKEN, TELEGRAM_BOT_TOKEN, and other secrets are blocked.

## Limitations

- Requires the Claude CLI to be installed and authenticated separately -- the plugin does not handle login.
- Quota API access depends on having valid OAuth credentials in the Claude Code credential store. API key users will not get quota percentages (only rate_limit_event fallback).
- The 30-minute quota cache means utilization percentages can be stale during heavy usage.
- Non-zero exit codes from the CLI trigger output salvage: if a result event was produced *and it reports a successful run*, that result is used. A result event carrying `is_error: true` is never salvaged -- it is a failed run. Signal kills (SIGTERM/SIGKILL) are not retried.
- Cost is not attributed for a run that fails: the spend a dropped-connection run incurred before dying is not carried on the error, so it does not reach the cost ledger.
- A per-invocation timeout (`command_timeout_ms`, default 2 hours) kills a single CLI call that runs too long; the daemon's `max_active_duration_ms` and stuck detection are the higher-level backstops for a runaway task across calls.
- The live Agent Calls feed shows **no reasoning text** for this agent. Current Claude Code versions (since 2.1.72) emit signature-only `thinking` blocks in `--output-format stream-json`: the block structure and `signature` are present but the `thinking` text is empty (upstream [claude-code#32810](https://github.com/anthropics/claude-code/issues/32810)). Per the [adapter contract](README.md#what-core-does-with-the-stream), Core drops these content-less blocks, so the feed simply omits the Thinking line rather than rendering a hollow one. Tool calls, results, and answer text are unaffected. If a future CLI version restores the text, it flows through with no change here.

## Related Plugins

| Plugin | Relationship |
|---|---|
| **opencode-agent** | Alternative agent plugin supporting multiple providers (Anthropic, OpenAI, Google) via one CLI. |
| **gemini-cli-agent** | Alternative agent plugin using Google's free Gemini CLI. No cost tracking. |

Only one agent plugin is active at a time. The Daemon uses the configured agent plugin for all Orchestrator phase inference.
