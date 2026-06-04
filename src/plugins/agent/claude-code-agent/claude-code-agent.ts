import { type ChildProcess, execSync, spawn } from "node:child_process";
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import {
  AdapterMethodError,
  AgentAdapter,
  type AgentCapabilities,
  type AgentRunRequest,
  type AgentRunResult,
  type AgentRunUsage,
  type HealthStatus,
  type InitResult,
  type QuotaStatus,
  type QuotaWindow,
  createAdapterError,
} from "../../../adapters/index.js";
import { AdapterErrorSeverities } from "../../../schemas/adapters.js";
import { killProcess } from "../../../utils/process.js";
import { appendStderr, buildAgentEnv } from "../subprocess.js";
import { type ClaudeCodeAgentConfig, ClaudeCodeAgentConfigSchema, DEFAULT_CLAUDE_MODEL } from "./config.js";

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
            rateLimitType: typeof info["rateLimitType"] === "string" ? info["rateLimitType"] : "unknown",
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

/**
 * ClaudeCodeAgentPlugin — the Engineer's autonomous coding agent via Claude Code.
 *
 * Spawns the Claude Code CLI (`claude --print --output-format stream-json --verbose`)
 * as a child process. Uses streaming NDJSON parsing to avoid buffering the entire
 * output in memory. Optionally writes raw CLI output to a trace file for debugging.
 */
export class ClaudeCodeAgentPlugin extends AgentAdapter {
  private config!: ClaudeCodeAgentConfig;
  private activeProcesses = new Set<ChildProcess>();
  private lastRateLimits: RateLimitInfo[] = [];

  // Quota API cache — instance-level so each plugin instance has its own cache.
  // Anthropic's usage API has aggressive per-token rate limits (~5 requests before 429).
  // Cache for 30 minutes to stay well within limits across multi-phase task pipelines.
  private readonly quotaCacheTtlMs = 30 * 60 * 1000;
  private cachedQuota: QuotaStatus | null = null;
  private cachedQuotaAt = 0;

