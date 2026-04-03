import { type ChildProcess, execSync, spawn } from "node:child_process";
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
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
  type QuotaWindow,
  createAdapterError,
} from "../../../adapters/index.js";
import { type ClaudeCodeLLMConfig, ClaudeCodeLLMConfigSchema } from "./config.js";

// ── LLM subprocess env isolation ─────────────────────────────────────────────

/**
 * Environment variable allowlist for Claude CLI child processes.
 * Only these vars (plus LC_* prefix matches) are forwarded.
 * Prevents leaking GITHUB_TOKEN, TELEGRAM_BOT_TOKEN, etc. to the LLM subprocess.
 *
 * No credential env vars are included — users authenticate with their CLI
 * provider separately before starting The Engineer (see docs/assumptions.md).
 */
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

/** Prefixes to match (for locale vars like LC_ALL, LC_CTYPE, etc.). */
const LLM_ENV_PREFIX_ALLOWLIST = ["LC_"];

/**
 * Build a sanitized environment for LLM child processes.
 * Only forwards allowlisted vars — no secrets leak to the subprocess.
 */
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

// ── Rate limit info from stream-json events ──────────────────────────────────

interface RateLimitInfo {
  rateLimitType: string;
  status: string;
  resetsAt: number | null;
}

// ── Streaming NDJSON line processor ──────────────────────────────────────────

/** Result of processing a single NDJSON line from Claude CLI output. */
export type NdjsonLineResult =
  | { type: "result"; event: Record<string, unknown> }
  | { type: "rate_limit"; info: RateLimitInfo }
  | { type: "skip" };

/**
 * Process a single NDJSON line from Claude CLI stream-json output.
 *
 * Pure function — independently testable. Extracts only the events we need:
 * - `type: "result"` → the final result with content, cost, usage
 * - `type: "rate_limit_event"` → quota window status
 * - everything else → skip (discarded from memory immediately)
 */
export function processNdjsonLine(line: string): NdjsonLineResult {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return { type: "skip" };
  }

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;

    if (parsed["type"] === "result") {
      return { type: "result", event: parsed };
    }

    if (parsed["type"] === "rate_limit_event") {
      const info = parsed["rate_limit_info"] as Record<string, unknown> | undefined;
      if (info) {
        return {
          type: "rate_limit",
          info: {
            rateLimitType:
              typeof info["rateLimitType"] === "string" ? info["rateLimitType"] : "unknown",
            status: typeof info["status"] === "string" ? info["status"] : "unknown",
            resetsAt: typeof info["resetsAt"] === "number" ? info["resetsAt"] : null,
          },
        };
      }
    }

    return { type: "skip" };
  } catch {
    return { type: "skip" };
  }
}

// ── Stderr ring buffer ───────────────────────────────────────────────────────

/** Maximum bytes to retain from stderr. Only used in error messages. */
const MAX_STDERR_BYTES = 10_240;

/**
 * Append to a capped stderr buffer. Returns the (possibly truncated) new buffer.
 * When the buffer exceeds MAX_STDERR_BYTES, keeps only the tail.
 */
export function appendStderr(current: string, chunk: string): string {
  const combined = current + chunk;
  if (combined.length <= MAX_STDERR_BYTES) {
    return combined;
  }
  return combined.slice(combined.length - MAX_STDERR_BYTES);
}

/**
 * ClaudeCodeLLMPlugin — the Engineer's thinking engine.
 *
 * Invokes the Claude Code CLI (`claude --print --output-format stream-json --verbose`)
 * as a child process. Uses streaming NDJSON parsing to avoid buffering the entire
 * output in memory. Optionally writes raw CLI output to a trace file for debugging.
 */
export class ClaudeCodeLLMPlugin extends LLMAdapter {
  private config!: ClaudeCodeLLMConfig;
  private activeProcess: ChildProcess | null = null;
  private lastRateLimits: RateLimitInfo[] = [];

  // Quota API cache — instance-level so each plugin instance has its own cache.
  // Anthropic's usage API has aggressive per-token rate limits (~5 requests before 429).
  // Cache for 30 minutes to stay well within limits across multi-phase task pipelines.
  private readonly quotaCacheTtlMs = 30 * 60 * 1000;
  private cachedQuota: QuotaStatus | null = null;
  private cachedQuotaAt = 0;

