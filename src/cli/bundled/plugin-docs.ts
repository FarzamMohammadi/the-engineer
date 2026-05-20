// ── Plugin Documentation ──────────────────────────────────────────────────────
// Bundled markdown — mirrors docs/plugins/**/*.md so first-run setup can write
// per-plugin docs into ~/.engineer/docs/. Keep in sync manually when docs change.
// Escape rules when copying from .md: backticks (` → \`) and ${} (${ → \${).

export interface PluginDoc {
  readonly relativePath: string;
  readonly content: string;
}

const TRIGGER_README = `# Trigger Adapter

Trigger adapters discover new work by polling external sources. The Daemon calls \`poll()\` on a configurable interval, and the adapter returns zero or more \`TriggerEvent\` objects representing new tasks. Each event carries an idempotency key so the Daemon can deduplicate across polls. This is the simplest adapter type -- one abstract method (\`doPoll()\`) beyond the standard lifecycle.

## Contract

\`TriggerAdapter\` extends \`BaseAdapter\`. All lifecycle methods (\`initialize\`, \`shutdown\`, \`healthCheck\`) are inherited from \`BaseAdapter\` as template methods -- you implement the \`do*\` variants.

| Method | Signature | Required | Description |
|--------|-----------|----------|-------------|
| \`doPoll()\` | \`() => Promise<TriggerEvent[]>\` | Yes | Poll the external source for new events. Return \`[]\` when there is nothing new. |
| \`doInitialize(config)\` | \`(config: Record<string, unknown>) => Promise<InitResult>\` | Yes | Parse config with Zod, set up clients. Return \`{ success: false, message }\` on bad config -- never throw. |
| \`doShutdown()\` | \`() => Promise<void>\` | Yes | Clean up resources (persist state, close connections). |
| \`doHealthCheck()\` | \`() => Promise<HealthStatus>\` | Yes | Verify external connectivity. Must resolve within 5 seconds. |

The public \`poll()\` wrapper on \`TriggerAdapter\` catches errors: \`AdapterMethodError\` is rethrown as-is, anything else is wrapped with \`code: "internal_error"\` and \`severity: "fatal"\`.

## Key Types

### TriggerEvent

Defined in \`src/schemas/adapters.ts\` (\`TriggerEventSchema\`).

| Field | Type | Description |
|-------|------|-------------|
| \`idempotency_key\` | \`string\` | Stable key for deduplication (e.g. \`github:issue:owner/repo:42\`). Must be deterministic -- same event must produce the same key across polls. |
| \`source\` | \`string\` | Plugin ID that produced this event. |
| \`event_type\` | \`string\` | Classification (e.g. \`issue_assigned\`, \`pr_review_requested\`). |
| \`external_ref\` | \`ExternalRef \\| null\` | Link back to the external system (type, repo, id, url). |
| \`title\` | \`string\` | Human-readable title for the task. |
| \`body\` | \`string \\| null\` | Full description/body text. |
| \`repo\` | \`string\` | Repository identifier (\`owner/name\`). |
| \`clone_url\` | \`string\` | HTTPS clone URL. Must start with \`https://\`. |
| \`thoughts_id\` | \`string \\| null\` | Identifier for the thoughts directory (e.g. \`issue-42\`). |
| \`metadata\` | \`Record<string, unknown>\` | Arbitrary platform-specific data (labels, assignees, timestamps). |

### InitResult

| Field | Type | Description |
|-------|------|-------------|
| \`success\` | \`boolean\` | Whether initialization succeeded. |
| \`message\` | \`string \\| null\` | Error message on failure, \`null\` on success. |

### HealthStatus

| Field | Type | Description |
|-------|------|-------------|
| \`healthy\` | \`boolean\` | Whether the adapter is operational. |
| \`message\` | \`string\` | Human-readable status message. |
| \`details\` | \`Record<string, unknown> \\| null\` | Optional structured details (e.g. API rate limit remaining). |

## Developing a New Plugin

### Directory structure

\`\`\`
src/plugins/trigger/my-trigger/
  my-trigger.ts       # Plugin class extending TriggerAdapter
  config.ts           # Zod config schema
  my-trigger.test.ts  # Tests including contract suite
\`\`\`

### Minimal class skeleton

\`\`\`typescript
import {
  type HealthStatus,
  type InitResult,
  TriggerAdapter,
  type TriggerEvent,
} from "../../../adapters/index.js";
import { type MyTriggerConfig, MyTriggerConfigSchema } from "./config.js";

export class MyTriggerPlugin extends TriggerAdapter {
  private config!: MyTriggerConfig;

  protected async doPoll(): Promise<TriggerEvent[]> {
    // Poll your external source, return events with stable idempotency keys
    return [];
  }

  protected doInitialize(config: Record<string, unknown>): Promise<InitResult> {
    const parsed = MyTriggerConfigSchema.safeParse(config);
    if (!parsed.success) {
      return Promise.resolve({
        success: false,
        message: \`Invalid config: \${parsed.error.message}\`,
      });
    }
    this.config = parsed.data;
    return Promise.resolve({ success: true, message: null });
  }

  protected doShutdown(): Promise<void> {
    return Promise.resolve();
  }

  protected async doHealthCheck(): Promise<HealthStatus> {
    return { healthy: true, message: "OK", details: null };
  }
}
\`\`\`

### Config schema pattern

Use Zod with \`z.output\` for the type (resolves defaults, required for \`exactOptionalPropertyTypes\`).

\`\`\`typescript
// my-trigger/config.ts
import { z } from "zod";

export const MyTriggerConfigSchema = z.object({
  api_token: z.string().min(1),
  poll_interval_ms: z.number().int().positive().default(30_000),
  project_id: z.string().min(1),
});

export type MyTriggerConfig = z.output<typeof MyTriggerConfigSchema>;
\`\`\`

### Registration in builtin.ts

Add three things to \`src/plugins/builtin.ts\`:

1. Import your plugin class.
2. Add a manifest to the \`manifests\` array.
3. Add a factory to the \`factories\` map.

\`\`\`typescript
// 1. Import
import { MyTriggerPlugin } from "./trigger/my-trigger/my-trigger.js";

// 2. Manifest (in manifests array)
{
  id: "my-trigger",
  type: "trigger",
  version: "1.0.0",
  name: "My Trigger",
  description: "Polls My Service for new tasks",
  critical: true,
  requirements: [{ type: "env", name: "MY_API_TOKEN" }],
  entry: "builtin",
  adapter_meta: { poll_interval: "30s" },
  contributes: { events: ["trigger.new_event"] },
},

// 3. Factory (in factories map)
"my-trigger": () => new MyTriggerPlugin(),
\`\`\`

If your plugin needs interactive setup (e.g. asking for a project ID), add a \`promptForConfig\` entry:

\`\`\`typescript
// In promptFunctions map
"my-trigger": async () => {
  const { input } = await import("@inquirer/prompts");
  const projectId = await input({ message: "Project ID:" });
  return { project_id: projectId };
},
\`\`\`

### Contract test suite

Run the shared contract suite in your test file. Path: \`test/helpers/contract-suites/trigger-contract.ts\`.

\`\`\`typescript
// my-trigger/my-trigger.test.ts
import { runTriggerContractSuite } from "../../../../test/helpers/contract-suites/trigger-contract.js";
import { MyTriggerPlugin } from "./my-trigger.js";

const manifest = {
  id: "my-trigger",
  type: "trigger" as const,
  version: "1.0.0",
  name: "My Trigger",
  description: "Test",
  critical: true,
  entry: "builtin",
  adapter_meta: {},
  contributes: { events: [], commands: [], config_keys: [], hooks: [] },
};

runTriggerContractSuite(
  () => new MyTriggerPlugin(),
  {
    manifest,
    validConfig: { api_token: "tok_123", project_id: "proj_1" },
    invalidConfig: {},  // triggers safeParse failure
  },
);
\`\`\`

The contract suite validates:
- \`initialize()\` succeeds with valid config, returns \`{ success: false }\` (not throws) with invalid config
- \`healthCheck()\` returns \`HealthStatus\` with all required fields, resolves within 5 seconds
- \`shutdown()\` resolves without throwing
- \`poll()\` returns an array where each event passes \`TriggerEventSchema\` validation
- Idempotency keys are stable across consecutive polls

## Built-in Plugins

| Plugin | Source | Polls | Idempotency Key Pattern | Watermarks | Requirements |
|--------|--------|-------|-------------------------|------------|--------------|
| **GitHub Trigger** | GitHub Issues | Issues assigned to user, filtered by labels | \`github:issue:{owner}/{repo}:{number}\` | Per-repo ISO timestamp, persisted to \`~/.engineer/state/github-trigger/watermarks.json\` | \`GITHUB_TOKEN\` env var |

The GitHub Trigger plugin also handles ETag-based conditional requests (304 Not Modified), Retry-After from 429 responses, and error classification (\`auth_failed\`, \`not_found\`, \`rate_limited\`, \`network_error\`).

## Reference

| File | Purpose |
|------|---------|
| \`src/adapters/trigger.ts\` | Abstract \`TriggerAdapter\` base class |
| \`src/adapters/base.ts\` | \`BaseAdapter\` -- lifecycle template methods, \`hasCapability()\` |
| \`src/adapters/errors.ts\` | \`AdapterMethodError\`, \`createAdapterError()\` |
| \`src/adapters/index.ts\` | Plugin SDK barrel -- single import point |
| \`src/schemas/adapters.ts\` | \`TriggerEventSchema\`, \`PluginManifestSchema\`, all shared types |
| \`src/plugins/trigger/github-trigger/github-trigger.ts\` | Reference implementation |
| \`src/plugins/trigger/github-trigger/config.ts\` | Reference config schema |
| \`src/plugins/builtin.ts\` | Plugin registration (manifests + factories + promptForConfig) |
| \`test/helpers/contract-suites/trigger-contract.ts\` | Contract compliance test suite |
`;

