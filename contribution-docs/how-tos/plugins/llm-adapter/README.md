# LLM Plugin Integration

How to integrate a new LLM CLI tool (Codex, Gemini CLI, a custom wrapper) as a plugin for The Engineer.

---

## What an LLM Plugin Is

The Engineer is the agent. LLM providers are inference-only — prompt in, text out. Your plugin spawns a CLI process, sends a prompt via stdin, parses the response from stdout, and returns structured content + cost + usage data. The Orchestrator's agent loop handles all reasoning, tool use, and phase transitions. Your plugin never makes decisions.

---

## The Three-Layer Contract

Each layer is optional. Core degrades gracefully when data is missing.

```
┌─────────────────────────────────────────────────────┐
│  Layer 3: Limit Detection                           │
│  QuotaStatus.is_rate_limited + earliest_reset_at    │
│  → Core pauses tasks, waits for reset               │
├─────────────────────────────────────────────────────┤
│  Layer 2: Quota Status                              │
│  getQuotaStatus() → QuotaWindow[]                   │
│  → Dashboard shows quota consumption                │
├─────────────────────────────────────────────────────┤
│  Layer 1: Per-Call Usage                             │
│  InferenceResult.usage → TokenUsage + model_id      │
│  → Safety Layer tracks cost, dashboard shows tokens  │
└─────────────────────────────────────────────────────┘
```

| Layer | What | Required? | Method/Field |
|-------|------|-----------|--------------|
| Per-call usage | Tokens, cost, cache hits | Optional | `InferenceResult.usage` |
| Quota status | Session/plan windows | Optional | `getQuotaStatus()` |
| Limit detection | Hard stop signal | Optional | `QuotaStatus.is_rate_limited` |

---

## Quick Start

Minimal plugin skeleton — extend `LLMAdapter`, implement three methods, ship it.

```typescript
import { spawn } from "node:child_process";
import {
  type HealthStatus,
  type InferenceRequest,
  type InferenceResult,
  type InitResult,
  LLMAdapter,
  type LLMCapabilities,
  createAdapterError,
  AdapterMethodError,
} from "../../../adapters/index.js";

export class MyLLMPlugin extends LLMAdapter {
  private config!: { cli_path: string; model: string; timeout_ms: number };

  protected doInfer(request: InferenceRequest): Promise<InferenceResult> {
    const start = Date.now();
    return new Promise((resolve, reject) => {
      const child = spawn(this.config.cli_path, ["--model", this.config.model], {
        stdio: ["pipe", "pipe", "pipe"],
        timeout: this.config.timeout_ms,
        cwd: request.cwd ?? undefined,
      });

      const chunks: Buffer[] = [];
      child.stdout?.on("data", (c: Buffer) => chunks.push(c));

      child.on("close", (code) => {
        if (code !== 0) {
          reject(new AdapterMethodError(
            createAdapterError("cli_error", `CLI exited with code ${code}`, { retryable: true }),
          ));
          return;
        }
        const raw = Buffer.concat(chunks).toString("utf-8");
        resolve({
          content: raw,
          cost_usd: null,       // Set if your CLI reports cost
          duration_ms: Date.now() - start,
          usage: null,          // Set if your CLI reports tokens
        });
      });

      child.on("error", (err) => {
        reject(new AdapterMethodError(
          createAdapterError("spawn_error", `Failed to spawn CLI: ${err.message}`),
        ));
      });

      // Pipe prompt via stdin — avoids OS argument length limits
      if (request.prompt) child.stdin?.write(request.prompt);
      if (request.system_prompt) child.stdin?.write(`\n---SYSTEM---\n${request.system_prompt}`);
      child.stdin?.end();
    });
  }

  getCapabilities(): LLMCapabilities {
    return {
      model_id: this.config?.model ?? "my-model",
      supports_usage_reporting: false,
      supports_quota_reporting: false,
      context_window: null,
    };
  }

  protected doInitialize(config: Record<string, unknown>): Promise<InitResult> {
    this.config = config as typeof this.config; // Use Zod in production — see Configuration section
    return Promise.resolve({ success: true, message: null });
  }

  protected doShutdown(): Promise<void> {
    return Promise.resolve();
  }

  protected doHealthCheck(): Promise<HealthStatus> {
    return new Promise((resolve) => {
      const child = spawn(this.config.cli_path, ["--version"], { timeout: 5000 });
      child.on("close", (code) => {
        resolve({
          healthy: code === 0,
          message: code === 0 ? "CLI available" : "CLI not available",
          details: null,
        });
      });
      child.on("error", () => {
        resolve({ healthy: false, message: "CLI not found", details: null });
      });
    });
  }
}
```