  protected doInfer(request: InferenceRequest): Promise<InferenceResult> {
    // --setting-sources user: prevent loading project-level CLAUDE.md and settings
    // from the CWD — the Engineer provides all context via the prompt.
    // --dangerously-skip-permissions: required for non-interactive tool use (read/write/bash)
    // --output-format stream-json + --verbose: gives us rate_limit_event + full usage in result
    const args = [
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      this.config.model,
      "--setting-sources",
      "user",
      "--dangerously-skip-permissions",
    ];

    if (request.system_prompt) {
      args.push("--system-prompt", request.system_prompt);
    }

    // Prompt is piped via stdin (not as a CLI arg) to avoid OS argument length limits.
    // The claude CLI reads from stdin when no positional prompt argument is given.
    return this.spawnAndParse(
      args,
      request.prompt,
      request.cwd ?? undefined,
      request.trace_output_path ?? undefined,
    );
  }

  getCapabilities(): LLMCapabilities {
    return {
      model_id: this.config?.model ?? "claude-opus-4-6",
      supports_usage_reporting: true,
      supports_quota_reporting: true,
      context_window: 200_000,
    };
  }

  async getQuotaStatus(): Promise<QuotaStatus | null> {
    // Try the secure API call first (real percentages), fall back to cached rate_limit_event data
    const apiQuota = this.fetchQuotaFromApi();
    if (apiQuota) {
      return apiQuota;
    }

    // Fallback: use cached rate_limit_event data from last infer() call
    if (this.lastRateLimits.length === 0) {
      return null;
    }

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

  protected doInitialize(config: Record<string, unknown>): Promise<InitResult> {
    const parsed = ClaudeCodeLLMConfigSchema.safeParse(config);
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
        env: this.cleanEnv(),
      });
      const chunks: Buffer[] = [];
      child.stdout?.on("data", (c: Buffer) => {
        chunks.push(c);
      });
      child.on("close", (code) => {
        const version = Buffer.concat(chunks).toString("utf-8").trim();
        resolve({
          healthy: code === 0,
          message: code === 0 ? `claude CLI v${version}` : "claude CLI not available",
          details: code === 0 ? { version } : null,
        });
      });
      child.on("error", () => {
        resolve({ healthy: false, message: "claude CLI not found", details: null });
      });
    });
  }

  // ── Private Helpers ──────────────────────────────────────────────────

  /** Build an allowlisted env for child processes — no secrets leak. */
  private cleanEnv(): Record<string, string> {
    return buildLlmEnv(process.env);
  }

  /**
   * Spawn Claude CLI and stream-parse its NDJSON output.
   *
   * Memory-safe: processes each line as it arrives, keeping only the final
   * result event and rate limit info. Optionally writes raw output to a trace
   * file on disk for debugging/observability.
   */
  private spawnAndParse(
    args: string[],
    stdinContent?: string,
    cwd?: string,
    traceOutputPath?: string,
  ): Promise<InferenceResult> {
    const startMs = Date.now();
    return new Promise<InferenceResult>((resolve, reject) => {
      // ── Streaming state ──────────────────────────────────────────────
      let remainder = "";
      let resultEvent: Record<string, unknown> | null = null;
      const rateLimits: RateLimitInfo[] = [];
      let stderrBuf = "";
      let totalStdoutBytes = 0;

      // ── Trace file stream (optional — piped directly to disk) ──────
      let traceStream: ReturnType<typeof createWriteStream> | null = null;
      if (traceOutputPath) {
        try {
          traceStream = createWriteStream(traceOutputPath, { flags: "w", mode: 0o600 });
          // Suppress write errors — trace is best-effort, never blocks inference
          traceStream.on("error", () => {
            traceStream?.destroy();
            traceStream = null;
          });
        } catch {
          // If we can't open the trace file, proceed without tracing
          traceStream = null;
        }
      }

      const child = spawn(this.config.cli_path, args, {
        stdio: ["pipe", "pipe", "pipe"],
        timeout: this.config.command_timeout_ms,
        env: this.cleanEnv(),
        cwd,
      });

      this.activeProcess = child;

      // ── Streaming stdout handler ───────────────────────────────────
      child.stdout?.on("data", (chunk: Buffer) => {
        totalStdoutBytes += chunk.length;

        // Output size safety valve — kill process if stdout exceeds configured limit
        if (totalStdoutBytes > this.config.max_cli_output_bytes) {
          console.error(
            `[claude-code-llm] stdout exceeded ${String(this.config.max_cli_output_bytes)} bytes — killing process`,
          );
          child.kill("SIGTERM");
          return;
        }

        // Pipe raw bytes to trace file (direct disk write, no memory copy)
        if (traceStream) {
          traceStream.write(chunk);
        }

        // Stream-parse: split into lines, process complete ones, keep remainder
        const text = remainder + chunk.toString("utf-8");
        const lines = text.split("\n");
        // Last element is either "" (chunk ended with \n) or an incomplete line
        remainder = lines.pop() ?? "";

        for (const line of lines) {
          const lineResult = processNdjsonLine(line);
          if (lineResult.type === "result") {
            resultEvent = lineResult.event;
          } else if (lineResult.type === "rate_limit") {
            rateLimits.push(lineResult.info);
          }
          // "skip" — discarded immediately, never stored in memory
        }
      });

      // ── Capped stderr handler ──────────────────────────────────────
      child.stderr?.on("data", (chunk: Buffer) => {
        stderrBuf = appendStderr(stderrBuf, chunk.toString("utf-8"));
      });

      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: output salvage + error classification requires branching on exit code, parse success, and signal type
      child.on("close", (code) => {
        this.activeProcess = null;
        const durationMs = Date.now() - startMs;

        // Close trace stream
        if (traceStream) {
          traceStream.end();
        }

        // Process any final incomplete line
        if (remainder.trim().length > 0) {
          const lineResult = processNdjsonLine(remainder);
          if (lineResult.type === "result") {
            resultEvent = lineResult.event;
          } else if (lineResult.type === "rate_limit") {
            rateLimits.push(lineResult.info);
          }
        }

        // ── Instrumentation: log CLI completion telemetry ──
        if (code !== 0) {
          const durationMin = (durationMs / 60_000).toFixed(1);
          console.error(
            `[claude-code-llm] CLI exited code=${String(code)} after ${durationMin}min ` +
              `(stdout=${String(totalStdoutBytes)}B, stderr=${String(stderrBuf.length)}B)`,
          );
        }

        if (code !== 0) {
          // ── Attempt to salvage from streaming state ──
          // If we captured a result event during streaming, use it despite non-zero exit
          if (resultEvent && resultEvent["subtype"] !== "error") {
            this.lastRateLimits = rateLimits;
            console.error(
              `[claude-code-llm] CLI exited code=${String(code)} but captured result event — salvaging`,
            );
            resolve(buildInferenceResult(resultEvent, rateLimits, durationMs));
            return;
          }

          // Signal kills (137=SIGKILL, 143=SIGTERM) indicate external termination.
          const isSignalKill = code === 137 || code === 143;
          const truncatedError = stderrBuf.slice(0, 2000);

          reject(
            new AdapterMethodError(
              createAdapterError(
                "cli_error",
                `claude CLI exited with code ${String(code)}: ${truncatedError}`,
                { retryable: !isSignalKill, severity: "error" },
              ),
            ),
          );
          return;
        }

        // ── Happy path: use streamed result ──
        if (!resultEvent) {
          reject(
            new AdapterMethodError(
              createAdapterError("internal_error", "No result event found in CLI output"),
            ),
          );
          return;
        }

        if (resultEvent["subtype"] === "error") {
          reject(
            new AdapterMethodError(
              createAdapterError(
                "internal_error",
                `CLI returned error: ${String(resultEvent["error"] ?? "unknown")}`,
              ),
            ),
          );
          return;
        }

        this.lastRateLimits = rateLimits;
        resolve(buildInferenceResult(resultEvent, rateLimits, durationMs));
      });

      child.on("error", (err) => {
        this.activeProcess = null;
        if (traceStream) {
          traceStream.end();
        }
        reject(
          new AdapterMethodError(
            createAdapterError("spawn_error", `Failed to spawn claude CLI: ${err.message}`),
          ),
        );
      });

      // Pipe prompt via stdin to avoid OS argument length limits
      // Suppress EPIPE — child may exit before stdin is consumed
      // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional noop — suppress EPIPE when child exits before stdin consumed
      child.stdin?.on("error", () => {});
      if (stdinContent) {
        child.stdin?.write(stdinContent);
      }
      child.stdin?.end();
    });
  }

  /**
   * Fetch quota/usage data from Anthropic's OAuth usage API.
   *
   * Security:
   * - OAuth token is read from Claude Code's credential store (OS-specific)
   * - Token is piped via stdin to curl so it never appears in the process list
   * - Token is NEVER logged, written to disk, passed to env vars, or stored as a field
   *
   * Cross-platform credential access:
   * - macOS: reads from macOS Keychain via `security` CLI
   * - Linux/Windows: reads from `~/.claude/.credentials.json` file
   *
   * Rate limiting: caches results for 30 minutes to avoid Anthropic's aggressive
   * per-token rate limits (~5 requests before 429).
   */
  private fetchQuotaFromApi(): QuotaStatus | null {
    if (this.cachedQuota && Date.now() - this.cachedQuotaAt < this.quotaCacheTtlMs) {
      return this.cachedQuota;
    }

    const token = readOAuthToken();
    if (!token) {
      return this.cachedQuota;
    }

    try {
      const raw = execSync(
        "curl -sf -H @- -H 'anthropic-beta: oauth-2025-04-20' 'https://api.anthropic.com/api/oauth/usage'",
        { timeout: 5000, encoding: "utf-8", input: `Authorization: Bearer ${token}` },
      ).trim();

      if (!raw) {
        return this.cachedQuota;
      }

      const data = JSON.parse(raw) as Record<string, unknown>;
      this.cachedQuota = parseUsageApiResponse(data);
      this.cachedQuotaAt = Date.now();
      return this.cachedQuota;
    } catch {
      return this.cachedQuota;
    }
  }
}