const TRIGGER_GITHUB_TRIGGER = `# GitHub Trigger

The GitHub Trigger plugin polls the GitHub Issues API for open issues across configured repositories. When it finds issues, it generates \`TriggerEvent\` objects with stable idempotency keys (\`github:issue:{owner}/{repo}:{number}\`), which the Daemon uses to create tasks.

Use this plugin when you want The Engineer to pick up work from GitHub Issues. It is the standard entry point for the GitHub workflow -- assign an issue, and The Engineer starts working on it.

## Requirements

| Requirement | Details |
|---|---|
| **\`GITHUB_TOKEN\`** | A GitHub personal access token with \`repo\` scope. Generate one at https://github.com/settings/tokens. Set as an environment variable before running \`engineer start\`. |
| **Network** | Outbound HTTPS access to \`api.github.com\`. |

The plugin is marked \`critical: true\` -- if it fails to initialize, the Daemon will not start.

## Capabilities

- Polls open issues from one or more repositories
- Filters by label (optional)
- Per-repo watermark tracking -- only returns issues updated since the last poll
- ETag caching for conditional requests (304 Not Modified skips processing)
- Rate limit handling with Retry-After backoff (429 responses pause polling)
- Watermark persistence to disk -- survives restarts without re-processing old issues
- Idempotency keys prevent duplicate task creation for the same issue
- Filters out pull requests (only issues are returned)

## Configuration

Config file: \`~/.engineer/config/plugins/github-trigger.yaml\`

| Field | Type | Default | Required | Description |
|---|---|---|---|---|
| \`github_token\` | \`string\` | -- | Yes | GitHub personal access token. Use \`\${GITHUB_TOKEN}\` to read from env. |
| \`repos\` | \`array\` | -- | Yes | At least one repository to watch. Each entry needs \`owner\` and \`name\`. |
| \`repos[].owner\` | \`string\` | -- | Yes | GitHub username or organization. |
| \`repos[].name\` | \`string\` | -- | Yes | Repository name. |
| \`labels\` | \`string[]\` | \`[]\` | No | Only trigger on issues with these labels. Empty means all issues. |
| \`poll_interval_ms\` | \`number\` | \`30000\` | No | Polling interval in milliseconds. |

### Minimal config

\`\`\`yaml
repos:
  - owner: your-github-username
    name: your-repo-name

github_token: "\${GITHUB_TOKEN}"
\`\`\`

### Full config

\`\`\`yaml
repos:
  - owner: FarzamMohammadi
    name: my-project

github_token: "\${GITHUB_TOKEN}"
labels: ["engineer"]
poll_interval_ms: 30000
\`\`\`

## How It Works

On each poll cycle, the plugin iterates through configured repos and calls the GitHub Issues API (\`GET /repos/{owner}/{repo}/issues\`) with \`state=open\`, \`sort=updated\`, \`direction=asc\`, and \`per_page=30\`.

**Watermarks**: After processing issues from a repo, the plugin records the latest \`updated_at\` timestamp. On subsequent polls, it passes this as the \`since\` parameter so the API only returns issues updated after that point. Watermarks are persisted to \`~/.engineer/state/github-trigger/watermarks.json\` on shutdown (atomic write via temp file + rename) and loaded on startup.

**ETag caching**: Each request includes an \`If-None-Match\` header with the ETag from the previous response. If the API returns 304 (no changes), the plugin skips processing entirely. This saves API quota on quiet repos.

**Rate limiting**: If the API returns 429, the plugin records the \`Retry-After\` duration and skips all polling until that time passes.

**Interactive setup**: The first \`engineer start\` invocation prompts for the repo in \`owner/name\` format and generates the config file.

## Limitations

- Polling only -- no webhook support. There is an inherent delay between issue creation and task pickup (up to \`poll_interval_ms\`).
- Fetches at most 30 issues per repo per poll cycle. Repos with many simultaneous new issues may need multiple cycles.
- No PR review trigger events in the current implementation (idempotency key format exists for reviews but \`pollIssues\` filters out PRs).
- Label filtering is applied at the API level (comma-joined), so an issue must have all listed labels to match.
- Watermark loss (corrupt file, first run) causes re-fetching from the beginning. The Daemon's idempotency key deduplication prevents duplicate tasks.

## Related Plugins

| Plugin | Relationship |
|---|---|
| **github-comm** | Posts comments and manages labels on the GitHub issues that triggered tasks. |
| **github-hosting** | Creates and manages PRs for completed work on the same repos. |

These three plugins share the same \`GITHUB_TOKEN\` and form the complete GitHub workflow: trigger from issues, communicate via comments, deliver via PRs.
`;

const LLM_README = `# LLM Adapter

LLM adapters are inference-only providers. The Engineer is the agent -- LLM plugins receive a prompt and return text. Each plugin spawns a CLI tool as a child process, pipes the prompt via stdin, parses structured output from stdout, and returns content + cost + usage data. The Orchestrator handles all reasoning, tool use, and phase transitions. Plugins never make decisions.

## Contract

\`LLMAdapter\` extends \`BaseAdapter\`. All lifecycle methods are inherited as template methods.

| Method | Signature | Required | Description |
|--------|-----------|----------|-------------|
| \`doInfer(request)\` | \`(request: InferenceRequest) => Promise<InferenceResult>\` | Yes | Spawn the CLI, pipe prompt via stdin, parse output. Every result MUST include \`cost_usd\` (or \`null\`) and \`duration_ms\`. |
| \`getCapabilities()\` | \`() => LLMCapabilities\` | Yes | Synchronous, pure. Return model ID, reporting flags, context window. |
| \`getQuotaStatus()\` | \`() => Promise<QuotaStatus \\| null>\` | No | Override to report rate limits/quota. Default returns \`null\`. |
| \`doInitialize(config)\` | \`(config: Record<string, unknown>) => Promise<InitResult>\` | Yes | Parse config with Zod. Return \`{ success: false, message }\` on bad config -- never throw. |
| \`doShutdown()\` | \`() => Promise<void>\` | Yes | Kill active child process, clean up. |
| \`doHealthCheck()\` | \`() => Promise<HealthStatus>\` | Yes | Verify CLI is installed (e.g. \`spawn("cli", ["--version"])\`). Must resolve within 5 seconds. |

The public \`infer()\` wrapper catches errors: \`AdapterMethodError\` is rethrown as-is, anything else is wrapped with \`code: "internal_error"\` and \`severity: "fatal"\`.

### Three-Layer Usage Contract

Each layer is optional. Core degrades gracefully when data is missing.

\`\`\`
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
\`\`\`

| Layer | What | Method/Field | If missing |
|-------|------|--------------|------------|
| Per-call usage | Tokens, cost, cache hits | \`InferenceResult.usage\` | Cost tracking uses \`cost_usd\` alone; token displays show N/A |
| Quota status | Session/plan windows | \`getQuotaStatus()\` | No quota display, no pause-for-reset |
| Limit detection | Hard stop signal | \`QuotaStatus.is_rate_limited\` | Core cannot detect rate limits proactively |

## Key Types

### InferenceRequest

| Field | Type | Description |
|-------|------|-------------|
| \`prompt\` | \`string\` | The full prompt text. **Always pipe via stdin** -- see critical warning below. |
| \`system_prompt\` | \`string \\| null\` | System-level instructions. Use CLI's \`--system-prompt\` flag if available, otherwise prepend to prompt. |
| \`cwd\` | \`string \\| null\` | Working directory for the CLI process. Set as \`spawn()\` cwd so the CLI loads the target repo's project context. |

### InferenceResult

| Field | Type | Description |
|-------|------|-------------|
| \`content\` | \`string\` | The LLM's response text. Orchestrator parses this for actions. |
| \`cost_usd\` | \`number \\| null\` | Cost of this call in USD. Critical for Safety Layer cost tracking. \`null\` if CLI does not report cost. |
| \`duration_ms\` | \`number\` | Wall-clock time for the CLI call. Measured by your plugin (\`Date.now()\` delta). |
| \`usage\` | \`InferenceUsage \\| null\` | Token breakdown and model info. \`null\` if CLI does not report usage. |

### InferenceUsage

| Field | Type | Description |
|-------|------|-------------|
| \`tokens.input_tokens\` | \`number\` | Tokens consumed by the prompt. |
| \`tokens.output_tokens\` | \`number\` | Tokens generated in the response. |
| \`tokens.cache_read_tokens\` | \`number\` | Tokens served from cache (default \`0\`). |
| \`tokens.cache_creation_tokens\` | \`number\` | Tokens written to cache (default \`0\`). |
| \`tokens.total_tokens\` | \`number\` | \`input_tokens + output_tokens\`. Compute this yourself. |
| \`model_id\` | \`string \\| null\` | Actual model used (may differ from requested). |
| \`service_tier\` | \`string \\| null\` | Provider's service tier (e.g. \`"standard"\`, \`"extended_thinking"\`). |

### LLMCapabilities

| Field | Type | Description |
|-------|------|-------------|
| \`model_id\` | \`string\` | Default model identifier. |
| \`supports_usage_reporting\` | \`boolean\` | Whether \`usage\` is populated in results. |
| \`supports_quota_reporting\` | \`boolean\` | Whether \`getQuotaStatus()\` returns data. |
| \`context_window\` | \`number \\| null\` | Context window size in tokens, or \`null\` if unknown. |

### QuotaStatus / QuotaWindow

| Field | Type | Description |
|-------|------|-------------|
| \`windows\` | \`QuotaWindow[]\` | Array of quota boundaries. |
| \`is_rate_limited\` | \`boolean\` | When \`true\`, Core pauses task dispatch and blocks active tasks. |
| \`earliest_reset_at\` | \`number \\| null\` | Unix timestamp (ms) of earliest reset. Core schedules resume check. |
| \`QuotaWindow.window_type\` | \`string\` | Identifier (e.g. \`"five_hour"\`, \`"seven_day"\`, \`"gemini_model_quota"\`). |
| \`QuotaWindow.resets_at\` | \`number \\| null\` | When this window resets. |
| \`QuotaWindow.is_exhausted\` | \`boolean\` | Whether this window's quota is fully consumed. |
| \`QuotaWindow.used_percentage\` | \`number \\| null\` | 0-100 usage percentage, if available. |

## Developing a New Plugin

### Directory structure

\`\`\`
src/plugins/llm/my-llm/
  my-llm.ts       # Plugin class extending LLMAdapter
  config.ts        # Zod config schema
  my-llm.test.ts   # Tests including contract suite
\`\`\`

### Minimal class skeleton

\`\`\`typescript
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
      ? \`[SYSTEM INSTRUCTIONS]\\n\${request.system_prompt}\\n[END SYSTEM INSTRUCTIONS]\\n\\n\${request.prompt}\`
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
            createAdapterError("cli_error", \`CLI exited with code \${code}: \${stderr}\`, {
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
          createAdapterError("spawn_error", \`Failed to spawn CLI: \${err.message}\`),
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
      return Promise.resolve({ success: false, message: \`Invalid config: \${parsed.error.message}\` });
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
          message: code === 0 ? \`CLI v\${version}\` : "CLI not available",
          details: code === 0 ? { version } : null,
        });
      });
      child.on("error", () => {
        resolve({ healthy: false, message: "CLI not found", details: null });
      });
    });
  }
}
\`\`\`

### Critical rules for LLM plugins

**Always pipe prompts via stdin.** Orchestrator prompts are 50KB+. Passing them as CLI arguments hits OS \`ARG_MAX\` limits and causes silent truncation or failure.

\`\`\`typescript
// WRONG -- will break on real orchestrator prompts
args.push(prompt);             // positional arg
args.push("-p", prompt);       // flag value

// RIGHT -- no size limit
child.stdin?.write(prompt);
child.stdin?.end();
\`\`\`

CLI-specific stdin patterns:

| CLI Tool | Stdin Pattern |
|----------|--------------|
| Claude Code | Reads from stdin when no positional arg given |
| OpenCode | Reads from stdin when no message args given |
| Gemini CLI | Appends stdin to \`-p\` value; use \`-p ""\` to enable non-interactive mode |

**Always sanitize the environment.** Use \`buildLlmEnv(process.env)\` -- never pass \`process.env\` directly to \`spawn()\`. The parent process holds \`GITHUB_TOKEN\`, \`TELEGRAM_BOT_TOKEN\`, and other secrets that must not leak to LLM subprocesses. If your CLI needs a specific auth env var, add it to a local allowlist in your plugin -- do not add secrets to the shared allowlist.

**Prepend system prompt when no CLI flag exists.** Only Claude Code has \`--system-prompt\`. For other CLIs:

\`\`\`typescript
const prompt = request.system_prompt
  ? \`[SYSTEM INSTRUCTIONS]\\n\${request.system_prompt}\\n[END SYSTEM INSTRUCTIONS]\\n\\n\${request.prompt}\`
  : request.prompt;
\`\`\`

**Detect rate limits from stdout AND stderr.** Some CLIs report rate limits in structured stdout (e.g. Gemini's \`result\` event with \`status: "error"\`). Others print retry messages to stderr. Monitor both:

\`\`\`typescript
const RATE_LIMIT_STDERR_RE = /exhausted your capacity|rate.?limit|quota/i;

child.stderr?.on("data", (chunk: Buffer) => {
  stderrChunks.push(chunk);
  const text = chunk.toString("utf-8");
  if (!killedForRateLimit && RATE_LIMIT_STDERR_RE.test(text)) {
    killedForRateLimit = true;
    child.kill("SIGTERM");  // kill immediately -- see below
  }
});
\`\`\`

**Kill infinite-retry CLIs immediately on rate limit detection.** Some CLIs (Gemini CLI, OpenCode) retry infinitely when rate limited, burning time and potentially accumulating cost. When you detect a rate limit pattern in stderr, \`SIGTERM\` the child process immediately and reject with a \`cli_error\` that has \`retryable: true\`. Core's Daemon handles the backoff and re-queuing.

**Suppress EPIPE on stdin.** The child process may exit before consuming all stdin. Add a no-op error handler:

\`\`\`typescript
child.stdin?.on("error", () => {});  // suppress EPIPE
\`\`\`

### Config schema pattern

\`\`\`typescript
// my-llm/config.ts
import { z } from "zod";

export const MyLLMConfigSchema = z.object({
  model: z.string().default("my-default-model"),
  cli_path: z.string().default("my-cli"),
  command_timeout_ms: z.number().int().positive().default(600_000),
});

export type MyLLMConfig = z.output<typeof MyLLMConfigSchema>;
\`\`\`

Use \`z.output<typeof Schema>\` (not \`z.infer\`) -- this resolves defaults and transforms, required for \`exactOptionalPropertyTypes\`.

### Registration in builtin.ts

\`\`\`typescript
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
\`\`\`

### Contract test suite

Path: \`test/helpers/contract-suites/llm-contract.ts\`.

\`\`\`typescript
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
\`\`\`

The contract suite validates:
- \`initialize()\` succeeds/fails correctly with valid/invalid config
- \`healthCheck()\` returns \`HealthStatus\` with all required fields, resolves within 5 seconds
- \`shutdown()\` resolves without throwing
- \`infer()\` returns a valid \`InferenceResult\` (schema-validated), always includes \`cost_usd\` and \`duration_ms\`
- \`usage\` is \`null\` or valid \`InferenceUsage\` with all token fields
- \`getCapabilities()\` returns valid \`LLMCapabilities\` with all fields
- \`getQuotaStatus()\` returns \`null\` or valid \`QuotaStatus\`

For unit tests that do not hit a real CLI, create mock scripts that write expected NDJSON to stdout. Set \`cli_path\` to the mock script path in your test config.

### NDJSON parsing

All three built-in plugins use NDJSON (newline-delimited JSON) output from their CLIs. The general pattern:

\`\`\`typescript
const lines = raw.split("\\n").filter((line) => line.trim().length > 0);
for (const line of lines) {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    // dispatch on parsed["type"]
  } catch {
    // Skip non-JSON lines (e.g. "Loaded cached credentials.")
  }
}
\`\`\`

Each CLI has a different event schema. Research your CLI's actual output before writing the parser.

## Built-in Plugins

| Plugin | CLI Tool | Default Model | Cost | Usage | Quota | System Prompt | Key Flags |
|--------|----------|---------------|------|-------|-------|---------------|-----------|
| **Claude Code** (default) | \`claude\` | \`claude-sonnet-4-20250514\` | Yes (USD) | Yes (full tokens + cache + model + service tier) | Yes (API + rate_limit_event fallback) | \`--system-prompt\` flag | \`--print --output-format stream-json --verbose --setting-sources user --dangerously-skip-permissions\` |
| **OpenCode** (opt-in) | \`opencode\` | \`opencode/gemini-3.1-pro\` | Yes (USD) | Yes (tokens + cache) | No | Prepend to prompt | \`run --format json\` |
| **Gemini CLI** (opt-in) | \`gemini\` | \`gemini-2.5-pro\` | No (free tier) | Yes (tokens + cache) | Yes (rate limit detection only) | Prepend to prompt | \`-p "" -o stream-json --yolo\` |

### Output format differences

| CLI | Content Event | Cost Source | Token Source | Rate Limit Source |
|-----|---------------|-------------|--------------|-------------------|
| Claude Code | \`type: "result"\` with \`result\` field | \`total_cost_usd\` on result event | \`usage\` on result event | \`type: "rate_limit_event"\` + API endpoint |
| OpenCode | \`type: "text"\` with \`part.text\` | \`part.cost\` on \`type: "step_finish"\` | \`part.tokens\` on \`type: "step_finish"\` | Stderr pattern matching |
| Gemini CLI | \`type: "message", role: "assistant"\` | N/A (free tier) | \`stats\` on \`type: "result"\` | Stderr pattern + stdout \`result.status: "error"\` |

### Quota reporting details

- **Claude Code**: Two sources. Primary: Anthropic's \`/api/oauth/usage\` endpoint (real percentages, cached 30 min). Fallback: \`rate_limit_event\` from last \`infer()\` call (status + reset time, no percentages). OAuth token read from macOS Keychain or \`~/.claude/.credentials.json\`.
- **Gemini CLI**: Sets a \`rateLimited\` flag when stdout result has \`status: "error"\` matching rate limit patterns, or stderr matches. Reports via \`getQuotaStatus()\` as a single \`gemini_model_quota\` window with \`is_exhausted: true\`. No reset time available.
- **OpenCode**: No quota reporting. Default \`getQuotaStatus()\` returns \`null\`.

## Reference

| File | Purpose |
|------|---------|
| \`src/adapters/llm.ts\` | Abstract \`LLMAdapter\` base class (three-layer contract) |
| \`src/adapters/base.ts\` | \`BaseAdapter\` -- lifecycle template methods, \`hasCapability()\` |
| \`src/adapters/errors.ts\` | \`AdapterMethodError\`, \`createAdapterError()\` |
| \`src/adapters/index.ts\` | Plugin SDK barrel -- single import point |
| \`src/schemas/adapters.ts\` | All Zod schemas (\`InferenceRequest\`, \`InferenceResult\`, \`TokenUsage\`, \`QuotaStatus\`, \`LLMCapabilities\`) |
| \`src/plugins/llm/claude-code-llm/claude-code-llm.ts\` | Reference: spawn, NDJSON parse, usage, quota API, env isolation |
| \`src/plugins/llm/claude-code-llm/config.ts\` | Reference config schema |
| \`src/plugins/llm/opencode-llm/opencode-llm.ts\` | Reference: multi-provider, step_finish cost/tokens, stderr rate limit kill |
| \`src/plugins/llm/gemini-cli-llm/gemini-cli-llm.ts\` | Reference: free tier, no cost, stdout+stderr rate limit detection |
| \`src/plugins/builtin.ts\` | Plugin registration (manifests + factories) |
| \`test/helpers/contract-suites/llm-contract.ts\` | Contract compliance test suite |
| \`contribution-docs/how-tos/plugins/llm-adapter/prompt.md\` | Interactive LLM-facing setup prompt |
`;