---

## InferenceRequest & InferenceResult

### InferenceRequest

What Core sends to your plugin. Source: `src/schemas/adapters.ts`.

```typescript
const InferenceRequestSchema = z.object({
  prompt: z.string(),
  system_prompt: z.string().nullable().default(null),
  cwd: z.string().nullable().default(null),
});
```

| Field | Type | Description |
|-------|------|-------------|
| `prompt` | `string` | The full prompt text. Pipe via stdin, not as a CLI argument (avoids OS arg length limits). |
| `system_prompt` | `string \| null` | System-level instructions. Pass via your CLI's system prompt flag if supported, otherwise prepend to the prompt. |
| `cwd` | `string \| null` | Working directory for the CLI process. Set as `spawn()` cwd so the CLI loads the target repo's project context, not the daemon's. |

### InferenceResult

What your plugin returns. Every field matters to Core.

```typescript
const InferenceResultSchema = z.object({
  content: z.string(),
  cost_usd: z.number().nullable(),
  duration_ms: z.number().int(),
  usage: InferenceUsageSchema.nullable().default(null),
});
```

| Field | Type | Description |
|-------|------|-------------|
| `content` | `string` | The LLM's response text. This is what the Orchestrator's agent loop parses for actions. |
| `cost_usd` | `number \| null` | Cost of this call in USD. Critical for Safety Layer cost tracking. `null` if your CLI doesn't report cost. |
| `duration_ms` | `number` | Wall-clock time for the CLI call. Measured by your plugin (`Date.now()` before and after spawn). |
| `usage` | `InferenceUsage \| null` | Token breakdown and model context. `null` if your CLI doesn't report usage. See next section. |

---

## Usage Reporting (Layer 1)

Populate `InferenceResult.usage` when your CLI reports token counts.

### InferenceUsage

```typescript
const InferenceUsageSchema = z.object({
  tokens: TokenUsageSchema,
  model_id: z.string().nullable().default(null),
  service_tier: z.string().nullable().default(null),
});
```

| Field | Type | Description |
|-------|------|-------------|
| `tokens` | `TokenUsage` | Per-call token breakdown. See below. |
| `model_id` | `string \| null` | The actual model used (may differ from requested if provider auto-routes). |
| `service_tier` | `string \| null` | Provider's service tier label (e.g. `"standard"`, `"extended_thinking"`). |

### TokenUsage

```typescript
const TokenUsageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cache_read_tokens: z.number().int().nonnegative().default(0),
  cache_creation_tokens: z.number().int().nonnegative().default(0),
  total_tokens: z.number().int().nonnegative(),
});
```

| Field | Type | Description |
|-------|------|-------------|
| `input_tokens` | `number` | Tokens consumed by the prompt. |
| `output_tokens` | `number` | Tokens generated in the response. |
| `cache_read_tokens` | `number` | Tokens served from cache (default `0`). |
| `cache_creation_tokens` | `number` | Tokens written to cache (default `0`). |
| `total_tokens` | `number` | `input_tokens + output_tokens`. Compute this yourself. |

### Example: Claude CLI output to TokenUsage

The Claude CLI's `stream-json` result event includes a `usage` object:

```json
{
  "type": "result",
  "usage": {
    "input_tokens": 4200,
    "output_tokens": 1800,
    "cache_read_input_tokens": 3000,
    "cache_creation_input_tokens": 0,
    "service_tier": "standard"
  },
  "modelUsage": { "claude-sonnet-4-20250514": { ... } }
}
```

Mapping:

```typescript
const usage: InferenceUsage = {
  tokens: {
    input_tokens: cliUsage.input_tokens,
    output_tokens: cliUsage.output_tokens,
    cache_read_tokens: cliUsage.cache_read_input_tokens ?? 0,
    cache_creation_tokens: cliUsage.cache_creation_input_tokens ?? 0,
    total_tokens: cliUsage.input_tokens + cliUsage.output_tokens,
  },
  model_id: Object.keys(cliResult.modelUsage)[0] ?? null,
  service_tier: cliUsage.service_tier ?? null,
};
```

### When your CLI doesn't report tokens

Return `usage: null`. Core handles this gracefully — cost tracking falls back to `cost_usd` alone, and dashboard token displays show "N/A".

---

## Quota Reporting (Layer 2)

Override `getQuotaStatus()` if your CLI exposes rate limit or quota information.

### QuotaStatus

```typescript
const QuotaStatusSchema = z.object({
  windows: z.array(QuotaWindowSchema).default([]),
  is_rate_limited: z.boolean().default(false),
  earliest_reset_at: z.number().int().nullable().default(null),
});
```

### QuotaWindow

Each window represents one quota boundary (e.g. "5-hour session", "7-day plan limit").

```typescript
const QuotaWindowSchema = z.object({
  window_type: z.string(),
  resets_at: z.number().int().nullable().default(null),
  is_exhausted: z.boolean().default(false),
  used_percentage: z.number().nonnegative().nullable().default(null),
});
```

| Field | Type | Description |
|-------|------|-------------|
| `window_type` | `string` | Identifier for this quota window (e.g. `"session"`, `"weekly"`, `"daily"`). Free-form string. |
| `resets_at` | `number \| null` | Unix timestamp (ms) when this window resets. `null` if unknown. |
| `is_exhausted` | `boolean` | Whether this window's quota is fully consumed. |
| `used_percentage` | `number \| null` | 0-100 usage percentage. `null` if the provider doesn't report it. |

### Example: Claude CLI rate limit events to QuotaWindow

The Claude CLI emits `rate_limit_event` lines in its stream-json output:

```json
{
  "type": "rate_limit_event",
  "rate_limit_info": {
    "rateLimitType": "session",
    "status": "throttled",
    "resetsAt": 1711234567890
  }
}
```

The reference plugin collects these during `doInfer()` and serves them from `getQuotaStatus()`:

```typescript
async getQuotaStatus(): Promise<QuotaStatus | null> {
  if (this.lastRateLimits.length === 0) return null;

  const windows: QuotaWindow[] = this.lastRateLimits.map((rl) => ({
    window_type: rl.rateLimitType,
    resets_at: rl.resetsAt,
    is_exhausted: rl.status !== "allowed",
    used_percentage: null,
  }));

  const isRateLimited = windows.some((w) => w.is_exhausted);
  const resetTimes = windows.map((w) => w.resets_at).filter((t): t is number => t !== null);

  return {
    windows,
    is_rate_limited: isRateLimited,
    earliest_reset_at: resetTimes.length > 0 ? Math.min(...resetTimes) : null,
  };
}
```

### Default: no quota concept

Don't override `getQuotaStatus()`. The base class returns `null`. Core skips quota display and never pauses for quota resets.

### Enriching Quota with Real Percentages (Secure API Call)

Some providers have a separate API endpoint that returns actual usage percentages (e.g. "43% of session used"). The Claude Code plugin uses Anthropic's `/api/oauth/usage` endpoint for this.