// ── Module-level helpers ─────────────────────────────────────────────────

/** Build an InferenceResult from a parsed result event. */
function buildInferenceResult(
  resultEvent: Record<string, unknown>,
  _rateLimits: RateLimitInfo[],
  durationMs: number,
): InferenceResult {
  const content = extractContent(resultEvent);
  const costUsd =
    typeof resultEvent["total_cost_usd"] === "number"
      ? resultEvent["total_cost_usd"]
      : typeof resultEvent["cost_usd"] === "number"
        ? resultEvent["cost_usd"]
        : null;
  const usage = extractUsage(resultEvent);

  return { content, cost_usd: costUsd, duration_ms: durationMs, usage };
}

/** Parsed output from the Claude CLI stream-json format. */
export interface ParsedCliOutput {
  content: string;
  cost_usd: number | null;
  usage: InferenceUsage | null;
  rateLimits: RateLimitInfo[];
}

/**
 * Parse NDJSON output from `claude --print --output-format stream-json --verbose`.
 *
 * Output is newline-delimited JSON events. We extract:
 * - `type: "result"` — content, cost, full token/model usage breakdown
 * - `type: "rate_limit_event"` — quota window status and reset times
 *
 * Returns content, cost, usage details, and rate limit info.
 * duration_ms is measured by the caller (spawnAndParse).
 *
 * NOTE: This function is retained for backward compatibility and testing.
 * The live streaming path uses processNdjsonLine() instead.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: NDJSON parser handling multiple event types and result formats
export function parseCliOutput(raw: string): ParsedCliOutput {
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  let resultEvent: Record<string, unknown> | null = null;
  const rateLimits: RateLimitInfo[] = [];

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed["type"] === "result") {
        resultEvent = parsed;
      } else if (parsed["type"] === "rate_limit_event") {
        const info = parsed["rate_limit_info"] as Record<string, unknown> | undefined;
        if (info) {
          rateLimits.push({
            rateLimitType:
              typeof info["rateLimitType"] === "string" ? info["rateLimitType"] : "unknown",
            status: typeof info["status"] === "string" ? info["status"] : "unknown",
            resetsAt: typeof info["resetsAt"] === "number" ? info["resetsAt"] : null,
          });
        }
      }
    } catch {
      // Skip non-JSON lines
    }
  }

  if (!resultEvent) {
    throw new AdapterMethodError(
      createAdapterError("internal_error", "No result event found in CLI output"),
    );
  }

  if (resultEvent["subtype"] === "error") {
    throw new AdapterMethodError(
      createAdapterError(
        "internal_error",
        `CLI returned error: ${String(resultEvent["error"] ?? "unknown")}`,
      ),
    );
  }

  const content = extractContent(resultEvent);
  const costUsd =
    typeof resultEvent["total_cost_usd"] === "number"
      ? resultEvent["total_cost_usd"]
      : typeof resultEvent["cost_usd"] === "number"
        ? resultEvent["cost_usd"]
        : null;
  const usage = extractUsage(resultEvent);

  return { content, cost_usd: costUsd, usage, rateLimits };
}

/** Extract text content from a result event's `result` field. */
function extractContent(resultEvent: Record<string, unknown>): string {
  const rawResult = resultEvent["result"];
  if (typeof rawResult === "string") {
    return rawResult;
  }
  if (typeof rawResult === "object" && rawResult !== null && "text" in rawResult) {
    const text = (rawResult as Record<string, unknown>)["text"];
    return typeof text === "string" ? text : "";
  }
  return "";
}