const LLM_CLAUDE_CODE = `# Claude Code LLM

The Claude Code LLM plugin is the default and most full-featured LLM option. It spawns the Claude CLI (\`claude\`) as a child process with \`--print --output-format stream-json --verbose\`, parses the NDJSON output for result events, and returns content, cost, and detailed token usage (including cache breakdown).

This is the recommended choice if you have a Claude Pro/Max subscription or API access. It is the only LLM plugin that supports quota reporting -- it reads your OAuth credentials to query Anthropic's usage API for real utilization percentages across quota windows.

## Requirements

| Requirement | Details |
|---|---|
| **\`claude\` CLI** | Install the Claude Code CLI and authenticate before starting The Engineer. The plugin runs \`claude --version\` as a health check. |
| **Authentication** | Log in via \`claude\` before first use. OAuth credentials are read from the OS keychain (macOS) or \`~/.claude/.credentials.json\` (Linux/Windows) for quota reporting. |

No environment variables are needed -- the Claude CLI handles its own authentication. The plugin is marked \`critical: true\`.

## Capabilities

- Full inference with system prompt support (\`--system-prompt\` flag)
- Prompt piped via stdin to avoid OS argument length limits
- Usage reporting: input/output tokens, cache read/creation tokens, total tokens, service tier, model ID
- Cost reporting: \`total_cost_usd\` or \`cost_usd\` from the CLI result event
- Quota reporting via Anthropic's OAuth usage API (five_hour, seven_day, and model-specific windows)
- Rate limit detection from \`rate_limit_event\` stream events
- Environment sanitization -- only allowlisted env vars forwarded to the subprocess (no secrets leak)
- Uses \`--setting-sources user\` to prevent loading project-level CLAUDE.md from the working directory
- Uses \`--dangerously-skip-permissions\` for non-interactive tool use (read/write/bash)
- Active process tracking with SIGTERM on shutdown
- 200,000 token context window reported

## Configuration

Config file: \`~/.engineer/config/plugins/claude-code-llm.yaml\`

| Field | Type | Default | Required | Description |
|---|---|---|---|---|
| \`model\` | \`string\` | \`claude-sonnet-4-20250514\` | No | Model identifier passed to \`--model\`. |
| \`max_tokens\` | \`number\` | \`16384\` | No | Maximum output tokens per completion. |
| \`cli_path\` | \`string\` | \`claude\` | No | Path to the Claude CLI binary. Change if it is not on your PATH. |
| \`command_timeout_ms\` | \`number\` | \`7200000\` | No | Maximum time per CLI invocation (default 2 hours). |

### Minimal config

All fields have defaults. An empty config file works:

\`\`\`yaml
# Claude Code LLM plugin
# Uses Claude CLI for LLM completions
\`\`\`

### Full config

\`\`\`yaml
model: claude-sonnet-4-20250514
max_tokens: 16384
cli_path: claude
command_timeout_ms: 7200000
\`\`\`

## How It Works

**Inference**: The plugin spawns \`claude --print --output-format stream-json --verbose --model <model> --setting-sources user --dangerously-skip-permissions\` with an optional \`--system-prompt\` flag. The prompt is written to stdin, then stdin is closed. The CLI streams NDJSON events to stdout.

**Output parsing**: The parser (\`parseCliOutput\`) scans for two event types:
- \`type: "result"\` -- the final output containing content (string or \`{text}\` object), \`total_cost_usd\`, and \`usage\` (token counts, cache stats, service tier). The \`modelUsage\` field provides the actual model ID.
- \`type: "rate_limit_event"\` -- quota window status (allowed/exhausted) with reset timestamps.

**Quota reporting**: \`getQuotaStatus()\` first tries the Anthropic OAuth usage API (\`/api/oauth/usage\`). The OAuth token is read from the OS credential store (macOS Keychain via \`security find-generic-password\`, or \`~/.claude/.credentials.json\` on other platforms). The token is piped to curl via stdin so it never appears in the process list. Results are cached for 30 minutes to respect Anthropic's aggressive per-token rate limits. If the API call fails, cached \`rate_limit_event\` data from the last inference call is used as a fallback.

**Environment isolation**: A strict allowlist controls which env vars reach the subprocess. Only system essentials (HOME, PATH, SHELL, LANG, TERM, TMPDIR), XDG dirs, Node.js config, TLS/proxy settings, and locale vars (LC_*) are forwarded. GITHUB_TOKEN, TELEGRAM_BOT_TOKEN, and other secrets are blocked.

## Limitations

- Requires the Claude CLI to be installed and authenticated separately -- the plugin does not handle login.
- Quota API access depends on having valid OAuth credentials in the Claude Code credential store. API key users will not get quota percentages (only rate_limit_event fallback).
- The 30-minute quota cache means utilization percentages can be stale during heavy usage.
- \`max_tokens\` is defined in config but not currently passed as a CLI flag (the Claude CLI manages its own output limits).
- Non-zero exit codes from the CLI are treated as retryable errors.

## Related Plugins

| Plugin | Relationship |
|---|---|
| **opencode-llm** | Alternative LLM plugin supporting multiple providers (Anthropic, OpenAI, Google) via one CLI. |
| **gemini-cli-llm** | Alternative LLM plugin using Google's free Gemini CLI. No cost tracking. |

Only one LLM plugin is active at a time. The Daemon uses the configured LLM plugin for all Orchestrator phase inference.
`;