**Security principle: the OAuth token never enters the Node.js process.** It flows through a shell pipe:

```
macOS Keychain → python3 (extract) → curl (API call) → JSON response
                                                            ↓
                                            Node.js only sees this
```

The plugin spawns a single shell command:

```typescript
function fetchQuotaFromApi(): QuotaStatus | null {
  try {
    const extractToken = `python3 -c "import json,sys; print(json.loads(sys.stdin.read())['claudeAiOauth']['accessToken'])"`;
    const curlApi = `xargs -I{} curl -sf -H "Authorization: Bearer {}" -H "anthropic-beta: oauth-2025-04-20" "https://api.anthropic.com/api/oauth/usage"`;
    const cmd = `security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null | ${extractToken} 2>/dev/null | ${curlApi} 2>/dev/null`;

    const raw = execSync(cmd, { timeout: 5000, encoding: "utf-8" }).trim();
    if (!raw) return null;
    return parseUsageApiResponse(JSON.parse(raw));
  } catch {
    return null; // Any failure: graceful fallback
  }
}
```

**API response shape (Anthropic-specific):**

```json
{
  "five_hour": { "utilization": 43.0, "resets_at": "2026-03-22T20:00:00Z" },
  "seven_day": { "utilization": 10.0, "resets_at": "2026-03-27T13:00:00Z" },
  "seven_day_sonnet": { "utilization": 1.0, "resets_at": "2026-03-27T21:00:00Z" },
  "extra_usage": { "is_enabled": false, "utilization": null }
}
```

Each entry maps to a `QuotaWindow` with `used_percentage` populated from `utilization`.

**Fallback chain in `getQuotaStatus()`:**

1. Try the API call → returns real percentages
2. If API fails (rate limited, expired token, not macOS) → use cached `rate_limit_event` data from last `doInfer()` (has status + reset time, no percentages)
3. If no rate limit events either → return `null`

### Platform Considerations

> **The secure API call approach described above is macOS-only.** It uses the macOS Keychain (`security find-generic-password`) to access Claude Code's OAuth token without ever reading it into the Node.js process.

**On other platforms, you'll need to adapt the credential access method:**

| Platform | Claude Code stores credentials in | Adaptation needed |
|----------|----------------------------------|-------------------|
| **macOS** | macOS Keychain (`security` CLI) | Current implementation works as-is |
| **Linux** | `libsecret` / `gnome-keyring` / file-based | Replace `security find-generic-password` with `secret-tool lookup` or read from `~/.claude/.credentials.json` if it exists |
| **Windows** | Windows Credential Manager | Replace with `cmdkey` or PowerShell `Get-StoredCredential`, or read from the Windows-equivalent credential file |

**If you're adapting for a new platform:**

1. Find where Claude Code stores its OAuth credentials on your OS (check Claude Code source or look for credential files)
2. Replace the `security find-generic-password` command with your platform's equivalent
3. Keep the same pipe pattern — credential → extract token → curl API → JSON result
4. The token must never be stored in a variable, file, log, or env var in the Node.js process
5. Test the fallback: if your credential access fails, `getQuotaStatus()` must return `null` gracefully, never throw

**If your CLI tool doesn't use OAuth or has a different auth model**, the fallback to `rate_limit_event` parsing still works. You'll get status (allowed/denied) and reset times — just not percentages.

**If your CLI tool has its own usage API** (e.g. OpenCode might expose usage through its own mechanism), implement `fetchQuotaFromApi()` with whatever secure approach works for that provider. The contract (`QuotaStatus` with `QuotaWindow[]`) is provider-agnostic.

---

## Limit Detection (Layer 3)

Core calls `getQuotaStatus()` after every inference call and periodically on a timer. When `is_rate_limited` is `true`:

1. **Daemon pauses task dispatch** — no new tasks are sent to the Orchestrator.
2. **Active tasks yield** — the current agent loop iteration completes, then the task is transitioned to `blocked`.
3. **Reset timer** — if `earliest_reset_at` is set, the Daemon schedules a resume check at that time.
4. **Dashboard** — the War Room shows the rate-limited state, which windows are exhausted, and the countdown to reset.

When `is_rate_limited` returns to `false`, blocked tasks are automatically re-queued.

Your plugin's only job: set `is_rate_limited: true` and `earliest_reset_at` accurately. Core handles everything else.

---

## Environment Isolation

LLM subprocesses must not inherit secrets from the parent process. The `buildLlmEnv()` pattern solves this.

```
Parent Process (The Engineer)
  ├── GITHUB_TOKEN=ghp_xxx       ← must NOT leak
  ├── TELEGRAM_BOT_TOKEN=123:abc ← must NOT leak
  ├── HOME=/Users/dev            ← safe
  ├── PATH=/usr/bin:...          ← safe
  └── ...

Child Process (LLM CLI)
  ├── HOME=/Users/dev            ← forwarded
  ├── PATH=/usr/bin:...          ← forwarded
  ├── LANG=en_US.UTF-8           ← forwarded
  └── (no secrets)               ← clean
```

### The allowlist

The reference implementation exports `buildLlmEnv()`:

```typescript
import { buildLlmEnv } from "./claude-code-llm.js"; // or copy the pattern

const LLM_ENV_ALLOWLIST = [
  "HOME", "PATH", "USER", "SHELL", "LANG", "TERM", "TMPDIR",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME",
  "NODE_OPTIONS", "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_TLS_REJECT_UNAUTHORIZED",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "no_proxy",
];

const LLM_ENV_PREFIX_ALLOWLIST = ["LC_"];

function buildLlmEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  const allowed = new Set(LLM_ENV_ALLOWLIST);
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (allowed.has(key) || LLM_ENV_PREFIX_ALLOWLIST.some((p) => key.startsWith(p))) {
      result[key] = value;
    }
  }
  return result;
}
```

Use it in every `spawn()` call:

```typescript
const child = spawn(cliPath, args, {
  env: buildLlmEnv(process.env),  // never pass process.env directly
  cwd: request.cwd ?? undefined,
});
```

If your CLI requires a specific env var for authentication (e.g. `OPENAI_API_KEY`), add it to your plugin's local allowlist — do not add secrets to the shared allowlist.

---

## Health Check

Implement `doHealthCheck()` to verify the CLI tool is installed and reachable.

```typescript
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
```

The Registry calls `healthCheck()` periodically. Return `{ healthy: false }` to trigger the health state machine (`healthy` -> `unhealthy` -> `failed` after consecutive failures). Never throw — `BaseAdapter.healthCheck()` catches exceptions, but returning a clean result is preferred.

---

## Configuration

Define a Zod schema for your plugin's config. Parse it in `doInitialize()`.

### Config schema

```typescript
// my-llm/config.ts
import { z } from "zod";

export const MyLLMConfigSchema = z.object({
  model: z.string().default("my-default-model"),
  cli_path: z.string().default("my-cli"),
  command_timeout_ms: z.number().int().positive().default(600_000),
  api_base_url: z.string().url().optional(),
});

export type MyLLMConfig = z.output<typeof MyLLMConfigSchema>;
```

Use `z.output<typeof Schema>` (not `z.infer`) — this resolves defaults and transforms, which matters with `exactOptionalPropertyTypes`.

### Initialization

```typescript
protected doInitialize(config: Record<string, unknown>): Promise<InitResult> {
  const parsed = MyLLMConfigSchema.safeParse(config);
  if (!parsed.success) {
    return Promise.resolve({
      success: false,
      message: `Invalid config: ${parsed.error.message}`,
    });
  }
  this.config = parsed.data;
  return Promise.resolve({ success: true, message: null });
}
```

Never throw from `doInitialize()`. Return `{ success: false, message }` on bad config.

### User-facing config

