# Agent Adapter

Agent adapters wrap autonomous coding agent CLIs (Claude Code, OpenCode, Gemini CLI). The Engineer drives them with prompts -- the agent reads and writes files in the workspace, decides what tools to call, and returns structured results. Each plugin spawns a CLI tool as a child process, pipes the prompt via stdin, parses structured output from stdout, and returns content + cost + usage data. The Orchestrator handles all reasoning, tool use, and phase transitions. Plugins never make decisions.

## Contract

`AgentAdapter` extends `BaseAdapter`. All lifecycle methods are inherited as template methods. Like every adapter, it receives a [PluginContext](../plugin-context.md) (`this.context.logger`, `this.context.stateStore`) injected before `initialize()`.

| Method | Signature | Required | Description |
|--------|-----------|----------|-------------|
| `doRun(request)` | `(request: AgentRunRequest) => Promise<AgentRunResult>` | Yes | Spawn the CLI, pipe prompt via stdin, parse output. Every result MUST include `cost_usd` (or `null`) and `duration_ms`. |
| `getCapabilities()` | `() => AgentCapabilities` | Yes | Synchronous, pure. Return model ID, reporting flags, context window. |
| `getQuotaStatus()` | `() => Promise<QuotaStatus \| null>` | No | Override to report rate limits/quota. Default returns `null`. |
| `doInitialize(config)` | `(config: Record<string, unknown>) => Promise<InitResult>` | Yes | Parse config with Zod. Return `{ success: false, message }` on bad config -- never throw. |
| `doShutdown()` | `() => Promise<void>` | Yes | Kill active child process, clean up. |
| `doHealthCheck()` | `() => Promise<HealthStatus>` | Yes | Verify CLI is installed (e.g. `spawn("cli", ["--version"])`). Must resolve within 5 seconds. |

The public `run()` wrapper catches errors: `AdapterMethodError` is rethrown as-is, anything else is wrapped with `code: "internal_error"` and `severity: "fatal"`.

### Three-Layer Usage Contract

Each layer is optional. Core degrades gracefully when data is missing.

```
+-----------------------------------------------------+
|  Layer 3: Limit Detection                           |
|  QuotaStatus.is_rate_limited + earliest_reset_at    |
|  -> Core pauses tasks, waits for reset              |
+-----------------------------------------------------+
|  Layer 2: Quota Status                              |
|  getQuotaStatus() -> QuotaWindow[]                  |
|  -> Dashboard shows quota consumption               |
+-----------------------------------------------------+
|  Layer 1: Per-Call Usage                             |
|  AgentRunResult.usage -> TokenUsage + model_id     |
|  -> Safety Layer tracks cost, dashboard shows tokens |
+-----------------------------------------------------+
```

| Layer | What | Method/Field | If missing |
|-------|------|--------------|------------|
| Per-call usage | Tokens, cost, cache hits | `AgentRunResult.usage` | Cost tracking uses `cost_usd` alone; token displays show N/A |
| Quota status | Session/plan windows | `getQuotaStatus()` | No quota display, no pause-for-reset |
| Limit detection | Hard stop signal | `QuotaStatus.is_rate_limited` | Core cannot detect rate limits proactively |

## Key Types

### AgentRunRequest