const LLM_OPENCODE = `# OpenCode LLM

The OpenCode LLM plugin provides multi-provider LLM inference through the OpenCode CLI. It supports Anthropic, OpenAI, Google, and other providers through a single CLI tool, using the \`opencode run --format json\` command with NDJSON output parsing.

Use this plugin when you want provider flexibility -- switch between models from different vendors by changing one config field, without swapping plugins.

## Requirements

| Requirement | Details |
|---|---|
| **\`opencode\` CLI** | Install the OpenCode CLI and configure your provider credentials before starting The Engineer. The plugin runs \`opencode --version\` as a health check. |
| **Provider credentials** | Authenticate with your chosen provider(s) through OpenCode's own configuration. The Engineer does not manage provider API keys. |

The plugin is marked \`critical: true\`.

## Capabilities

- Multi-provider inference (Anthropic, OpenAI, Google, and others via OpenCode's provider system)
- Cost reporting from \`step_finish\` events
- Token usage reporting: input, output, cache read, cache write, total
- Prompt piped via stdin to avoid OS argument length limits
- System prompt prepended to user prompt (no native \`--system-prompt\` flag)
- Working directory support via \`--dir\` flag
- Rate limit detection from stderr -- process killed immediately on detection
- Environment sanitization -- only allowlisted env vars forwarded to the subprocess
- Active process tracking with SIGTERM on shutdown

Does **not** support:
- Quota reporting (\`supports_quota_reporting: false\`)
- Context window reporting (\`context_window: null\`)

## Configuration

Config file: \`~/.engineer/config/plugins/opencode-llm.yaml\`

| Field | Type | Default | Required | Description |
|---|---|---|---|---|
| \`model\` | \`string\` | \`opencode/gemini-3.1-pro\` | No | Model in \`provider/model\` format. |
| \`cli_path\` | \`string\` | \`opencode\` | No | Path to the OpenCode CLI binary. |
| \`command_timeout_ms\` | \`number\` | \`600000\` | No | Timeout for each CLI invocation (10 minutes). |

### Minimal config

All fields have defaults. An empty config file works:

\`\`\`yaml
# OpenCode LLM plugin
# Multi-provider LLM reasoning via OpenCode CLI
\`\`\`

### Full config

\`\`\`yaml
model: opencode/gemini-3.1-pro
cli_path: opencode
command_timeout_ms: 600000
\`\`\`

## How It Works

**Inference**: The plugin spawns \`opencode run --format json --model <model>\` with an optional \`--dir <cwd>\` flag. The prompt is written to stdin, then stdin is closed. OpenCode streams NDJSON events to stdout.

**System prompt handling**: OpenCode has no \`--system-prompt\` flag. When a system prompt is provided, the plugin prepends it to the user prompt wrapped in \`[SYSTEM INSTRUCTIONS]...[END SYSTEM INSTRUCTIONS]\` markers.

**Output parsing**: The parser (\`parseOpenCodeOutput\`) scans for two NDJSON event types:
- \`type: "text"\` -- content fragments in \`part.text\`, concatenated into the final response.
- \`type: "step_finish"\` -- cost (\`part.cost\`) and token breakdown (\`part.tokens\` with input, output, total, and cache read/write).

**Rate limit detection**: The plugin monitors stderr for patterns matching \`exhausted your capacity\`, \`rate limit\`, or \`quota\` (case-insensitive). On detection, it immediately sends SIGTERM to the child process and rejects with a retryable \`cli_error\`. This prevents the OpenCode CLI from entering infinite retry loops that waste time and potentially cost money.

**Environment isolation**: Same allowlist as all LLM plugins -- only system essentials, XDG dirs, Node.js config, TLS/proxy settings, and locale vars are forwarded. No secrets leak to the subprocess.

## Limitations

- No quota reporting -- the plugin cannot tell you how much of your provider's quota you have used.
- No context window size reported -- depends on the underlying model/provider.
- System prompts are prepended to the user prompt as text markers, not passed as a native parameter. The LLM sees them as part of the conversation, which is slightly less reliable than native system prompt support.
- Model ID in capabilities reflects the configured model string, not the actual model used by the provider.
- No \`max_tokens\` config field -- output length is controlled by the underlying provider/model defaults.

## Related Plugins

| Plugin | Relationship |
|---|---|
| **claude-code-llm** | The default LLM plugin. Full cost/quota reporting, native system prompt support, 200k context window. Best choice if you only use Anthropic. |
| **gemini-cli-llm** | Google's free-tier Gemini CLI. No cost data. Good for zero-cost experimentation. |

Only one LLM plugin is active at a time.
`;

const LLM_GEMINI_CLI = `# Gemini CLI LLM

The Gemini CLI LLM plugin uses Google's Gemini CLI tool for LLM inference. It runs on the free tier -- there is no cost data (cost_usd is always null). The plugin invokes \`gemini -p "" -o stream-json --yolo\` with the prompt piped via stdin, parses NDJSON output for content and token usage, and detects rate limits from both stdout and stderr.

Use this plugin for zero-cost experimentation or as a fallback when paid providers hit quota limits.

## Requirements

| Requirement | Details |
|---|---|
| **\`gemini\` CLI** | Install the Google Gemini CLI and authenticate before starting The Engineer. The plugin runs \`gemini --version\` as a health check. |
| **Google account** | Log in via \`gemini\` before first use. Free tier access requires a Google account. |

No API keys or environment variables needed. The plugin is marked \`critical: true\`.

## Capabilities

- Free-tier LLM inference via Google's Gemini CLI
- Token usage reporting: input, output, cached, total
- Quota status reporting (exhausted/available based on rate limit detection)
- System prompt prepended to user prompt (no native \`--system-prompt\` flag)
- Working directory support (passed as \`cwd\` to the spawned process)
- Rate limit detection from both stdout (error result events) and stderr (retry messages) -- process killed immediately on stderr detection
- \`--yolo\` flag for auto-approved tool calls (required for non-interactive use)
- Environment sanitization -- only allowlisted env vars forwarded to the subprocess
- Active process tracking with SIGTERM on shutdown

Does **not** support:
- Cost reporting (\`cost_usd\` is always \`null\`)
- Context window reporting (\`context_window: null\`)

## Configuration

Config file: \`~/.engineer/config/plugins/gemini-cli-llm.yaml\`

| Field | Type | Default | Required | Description |
|---|---|---|---|---|
| \`model\` | \`string\` | \`gemini-2.5-pro\` | No | Gemini model identifier passed to \`--model\`. |
| \`cli_path\` | \`string\` | \`gemini\` | No | Path to the Gemini CLI binary. |
| \`command_timeout_ms\` | \`number\` | \`600000\` | No | Timeout for each CLI invocation (10 minutes). |

### Minimal config

All fields have defaults. An empty config file works:

\`\`\`yaml
# Gemini CLI LLM plugin
# Uses Google Gemini CLI for LLM completions
# Free tier -- no cost tracking
\`\`\`

### Full config

\`\`\`yaml
model: gemini-2.5-pro
cli_path: gemini
command_timeout_ms: 600000
\`\`\`

## How It Works

**Inference**: The plugin spawns \`gemini -p "" -o stream-json --model <model> --yolo\`. The \`-p ""\` flag enables non-interactive mode -- Gemini appends stdin content to the empty prompt value. \`--yolo\` auto-approves any tool calls the model wants to make. The prompt is written to stdin, then stdin is closed.

**System prompt handling**: Gemini CLI has no \`--system-prompt\` flag. When a system prompt is provided, the plugin prepends it to the user prompt wrapped in \`[SYSTEM INSTRUCTIONS]...[END SYSTEM INSTRUCTIONS]\` markers.

**Output parsing**: The parser (\`parseGeminiCliOutput\`) scans for three NDJSON event types:
- \`type: "init"\` -- session metadata including the model ID.
- \`type: "message", role: "assistant"\` -- response content, concatenated into the final output.
- \`type: "result"\` -- token stats (\`stats.input_tokens\`, \`stats.output_tokens\`, \`stats.total_tokens\`, \`stats.cached\`). Also checked for \`status: "error"\` with rate limit messages.

**Rate limit detection (dual-path)**:
1. **stdout**: If a \`type: "result"\` event has \`status: "error"\` and the error message matches rate limit patterns (\`exhausted.*capacity\`, \`quota\`, \`rate limit\`), the plugin flags it as rate limited and rejects with a retryable error.
2. **stderr**: The plugin monitors stderr for the same patterns. On detection, it immediately sends SIGTERM to the child process. This is critical because the Gemini CLI retries infinitely on rate limits -- without this kill, the process would hang forever.

**Quota reporting**: \`getQuotaStatus()\` returns a simple exhausted/not-exhausted status based on the \`rateLimited\` flag from the last inference call. There is no usage API to query actual percentages.

**Environment isolation**: Same allowlist as all LLM plugins -- only system essentials, XDG dirs, Node.js config, TLS/proxy settings, and locale vars are forwarded.

## Limitations

- No cost data whatsoever -- \`cost_usd\` is always null. The free tier does not expose billing information.
- No usage API for quota percentages -- you only know if you are rate limited, not how close you are to the limit.
- System prompts are prepended to the user prompt as text markers, not passed as a native parameter.
- The Gemini CLI retries infinitely on rate limits. The plugin mitigates this by killing the process, but there is a brief window where retries may occur before stderr detection triggers.
- \`cache_creation_tokens\` is always 0 (Gemini reports \`cached\` but not cache creation).
- No \`max_tokens\` config field -- output length is controlled by the model defaults.

## Related Plugins

| Plugin | Relationship |
|---|---|
| **claude-code-llm** | The default LLM plugin. Full cost/quota reporting, native system prompt support. Best for production use. |
| **opencode-llm** | Multi-provider alternative supporting Anthropic, OpenAI, Google, and others through one CLI. Reports cost. |

Only one LLM plugin is active at a time.
`;