  protected doRun(request: AgentRunRequest): Promise<AgentRunResult> {
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
      request.signal,
    );
  }

  getCapabilities(): AgentCapabilities {
    return {
      model_id: this.config?.model ?? DEFAULT_CLAUDE_MODEL,
      supports_usage_reporting: true,
      supports_quota_reporting: true,
      supports_activity_streaming: false,
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
    const parsed = ClaudeCodeAgentConfigSchema.safeParse(config);
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
    for (const child of this.activeProcesses) {
      killProcess(child);
    }
    this.activeProcesses.clear();
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
    return buildAgentEnv(process.env);
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
    signal?: AbortSignal,
  ): Promise<AgentRunResult> {
    const startMs = Date.now();
    return new Promise<AgentRunResult>((resolve, reject) => {
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
        signal,
      });

      this.activeProcesses.add(child);

      // ── Streaming stdout handler ───────────────────────────────────
      child.stdout?.on("data", (chunk: Buffer) => {
        totalStdoutBytes += chunk.length;

        // Output size safety valve — kill process if stdout exceeds configured limit
        if (totalStdoutBytes > this.config.max_cli_output_bytes) {
          this.context.logger.warn("CLI stdout exceeded byte limit — killing process", {
            limitBytes: this.config.max_cli_output_bytes,
            receivedBytes: totalStdoutBytes,
          });
          killProcess(child);
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
        this.activeProcesses.delete(child);
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
          this.context.logger.warn("CLI exited with non-zero code", {
            code,
            durationMs,
            stdoutBytes: totalStdoutBytes,
            stderrBytes: stderrBuf.length,
          });
        }

        if (code !== 0) {
          // ── Attempt to salvage from streaming state ──
          // If we captured a result event during streaming, use it despite non-zero exit
          if (resultEvent && resultEvent["subtype"] !== "error") {
            this.lastRateLimits = rateLimits;
            this.context.logger.info("CLI exited non-zero but result event captured — salvaging", { code });
            resolve(buildAgentRunResult(resultEvent, durationMs));
            return;
          }

          // Signal kills (137=SIGKILL, 143=SIGTERM) indicate external termination.
          const isSignalKill = code === 137 || code === 143;
          const truncatedError = stderrBuf.slice(0, 2000);

          reject(
            new AdapterMethodError(
              createAdapterError("cli_error", `claude CLI exited with code ${String(code)}: ${truncatedError}`, {
                retryable: !isSignalKill,
                severity: AdapterErrorSeverities.error,
              }),
            ),
          );
          return;
        }

        // ── Happy path: use streamed result ──
        if (!resultEvent) {
          reject(new AdapterMethodError(createAdapterError("internal_error", "No result event found in CLI output")));
          return;
        }

        if (resultEvent["subtype"] === "error") {
          reject(
            new AdapterMethodError(
              createAdapterError("internal_error", `CLI returned error: ${String(resultEvent["error"] ?? "unknown")}`),
            ),
          );
          return;
        }

        this.lastRateLimits = rateLimits;
        resolve(buildAgentRunResult(resultEvent, durationMs));
      });

      child.on("error", (err) => {
        this.activeProcesses.delete(child);
        if (traceStream) {
          traceStream.end();
        }
        reject(
          new AdapterMethodError(createAdapterError("spawn_error", `Failed to spawn claude CLI: ${err.message}`), {
            cause: err,
          }),
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

/** Build an AgentRunResult from a parsed result event. */
function buildAgentRunResult(resultEvent: Record<string, unknown>, durationMs: number): AgentRunResult {
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

/**
 * The model that actually did the work, taken from the result event's `modelUsage` map by spend.
 *
 * Claude Code routinely runs a small auxiliary model (e.g. a `claude-haiku-*` helper for housekeeping)
 * alongside the configured model, so `modelUsage` can carry several keys for one run. Reporting the wrong
 * one is not cosmetic: this id rides the `cost.incurred` event and is what the dashboard shows as "the
 * model this task ran on". Picking `Object.keys()[0]` reported whichever key happened to come first —
 * often the few-cent helper. We pick the highest-spend key instead (output tokens as the tiebreaker),
 * which is the configured model in every real run. Null when no usage was reported.
 */
export function dominantModelId(modelUsage: Record<string, unknown> | undefined): string | null {
  if (!modelUsage) {
    return null;
  }
  let best: { id: string; cost: number; output: number } | null = null;
  for (const [id, raw] of Object.entries(modelUsage)) {
    const usage = (raw ?? {}) as Record<string, unknown>;
    const cost = typeof usage["costUSD"] === "number" ? usage["costUSD"] : 0;
    const output = typeof usage["outputTokens"] === "number" ? usage["outputTokens"] : 0;
    if (!best || cost > best.cost || (cost === best.cost && output > best.output)) {
      best = { id, cost, output };
    }
  }
  return best?.id ?? null;
}

/** Extract token usage from a result event's `usage` and `modelUsage` fields. */
function extractUsage(resultEvent: Record<string, unknown>): AgentRunUsage | null {
  const usage = resultEvent["usage"] as Record<string, unknown> | undefined;
  if (!usage) {
    return null;
  }

  const inputTokens = typeof usage["input_tokens"] === "number" ? usage["input_tokens"] : 0;
  const outputTokens = typeof usage["output_tokens"] === "number" ? usage["output_tokens"] : 0;
  const cacheRead = typeof usage["cache_read_input_tokens"] === "number" ? usage["cache_read_input_tokens"] : 0;
  const cacheCreation =
    typeof usage["cache_creation_input_tokens"] === "number" ? usage["cache_creation_input_tokens"] : 0;
  const serviceTier = typeof usage["service_tier"] === "string" ? usage["service_tier"] : null;

  // Derive model_id from modelUsage — the model that did the real work, not whichever key sorts first.
  const modelUsage = resultEvent["modelUsage"] as Record<string, unknown> | undefined;
  const modelId = dominantModelId(modelUsage);

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
  const credPaths = [join(homedir(), ".claude", ".credentials.json"), join(homedir(), ".claude", "credentials.json")];

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
  const windowMappings: string[] = [
    "five_hour",
    "seven_day",
    "seven_day_sonnet",
    "seven_day_opus",
    "seven_day_oauth_apps",
  ];

  for (const key of windowMappings) {
    const entry = data[key] as Record<string, unknown> | null | undefined;
    if (!entry) {
      continue;
    }

    const utilization = typeof entry["utilization"] === "number" ? entry["utilization"] : null;
    const resetsAtStr = typeof entry["resets_at"] === "string" ? entry["resets_at"] : null;
    const resetsAtSec = resetsAtStr ? Math.floor(new Date(resetsAtStr).getTime() / 1000) : null;

    windows.push({
      window_type: key,
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
