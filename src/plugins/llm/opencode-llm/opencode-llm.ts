import { type ChildProcess, spawn } from "node:child_process";
import {
  AdapterMethodError,
  type HealthStatus,
  type InferenceRequest,
  type InferenceResult,
  type InferenceUsage,
  type InitResult,
  LLMAdapter,
  type LLMCapabilities,
  createAdapterError,
} from "../../../adapters/index.js";
import { type OpenCodeLLMConfig, OpenCodeLLMConfigSchema } from "./config.js";

// ── LLM subprocess env isolation ─────────────────────────────────────────────
// Canonical copy in claude-code-llm.ts — keep in sync across LLM plugins

const LLM_ENV_ALLOWLIST = [
  "HOME",
  "PATH",
  "USER",
  "SHELL",
  "LANG",
  "TERM",
  "TMPDIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "NODE_OPTIONS",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
];

const LLM_ENV_PREFIX_ALLOWLIST = ["LC_"];

/** Build a sanitized environment for LLM child processes. */
export function buildLlmEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  const allowed = new Set(LLM_ENV_ALLOWLIST);
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      continue;
    }
    if (allowed.has(key) || LLM_ENV_PREFIX_ALLOWLIST.some((p) => key.startsWith(p))) {
      result[key] = value;
    }
  }
  return result;
}

/** Rate limit pattern for stderr detection — hoisted for performance. */
const RATE_LIMIT_STDERR_RE = /exhausted your capacity|rate.?limit|quota/i;

// ── Output parsing ───────────────────────────────────────────────────────────

/** Parsed output from OpenCode CLI's JSON format (NDJSON). */
export interface ParsedOpenCodeOutput {
  content: string;
  cost_usd: number | null;
  usage: InferenceUsage | null;
}

/**
 * Parse NDJSON output from `opencode run --format json`.
 *
 * Output is newline-delimited JSON events:
 * - `type: "text"` — content fragments in `part.text`
 * - `type: "step_finish"` — cost and token breakdown in `part`
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: NDJSON parser handling multiple event types
export function parseOpenCodeOutput(raw: string): ParsedOpenCodeOutput {
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  const textParts: string[] = [];
  let costUsd: number | null = null;
  let usage: InferenceUsage | null = null;

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const part = parsed["part"] as Record<string, unknown> | undefined;
      if (!part) {
        continue;
      }

      if (parsed["type"] === "text") {
        const text = part["text"];
        if (typeof text === "string") {
          textParts.push(text);
        }
      } else if (parsed["type"] === "step_finish") {
        if (typeof part["cost"] === "number") {
          costUsd = part["cost"];
        }

        const tokens = part["tokens"] as Record<string, unknown> | undefined;
        if (tokens) {
          const inputTokens = typeof tokens["input"] === "number" ? tokens["input"] : 0;
          const outputTokens = typeof tokens["output"] === "number" ? tokens["output"] : 0;
          const totalTokens = typeof tokens["total"] === "number" ? tokens["total"] : 0;
          const cache = tokens["cache"] as Record<string, unknown> | undefined;
          const cacheRead = typeof cache?.["read"] === "number" ? cache["read"] : 0;
          const cacheWrite = typeof cache?.["write"] === "number" ? cache["write"] : 0;

          usage = {
            tokens: {
              input_tokens: inputTokens,
              output_tokens: outputTokens,
              cache_read_tokens: cacheRead,
              cache_creation_tokens: cacheWrite,
              total_tokens: totalTokens,
            },
            model_id: null,
            service_tier: null,
          };
        }
      }
    } catch {
      // Skip non-JSON lines
    }
  }

  const content = textParts.join("");

  if (content.length === 0 && costUsd === null) {
    throw new AdapterMethodError(
      createAdapterError("internal_error", "No text or step_finish event found in OpenCode output"),
    );
  }

  return { content, cost_usd: costUsd, usage };
}

// ── Plugin ───────────────────────────────────────────────────────────────────

/**
 * OpenCodeLLMPlugin — multi-provider LLM inference via OpenCode CLI.
 *
 * Invokes `opencode run --format json` as a child process,
 * parses NDJSON output for text content, cost, and token usage.
 */
export class OpenCodeLLMPlugin extends LLMAdapter {
  private config!: OpenCodeLLMConfig;
  private activeProcess: ChildProcess | null = null;