| Field | Type | Description |
|-------|------|-------------|
| `prompt` | `string` | The full prompt text. **Always pipe via stdin** -- see critical warning below. |
| `system_prompt` | `string \| null` | System-level instructions. Use CLI's `--system-prompt` flag if available, otherwise prepend to prompt. |
| `cwd` | `string \| null` | Working directory for the CLI process. Set as `spawn()` cwd so the CLI loads the target repo's project context. |
| `trace_output_path` | `string \| null` | Optional file path to stream raw CLI output to for tracing. Plugins that support it stream stdout here; plugins that don't ignore it. Core generates the path. |
| `signal` | `AbortSignal \| undefined` | Optional abort signal. Pass it to `spawn(cmd, args, { signal })` so a preemption, shutdown, or cost-limit aborts the child (`SIGTERM`) instead of waiting it out. A plugin that ignores it cannot be terminated mid-run. |
| `on_activity` | `((event: AgentActivityEvent) => void) \| undefined` | Optional best-effort activity sink. A plugin that streams calls it for each `AgentActivityEvent` it parses from its CLI; a plugin that cannot stream never calls it. Observation-only — see [Activity Streaming](#activity-streaming-optional) below. |

### AgentRunResult

| Field | Type | Description |
|-------|------|-------------|
| `content` | `string` | The agent's response text. Orchestrator parses this for actions. |
| `cost_usd` | `number \| null` | Cost of this call in USD. Critical for Safety Layer cost tracking. `null` if CLI does not report cost. |
| `duration_ms` | `number` | Wall-clock time for the CLI call. Measured by your plugin (`Date.now()` delta). |
| `usage` | `AgentRunUsage \| null` | Token breakdown and model info. `null` if CLI does not report usage. |

### AgentRunUsage

| Field | Type | Description |
|-------|------|-------------|
| `tokens.input_tokens` | `number` | Tokens consumed by the prompt. |
| `tokens.output_tokens` | `number` | Tokens generated in the response. |
| `tokens.cache_read_tokens` | `number` | Tokens served from cache (default `0`). |
| `tokens.cache_creation_tokens` | `number` | Tokens written to cache (default `0`). |
| `tokens.total_tokens` | `number` | `input_tokens + output_tokens`. Compute this yourself. |
| `model_id` | `string \| null` | Actual model used (may differ from requested). |
| `service_tier` | `string \| null` | Provider's service tier (e.g. `"standard"`, `"extended_thinking"`). |

### AgentCapabilities

| Field | Type | Description |
|-------|------|-------------|
| `model_id` | `string` | Default model identifier. |
| `supports_usage_reporting` | `boolean` | Whether `usage` is populated in results. |
| `supports_quota_reporting` | `boolean` | Whether `getQuotaStatus()` returns data. |
| `supports_activity_streaming` | `boolean` | Whether the plugin emits live `AgentActivityEvent`s via `on_activity`. See [Activity Streaming](#activity-streaming-optional). |
| `context_window` | `number \| null` | Context window size in tokens, or `null` if unknown. |

## Activity Streaming (optional)

A run is otherwise a black box: Core sees the final `AgentRunResult`, but not the thinking, tool calls, and intermediate text that produced it. Activity streaming surfaces that inner activity **live** so the owner can watch a run as it happens and re-watch it afterward — without Core ever knowing which CLI is behind the stream.

This is **optional**, **capability-gated**, and **best-effort**:

- **Optional** — a plugin that cannot (or chooses not to) stream simply never calls `on_activity`. The run behaves identically; Core just has no live feed for it (graceful degradation).
- **Capability-gated** — a streaming plugin sets `supports_activity_streaming: true` in `getCapabilities()`. Core reads the flag to decide whether to expect a feed; it never assumes one.
- **Best-effort** — `on_activity` is observation-only. It must **never** change the run's outcome, cost, or timing, and a slow or failing consumer must never break the run. Emit and move on.

### The canonical event vocabulary

`on_activity` carries an `AgentActivityEvent` — a discriminated union on a snake_case `kind`. This is the **only** thing Core and agent plugins share about a run's inner activity. Each plugin maps its native CLI stream into these variants in the same `spawnAndParse` loop it already runs; Core consumes only the union. It is deliberately minimal and free of any plugin-specific shape, so a new CLI is mirrored by mapping into it — nothing new is added to the contract per agent.

| `kind` | Fields | Meaning |
|--------|--------|---------|
| `session` | `model: string \| null`, `tools: number \| null`, `cwd: string \| null` | Optional session-start marker: what the agent booted with. Each field is nullable because a CLI may report some, all, or none. |
| `assistant_text` | `text: string` | A chunk of the agent's user-facing answer. |
| `thinking` | `text: string` | A chunk of the agent's reasoning, when the CLI exposes it. |
| `tool_use` | `tool_call_id: string`, `name: string`, `input: unknown` | The agent invoked a tool. `input` is the raw arguments (may carry file contents, shell commands, env) — opaque in the contract, sanitized by Core before it is ever persisted. |
| `tool_result` | `tool_call_id: string`, `status: "ok" \| "error"`, `output: unknown` | A tool returned. `tool_call_id` pairs it with its `tool_use`; `output` is opaque and sanitized by Core. |

`input` and `output` are `unknown` on purpose: their shape is the CLI's, and the contract does not constrain it. A plugin passes them through verbatim — Core sanitizes secrets and bounds size before storing.

### What Core does with the stream

The plugin's only job is to *map and emit*. What happens next lives entirely in Core's `src/core/agent-activity/` module — the plugin never sees it, and never imports it:

- **Each event becomes a durable observation.** Core writes one `agent_activity` row per event, nested under the run's open `agent_call` span. The dashboard's Agent Calls tab plays the conversation **live** while the run is in flight and lets the owner **re-watch** it afterward — same rows, one source of truth.
- **Core sanitizes and bounds.** Every text, tool input, and tool output is run through secret sanitization before it is stored; large payloads are offloaded to the blob store with a bounded inline preview. This is why the contract leaves `input`/`output` as raw `unknown` — the plugin must **not** pre-scrub or truncate; it passes the CLI's values through and Core does the rest at one chokepoint.
- **The path can never fail your run.** Core wraps every write best-effort: a malformed event or a storage hiccup degrades to a debug log, never a throw back into your `on_activity` call. You can emit freely without defensive code.
- **Opacity is preserved.** Core's module depends only on `AgentActivityEvent` and its observer — never on any plugin. Delete every agent plugin and the module still compiles; it just has nothing to observe.

Core gates the whole feed on your `supports_activity_streaming` flag **and** an operator toggle (`orchestrator.observability.live_activity`, on by default). When either is off, Core never passes `on_activity`, so your plugin has no sink to call and the run is unchanged. See the [observability how-to → Live Agent Activity](../../contribution-docs/how-tos/observability.md#live-agent-activity) for the full Core-side picture.

### QuotaStatus / QuotaWindow

| Field | Type | Description |
|-------|------|-------------|
| `windows` | `QuotaWindow[]` | Array of quota boundaries. |
| `is_rate_limited` | `boolean` | When `true`, Core pauses task dispatch and blocks active tasks. |
| `earliest_reset_at` | `number \| null` | Unix timestamp (ms) of earliest reset. Core schedules resume check. |
| `QuotaWindow.window_type` | `string` | Identifier (e.g. `"five_hour"`, `"seven_day"`, `"gemini_model_quota"`). |
| `QuotaWindow.resets_at` | `number \| null` | When this window resets. |
| `QuotaWindow.is_exhausted` | `boolean` | Whether this window's quota is fully consumed. |
| `QuotaWindow.used_percentage` | `number \| null` | 0-100 usage percentage, if available. |

## Developing a New Plugin

### Directory structure

Source and tests live in mirrored trees — source under `src/`, tests under `tests/unit/` (see [coding standards § 7 — Test Location](../../coding-standards.md#test-location)):

```
src/plugins/agent/my-agent/
  my-agent.ts       # Plugin class extending AgentAdapter
  config.ts       # Zod config schema

tests/unit/plugins/agent/my-agent/
  my-agent.test.ts  # Tests including contract suite
```

### Minimal class skeleton

```typescript
import { type ChildProcess, spawn } from "node:child_process";
import {
  AdapterMethodError,
  type HealthStatus,
  type AgentRunRequest,
  type AgentRunResult,
  type InitResult,
  AgentAdapter,
  type AgentCapabilities,
  createAdapterError,
} from "../../../adapters/index.js";
import { type MyAgentConfig, MyAgentConfigSchema } from "./config.js";

// ── Environment isolation ─────────────────────────────────────────────────────
// Shared subprocess discipline -- enforces env sanitization across all agent plugins.
// NEVER pass process.env directly to spawn() -- secrets will leak to the CLI.
import { buildAgentEnv } from "../subprocess.js";

export class MyAgentPlugin extends AgentAdapter {
  private config!: MyAgentConfig;
  private activeProcess: ChildProcess | null = null;

  protected doRun(request: AgentRunRequest): Promise<AgentRunResult> {
    const args = ["--model", this.config.model, "--format", "json"];

    // System prompt: use CLI flag if available, otherwise prepend
    const prompt = request.system_prompt
      ? `[SYSTEM INSTRUCTIONS]\n${request.system_prompt}\n[END SYSTEM INSTRUCTIONS]\n\n${request.prompt}`
      : request.prompt;

    const startMs = Date.now();
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      const child = spawn(this.config.cli_path, args, {
        stdio: ["pipe", "pipe", "pipe"],
        timeout: this.config.command_timeout_ms,
        env: buildAgentEnv(process.env),  // sanitized -- no secrets
        cwd: request.cwd ?? undefined,
      });

      this.activeProcess = child;

      child.stdout?.on("data", (c: Buffer) => chunks.push(c));
      child.stderr?.on("data", (c: Buffer) => stderrChunks.push(c));

      child.on("close", (code) => {
        this.activeProcess = null;
        if (code !== 0) {
          const stderr = Buffer.concat(stderrChunks).toString("utf-8");
          reject(new AdapterMethodError(
            createAdapterError("cli_error", `CLI exited with code ${code}: ${stderr}`, {
              retryable: true,
            }),
          ));
          return;
        }
        const raw = Buffer.concat(chunks).toString("utf-8");
        resolve({
          content: raw,  // parse your CLI's output format here
          cost_usd: null,
          duration_ms: Date.now() - startMs,
          usage: null,
        });
      });

      child.on("error", (err) => {
        this.activeProcess = null;
        reject(new AdapterMethodError(
          createAdapterError("spawn_error", `Failed to spawn CLI: ${err.message}`),
        ));
      });

      // CRITICAL: pipe via stdin -- never pass prompt as CLI argument
      child.stdin?.on("error", () => {});  // suppress EPIPE
      child.stdin?.write(prompt);
      child.stdin?.end();
    });
  }

  getCapabilities(): AgentCapabilities {
    return {
      model_id: this.config?.model ?? "my-default-model",
      supports_usage_reporting: false,
      supports_quota_reporting: false,
      supports_activity_streaming: false,
      context_window: null,
    };
  }

  protected doInitialize(config: Record<string, unknown>): Promise<InitResult> {
    const parsed = MyAgentConfigSchema.safeParse(config);
    if (!parsed.success) {
      return Promise.resolve({ success: false, message: `Invalid config: ${parsed.error.message}` });
    }
    this.config = parsed.data;
    return Promise.resolve({ success: true, message: null });
  }

  protected doShutdown(): Promise<void> {
    if (this.activeProcess) {
      this.activeProcess.kill("SIGTERM");
      this.activeProcess = null;
    }
    return Promise.resolve();
  }

  protected async doHealthCheck(): Promise<HealthStatus> {
    return new Promise((resolve) => {
      const child = spawn(this.config.cli_path, ["--version"], {
        timeout: 5000,
        env: buildAgentEnv(process.env),
      });
      const chunks: Buffer[] = [];
      child.stdout?.on("data", (c: Buffer) => chunks.push(c));
      child.on("close", (code) => {
        const version = Buffer.concat(chunks).toString("utf-8").trim();
        resolve({
          healthy: code === 0,
          message: code === 0 ? `CLI v${version}` : "CLI not available",
          details: code === 0 ? { version } : null,
        });
      });
      child.on("error", () => {
        resolve({ healthy: false, message: "CLI not found", details: null });
      });
    });
  }
}
```

### Critical rules for agent plugins

**Always pipe prompts via stdin.** Orchestrator prompts are 50KB+. Passing them as CLI arguments hits OS `ARG_MAX` limits and causes silent truncation or failure.

```typescript
// WRONG -- will break on real orchestrator prompts
args.push(prompt);             // positional arg
args.push("-p", prompt);       // flag value

// RIGHT -- no size limit
child.stdin?.write(prompt);
child.stdin?.end();
```

CLI-specific stdin patterns:

| CLI Tool | Stdin Pattern |
|----------|--------------|
| Claude Code | Reads from stdin when no positional arg given |
| OpenCode | Reads from stdin when no message args given |
| Gemini CLI | Appends stdin to `-p` value; use `-p ""` to enable non-interactive mode |

**Always sanitize the environment.** Use `buildAgentEnv(process.env)` -- never pass `process.env` directly to `spawn()`. The parent process holds `GITHUB_TOKEN`, `TELEGRAM_BOT_TOKEN`, and other secrets that must not leak to agent subprocesses. If your CLI needs a specific auth env var, add it to a local allowlist in your plugin -- do not add secrets to the shared allowlist.

**Prepend system prompt when no CLI flag exists.** Only Claude Code has `--system-prompt`. For other CLIs:

```typescript
const prompt = request.system_prompt
  ? `[SYSTEM INSTRUCTIONS]\n${request.system_prompt}\n[END SYSTEM INSTRUCTIONS]\n\n${request.prompt}`
  : request.prompt;
```

**Detect rate limits from stdout AND stderr.** Some CLIs report rate limits in structured stdout (e.g. Gemini's `result` event with `status: "error"`). Others print retry messages to stderr. Monitor both:

```typescript
const RATE_LIMIT_STDERR_RE = /exhausted your capacity|rate.?limit|quota/i;

child.stderr?.on("data", (chunk: Buffer) => {
  stderrChunks.push(chunk);
  const text = chunk.toString("utf-8");
  if (!killedForRateLimit && RATE_LIMIT_STDERR_RE.test(text)) {
    killedForRateLimit = true;
    child.kill("SIGTERM");  // kill immediately -- see below
  }
});
```

**Kill infinite-retry CLIs immediately on rate limit detection.** Some CLIs (Gemini CLI, OpenCode) retry infinitely when rate limited, burning time and potentially accumulating cost. When you detect a rate limit pattern in stderr, `SIGTERM` the child process immediately and reject with a `cli_error` that has `retryable: true`. Core's Daemon handles the backoff and re-queuing.

**Suppress EPIPE on stdin.** The child process may exit before consuming all stdin. Add a no-op error handler:

```typescript
child.stdin?.on("error", () => {});  // suppress EPIPE
```

### Config schema pattern

```typescript
// my-agent/config.ts
import { z } from "zod";

export const MyAgentConfigSchema = z.object({
  model: z.string().default("my-default-model"),
  cli_path: z.string().default("my-cli"),
  command_timeout_ms: z.number().int().positive().default(600_000),
});

export type MyAgentConfig = z.output<typeof MyAgentConfigSchema>;
```

Use `z.output<typeof Schema>` (not `z.infer`) -- this resolves defaults and transforms, required for `exactOptionalPropertyTypes`.

### Registration in builtin.ts

```typescript
// 1. Import
import { MyAgentPlugin } from "./agent/my-agent/my-agent.js";

// 2. Manifest (in manifests array)
{
  id: "my-agent",
  type: "agent",
  version: "1.0.0",
  name: "My Agent CLI",
  description: "agent reasoning via My CLI process",
  critical: true,
  requirements: [{ type: "binary", name: "my-cli" }],
  entry: "builtin",
  adapter_meta: { provider_type: "cli" },
  contributes: { events: ["cost.incurred"] },
},

// 3. Factory (in factories map)
"my-agent": () => new MyAgentPlugin(),
```

### Contract test suite

Path: `tests/helpers/contract-suites/agent-contract.ts`.

```typescript
// tests/unit/plugins/agent/my-agent/my-agent.test.ts
import { runContractSuite } from "../../../../helpers/contract-suites/agent-contract.js";
import { MyAgentPlugin } from "./my-agent.js";

const manifest = {
  id: "my-agent",
  type: "agent" as const,
  version: "1.0.0",
  name: "My Agent",
  description: "Test",
  critical: true,
  entry: "builtin",
  adapter_meta: {},
  contributes: { events: [], commands: [], config_keys: [], hooks: [] },
};

runContractSuite(
  () => new MyAgentPlugin(),
  {
    manifest,
    validConfig: { model: "my-model", cli_path: "/path/to/mock-cli" },
    invalidConfig: { model: 123 },
    request: { prompt: "Hello", system_prompt: null, cwd: null },
  },
);
```

The contract suite validates:
- `initialize()` succeeds/fails correctly with valid/invalid config
- `healthCheck()` returns `HealthStatus` with all required fields, resolves within 5 seconds
- `shutdown()` resolves without throwing
- `run()` returns a valid `AgentRunResult` (schema-validated), always includes `cost_usd` and `duration_ms`
- `usage` is `null` or valid `AgentRunUsage` with all token fields
- `getCapabilities()` returns valid `AgentCapabilities` with all fields
- `getQuotaStatus()` returns `null` or valid `QuotaStatus`

For unit tests that do not hit a real CLI, create mock scripts that write expected NDJSON to stdout. Set `cli_path` to the mock script path in your test config.

### NDJSON parsing

All three built-in plugins use NDJSON (newline-delimited JSON) output from their CLIs. The general pattern:

```typescript
const lines = raw.split("\n").filter((line) => line.trim().length > 0);
for (const line of lines) {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    // dispatch on parsed["type"]
  } catch {
    // Skip non-JSON lines (e.g. "Loaded cached credentials.")
  }
}
```

Each CLI has a different event schema. Research your CLI's actual output before writing the parser.

## Built-in Plugins

| Plugin | CLI Tool | Default Model | Cost | Usage | Quota | System Prompt | Key Flags |
|--------|----------|---------------|------|-------|-------|---------------|-----------|
| **Claude Code** (default) | `claude` | `claude-sonnet-4-6` | Yes (USD) | Yes (full tokens + cache + model + service tier) | Yes (API + rate_limit_event fallback) | `--system-prompt` flag | `--print --output-format stream-json --verbose --setting-sources user --dangerously-skip-permissions` |
| **OpenCode** (opt-in) | `opencode` | `opencode/gemini-3.1-pro` | Yes (USD) | Yes (tokens + cache) | No | Prepend to prompt | `run --format json` |
| **Gemini CLI** (opt-in) | `gemini` | `gemini-2.5-pro` | No (free tier) | Yes (tokens + cache) | Yes (rate limit detection only) | Prepend to prompt | `-p "" -o stream-json --yolo` |

### Output format differences

| CLI | Content Event | Cost Source | Token Source | Rate Limit Source |
|-----|---------------|-------------|--------------|-------------------|
| Claude Code | `type: "result"` with `result` field | `total_cost_usd` on result event | `usage` on result event | `type: "rate_limit_event"` + API endpoint |
| OpenCode | `type: "text"` with `part.text` | `part.cost` on `type: "step_finish"` | `part.tokens` on `type: "step_finish"` | Stderr pattern matching |
| Gemini CLI | `type: "message", role: "assistant"` | N/A (free tier) | `stats` on `type: "result"` | Stderr pattern + stdout `result.status: "error"` |

### Quota reporting details

- **Claude Code**: Two sources. Primary: Anthropic's `/api/oauth/usage` endpoint (real percentages, cached 30 min). Fallback: `rate_limit_event` from last `run()` call (status + reset time, no percentages). OAuth token read from macOS Keychain or `~/.claude/.credentials.json`.
- **Gemini CLI**: Sets a `rateLimited` flag when stdout result has `status: "error"` matching rate limit patterns, or stderr matches. Reports via `getQuotaStatus()` as a single `gemini_model_quota` window with `is_exhausted: true`. No reset time available.
- **OpenCode**: No quota reporting. Default `getQuotaStatus()` returns `null`.

## Reference

| File | Purpose |
|------|---------|
| `src/adapters/agent.ts` | Abstract `AgentAdapter` base class (three-layer contract) |
| `src/adapters/base.ts` | `BaseAdapter` -- lifecycle template methods, `hasCapability()` |
| `src/adapters/errors.ts` | `AdapterMethodError`, `createAdapterError()` |
| `src/adapters/index.ts` | Plugin SDK barrel -- single import point |
| `src/schemas/adapters.ts` | All Zod schemas (`AgentRunRequest`, `AgentRunResult`, `TokenUsage`, `QuotaStatus`, `AgentCapabilities`) |
| `src/plugins/agent/subprocess.ts` | Shared subprocess discipline: env sanitization, stderr buffer cap |
| `src/plugins/agent/claude-code-agent/claude-code-agent.ts` | Reference: spawn, NDJSON parse, usage, quota API |
| `src/plugins/agent/claude-code-agent/config.ts` | Reference config schema |
| `src/plugins/agent/opencode-agent/opencode-agent.ts` | Reference: multi-provider, step_finish cost/tokens, stderr rate limit kill |
| `src/plugins/agent/gemini-cli-agent/gemini-cli-agent.ts` | Reference: free tier, no cost, stdout+stderr rate limit detection |
| `src/plugins/builtin.ts` | Plugin registration (manifests + factories) |
| `tests/helpers/contract-suites/agent-contract.ts` | Contract compliance test suite |
| `contribution-docs/how-tos/plugins/agent-adapter/prompt.md` | Interactive agent-facing setup prompt |
