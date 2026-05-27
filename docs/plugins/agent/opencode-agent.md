# OpenCode Agent

The OpenCode agent plugin provides multi-provider agent execution through the OpenCode CLI. It supports Anthropic, OpenAI, Google, and other providers through a single CLI tool, using the `opencode run --format json` command with NDJSON output parsing.

Use this plugin when you want provider flexibility -- switch between models from different vendors by changing one config field, without swapping plugins.

## Requirements

| Requirement | Details |
|---|---|
| **`opencode` CLI** | Install the OpenCode CLI and configure your provider credentials before starting The Engineer. The plugin runs `opencode --version` as a health check. |
| **Provider credentials** | Authenticate with your chosen provider(s) through OpenCode's own configuration. The Engineer does not manage provider API keys. |

The plugin is marked `critical: true`.

## Capabilities

- Multi-provider inference (Anthropic, OpenAI, Google, and others via OpenCode's provider system)
- Cost reporting from `step_finish` events
- Token usage reporting: input, output, cache read, cache write, total
- Prompt piped via stdin to avoid OS argument length limits
- System prompt prepended to user prompt (no native `--system-prompt` flag)
- Working directory support via `--dir` flag
- Rate limit detection from stderr -- process killed immediately on detection
- Environment sanitization -- only allowlisted env vars forwarded to the subprocess
- Active process tracking with SIGTERM on shutdown

Does **not** support:
- Quota reporting (`supports_quota_reporting: false`)
- Context window reporting (`context_window: null`)

## Configuration

Config file: `~/.engineer/config/plugins/opencode-agent.yaml`

| Field | Type | Default | Required | Description |
|---|---|---|---|---|
| `model` | `string` | `opencode/gemini-3.1-pro` | No | Model in `provider/model` format. |
| `cli_path` | `string` | `opencode` | No | Path to the OpenCode CLI binary. |
| `command_timeout_ms` | `number` | `600000` | No | Timeout for each CLI invocation (10 minutes). |

### Minimal config

All fields have defaults. An empty config file works:

```yaml
# OpenCode Agent plugin
# Multi-provider autonomous coding agent via OpenCode CLI
```

### Full config

```yaml
model: opencode/gemini-3.1-pro
cli_path: opencode
command_timeout_ms: 600000
```

## How It Works

**Inference**: The plugin spawns `opencode run --format json --model <model>` with an optional `--dir <cwd>` flag. The prompt is written to stdin, then stdin is closed. OpenCode streams NDJSON events to stdout.

**System prompt handling**: OpenCode has no `--system-prompt` flag. When a system prompt is provided, the plugin prepends it to the user prompt wrapped in `[SYSTEM INSTRUCTIONS]...[END SYSTEM INSTRUCTIONS]` markers.

**Output parsing**: The parser (`parseOpenCodeOutput`) scans for two NDJSON event types:
- `type: "text"` -- content fragments in `part.text`, concatenated into the final response.
- `type: "step_finish"` -- cost (`part.cost`) and token breakdown (`part.tokens` with input, output, total, and cache read/write).

**Rate limit detection**: The plugin monitors stderr for patterns matching `exhausted your capacity`, `rate limit`, or `quota` (case-insensitive). On detection, it immediately sends SIGTERM to the child process and rejects with a retryable `cli_error`. This prevents the OpenCode CLI from entering infinite retry loops that waste time and potentially cost money.

**Environment isolation**: Same allowlist as all agent plugins -- only system essentials, XDG dirs, Node.js config, TLS/proxy settings, and locale vars are forwarded. No secrets leak to the subprocess.

## Limitations

- No quota reporting -- the plugin cannot tell you how much of your provider's quota you have used.
- No context window size reported -- depends on the underlying model/provider.
- System prompts are prepended to the user prompt as text markers, not passed as a native parameter. The agent sees them as part of the conversation, which is slightly less reliable than native system prompt support.
- Model ID in capabilities reflects the configured model string, not the actual model used by the provider.
- No `max_tokens` config field -- output length is controlled by the underlying provider/model defaults.

## Related Plugins

| Plugin | Relationship |
|---|---|
| **claude-code-agent** | The default agent plugin. Full cost/quota reporting, native system prompt support, 200k context window. Best choice if you only use Anthropic. |
| **gemini-cli-agent** | Google's free-tier Gemini CLI. No cost data. Good for zero-cost experimentation. |

Only one agent plugin is active at a time.
