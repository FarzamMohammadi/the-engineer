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
  type QuotaStatus,
  createAdapterError,
} from "../../../adapters/index.js";
import { type GeminiCliLLMConfig, GeminiCliLLMConfigSchema } from "./config.js";

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

/** Rate limit patterns — hoisted for performance. */
const RATE_LIMIT_STDERR_RE = /exhausted your capacity|rate.?limit|quota/i;
const RATE_LIMIT_STDOUT_RE = /exhausted.*capacity|quota|rate.?limit/i;

// ── Output parsing ───────────────────────────────────────────────────────────

/** Parsed output from Gemini CLI's stream-json format (NDJSON). */
export interface ParsedGeminiCliOutput {
  content: string;
  usage: InferenceUsage | null;
  rateLimited: boolean;
  rateLimitMessage: string | null;
}

/**
 * Parse NDJSON output from `gemini -p <prompt> -o stream-json`.
 *
 * Output is newline-delimited JSON events:
 * - `type: "init"` — session info with model
 * - `type: "message", role: "assistant"` — response content
 * - `type: "result"` — token stats (no cost — Gemini CLI doesn't report cost)
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: NDJSON parser handling multiple event types
export function parseGeminiCliOutput(raw: string): ParsedGeminiCliOutput {
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  const contentParts: string[] = [];
  let usage: InferenceUsage | null = null;
  let modelId: string | null = null;
  let rateLimited = false;
  let rateLimitMessage: string | null = null;

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;

      if (parsed["type"] === "init") {
        if (typeof parsed["model"] === "string") {
          modelId = parsed["model"];
        }
      } else if (parsed["type"] === "message" && parsed["role"] === "assistant") {
        const content = parsed["content"];
        if (typeof content === "string") {
          contentParts.push(content);
        }
      } else if (parsed["type"] === "result") {
        // Check for error result (e.g. rate limiting, quota exhaustion)
        if (parsed["status"] === "error") {
          const err = parsed["error"] as Record<string, unknown> | undefined;
          const msg = typeof err?.["message"] === "string" ? err["message"] : "";
          if (RATE_LIMIT_STDOUT_RE.test(msg)) {
            rateLimited = true;
            rateLimitMessage = msg;
          }
        }

        const stats = parsed["stats"] as Record<string, unknown> | undefined;
        if (stats) {
          const inputTokens = typeof stats["input_tokens"] === "number" ? stats["input_tokens"] : 0;
          const outputTokens =
            typeof stats["output_tokens"] === "number" ? stats["output_tokens"] : 0;
          const totalTokens = typeof stats["total_tokens"] === "number" ? stats["total_tokens"] : 0;
          const cached = typeof stats["cached"] === "number" ? stats["cached"] : 0;

          usage = {
            tokens: {
              input_tokens: inputTokens,
              output_tokens: outputTokens,
              cache_read_tokens: cached,
              cache_creation_tokens: 0,
              total_tokens: totalTokens,
            },
            model_id: modelId,
            service_tier: null,
          };
        }
      }
    } catch {
      // Skip non-JSON lines (e.g. "Loaded cached credentials.")
    }
  }

  const content = contentParts.join("");

  if (!rateLimited && content.length === 0 && usage === null) {
    throw new AdapterMethodError(
      createAdapterError(
        "internal_error",
        "No assistant message or result event found in Gemini CLI output",
      ),
    );
  }

  return { content, usage, rateLimited, rateLimitMessage };
}

// ── Plugin ───────────────────────────────────────────────────────────────────

/**
 * GeminiCliLLMPlugin — LLM inference via Google's Gemini CLI (free tier).
 *
 * Designed for Gemini CLI's free tier — no cost reporting (cost_usd always null),
 * no billing API. Rate limits detected from stdout error results and stderr retry messages.
 *
 * Invokes `gemini -p "" -o stream-json --yolo` with prompt piped via stdin.
 * Parses NDJSON output for content and token usage.
 */
export class GeminiCliLLMPlugin extends LLMAdapter {
  private config!: GeminiCliLLMConfig;
  private activeProcess: ChildProcess | null = null;
  private rateLimited = false;

  protected doInfer(request: InferenceRequest): Promise<InferenceResult> {
    // Gemini has no --system-prompt flag. Prepend system prompt to user prompt.
    const prompt = request.system_prompt
      ? `[SYSTEM INSTRUCTIONS]\n${request.system_prompt}\n[END SYSTEM INSTRUCTIONS]\n\n${request.prompt}`
      : request.prompt;

    // -p "" enables non-interactive mode. Prompt piped via stdin to avoid OS arg length limits.
    // Gemini appends stdin content to the -p value.
    const args = [
      "-p",
      "",
      "-o",
      "stream-json",
      "--model",
      this.config.model,
      "--yolo", // auto-approve tool calls (required for non-interactive)
    ];

    return this.spawnAndParse(args, request.cwd ?? undefined, prompt);
  }