const COMMUNICATION_README = `# Communication Adapter

Communication adapters are the Engineer's voice -- how it talks to humans through external platforms. They are dumb transport: the Orchestrator owns all intelligence (what to say, when to say it, how to react). Plugins just format and deliver messages. The adapter has the largest contract surface of any adapter type because it supports three optional capability groups beyond the required send methods.

## Contract

\`CommunicationAdapter\` extends \`BaseAdapter\`. Methods are split into required and capability-gated optional groups.

### Required methods

| Method | Signature | Description |
|--------|-----------|-------------|
| \`doSendMessage(target, message)\` | \`(target: Target, message: FormattedMessage) => Promise<SendResult>\` | Send a message to a target. Return \`SendResult\` with success/failure -- do not throw on delivery failure. |
| \`formatMessage(content, type)\` | \`(content: string, type: MessageType) => string\` | Format content for this platform. Synchronous, pure. Called by Core before \`sendMessage()\`. |
| \`doInitialize(config)\` | \`(config: Record<string, unknown>) => Promise<InitResult>\` | Parse config with Zod, set up clients. Return \`{ success: false, message }\` on bad config. |
| \`doShutdown()\` | \`() => Promise<void>\` | Clean up resources. |
| \`doHealthCheck()\` | \`() => Promise<HealthStatus>\` | Verify external connectivity. Must resolve within 5 seconds. |

### Optional methods (capability-gated)

Core checks \`hasCapability(name)\` before calling any optional method. Default implementations throw \`AdapterMethodError\` with code \`capability_not_available\`. Override only the methods your plugin supports.

#### Capability: \`receive\`

| Method | Signature | Description |
|--------|-----------|-------------|
| \`doStartListening()\` | \`() => Promise<void>\` | Begin receiving inbound messages. |
| \`doStopListening()\` | \`() => Promise<void>\` | Stop receiving inbound messages. |
| \`doPollMessages(channels, since)\` | \`(channels: string[], since: string) => Promise<{ messages: InboundMessage[]; cursor: string }>\` | Poll for new inbound messages. Return messages and a cursor for pagination. |

#### Capability: \`sync\`

| Method | Signature | Description |
|--------|-----------|-------------|
| \`doSyncTaskState(taskId, oldState, newState, metadata)\` | \`(taskId: string, oldState: string, newState: string, metadata: SyncMetadata) => Promise<void>\` | Sync a task state change to the external platform (e.g. update labels). |
| \`doReconcileState(tasks)\` | \`(tasks: TaskReconciliationInput[]) => Promise<ReconciliationResult>\` | Reconcile task states after an outage. Batch operation. |

#### Capability: \`ticket_management\`

| Method | Signature | Description |
|--------|-----------|-------------|
| \`doCommentOnTicket(externalRef, comment)\` | \`(externalRef: ExternalRef, comment: string) => Promise<void>\` | Comment on an external ticket (issue/PR). |
| \`doCreateTicket(repo, options)\` | \`(repo: string, options: IssueOptions) => Promise<IssueResult>\` | Create a new ticket. Returns issue number and URL. |
| \`doUpdateTicket(repo, issueNumber, updates)\` | \`(repo: string, issueNumber: number, updates: IssueUpdates) => Promise<void>\` | Update an existing ticket (state, labels, body). |

### Capability system

Capabilities are declared in the plugin manifest's \`adapter_meta.capabilities\` array and checked at runtime via \`hasCapability()\`. Core never calls an optional method without checking first.

\`\`\`typescript
// In the manifest (builtin.ts):
adapter_meta: { capabilities: ["send", "sync", "ticket_management"], channel: "github" }

// Core checks before calling:
if (commPlugin.hasCapability("ticket_management")) {
  await commPlugin.commentOnTicket(externalRef, comment);
}
\`\`\`

You can override \`hasCapability()\` directly instead of relying on \`adapter_meta\` if your plugin needs dynamic capability resolution:

\`\`\`typescript
override hasCapability(capability: string): boolean {
  return ["send", "receive"].includes(capability);
}
\`\`\`

### Error handling pattern

All public methods on \`CommunicationAdapter\` use \`wrapAsync()\` which rethrows \`AdapterMethodError\` as-is and wraps unknown errors as \`internal_error\` with \`severity: "fatal"\`. For \`sendMessage()\`, return errors in the \`SendResult.error\` field rather than throwing -- this lets Core distinguish delivery failures (retryable) from plugin bugs (fatal).

## Key Types

### Target

| Field | Type | Description |
|-------|------|-------------|
| \`user_id\` | \`string\` | Handle identifying the recipient (e.g. GitHub username, Telegram handle). |
| \`channel\` | \`string \\| null\` | Platform-specific channel (e.g. \`owner/repo#42\` for GitHub, \`null\` for Telegram DM). |

### FormattedMessage

| Field | Type | Description |
|-------|------|-------------|
| \`content\` | \`string\` | Pre-formatted message content (output of \`formatMessage()\`). |
| \`metadata.task_id\` | \`string \\| null\` | Associated task ID. |
| \`metadata.type\` | \`MessageType\` | One of: \`notification\`, \`question\`, \`status_response\`, \`milestone\`, \`alert\`. |

### SendResult

| Field | Type | Description |
|-------|------|-------------|
| \`success\` | \`boolean\` | Whether the message was delivered. |
| \`message_id\` | \`string \\| null\` | Platform message ID on success. |
| \`error\` | \`AdapterError \\| null\` | Structured error on failure (code, message, retryable flag). |

### InboundMessage

| Field | Type | Description |
|-------|------|-------------|
| \`source\` | \`string\` | Platform name (e.g. \`"telegram"\`, \`"github"\`). |
| \`sender\` | \`string\` | Username or ID of the message author. |
| \`content\` | \`string\` | Message text. |
| \`timestamp\` | \`string\` | ISO 8601 datetime. |
| \`reply_to\` | \`string \\| null\` | ID of the message being replied to. |
| \`platform_metadata\` | \`Record<string, unknown>\` | Platform-specific data (chat_id, message_id, etc.). |

### SyncMetadata

| Field | Type | Description |
|-------|------|-------------|
| \`task_title\` | \`string\` | Task title for display. |
| \`external_ref\` | \`ExternalRef \\| null\` | Link to external ticket (repo, id, url). |
| \`sub_state\` | \`string \\| null\` | Task sub-state for label granularity. |
| \`reason\` | \`string \\| null\` | Reason for the state change. |

### IssueOptions / IssueResult / IssueUpdates

| Type | Key Fields | Description |
|------|------------|-------------|
| \`IssueOptions\` | \`title\`, \`body\`, \`labels?\`, \`assignees?\`, \`parent_issue?\` | Input for creating a new ticket. |
| \`IssueResult\` | \`number\`, \`url\` | Output from ticket creation. |
| \`IssueUpdates\` | \`state?\`, \`labels_add?\`, \`labels_remove?\`, \`body?\` | Partial update to an existing ticket. All fields nullable -- only non-null fields are applied. |

### ReconciliationResult

| Field | Type | Description |
|-------|------|-------------|
| \`reconciled\` | \`number\` | Count of tasks whose external state was corrected. |
| \`errors\` | \`Array<{ task_id, reason }>\` | Tasks that failed reconciliation. |

## Developing a New Plugin

### Directory structure

\`\`\`
src/plugins/communication/my-comm/
  my-comm.ts       # Plugin class extending CommunicationAdapter
  config.ts        # Zod config schema
  my-comm.test.ts  # Tests including contract suite
\`\`\`

### Minimal class skeleton

A send-only plugin (simplest possible):

\`\`\`typescript
import {
  CommunicationAdapter,
  type FormattedMessage,
  type HealthStatus,
  type InitResult,
  type MessageType,
  type SendResult,
  type Target,
  createAdapterError,
} from "../../../adapters/index.js";
import { type MyCommConfig, MyCommConfigSchema } from "./config.js";

const TYPE_PREFIXES: Record<MessageType, string> = {
  notification: "[Info]",
  question: "[Question]",
  status_response: "[Status]",
  milestone: "[Milestone]",
  alert: "[Alert]",
};

export class MyCommPlugin extends CommunicationAdapter {
  private config!: MyCommConfig;

  formatMessage(content: string, type: MessageType): string {
    const prefix = TYPE_PREFIXES[type] ?? "";
    return prefix ? \`\${prefix} \${content}\` : content;
  }

  protected async doSendMessage(
    target: Target,
    message: FormattedMessage,
  ): Promise<SendResult> {
    try {
      const messageId = await myApiSend(target.channel, message.content);
      return { success: true, message_id: messageId, error: null };
    } catch (error) {
      return {
        success: false,
        message_id: null,
        error: createAdapterError(
          "network_error",
          error instanceof Error ? error.message : String(error),
          { retryable: true },
        ),
      };
    }
  }

  protected doInitialize(config: Record<string, unknown>): Promise<InitResult> {
    const parsed = MyCommConfigSchema.safeParse(config);
    if (!parsed.success) {
      return Promise.resolve({
        success: false,
        message: \`Invalid config: \${parsed.error.message}\`,
      });
    }
    this.config = parsed.data;
    return Promise.resolve({ success: true, message: null });
  }

  protected doShutdown(): Promise<void> {
    return Promise.resolve();
  }

  protected async doHealthCheck(): Promise<HealthStatus> {
    return { healthy: true, message: "OK", details: null };
  }
}
\`\`\`

### Adding capabilities

To support optional methods, override \`hasCapability()\` and implement the corresponding \`do*\` methods:

\`\`\`typescript
override hasCapability(capability: string): boolean {
  return ["send", "receive"].includes(capability);
}

// Then implement doPollMessages, doStartListening, doStopListening
protected async doPollMessages(
  _channels: string[],
  _since: string,
): Promise<{ messages: InboundMessage[]; cursor: string }> {
  // Poll your platform's API for new messages
  return { messages: [], cursor: "0" };
}
\`\`\`

### Config schema pattern

\`\`\`typescript
// my-comm/config.ts
import { z } from "zod";

export const MyCommConfigSchema = z.object({
  api_token: z.string().min(1),
  default_channel: z.string().default("general"),
});

export type MyCommConfig = z.output<typeof MyCommConfigSchema>;
\`\`\`

Use \`z.output<typeof Schema>\` (not \`z.infer\`) -- resolves defaults and transforms, required for \`exactOptionalPropertyTypes\`.

### Registration in builtin.ts

\`\`\`typescript
// 1. Import
import { MyCommPlugin } from "./communication/my-comm/my-comm.js";

// 2. Manifest (in manifests array)
{
  id: "my-comm",
  type: "communication",
  version: "1.0.0",
  name: "My Communication",
  description: "Sends notifications via My Platform",
  critical: false,  // communication plugins are typically non-critical
  requirements: [{ type: "env", name: "MY_API_TOKEN" }],
  entry: "builtin",
  adapter_meta: { capabilities: ["send"], channel: "my-platform" },
  contributes: { events: ["comm.message_sent"] },
},

// 3. Factory (in factories map)
"my-comm": () => new MyCommPlugin(),
\`\`\`

### Contract test suite

Path: \`test/helpers/contract-suites/communication-contract.ts\`.

\`\`\`typescript
// my-comm/my-comm.test.ts
import { runCommunicationContractSuite } from "../../../../test/helpers/contract-suites/communication-contract.js";
import { MyCommPlugin } from "./my-comm.js";

const manifest = {
  id: "my-comm",
  type: "communication" as const,
  version: "1.0.0",
  name: "My Comm",
  description: "Test",
  critical: false,
  entry: "builtin",
  adapter_meta: { capabilities: ["send"] },
  contributes: { events: [], commands: [], config_keys: [], hooks: [] },
};

runCommunicationContractSuite(
  () => new MyCommPlugin(),
  {
    manifest,
    validConfig: { api_token: "tok_123" },
    invalidConfig: {},
    target: { user_id: "testuser", channel: "test-channel" },
    message: { content: "Hello", metadata: { task_id: null, type: "notification" } },
  },
);
\`\`\`

The contract suite validates:
- \`initialize()\` succeeds/fails correctly with valid/invalid config
- \`healthCheck()\` returns \`HealthStatus\` with all required fields, resolves within 5 seconds
- \`shutdown()\` resolves without throwing
- \`sendMessage()\` returns a valid \`SendResult\` (schema-validated) with required fields
- \`formatMessage()\` returns a non-empty string for all five \`MessageType\` values

## Built-in Plugins

| Plugin | Platform | Capabilities | Channel Format | Auth | Critical |
|--------|----------|--------------|----------------|------|----------|
| **GitHub Comm** | GitHub Issues/PRs | \`send\`, \`sync\`, \`ticket_management\` | \`owner/repo#number\` | \`GITHUB_TOKEN\` | No |
| **Telegram Comm** | Telegram Bot API | \`send\`, \`receive\` | Telegram username (resolved to chat_id) | \`TELEGRAM_BOT_TOKEN\` | No |

### GitHub Comm

- **send**: Posts comments on GitHub issues/PRs via \`octokit.issues.createComment()\`.
- **sync**: Updates labels on issues to reflect task state changes. Uses a configurable \`label_prefix\` (default: \`engineer:\`). Reconciliation batch-checks and corrects label drift after outages.
- **ticket_management**: Full CRUD -- create issues, update state/labels/body, comment on tickets.
- **formatMessage**: Prepends type-specific GitHub markdown blockquotes (e.g. \`> **Info**\`).
- Config: \`github_token\` (required), \`label_prefix\` (default \`"engineer:"\`).

### Telegram Comm

- **send**: Sends messages via \`bot.api.sendMessage()\` with configurable parse mode (MarkdownV2/Markdown/HTML).
- **receive**: Polls for inbound messages via \`bot.api.getUpdates()\`. Captures \`/start\` handshake messages for username-to-chat_id mapping.
- **formatMessage**: Escapes content for the configured parse mode. MarkdownV2 requires special character escaping; HTML escapes \`<\`, \`>\`, \`&\`.
- **Setup requirement**: Users must send \`/start\` to the bot before it can message them. The plugin persists username-to-chat_id mappings to \`~/.engineer/state/telegram-comm/chat-map.json\` (atomic write via rename). Mappings are captured during initialization (drains pending updates) and during polling.
- Config: \`bot_token\` (required), \`parse_mode\` (default \`"MarkdownV2"\`), \`disable_link_preview\` (default \`true\`).

## Reference

| File | Purpose |
|------|---------|
| \`src/adapters/communication.ts\` | Abstract \`CommunicationAdapter\` base class (required + optional methods, capability errors) |
| \`src/adapters/base.ts\` | \`BaseAdapter\` -- lifecycle template methods, \`hasCapability()\` |
| \`src/adapters/errors.ts\` | \`AdapterMethodError\`, \`createAdapterError()\` |
| \`src/adapters/index.ts\` | Plugin SDK barrel -- single import point |
| \`src/schemas/adapters.ts\` | All Zod schemas (\`Target\`, \`FormattedMessage\`, \`SendResult\`, \`InboundMessage\`, \`SyncMetadata\`, \`IssueOptions\`, etc.) |
| \`src/plugins/communication/github-comm/github-comm.ts\` | Reference: send + sync + ticket_management |
| \`src/plugins/communication/github-comm/config.ts\` | Reference config schema |
| \`src/plugins/communication/github-comm/github-utils.ts\` | Label diffing and channel parsing utilities |
| \`src/plugins/communication/telegram-comm/telegram-comm.ts\` | Reference: send + receive, /start handshake, chat map persistence |
| \`src/plugins/communication/telegram-comm/config.ts\` | Reference config schema |
| \`src/plugins/builtin.ts\` | Plugin registration (manifests + factories) |
| \`test/helpers/contract-suites/communication-contract.ts\` | Contract compliance test suite |
`;

