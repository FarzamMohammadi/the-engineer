# Gemini CLI Agent

The Gemini CLI agent plugin uses Google's Gemini CLI tool for agent execution. It runs on the free tier -- there is no cost data (cost_usd is always null). The plugin invokes `gemini -p "" -o stream-json --model <model> --yolo` with the prompt piped via stdin, parses NDJSON output for content and token usage, and detects rate limits from both stdout and stderr.

Use this plugin for zero-cost experimentation or as a fallback when paid providers hit quota limits.

## Requirements

| Requirement | Details |
|---|---|
| **`gemini` CLI** | Install the Google Gemini CLI and authenticate before starting The Engineer. The plugin runs `gemini --version` as a health check. |
| **Google account** | Log in via `gemini` before first use. Free tier access requires a Google account. |

No API keys or environment variables needed. The plugin is marked `critical: true`.

## Capabilities

- Free-tier agent execution via Google's Gemini CLI
- Token usage reporting: input, output, cached, total
- Quota status reporting (exhausted/available based on rate limit detection)
- System prompt prepended to user prompt (no native `--system-prompt` flag)
- Working directory support (passed as `cwd` to the spawned process)
- Rate limit detection from both stdout (error result events) and stderr (retry messages) -- process killed immediately on stderr detection
- Live activity streaming (`supports_activity_streaming: true`) -- maps each stream-json event to a canonical activity event for the dashboard's live Agent Calls feed
- `--yolo` flag for auto-approved tool calls (required for non-interactive use)
- Environment sanitization -- only allowlisted env vars forwarded to the subprocess
- Active process tracking with SIGTERM on shutdown

Does **not** support:
- Cost reporting (`cost_usd` is always `null`)
- Context window reporting (`context_window: null`)

## Configuration

Config file: `~/.engineer/config/plugins/gemini-cli-agent.yaml`

| Field | Type | Default | Required | Description |
|---|---|---|---|---|
| `model` | `string` | `gemini-2.5-pro` | No | Gemini model identifier passed to `--model`. |
| `cli_path` | `string` | `gemini` | No | Path to the Gemini CLI binary. |
| `command_timeout_ms` | `number` | `600000` | No | Timeout for each CLI invocation (10 minutes). |
| `max_cli_output_bytes` | `number` | `500000000` | No | Maximum bytes of CLI stdout before the process is killed (default 500 MB). Prevents memory blowups from runaway output. |

### Minimal config

All fields have defaults. An empty config file works:

```yaml
# Gemini CLI Agent plugin
# Drives Google's Gemini CLI as an autonomous coding agent
# Free tier -- no cost tracking
```

### Full config

```yaml
model: gemini-2.5-pro
cli_path: gemini
command_timeout_ms: 600000
max_cli_output_bytes: 500000000
```

## How It Works

**Inference**: The plugin spawns `gemini -p "" -o stream-json --model <model> --yolo`. The `-p ""` flag enables non-interactive mode -- Gemini appends stdin content to the empty prompt value. `--yolo` auto-approves any tool calls the model wants to make. The prompt is written to stdin, then stdin is closed.

**System prompt handling**: Gemini CLI has no `--system-prompt` flag. When a system prompt is provided, the plugin prepends it to the user prompt wrapped in `[SYSTEM INSTRUCTIONS]...[END SYSTEM INSTRUCTIONS]` markers.

**Output parsing**: The parser (`processGeminiNdjsonLine`) scans for three NDJSON event types:
- `type: "init"` -- session metadata including the model ID.
- `type: "message", role: "assistant"` -- response content, concatenated into the final output.
- `type: "result"` -- token stats (`stats.input_tokens`, `stats.output_tokens`, `stats.total_tokens`, `stats.cached`). Also checked for `status: "error"` with rate limit messages.

**Live activity streaming**: When the orchestrator passes an `on_activity` sink (the live-activity feature is on by default), a separate pure mapper (`activityEventsFromLine`) maps each stream-json line to a block-level canonical `AgentActivityEvent` and emits it as the line arrives -- best-effort, so a failing sink can never break or slow the run. The stream-json shapes are otherwise undocumented; the mapping was verified against a real captured `gemini -o stream-json --yolo` run (the test fixture):
- `type: "init"` -- becomes one `session` event (model only; the stream carries no tool count or cwd).
- `type: "message", role: "assistant"` -- `content` becomes one `assistant_text` event. The echoed `role: "user"` prompt line is ignored.
- `type: "tool_use"` -- `tool_id`, `tool_name`, `parameters` become one `tool_use` event.
- `type: "tool_result"` -- `tool_id`, `status` (`ok` when `"success"` else `error`), `output` become one `tool_result` event.
- `type: "result"` -- produces no activity event.

**Rate limit detection (dual-path)**:
1. **stdout**: If a `type: "result"` event has `status: "error"` and the error message matches rate limit patterns (`exhausted.*capacity`, `quota`, `rate limit`), the plugin flags it as rate limited and rejects with a retryable error.
2. **stderr**: The plugin monitors stderr for the same patterns. On detection, it immediately sends SIGTERM to the child process. This is critical because the Gemini CLI retries infinitely on rate limits -- without this kill, the process would hang forever.

**Quota reporting**: `getQuotaStatus()` returns a simple exhausted/not-exhausted status based on the `rateLimited` flag from the last inference call. There is no usage API to query actual percentages.

**Environment isolation**: Same allowlist as all agent plugins -- only system essentials, XDG dirs, Node.js config, TLS/proxy settings, and locale vars are forwarded.

## Limitations

- No cost data whatsoever -- `cost_usd` is always null. The free tier does not expose billing information.
- No usage API for quota percentages -- you only know if you are rate limited, not how close you are to the limit.
- System prompts are prepended to the user prompt as text markers, not passed as a native parameter.
- The Gemini CLI retries infinitely on rate limits. The plugin mitigates this by killing the process, but there is a brief window where retries may occur before stderr detection triggers.
- `cache_creation_tokens` is always 0 (Gemini reports `cached` but not cache creation).
- No `max_tokens` config field -- output length is controlled by the model defaults.

## Related Plugins

| Plugin | Relationship |
|---|---|
| **claude-code-agent** | The default agent plugin. Full cost/quota reporting, native system prompt support. Best for production use. |
| **opencode-agent** | Multi-provider alternative supporting Anthropic, OpenAI, Google, and others through one CLI. Reports cost. |

Only one agent plugin is active at a time.