  protected doInfer(request: InferenceRequest): Promise<InferenceResult> {
    const args = ["run", "--format", "json", "--model", this.config.model];

    if (request.cwd) {
      args.push("--dir", request.cwd);
    }

    // OpenCode has no --system-prompt flag. Prepend system prompt to user prompt.
    const prompt = request.system_prompt
      ? `[SYSTEM INSTRUCTIONS]\n${request.system_prompt}\n[END SYSTEM INSTRUCTIONS]\n\n${request.prompt}`
      : request.prompt;

    // Pipe prompt via stdin — avoids OS argument length limits on large orchestrator prompts.
    // OpenCode reads from stdin when no positional message args are given.
    return this.spawnAndParse(args, prompt);
  }

  getCapabilities(): LLMCapabilities {
    return {
      model_id: this.config?.model ?? "opencode/gemini-3.1-pro",
      supports_usage_reporting: true,
      supports_quota_reporting: false,
      context_window: null,
    };
  }

  protected doInitialize(config: Record<string, unknown>): Promise<InitResult> {
    const parsed = OpenCodeLLMConfigSchema.safeParse(config);
    if (!parsed.success) {
      return Promise.resolve({
        success: false,
        message: `Invalid config: ${parsed.error.message}`,
      });
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
      child.stdout?.on("data", (c: Buffer) => {
        chunks.push(c);
      });
      child.on("close", (code) => {
        const version = Buffer.concat(chunks).toString("utf-8").trim();
        resolve({
          healthy: code === 0,
          message: code === 0 ? `opencode CLI v${version}` : "opencode CLI not available",
          details: code === 0 ? { version } : null,
        });
      });
      child.on("error", () => {
        resolve({ healthy: false, message: "opencode CLI not found", details: null });
      });
    });
  }

  // ── Private Helpers ──────────────────────────────────────────────────

  private spawnAndParse(args: string[], stdinContent?: string): Promise<InferenceResult> {
    const startMs = Date.now();
    return new Promise<InferenceResult>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      const child = spawn(this.config.cli_path, args, {
        stdio: ["pipe", "pipe", "pipe"],
        timeout: this.config.command_timeout_ms,
        env: buildLlmEnv(process.env),
      });

      this.activeProcess = child;
      let killedForRateLimit = false;

      child.stdout?.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderrChunks.push(chunk);
        // Detect rate limiting from stderr and kill immediately to avoid infinite CLI retries.
        const text = chunk.toString("utf-8");
        if (!killedForRateLimit && RATE_LIMIT_STDERR_RE.test(text)) {
          killedForRateLimit = true;
          child.kill("SIGTERM");
        }
      });

      child.on("close", (code) => {
        if (killedForRateLimit) {
          this.activeProcess = null;
          const stderr = Buffer.concat(stderrChunks).toString("utf-8");
          reject(
            new AdapterMethodError(
              createAdapterError(
                "cli_error",
                `opencode CLI rate limited: ${stderr.slice(0, 200)}`,
                { retryable: true, severity: "error" },
              ),
            ),
          );
          return;
        }
        this.activeProcess = null;
        const raw = Buffer.concat(chunks).toString("utf-8");
        const stderr = Buffer.concat(stderrChunks).toString("utf-8");
        const durationMs = Date.now() - startMs;

        if (code !== 0) {
          reject(
            new AdapterMethodError(
              createAdapterError(
                "cli_error",
                `opencode CLI exited with code ${String(code)}: ${stderr || raw}`,
                { retryable: true, severity: "error" },
              ),
            ),
          );
          return;
        }

        try {
          const parsed = parseOpenCodeOutput(raw);
          resolve({
            content: parsed.content,
            cost_usd: parsed.cost_usd,
            duration_ms: durationMs,
            usage: parsed.usage,
          });
        } catch (err) {
          reject(
            new AdapterMethodError(
              createAdapterError(
                "parse_error",
                `Failed to parse OpenCode output: ${err instanceof Error ? err.message : String(err)}`,
              ),
            ),
          );
        }
      });

      child.on("error", (err) => {
        this.activeProcess = null;
        reject(
          new AdapterMethodError(
            createAdapterError("spawn_error", `Failed to spawn opencode CLI: ${err.message}`),
          ),
        );
      });

      // Suppress EPIPE — child may exit before stdin is consumed
      // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional noop — suppress EPIPE when child exits before stdin consumed
      child.stdin?.on("error", () => {});
      if (stdinContent) {
        child.stdin?.write(stdinContent);
      }
      child.stdin?.end();
    });
  }
}