const COMMUNICATION_GITHUB_COMM = `# GitHub Communication

Posts comments on GitHub issues and PRs, manages state labels (\`engineer:*\` prefix), and creates/updates issues. This is the primary public-facing communication channel -- everything the Engineer says on GitHub goes through this plugin.

Use this plugin when you want task status updates, milestone announcements, and questions to appear directly on the source GitHub issue.

## Requirements

| Type | Name | Notes |
|------|------|-------|
| env  | \`GITHUB_TOKEN\` | Personal access token with \`repo\` scope. Set in \`~/.engineer/.env\`. |

The token must have permission to comment on issues/PRs and manage labels in the target repositories.

## Capabilities

| Capability | Supported | Description |
|------------|-----------|-------------|
| \`send\` | Yes | Posts formatted comments on issues and PRs |
| \`sync\` | Yes | Manages \`engineer:*\` state labels on issues (adds new state label, removes old ones) |
| \`ticket_management\` | Yes | Creates issues, updates issue state/body/labels, comments on tickets via \`ExternalRef\` |
| \`receive\` | No | Deferred -- see future-considerations.md |

## Configuration

Config file: \`~/.engineer/config/plugins/github-comm.yaml\`

\`\`\`yaml
github_token: "\${GITHUB_TOKEN}"    # REQUIRED -- GitHub personal access token (env var ref)
label_prefix: "engineer:"          # Prefix for state labels (default: "engineer:")
\`\`\`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| \`github_token\` | \`string\` | -- (required) | GitHub PAT. Use \`\${GITHUB_TOKEN}\` to reference the env var. |
| \`label_prefix\` | \`string\` | \`"engineer:"\` | Prefix prepended to task state names when managing labels. For example, state \`executing\` becomes label \`engineer:executing\`. |

## How It Works

**Message formatting.** Each message type gets a GitHub-flavored markdown prefix:
- \`notification\` --> \`> **Info**\`
- \`question\` --> \`> **Question**\`
- \`alert\` --> \`> **Alert**\`
- \`milestone\` --> \`> **Milestone**\`
- \`status_response\` --> \`> **Status**\`

**Sending.** Target channels use the format \`owner/repo#number\`. The plugin calls \`issues.createComment\` via Octokit. Returns the comment ID on success.

**State sync.** When a task transitions states, the plugin:
1. Fetches current labels on the issue
2. Computes a diff (which \`engineer:*\` label to add, which to remove)
3. Adds the new state label, removes stale ones
4. Silently ignores 404s when removing labels that are already gone

**Reconciliation.** \`reconcileState\` batch-checks multiple tasks, ensuring each issue's labels match the expected state. Returns a count of reconciled tasks and any errors.

**Ticket management.** \`createTicket\` creates new GitHub issues with optional labels and assignees. \`updateTicket\` modifies state, body, labels (add/remove). \`commentOnTicket\` posts a comment using an \`ExternalRef\` (repo + issue number).

**Health checks.** Calls the GitHub rate limit API. Reports unhealthy when remaining requests drop below 100.

**Error classification.** HTTP status codes map to adapter error types:
- 401/403 --> \`auth_failed\`
- 404 --> \`not_found\`
- 429 --> \`rate_limited\`
- 5xx --> \`network_error\` (retryable)

## Limitations

- No \`receive\` capability. The plugin cannot listen for incoming messages or webhook events. Polling for inbound communication is deferred.
- Label management is best-effort. If a label removal fails (e.g., concurrent modification), the error is swallowed. Reconciliation can fix drift.
- Rate limit awareness is passive. The plugin checks remaining quota during health checks but does not throttle requests proactively. If you hit the rate limit, individual API calls will fail with \`rate_limited\` errors.
- The \`label_prefix\` applies globally. All repos managed by this plugin share the same prefix.

## Related Plugins

| Plugin | Relationship |
|--------|-------------|
| \`github-trigger\` | Watches the same repos for new issues/PR reviews. Shares \`GITHUB_TOKEN\`. |
| \`github-hosting\` | Manages PR lifecycle (create, merge, review). Shares \`GITHUB_TOKEN\`. |
| \`telegram-comm\` | Alternative communication channel for personal notifications. |
`;