Users configure plugins in `~/.engineer/config/plugins.yaml`:

```yaml
plugins:
  my-llm:
    enabled: true
    config:
      model: "gpt-4o"
      cli_path: "/usr/local/bin/my-cli"
      command_timeout_ms: 300000
```

The Registry passes the `config` object to your `doInitialize()`.

---

## Testing

### Contract compliance suite

Every LLM plugin must pass the shared contract suite. This validates lifecycle, result shapes, and capability reporting.

```typescript
// my-llm/my-llm.test.ts
import { describe } from "vitest";
import { runLLMContractSuite } from "../../../../test/helpers/contract-suites/llm-contract.js";
import type { PluginManifest } from "../../../adapters/index.js";
import { MyLLMPlugin } from "./my-llm.js";

const manifest: PluginManifest = {
  id: "my-llm",
  type: "llm",
  version: "0.1.0",
  name: "My LLM Plugin",
  description: "Integration with My CLI",
  config_schema: {},
  critical: true,
  enabled: true,
  entry: "index.ts",
  adapter_meta: {},
  contributes: { events: [], commands: [], config_keys: [], hooks: [] },
};

runLLMContractSuite(
  () => new MyLLMPlugin(),
  {
    manifest,
    validConfig: { model: "my-model", cli_path: "/path/to/mock" },
    invalidConfig: { model: 123 }, // triggers safeParse failure
    request: { prompt: "Hello", system_prompt: null, cwd: null },
  },
);
```

The contract suite tests:

- `initialize()` with valid config returns `{ success: true }`
- `initialize()` with invalid config returns `{ success: false }` (does not throw)
- `healthCheck()` returns `HealthStatus` with all required fields, within 5 seconds
- `shutdown()` resolves without throwing
- `infer()` returns a valid `InferenceResult` (schema-validated)
- `infer()` result always has `cost_usd` and `duration_ms`
- `usage` is `null` or valid `InferenceUsage`
- `getCapabilities()` returns valid `LLMCapabilities`
- `getQuotaStatus()` returns `null` or valid `QuotaStatus`

### Mock CLI scripts

For unit tests that don't hit a real CLI, create mock scripts that write expected output to stdout. See `src/plugins/llm/claude-code-llm/claude-code-llm.test.ts` for the pattern — the test sets `cli_path` to a mock script that outputs pre-formatted NDJSON.

---

## Reference

Canonical example: `src/plugins/llm/claude-code-llm/`

| File | Purpose |
|------|---------|
| `src/plugins/llm/claude-code-llm/claude-code-llm.ts` | Full implementation (spawn, parse, usage, quota, env isolation) |
| `src/plugins/llm/claude-code-llm/config.ts` | Zod config schema |
| `src/plugins/llm/claude-code-llm/claude-code-llm.test.ts` | Tests with mock CLI scripts |
| `src/adapters/llm.ts` | Abstract `LLMAdapter` base class (three-layer contract, `getQuotaStatus()` default) |
| `src/adapters/base.ts` | `BaseAdapter` — lifecycle template methods |
| `src/adapters/index.ts` | Plugin SDK barrel — the single import point |
| `src/schemas/adapters.ts` | All Zod schemas (InferenceRequest, InferenceResult, TokenUsage, QuotaStatus, LLMCapabilities) |
| `test/helpers/contract-suites/llm-contract.ts` | Contract compliance test suite |
| `src/dashboard/api/metrics.ts` | Dashboard endpoints — `/quota` includes the same secure API pipe (macOS) |

### Platform-specific code locations

The macOS Keychain integration lives in two places:

1. **Plugin** — `fetchQuotaFromApi()` in `claude-code-llm.ts` (called during daemon operation)
2. **Dashboard** — `fetchQuotaViaShellPipe()` in `metrics.ts` (called when dashboard loads, before any daemon run)

Both use the same shell pipe pattern. If adapting for Linux/Windows, update both locations.
