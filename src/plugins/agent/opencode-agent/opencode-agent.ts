import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import {
  AdapterMethodError,
  AgentAdapter,
  type AgentCapabilities,
  type AgentRunRequest,
  type AgentRunResult,
  type AgentRunUsage,
  type HealthStatus,
  type InitResult,
  createAdapterError,
} from "../../../adapters/index.js";
import { AdapterErrorSeverities } from "../../../schemas/adapters.js";
import { killProcess } from "../../../utils/process.js";
import { appendStderr, buildAgentEnv } from "../subprocess.js";
import { type OpenCodeAgentConfig, OpenCodeAgentConfigSchema } from "./config.js";

const DEFAULT_OPENCODE_MODEL = "opencode/gemini-3.1-pro";

/** Rate limit pattern for stderr detection — hoisted for performance. */
const RATE_LIMIT_STDERR_RE = /exhausted your capacity|rate.?limit|quota/i;

// ── Streaming NDJSON line processor ──────────────────────────────────────────

/** Result of processing a single NDJSON line from OpenCode CLI output. */
export type OpenCodeNdjsonLineResult =
  | { type: "text"; text: string }
  | { type: "step_finish"; costUsd: number | null; usage: AgentRunUsage | null }
  | { type: "skip" };

/**
 * Process a single NDJSON line from OpenCode CLI output.
 * Pure function — independently testable.
 */
export function processOpenCodeNdjsonLine(line: string): OpenCodeNdjsonLineResult {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return { type: "skip" };
  }

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const part = parsed["part"] as Record<string, unknown> | undefined;
    if (!part) {
      return { type: "skip" };
    }

    if (parsed["type"] === "text") {
      const text = part["text"];
      if (typeof text === "string") {
        return { type: "text", text };
      }
      return { type: "skip" };
    }

    if (parsed["type"] === "step_finish") {
      const costUsd = typeof part["cost"] === "number" ? part["cost"] : null;
      let usage: AgentRunUsage | null = null;

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

      return { type: "step_finish", costUsd, usage };
    }

    return { type: "skip" };
  } catch {
    return { type: "skip" };
  }
}

// ── Plugin ───────────────────────────────────────────────────────────────────

/**
 * OpenCodeAgentPlugin — multi-provider autonomous coding agent via OpenCode CLI.
 *
 * Uses streaming NDJSON parsing to avoid buffering the entire output in memory.
 * Optionally writes raw CLI output to a trace file for debugging.
 */
export class OpenCodeAgentPlugin extends AgentAdapter {
  private config!: OpenCodeAgentConfig;
  private activeProcesses = new Set<ChildProcess>();

  protected doRun(request: AgentRunRequest): Promise<AgentRunResult> {
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
    return this.spawnAndParse(args, prompt, request.trace_output_path ?? undefined, request.signal);
  }

  getCapabilities(): AgentCapabilities {
    return {
      model_id: this.config?.model ?? DEFAULT_OPENCODE_MODEL,
      supports_usage_reporting: true,
      supports_quota_reporting: false,
      context_window: null,
    };
  }

  protected doInitialize(config: Record<string, unknown>): Promise<InitResult> {
    const parsed = OpenCodeAgentConfigSchema.safeParse(config);
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
        env: buildAgentEnv(process.env),
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

  /**
   * Spawn OpenCode CLI and stream-parse its NDJSON output.
   * Memory-safe: processes each line as it arrives. Optionally traces to disk.
   */
  private spawnAndParse(
    args: string[],
    stdinContent?: string,
    traceOutputPath?: string,
    signal?: AbortSignal,
  ): Promise<AgentRunResult> {
    const startMs = Date.now();
    return new Promise<AgentRunResult>((resolve, reject) => {
      // ── Streaming state ──
      let remainder = "";
      const textParts: string[] = [];
      let costUsd: number | null = null;
      let usage: AgentRunUsage | null = null;
      let stderrBuf = "";

      // ── Trace file stream ──
      let traceStream: ReturnType<typeof createWriteStream> | null = null;
      if (traceOutputPath) {
        try {
          traceStream = createWriteStream(traceOutputPath, { flags: "w", mode: 0o600 });
          traceStream.on("error", () => {
            traceStream?.destroy();
            traceStream = null;
          });
        } catch {
          traceStream = null;
        }
      }

      const child = spawn(this.config.cli_path, args, {
        stdio: ["pipe", "pipe", "pipe"],
        timeout: this.config.command_timeout_ms,
        env: buildAgentEnv(process.env),
        signal,
      });

      this.activeProcesses.add(child);
      let killedForRateLimit = false;

      let totalStdoutBytes = 0;

      // ── Streaming stdout ──
      child.stdout?.on("data", (chunk: Buffer) => {
        totalStdoutBytes += chunk.length;

        // Output size safety valve
        if (totalStdoutBytes > this.config.max_cli_output_bytes) {
          this.context.logger.warn("CLI stdout exceeded byte limit — killing process", {
            limitBytes: this.config.max_cli_output_bytes,
            receivedBytes: totalStdoutBytes,
          });
          killProcess(child);
          return;
        }

        if (traceStream) {
          traceStream.write(chunk);
        }

        const text = remainder + chunk.toString("utf-8");
        const lines = text.split("\n");
        remainder = lines.pop() ?? "";

        for (const line of lines) {
          const result = processOpenCodeNdjsonLine(line);
          if (result.type === "text") {
            textParts.push(result.text);
          } else if (result.type === "step_finish") {
            costUsd = result.costUsd;
            usage = result.usage;
          }
        }
      });

      // ── Capped stderr with rate limit detection ──
      child.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf-8");
        stderrBuf = appendStderr(stderrBuf, text);
        if (!killedForRateLimit && RATE_LIMIT_STDERR_RE.test(text)) {
          killedForRateLimit = true;
          killProcess(child);
        }
      });

      child.on("close", (code) => {
        this.activeProcesses.delete(child);
        if (traceStream) {
          traceStream.end();
        }

        // Process final incomplete line
        if (remainder.trim().length > 0) {
          const result = processOpenCodeNdjsonLine(remainder);
          if (result.type === "text") {
            textParts.push(result.text);
          } else if (result.type === "step_finish") {
            costUsd = result.costUsd;
            usage = result.usage;
          }
        }

        const durationMs = Date.now() - startMs;

        if (killedForRateLimit) {
          reject(
            new AdapterMethodError(
              createAdapterError("cli_error", `opencode CLI rate limited: ${stderrBuf.slice(0, 200)}`, {
                retryable: true,
                severity: AdapterErrorSeverities.error,
              }),
            ),
          );
          return;
        }

        if (code !== 0) {
          reject(
            new AdapterMethodError(
              createAdapterError(
                "cli_error",
                `opencode CLI exited with code ${String(code)}: ${stderrBuf || textParts.join("")}`,
                { retryable: true, severity: AdapterErrorSeverities.error },
              ),
            ),
          );
          return;
        }

        const content = textParts.join("");
        if (content.length === 0 && costUsd === null) {
          reject(
            new AdapterMethodError(
              createAdapterError("internal_error", "No text or step_finish event found in OpenCode output"),
            ),
          );
          return;
        }

        resolve({
          content,
          cost_usd: costUsd,
          duration_ms: durationMs,
          usage,
        });
      });

      child.on("error", (err) => {
        this.activeProcesses.delete(child);
        if (traceStream) {
          traceStream.end();
        }
        reject(
          new AdapterMethodError(createAdapterError("spawn_error", `Failed to spawn opencode CLI: ${err.message}`), {
            cause: err,
          }),
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