const COMMUNICATION_TELEGRAM_COMM = `# Telegram Communication

Sends notifications and receives replies via a Telegram bot using the [grammy](https://grammy.dev/) library. This is the personal notification channel -- direct messages to the project owner about task progress, questions, and alerts.

Use this plugin when you want real-time personal notifications on your phone. Pair with \`github-comm\` for public-facing updates on issues.

## Requirements

| Type | Name | Notes |
|------|------|-------|
| env  | \`TELEGRAM_BOT_TOKEN\` | Bot token from [@BotFather](https://t.me/BotFather). Set in \`~/.engineer/.env\`. |

No \`TELEGRAM_CHAT_ID\` env var is needed at the config level. Chat IDs are resolved automatically via the \`/start\` handshake (see below).

## The /start Handshake

Telegram bots cannot initiate conversations. Each person who should receive messages must send \`/start\` to the bot once. This is a Telegram platform requirement, not a plugin limitation.

**Setup flow:**

1. Create a bot via @BotFather on Telegram. Save the token.
2. Set \`TELEGRAM_BOT_TOKEN\` in \`~/.engineer/.env\`.
3. Each user opens the bot in Telegram and sends \`/start\`.
4. The plugin captures the \`username -> chat_id\` mapping automatically.
5. The mapping is persisted to \`~/.engineer/state/telegram-comm/chat-map.json\`.

The \`handle\` field in People Directory contacts must match the Telegram username (case-insensitive, without the \`@\` prefix). If no mapping exists when the Engineer tries to send a message, the error is clear: "they need to /start the bot first."

**Persistence.** The chat map is written atomically (write to \`.tmp\`, then rename) to survive crashes. Mappings persist across restarts. Once a user has \`/start\`-ed, they never need to do it again unless the state file is deleted.

**Capture timing.** Handshakes are captured both during initialization (drains all pending updates received while offline) and during live polling. A \`/start\` sent while the Engineer is stopped will be picked up on next startup.

## Capabilities

| Capability | Supported | Description |
|------------|-----------|-------------|
| \`send\` | Yes | Sends formatted messages to users via their Telegram chat |
| \`receive\` | Yes | Polls for inbound messages via \`getUpdates\` (long-polling disabled, instant return) |

## Configuration

Config file: \`~/.engineer/config/plugins/telegram-comm.yaml\`

\`\`\`yaml
bot_token: "\${TELEGRAM_BOT_TOKEN}"    # REQUIRED -- Telegram bot token (env var ref)
parse_mode: MarkdownV2                # MarkdownV2 | Markdown | HTML (default: MarkdownV2)
disable_link_preview: true            # Disable link previews in messages (default: true)
\`\`\`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| \`bot_token\` | \`string\` | -- (required) | Telegram bot token. Use \`\${TELEGRAM_BOT_TOKEN}\` to reference the env var. |
| \`parse_mode\` | \`"MarkdownV2"\` \\| \`"Markdown"\` \\| \`"HTML"\` | \`"MarkdownV2"\` | Telegram message formatting mode. |
| \`disable_link_preview\` | \`boolean\` | \`true\` | When true, URLs in messages won't generate preview cards. |

## How It Works

**Message formatting.** Each message type gets a bold prefix appropriate to the parse mode:
- MarkdownV2/Markdown: \`*Info*\`, \`*Question*\`, \`*Alert*\`, etc.
- HTML: \`<b>Info</b>\`, \`<b>Question</b>\`, \`<b>Alert</b>\`, etc.

**Escaping.** MarkdownV2 mode automatically escapes all special characters (\`_\`, \`*\`, \`[\`, \`]\`, \`(\`, \`)\`, \`~\`, \`\` \` \`\`, \`>\`, \`#\`, \`+\`, \`-\`, \`=\`, \`|\`, \`{\`, \`}\`, \`.\`, \`!\`, \`\\\`). HTML mode escapes \`&\`, \`<\`, \`>\`. Legacy Markdown mode does no escaping (Telegram is lenient with it).

**Sending.** The plugin resolves a target's \`user_id\` to a \`chat_id\` via the in-memory chat map (populated by \`/start\` handshakes). Calls \`bot.api.sendMessage\` with the configured \`parse_mode\` and link preview setting. Returns the Telegram \`message_id\` on success.

**Receiving.** \`pollMessages\` calls \`getUpdates\` with \`timeout: 0\` (non-blocking). Filters out bot commands (messages starting with \`/\`). Returns structured \`InboundMessage\` objects with sender username, content, timestamp, reply context, and platform metadata (\`chat_id\`, \`message_id\`, \`from_id\`).

**Startup drain.** On initialization, the plugin calls \`getUpdates\` once to drain all pending updates. Any \`/start\` messages received while the Engineer was offline are captured. If the drain fails, it is non-fatal -- the first poll cycle provides a safety net.

**Health checks.** Calls \`bot.api.getMe()\` to verify the bot token is valid. Reports the bot's username on success.

**Error classification.** Telegram error codes map to adapter error types:
- 401/403 --> \`auth_failed\`
- 404 --> \`not_found\`
- 429 --> \`rate_limited\` (includes \`retry_after_ms\` from Telegram's response)
- 5xx --> \`network_error\` (retryable)

**Shutdown.** Persists the chat map to disk before stopping.

## Limitations

- Bot-initiated conversations require the \`/start\` handshake. There is no workaround -- this is a Telegram platform constraint.
- Polling is non-blocking (\`timeout: 0\`). The plugin does not use long-polling or webhooks. Message delivery latency depends on the Daemon's poll interval.
- No group chat support. The plugin is designed for 1:1 bot-to-user messaging. Group messages are not filtered or handled specially.
- Message length limits. Telegram caps messages at 4096 characters. The plugin does not split long messages -- oversized messages will fail at the API level.
- The chat map file (\`chat-map.json\`) is the single source of truth for username-to-chat mappings. If deleted, all users must \`/start\` again.

## Related Plugins

| Plugin | Relationship |
|--------|-------------|
| \`github-comm\` | Public communication channel (issue comments, labels). Telegram handles personal notifications. |
| \`github-trigger\` | Triggers tasks from GitHub issues. Telegram notifies the owner about task progress. |
`;

const GIT_HOSTING_README = `# Git Hosting Adapter

Git Hosting adapters manage the PR lifecycle on remote code hosting platforms. They are the remote API layer -- local git operations (worktrees, commits, branches) are handled by the Workspace Manager, not here.

This adapter type is fully separate from Communication adapters. PRs are code artifacts, not messages. GitHub needs three plugins (Trigger, Communication, Hosting) because each operates in a different capability domain.

All 10 methods are required. There are no optional or capability-gated methods. Every implementation must handle the full PR lifecycle: create, update, merge, close, query status, query reviews, comment, fetch comments, check branch protection, and resolve default branch.

A core safety invariant: never force-merge. If branch protection rules are not satisfied, return an error in \`MergeResult\` rather than bypassing them.

## Contract

The abstract class \`GitHostingAdapter\` extends \`BaseAdapter\`. Plugin authors implement the \`do*\` protected methods. The public methods wrap them with error handling -- unknown errors become \`AdapterMethodError\` with \`internal_error\` code.

| Public Method | Signature | Returns |
|---|---|---|
| \`createPR\` | \`(options: PROptions) => Promise<PRResult>\` | \`{ pr_number, url }\` |
| \`updatePR\` | \`(repo: string, prNumber: number, updates: PRUpdates) => Promise<void>\` | -- |
| \`mergePR\` | \`(repo: string, prNumber: number, strategy: MergeStrategy) => Promise<MergeResult>\` | \`{ merge_sha, success, error }\` |
| \`closePR\` | \`(repo: string, prNumber: number) => Promise<void>\` | -- |
| \`getPRStatus\` | \`(repo: string, prNumber: number) => Promise<PRStatus>\` | \`{ number, state, draft, mergeable, checks_state, url }\` |
| \`getReviewStatus\` | \`(repo: string, prNumber: number) => Promise<ReviewStatus>\` | \`{ approved, approvals, changes_requested, reviewers, comments }\` |
| \`getPRComments\` | \`(repo: string, prNumber: number) => Promise<PRComment[]>\` | Array of \`{ id, author, body, created_at }\` |
| \`commentOnPR\` | \`(repo: string, prNumber: number, comment: string, replyTo?: string) => Promise<CommentResult>\` | \`{ comment_id, url }\` |
| \`getBranchProtection\` | \`(repo: string, branch: string) => Promise<BranchProtection>\` | \`{ protected, required_reviews, required_checks, restrictions }\` |
| \`getDefaultBranch\` | \`(repo: string) => Promise<string>\` | Branch name (e.g. \`"main"\`) |

The \`repo\` parameter uses \`"owner/repo"\` format throughout.

### Lifecycle (inherited from BaseAdapter)

| Method | Signature | Notes |
|---|---|---|
| \`initialize\` | \`(config: Record<string, unknown>) => Promise<InitResult>\` | Validate config, set up API client. Never throws -- returns \`{ success: false }\` on failure. |
| \`shutdown\` | \`() => Promise<void>\` | Clean up resources. Errors are swallowed. |
| \`healthCheck\` | \`() => Promise<HealthStatus>\` | Report API availability. Timeout handled by Registry. |

## Key Types

All types are Zod schemas exported from \`src/schemas/adapters.ts\`.

\`\`\`typescript
// PR creation input
type PROptions = {
  repo: string;        // "owner/repo"
  branch: string;      // head branch
  base: string;        // target branch
  title: string;
  body: string;
  draft: boolean;
  labels: string[] | null;
  reviewers: string[] | null;
};

// PR creation result
type PRResult = { pr_number: number; url: string };

// PR update fields (null = no change)
type PRUpdates = {
  title: string | null;
  body: string | null;
  draft: boolean | null;
  labels_add: string[] | null;
  labels_remove: string[] | null;
};

// Merge strategies
type MergeStrategy = "merge" | "squash" | "rebase";

// Merge result (success: false when protection rules block merge)
type MergeResult = { merge_sha: string; success: boolean; error: AdapterError | null };

// PR state query
type PRStatus = {
  number: number;
  state: "open" | "closed" | "merged";
  draft: boolean;
  mergeable: boolean;
  checks_state: "passing" | "failing" | "pending" | "none";
  url: string;
};

// Review aggregation
type ReviewStatus = {
  approved: boolean;           // true only if approvals > 0 AND no changes_requested
  approvals: number;
  changes_requested: boolean;
  reviewers: { username: string; state: "approved" | "changes_requested" | "commented" | "pending" }[];
  comments: string[];          // review body text
};

// Branch protection
type BranchProtection = {
  protected: boolean;
  required_reviews: number;
  required_checks: string[];
  restrictions: Record<string, unknown> | null;
};
\`\`\`

## Developing a New Plugin

### Directory structure

\`\`\`
src/plugins/git-hosting/
  your-hosting/
    your-hosting.ts    # Plugin class
    config.ts          # Zod config schema
\`\`\`

### Class skeleton

\`\`\`typescript
import {
  GitHostingAdapter,
  type HealthStatus,
  type InitResult,
  type PROptions,
  type PRResult,
  type PRStatus,
  type PRUpdates,
  type MergeResult,
  type MergeStrategy,
  type ReviewStatus,
  type PRComment,
  type CommentResult,
  type BranchProtection,
  createAdapterError,
} from "../../../adapters/index.js";
import { type YourConfig, YourConfigSchema } from "./config.js";

export class YourHostingPlugin extends GitHostingAdapter {
  private config!: YourConfig;

  // ── PR Lifecycle ────────────────────────────────────
  protected async doCreatePR(options: PROptions): Promise<PRResult> { /* ... */ }
  protected async doUpdatePR(repo: string, prNumber: number, updates: PRUpdates): Promise<void> { /* ... */ }
  protected async doMergePR(repo: string, prNumber: number, strategy: MergeStrategy): Promise<MergeResult> { /* ... */ }
  protected async doClosePR(repo: string, prNumber: number): Promise<void> { /* ... */ }

  // ── PR Queries ──────────────────────────────────────
  protected async doGetPRStatus(repo: string, prNumber: number): Promise<PRStatus> { /* ... */ }
  protected async doGetReviewStatus(repo: string, prNumber: number): Promise<ReviewStatus> { /* ... */ }
  protected async doGetPRComments(repo: string, prNumber: number): Promise<PRComment[]> { /* ... */ }

  // ── PR Comments ─────────────────────────────────────
  protected async doCommentOnPR(repo: string, prNumber: number, comment: string, replyTo: string | undefined): Promise<CommentResult> { /* ... */ }

  // ── Branch Queries ──────────────────────────────────
  protected async doGetBranchProtection(repo: string, branch: string): Promise<BranchProtection> { /* ... */ }
  protected async doGetDefaultBranch(repo: string): Promise<string> { /* ... */ }

  // ── Lifecycle ───────────────────────────────────────
  protected async doInitialize(config: Record<string, unknown>): Promise<InitResult> {
    const parsed = YourConfigSchema.safeParse(config);
    if (!parsed.success) {
      return { success: false, message: \`Invalid config: \${parsed.error.message}\` };
    }
    this.config = parsed.data;
    // Set up API client here
    return { success: true, message: null };
  }

  protected async doShutdown(): Promise<void> { /* clean up */ }
  protected async doHealthCheck(): Promise<HealthStatus> { /* check API reachability */ }
}
\`\`\`

### Config schema

Create a Zod schema in \`config.ts\`:

\`\`\`typescript
import { z } from "zod";
import { MergeStrategySchema } from "../../../schemas/adapters.js";

export const YourConfigSchema = z.object({
  api_token: z.string().min(1),
  default_merge_strategy: MergeStrategySchema.default("squash"),
});

export type YourConfig = z.output<typeof YourConfigSchema>;
\`\`\`

### Registration

Add your plugin to \`src/plugins/builtin.ts\`:

1. Import your class.
2. Add a manifest entry to the \`manifests\` array with \`type: "git_hosting"\`.
3. Add a factory entry to the \`factories\` map.

\`\`\`typescript
// In manifests array:
{
  id: "your-hosting",
  type: "git_hosting",
  version: "1.0.0",
  name: "Your Hosting",
  description: "PR lifecycle management via Your Platform API",
  critical: true,
  requirements: [{ type: "env", name: "YOUR_API_TOKEN" }],
  entry: "builtin",
  adapter_meta: { action_classes: ["git-remote", "merge"] },
  contributes: { events: ["git.pr_opened", "git.pr_updated", "git.pr_merged"] },
}

// In factories map:
"your-hosting": () => new YourHostingPlugin(),
\`\`\`

### Contract tests

Use the reusable contract suite in \`test/helpers/contract-suites/git-hosting-contract.ts\`:

\`\`\`typescript
import { describe } from "vitest";
import { runGitHostingContractSuite, type GitHostingContractFixtures } from "../../helpers/contract-suites/git-hosting-contract.js";
import { YourHostingPlugin } from "../../../src/plugins/git-hosting/your-hosting/your-hosting.js";

const fixtures: GitHostingContractFixtures = {
  validConfig: { api_token: "test-token" },
  invalidConfig: {},
  manifest: {
    id: "your-hosting",
    type: "git_hosting",
    version: "1.0.0",
    name: "Your Hosting",
    description: "Test",
    critical: true,
    requirements: [],
    entry: "builtin",
    adapter_meta: {},
    contributes: {},
  },
  prOptions: {
    repo: "owner/repo",
    branch: "feature",
    base: "main",
    title: "Test PR",
    body: "Test body",
    draft: false,
    labels: null,
    reviewers: null,
  },
};

describe("YourHostingPlugin", () => {
  runGitHostingContractSuite(() => new YourHostingPlugin(), fixtures);
});
\`\`\`

The contract suite validates: lifecycle (init, health, shutdown), PR lifecycle (create, status, review, comments, comment, merge), and branch queries (default branch, protection).

## Built-in Plugins

| Plugin | Platform | API Client | Config Keys | Requirements |
|---|---|---|---|---|
| \`GitHubHostingPlugin\` | GitHub | \`@octokit/rest\` | \`github_token\`, \`default_merge_strategy\` | \`GITHUB_TOKEN\` env var |

The GitHub implementation uses Octokit for all API calls. It parses \`"owner/repo"\` strings internally with \`splitRepo()\`. Merge errors are classified by HTTP status (405 = not mergeable, 409 = conflict). Review aggregation takes the latest state per reviewer and collects review body text.

## Reference

| File | Description |
|---|---|
| \`src/adapters/git-hosting.ts\` | Abstract class with 10 public methods + 10 protected abstract \`do*\` methods |
| \`src/adapters/base.ts\` | \`BaseAdapter\` -- lifecycle template methods, manifest, \`hasCapability()\` |
| \`src/adapters/errors.ts\` | \`AdapterMethodError\` and \`createAdapterError()\` |
| \`src/schemas/adapters.ts\` | All Zod schemas: \`PROptionsSchema\`, \`PRResultSchema\`, \`MergeResultSchema\`, etc. |
| \`src/plugins/git-hosting/github-hosting/github-hosting.ts\` | Reference implementation (GitHub via Octokit) |
| \`src/plugins/git-hosting/github-hosting/config.ts\` | GitHub-specific config schema |
| \`src/plugins/builtin.ts\` | Manifest definitions and factory registration |
| \`test/helpers/contract-suites/git-hosting-contract.ts\` | Reusable contract compliance test suite |
`;

