import { type ChildProcess, execSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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

/**
 * ClaudeCodeLLMPlugin — the Engineer's thinking engine.
 *
 * Invokes the Claude Code CLI (`claude --print --output-format stream-json --verbose`)
 * as a child process, parses NDJSON output for result + rate limit events,
 * and extracts content, usage data, and quota status.
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
    return this.spawnAndParse(args, request.prompt, request.cwd ?? undefined);
  }

  getContinueArgs(): string[] {
    return ["--continue"];
  }

  getCapabilities(): LLMCapabilities {
    return {
      model_id: this.config?.model ?? "claude-sonnet-4-20250514",
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

  private spawnAndParse(
    args: string[],
    stdinContent?: string,
    cwd?: string,
  ): Promise<InferenceResult> {
    const startMs = Date.now();
    return new Promise<InferenceResult>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      const child = spawn(this.config.cli_path, args, {
        stdio: ["pipe", "pipe", "pipe"],
        timeout: this.config.command_timeout_ms,
        env: this.cleanEnv(),
        cwd,
      });

      this.activeProcess = child;

      child.stdout?.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderrChunks.push(chunk);
      });

      child.on("close", (code) => {
        this.activeProcess = null;
        const raw = Buffer.concat(chunks).toString("utf-8");
        const stderr = Buffer.concat(stderrChunks).toString("utf-8");
        const durationMs = Date.now() - startMs;

        if (code !== 0) {
          reject(
            new AdapterMethodError(
              createAdapterError(
                "cli_error",
                `claude CLI exited with code ${String(code)}: ${stderr || raw}`,
                { retryable: true, severity: "error" },
              ),
            ),
          );
          return;
        }

        try {
          const parsed = parseCliOutput(raw);
          this.lastRateLimits = parsed.rateLimits;
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
                `Failed to parse CLI output: ${err instanceof Error ? err.message : String(err)}`,
              ),
            ),
          );
        }
      });

      child.on("error", (err) => {
        this.activeProcess = null;
        reject(
          new AdapterMethodError(
            createAdapterError("spawn_error", `Failed to spawn claude CLI: ${err.message}`),
          ),
        );
      });

      // Pipe prompt via stdin to avoid OS argument length limits
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