/** Extract token usage from a result event's `usage` and `modelUsage` fields. */
function extractUsage(resultEvent: Record<string, unknown>): InferenceUsage | null {
  const usage = resultEvent["usage"] as Record<string, unknown> | undefined;
  if (!usage) {
    return null;
  }

  const inputTokens = typeof usage["input_tokens"] === "number" ? usage["input_tokens"] : 0;
  const outputTokens = typeof usage["output_tokens"] === "number" ? usage["output_tokens"] : 0;
  const cacheRead =
    typeof usage["cache_read_input_tokens"] === "number" ? usage["cache_read_input_tokens"] : 0;
  const cacheCreation =
    typeof usage["cache_creation_input_tokens"] === "number"
      ? usage["cache_creation_input_tokens"]
      : 0;
  const serviceTier = typeof usage["service_tier"] === "string" ? usage["service_tier"] : null;

  // Derive model_id from modelUsage keys if available
  const modelUsage = resultEvent["modelUsage"] as Record<string, unknown> | undefined;
  const modelId = modelUsage ? (Object.keys(modelUsage)[0] ?? null) : null;

  return {
    tokens: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_tokens: cacheRead,
      cache_creation_tokens: cacheCreation,
      total_tokens: inputTokens + outputTokens,
    },
    model_id: modelId,
    service_tier: serviceTier,
  };
}