const GIT_HOSTING_GITHUB_HOSTING = `# GitHub Hosting

Manages the full pull request lifecycle on GitHub via the Octokit REST API. Creates PRs, updates metadata, merges, closes, checks review status, reads comments, and queries branch protection. All 9 \`GitHostingAdapter\` methods are implemented.

Use this plugin whenever the Engineer needs to open PRs, respond to review feedback, or merge completed work.

## Requirements

| Type | Name | Notes |
|------|------|-------|
| env  | \`GITHUB_TOKEN\` | Personal access token with \`repo\` scope. Set in \`~/.engineer/.env\`. |

The token needs sufficient permissions for the target repositories: create/update/merge PRs, read branch protection rules, manage labels, and request reviewers.

## Capabilities

All 9 adapter methods are implemented:

| Method | Description |
|--------|-------------|
| \`createPR\` | Opens a pull request with title, body, base/head branches, draft mode, labels, and reviewers |
| \`updatePR\` | Modifies title, body, draft status, and labels (add/remove) on an existing PR |
| \`mergePR\` | Merges a PR using the configured strategy. Never force-merges. |
| \`closePR\` | Closes a PR without merging |
| \`getPRStatus\` | Returns PR state (open/closed/merged), draft flag, mergeability, CI check status, and URL |
| \`getReviewStatus\` | Aggregates review state per reviewer (approved/changes_requested/commented/pending) |
| \`commentOnPR\` | Posts a conversation comment or replies to an inline review comment |
| \`getPRComments\` | Fetches both conversation-level and inline review comments (filters out bot comments) |
| \`getBranchProtection\` | Returns protection rules: required reviews, required checks, push restrictions |
| \`getDefaultBranch\` | Returns the repository's default branch name |

## Configuration

Config file: \`~/.engineer/config/plugins/github-hosting.yaml\`

\`\`\`yaml
github_token: "\${GITHUB_TOKEN}"          # REQUIRED -- GitHub personal access token (env var ref)
default_merge_strategy: squash           # squash | merge | rebase (default: squash)
\`\`\`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| \`github_token\` | \`string\` | -- (required) | GitHub PAT. Use \`\${GITHUB_TOKEN}\` to reference the env var. |
| \`default_merge_strategy\` | \`"squash"\` \\| \`"merge"\` \\| \`"rebase"\` | \`"squash"\` | Merge method used when merging PRs. |

## How It Works

**PR creation.** Calls \`pulls.create\` via Octokit. After creation, adds labels and requests reviewers in separate API calls if provided. Returns the PR number and URL.

**PR updates.** Only sends API calls for fields that are non-null. Label additions and removals are handled separately. Label removal silently ignores 404s (label may already be gone).

**Merging.** Calls \`pulls.merge\` with the configured merge strategy (\`squash\`, \`merge\`, or \`rebase\`). The plugin never force-merges. If branch protection requirements are not satisfied (required reviews, status checks), the merge returns an error with \`pr_not_mergeable\` or \`merge_conflict\` -- it does not bypass protections.

**PR status.** Fetches the PR and resolves CI state by querying both the Status API (\`repos.getCombinedStatusForRef\`) and the Checks API (\`checks.listForRef\`). Worst state wins across both sources. Maps GitHub's state to a simplified \`open | closed | merged\` enum. CI check state is a tri-state (\`passing | failing | pending | none\`).

**Review aggregation.** Fetches all reviews chronologically and tracks the latest meaningful state per reviewer (\`APPROVED\`, \`CHANGES_REQUESTED\`, \`COMMENTED\`). A PR is considered approved only when at least one reviewer approved AND no reviewer has \`changes_requested\` as their latest state. Review body text is collected as feedback comments.

**Comments.** \`commentOnPR\` handles two cases: if \`replyTo\` is provided, it creates a reply to an inline review comment; otherwise, it posts a regular issue comment (PRs are issues in the GitHub API). \`getPRComments\` fetches both conversation-level (\`issues.listComments\`) and inline review comments (\`pulls.listReviewComments\`) in parallel, filtering out \`github-actions[bot]\`.

**Branch protection.** Queries branch protection rules. Returns required review count, required status check contexts, and push restrictions (users/teams). A 404 response means no protection is configured (returns safe defaults with \`protected: false\`).

**Health checks.** Same as other GitHub plugins -- calls the rate limit API, reports unhealthy below 100 remaining requests.

**Error classification for merges:**
- 405 --> \`pr_not_mergeable\` (branch protection not satisfied)
- 409 --> \`merge_conflict\`
- Other --> \`network_error\`

## Limitations

- No force-merge capability. If branch protection blocks a merge, the plugin returns an error. This is intentional -- the Engineer respects repository rules.
- No webhook support. The plugin is API-driven, not event-driven. PR status changes are detected by polling.
- Review aggregation uses the latest state per reviewer. If a reviewer approves, then comments, their state shows as \`commented\` (not \`approved\`). This matches GitHub's own review summary behavior.
- Bot comments from \`github-actions[bot]\` are filtered from \`getPRComments\`. Other bot accounts are not filtered.
- The \`default_merge_strategy\` applies globally. Per-repo merge strategies are not configurable at the plugin level (the Orchestrator can override per-call).

## Related Plugins

| Plugin | Relationship |
|--------|-------------|
| \`github-trigger\` | Watches repos for assigned issues and PR review requests. Shares \`GITHUB_TOKEN\`. |
| \`github-comm\` | Posts comments and manages labels on the same issues/PRs. Shares \`GITHUB_TOKEN\`. |
`;

export const ALL_PLUGIN_DOCS: readonly PluginDoc[] = [
  { relativePath: "docs/plugins/trigger/README.md", content: TRIGGER_README },
  { relativePath: "docs/plugins/trigger/github-trigger.md", content: TRIGGER_GITHUB_TRIGGER },
  { relativePath: "docs/plugins/llm/README.md", content: LLM_README },
  { relativePath: "docs/plugins/llm/claude-code-llm.md", content: LLM_CLAUDE_CODE },
  { relativePath: "docs/plugins/llm/opencode-llm.md", content: LLM_OPENCODE },
  { relativePath: "docs/plugins/llm/gemini-cli-llm.md", content: LLM_GEMINI_CLI },
  { relativePath: "docs/plugins/communication/README.md", content: COMMUNICATION_README },
  { relativePath: "docs/plugins/communication/github-comm.md", content: COMMUNICATION_GITHUB_COMM },
  {
    relativePath: "docs/plugins/communication/telegram-comm.md",
    content: COMMUNICATION_TELEGRAM_COMM,
  },
  { relativePath: "docs/plugins/git-hosting/README.md", content: GIT_HOSTING_README },
  {
    relativePath: "docs/plugins/git-hosting/github-hosting.md",
    content: GIT_HOSTING_GITHUB_HOSTING,
  },
];