  getCapabilities(): LLMCapabilities {
    return {
      model_id: this.config?.model ?? "gemini-2.5-pro",
      supports_usage_reporting: true,
      supports_quota_reporting: true,
      context_window: null,
    };
  }

  getQuotaStatus(): Promise<QuotaStatus | null> {
    if (!this.rateLimited) {
      return Promise.resolve(null);
    }
    return Promise.resolve({
      windows: [
        {
          window_type: "gemini_model_quota",
          resets_at: null,
          is_exhausted: true,
          used_percentage: null,
        },
      ],
      is_rate_limited: true,
      earliest_reset_at: null,
    });
  }

  protected doInitialize(config: Record<string, unknown>): Promise<InitResult> {
    const parsed = GeminiCliLLMConfigSchema.safeParse(config);
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
          message: code === 0 ? `gemini CLI v${version}` : "gemini CLI not available",
          details: code === 0 ? { version } : null,
        });
      });
      child.on("error", () => {
        resolve({ healthy: false, message: "gemini CLI not found", details: null });
      });
    });
  }

  // ── Private Helpers ──────────────────────────────────────────────────

  private spawnAndParse(
    args: string[],
    cwd?: string,
    stdinContent?: string,
  ): Promise<InferenceResult> {
    const startMs = Date.now();
    return new Promise<InferenceResult>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      const child = spawn(this.config.cli_path, args, {
        stdio: ["pipe", "pipe", "pipe"],
        timeout: this.config.command_timeout_ms,
        env: buildLlmEnv(process.env),
        cwd,
      });

      this.activeProcess = child;
      let killedForRateLimit = false;

      child.stdout?.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderrChunks.push(chunk);
        // Gemini CLI retries infinitely on rate limits. Detect and kill immediately.
        const text = chunk.toString("utf-8");
        if (!killedForRateLimit && RATE_LIMIT_STDERR_RE.test(text)) {
          killedForRateLimit = true;
          child.kill("SIGTERM");
        }
      });

      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: CLI process lifecycle with rate limit + error + parse paths
      child.on("close", (code) => {
        if (killedForRateLimit) {
          this.activeProcess = null;
          const stderr = Buffer.concat(stderrChunks).toString("utf-8");
          reject(
            new AdapterMethodError(
              createAdapterError("cli_error", `gemini CLI rate limited: ${stderr.slice(0, 200)}`, {
                retryable: true,
                severity: "error",
              }),
            ),
          );
          return;
        }
        this.activeProcess = null;
        const raw = Buffer.concat(chunks).toString("utf-8");
        const stderr = Buffer.concat(stderrChunks).toString("utf-8");
        const duration_ms = Date.now() - startMs;

        if (code !== 0) {
          reject(
            new AdapterMethodError(
              createAdapterError(
                "cli_error",
                `gemini CLI exited with code ${String(code)}: ${stderr || raw}`,
                { retryable: true, severity: "error" },
              ),
            ),
          );
          return;
        }

        try {
          const parsed = parseGeminiCliOutput(raw);

          // Update rate limit state for getQuotaStatus()
          this.rateLimited = parsed.rateLimited;

          if (parsed.rateLimited) {
            reject(
              new AdapterMethodError(
                createAdapterError(
                  "cli_error",
                  `gemini CLI rate limited: ${parsed.rateLimitMessage ?? "quota exhausted"}`,
                  { retryable: true, severity: "error" },
                ),
              ),
            );
            return;
          }

          resolve({
            content: parsed.content,
            cost_usd: null, // Gemini CLI does not report cost
            duration_ms,
            usage: parsed.usage,
          });
        } catch (err) {
          reject(
            new AdapterMethodError(
              createAdapterError(
                "parse_error",
                `Failed to parse Gemini CLI output: ${err instanceof Error ? err.message : String(err)}`,
              ),
            ),
          );
        }
      });

      child.on("error", (err) => {
        this.activeProcess = null;
        reject(
          new AdapterMethodError(
            createAdapterError("spawn_error", `Failed to spawn gemini CLI: ${err.message}`),
          ),
        );
      });

      if (stdinContent) {
        child.stdin?.write(stdinContent);
      }
      child.stdin?.end();
    });
  }
}
