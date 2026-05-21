# LLM Adapter

LLM adapters are inference-only providers. The Engineer is the agent -- LLM plugins receive a prompt and return text. Each plugin spawns a CLI tool as a child process, pipes the prompt via stdin, parses structured output from stdout, and returns content + cost + usage data. The Orchestrator handles all reasoning, tool use, and phase transitions. Plugins never make decisions.

## Contract

`LLMAdapter` extends `BaseAdapter`. All lifecycle methods are inherited as template methods. Like every adapter, it receives a [PluginContext](../plugin-context.md) (`this.context.logger`, `this.context.stateStore`) injected before `initialize()`.

| Method | Signature | Required | Description |
|--------|-----------|----------|-------------|
| `doInfer(request)` | `(request: InferenceRequest) => Promise<InferenceResult>` | Yes | Spawn the CLI, pipe prompt via stdin, parse output. Every result MUST include `cost_usd` (or `null`) and `duration_ms`. |
| `getCapabilities()` | `() => LLMCapabilities` | Yes | Synchronous, pure. Return model ID, reporting flags, context window. |
| `getQuotaStatus()` | `() => Promise<QuotaStatus \| null>` | No | Override to report rate limits/quota. Default returns `null`. |
| `doInitialize(config)` | `(config: Record<string, unknown>) => Promise<InitResult>` | Yes | Parse config with Zod. Return `{ success: false, message }` on bad config -- never throw. |
| `doShutdown()` | `() => Promise<void>` | Yes | Kill active child process, clean up. |
| `doHealthCheck()` | `() => Promise<HealthStatus>` | Yes | Verify CLI is installed (e.g. `spawn("cli", ["--version"])`). Must resolve within 5 seconds. |

The public `infer()` wrapper catches errors: `AdapterMethodError` is rethrown as-is, anything else is wrapped with `code: "internal_error"` and `severity: "fatal"`.

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
|  InferenceResult.usage -> TokenUsage + model_id     |
|  -> Safety Layer tracks cost, dashboard shows tokens |
+-----------------------------------------------------+
```

| Layer | What | Method/Field | If missing |
|-------|------|--------------|------------|
| Per-call usage | Tokens, cost, cache hits | `InferenceResult.usage` | Cost tracking uses `cost_usd` alone; token displays show N/A |
| Quota status | Session/plan windows | `getQuotaStatus()` | No quota display, no pause-for-reset |
| Limit detection | Hard stop signal | `QuotaStatus.is_rate_limited` | Core cannot detect rate limits proactively |

## Key Types

### InferenceRequest

| Field | Type | Description |
|-------|------|-------------|
| `prompt` | `string` | The full prompt text. **Always pipe via stdin** -- see critical warning below. |
| `system_prompt` | `string \| null` | System-level instructions. Use CLI's `--system-prompt` flag if available, otherwise prepend to prompt. |
| `cwd` | `string \| null` | Working directory for the CLI process. Set as `spawn()` cwd so the CLI loads the target repo's project context. |

### InferenceResult

| Field | Type | Description |
|-------|------|-------------|
| `content` | `string` | The LLM's response text. Orchestrator parses this for actions. |
| `cost_usd` | `number \| null` | Cost of this call in USD. Critical for Safety Layer cost tracking. `null` if CLI does not report cost. |
| `duration_ms` | `number` | Wall-clock time for the CLI call. Measured by your plugin (`Date.now()` delta). |
| `usage` | `InferenceUsage \| null` | Token breakdown and model info. `null` if CLI does not report usage. |

### InferenceUsage

| Field | Type | Description |
|-------|------|-------------|
| `tokens.input_tokens` | `number` | Tokens consumed by the prompt. |
| `tokens.output_tokens` | `number` | Tokens generated in the response. |
| `tokens.cache_read_tokens` | `number` | Tokens served from cache (default `0`). |
| `tokens.cache_creation_tokens` | `number` | Tokens written to cache (default `0`). |
| `tokens.total_tokens` | `number` | `input_tokens + output_tokens`. Compute this yourself. |
| `model_id` | `string \| null` | Actual model used (may differ from requested). |
| `service_tier` | `string \| null` | Provider's service tier (e.g. `"standard"`, `"extended_thinking"`). |

### LLMCapabilities

| Field | Type | Description |
|-------|------|-------------|
| `model_id` | `string` | Default model identifier. |
| `supports_usage_reporting` | `boolean` | Whether `usage` is populated in results. |
| `supports_quota_reporting` | `boolean` | Whether `getQuotaStatus()` returns data. |
| `context_window` | `number \| null` | Context window size in tokens, or `null` if unknown. |

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

```
src/plugins/llm/my-llm/
  my-llm.ts       # Plugin class extending LLMAdapter
  config.ts        # Zod config schema
  my-llm.test.ts   # Tests including contract suite