// ── Credential Access ────────────────────────────────────────────────────────

/**
 * Read the OAuth access token from Claude Code's credential store.
 *
 * Tries OS-specific secure storage first, falls back to file-based credentials.
 * Returns null if credentials cannot be found or are expired.
 * The returned token should be used immediately and not stored.
 */
function readOAuthToken(): string | null {
  // Try OS-specific credential store first
  if (platform() === "darwin") {
    try {
      const raw = execSync('security find-generic-password -s "Claude Code-credentials" -w', {
        timeout: 3000,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      if (raw) {
        const creds = JSON.parse(raw) as Record<string, unknown>;
        return extractTokenFromCreds(creds);
      }
    } catch {
      // Fall through to file-based
    }
  }

  // File-based credentials (Linux, Windows, or macOS fallback)
  const credPaths = [
    join(homedir(), ".claude", ".credentials.json"),
    join(homedir(), ".claude", "credentials.json"),
  ];

  for (const credPath of credPaths) {
    try {
      if (existsSync(credPath)) {
        const raw = readFileSync(credPath, "utf-8");
        const creds = JSON.parse(raw) as Record<string, unknown>;
        return extractTokenFromCreds(creds);
      }
    } catch {
      // Try next path
    }
  }

  return null;
}

/** Extract and validate the access token from Claude Code's credential JSON. */
function extractTokenFromCreds(creds: Record<string, unknown>): string | null {
  const oauth = creds["claudeAiOauth"] as Record<string, unknown> | undefined;
  if (!oauth) {
    return null;
  }

  const token = oauth["accessToken"];
  if (typeof token !== "string" || !token) {
    return null;
  }

  // Check expiry — don't use expired tokens
  const expiresAt = oauth["expiresAt"];
  if (typeof expiresAt === "number" && expiresAt < Date.now()) {
    return null;
  }

  return token;
}

/** Parse the Anthropic usage API response into our QuotaStatus shape. */
function parseUsageApiResponse(data: Record<string, unknown>): QuotaStatus {
  const windows: QuotaWindow[] = [];

  // Map known API fields to our QuotaWindow format
  const windowMappings: Array<{ key: string; displayType: string }> = [
    { key: "five_hour", displayType: "five_hour" },
    { key: "seven_day", displayType: "seven_day" },
    { key: "seven_day_sonnet", displayType: "seven_day_sonnet" },
    { key: "seven_day_opus", displayType: "seven_day_opus" },
    { key: "seven_day_oauth_apps", displayType: "seven_day_oauth_apps" },
  ];

  for (const mapping of windowMappings) {
    const entry = data[mapping.key] as Record<string, unknown> | null | undefined;
    if (!entry) {
      continue;
    }

    const utilization = typeof entry["utilization"] === "number" ? entry["utilization"] : null;
    const resetsAtStr = typeof entry["resets_at"] === "string" ? entry["resets_at"] : null;
    const resetsAtSec = resetsAtStr ? Math.floor(new Date(resetsAtStr).getTime() / 1000) : null;

    windows.push({
      window_type: mapping.displayType,
      resets_at: resetsAtSec,
      is_exhausted: utilization !== null && utilization >= 100,
      used_percentage: utilization,
    });
  }

  const isRateLimited = windows.some((w) => w.is_exhausted);
  const resetTimes = windows.map((w) => w.resets_at).filter((t): t is number => t !== null);

  return {
    windows,
    is_rate_limited: isRateLimited,
    earliest_reset_at: resetTimes.length > 0 ? Math.min(...resetTimes) : null,
  };
}