```

### Minimal class skeleton

```typescript
import { type ChildProcess, spawn } from "node:child_process";
import {
  AdapterMethodError,
  type HealthStatus,
  type InferenceRequest,
  type InferenceResult,
  type InitResult,
  LLMAdapter,
  type LLMCapabilities,
  createAdapterError,
} from "../../../adapters/index.js";
import { type MyLLMConfig, MyLLMConfigSchema } from "./config.js";

// ── Environment isolation ─────────────────────────────────────────────────────
// Copy the buildLlmEnv pattern from an existing plugin.
// NEVER pass process.env directly to spawn() -- secrets will leak to the CLI.
import { buildLlmEnv } from "../claude-code-llm/claude-code-llm.js";

export class MyLLMPlugin extends LLMAdapter {
  private config!: MyLLMConfig;
  private activeProcess: ChildProcess | null = null;

  protected doInfer(request: InferenceRequest): Promise<InferenceResult> {
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
        env: buildLlmEnv(process.env),  // sanitized -- no secrets
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

  getCapabilities(): LLMCapabilities {
    return {
      model_id: this.config?.model ?? "my-default-model",
      supports_usage_reporting: false,
      supports_quota_reporting: false,
      context_window: null,
    };
  }

  protected doInitialize(config: Record<string, unknown>): Promise<InitResult> {
    const parsed = MyLLMConfigSchema.safeParse(config);
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
        env: buildLlmEnv(process.env),
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

### Critical rules for LLM plugins

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

**Always sanitize the environment.** Use `buildLlmEnv(process.env)` -- never pass `process.env` directly to `spawn()`. The parent process holds `GITHUB_TOKEN`, `TELEGRAM_BOT_TOKEN`, and other secrets that must not leak to LLM subprocesses. If your CLI needs a specific auth env var, add it to a local allowlist in your plugin -- do not add secrets to the shared allowlist.

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
// my-llm/config.ts
import { z } from "zod";

export const MyLLMConfigSchema = z.object({
  model: z.string().default("my-default-model"),
  cli_path: z.string().default("my-cli"),
  command_timeout_ms: z.number().int().positive().default(600_000),
});

export type MyLLMConfig = z.output<typeof MyLLMConfigSchema>;
```

Use `z.output<typeof Schema>` (not `z.infer`) -- this resolves defaults and transforms, required for `exactOptionalPropertyTypes`.

### Registration in builtin.ts

```typescript
// 1. Import
import { MyLLMPlugin } from "./llm/my-llm/my-llm.js";

// 2. Manifest (in manifests array)
{
  id: "my-llm",
  type: "llm",
  version: "1.0.0",
  name: "My LLM CLI",
  description: "LLM reasoning via My CLI process",
  critical: true,
  requirements: [{ type: "binary", name: "my-cli" }],
  entry: "builtin",
  adapter_meta: { provider_type: "cli" },
  contributes: { events: ["cost.incurred"] },
},

// 3. Factory (in factories map)
"my-llm": () => new MyLLMPlugin(),
```

### Contract test suite

Path: `test/helpers/contract-suites/llm-contract.ts`.

```typescript
// my-llm/my-llm.test.ts
import { runLLMContractSuite } from "../../../../test/helpers/contract-suites/llm-contract.js";
import { MyLLMPlugin } from "./my-llm.js";

const manifest = {
  id: "my-llm",
  type: "llm" as const,
  version: "1.0.0",
  name: "My LLM",
  description: "Test",
  critical: true,
  entry: "builtin",
  adapter_meta: {},
  contributes: { events: [], commands: [], config_keys: [], hooks: [] },
};

runLLMContractSuite(
  () => new MyLLMPlugin(),
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
- `infer()` returns a valid `InferenceResult` (schema-validated), always includes `cost_usd` and `duration_ms`
- `usage` is `null` or valid `InferenceUsage` with all token fields
- `getCapabilities()` returns valid `LLMCapabilities` with all fields
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
| **Claude Code** (default) | `claude` | `claude-sonnet-4-20250514` | Yes (USD) | Yes (full tokens + cache + model + service tier) | Yes (API + rate_limit_event fallback) | `--system-prompt` flag | `--print --output-format stream-json --verbose --setting-sources user --dangerously-skip-permissions` |
| **OpenCode** (opt-in) | `opencode` | `opencode/gemini-3.1-pro` | Yes (USD) | Yes (tokens + cache) | No | Prepend to prompt | `run --format json` |
| **Gemini CLI** (opt-in) | `gemini` | `gemini-2.5-pro` | No (free tier) | Yes (tokens + cache) | Yes (rate limit detection only) | Prepend to prompt | `-p "" -o stream-json --yolo` |

### Output format differences

| CLI | Content Event | Cost Source | Token Source | Rate Limit Source |
|-----|---------------|-------------|--------------|-------------------|
| Claude Code | `type: "result"` with `result` field | `total_cost_usd` on result event | `usage` on result event | `type: "rate_limit_event"` + API endpoint |
| OpenCode | `type: "text"` with `part.text` | `part.cost` on `type: "step_finish"` | `part.tokens` on `type: "step_finish"` | Stderr pattern matching |
| Gemini CLI | `type: "message", role: "assistant"` | N/A (free tier) | `stats` on `type: "result"` | Stderr pattern + stdout `result.status: "error"` |

### Quota reporting details

- **Claude Code**: Two sources. Primary: Anthropic's `/api/oauth/usage` endpoint (real percentages, cached 30 min). Fallback: `rate_limit_event` from last `infer()` call (status + reset time, no percentages). OAuth token read from macOS Keychain or `~/.claude/.credentials.json`.
- **Gemini CLI**: Sets a `rateLimited` flag when stdout result has `status: "error"` matching rate limit patterns, or stderr matches. Reports via `getQuotaStatus()` as a single `gemini_model_quota` window with `is_exhausted: true`. No reset time available.
- **OpenCode**: No quota reporting. Default `getQuotaStatus()` returns `null`.

## Reference

| File | Purpose |
|------|---------|
| `src/adapters/llm.ts` | Abstract `LLMAdapter` base class (three-layer contract) |
| `src/adapters/base.ts` | `BaseAdapter` -- lifecycle template methods, `hasCapability()` |
| `src/adapters/errors.ts` | `AdapterMethodError`, `createAdapterError()` |
| `src/adapters/index.ts` | Plugin SDK barrel -- single import point |
| `src/schemas/adapters.ts` | All Zod schemas (`InferenceRequest`, `InferenceResult`, `TokenUsage`, `QuotaStatus`, `LLMCapabilities`) |
| `src/plugins/llm/claude-code-llm/claude-code-llm.ts` | Reference: spawn, NDJSON parse, usage, quota API, env isolation |
| `src/plugins/llm/claude-code-llm/config.ts` | Reference config schema |
| `src/plugins/llm/opencode-llm/opencode-llm.ts` | Reference: multi-provider, step_finish cost/tokens, stderr rate limit kill |
| `src/plugins/llm/gemini-cli-llm/gemini-cli-llm.ts` | Reference: free tier, no cost, stdout+stderr rate limit detection |
| `src/plugins/builtin.ts` | Plugin registration (manifests + factories) |
| `test/helpers/contract-suites/llm-contract.ts` | Contract compliance test suite |
| `contribution-docs/how-tos/plugins/llm-adapter/prompt.md` | Interactive LLM-facing setup prompt |
