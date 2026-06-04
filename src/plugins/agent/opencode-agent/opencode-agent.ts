import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import {
  AdapterMethodError,
  type AgentActivityEvent,
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

/** Mutable accumulator threaded through the stream loop: the salvageable result content + cost + usage. */
interface StreamParseState {
  textParts: string[];
  costUsd: number | null;
  usage: AgentRunUsage | null;
}

/**
 * Process a single NDJSON line from OpenCode CLI output.
 * Pure function — independently testable.
 */

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: <explanation>
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

// ── Live activity mapping ─────────────────────────────────────────────────────

/**
 * Map a single NDJSON line from OpenCode CLI output into canonical activity events.
 *
 * Pure function — independently testable, mirrors `processOpenCodeNdjsonLine`. Each line wraps one
 * complete `part`, so this maps at block granularity (one event per finished text / reasoning / tool),
 * never per token:
 * - `text` → one `assistant_text` event (`part.text`)
 * - `reasoning` → one `thinking` event (`part.text`)
 * - a completed `tool_use` → TWO events in order: `tool_use` (call+input) then `tool_result`
 *   (output+status). OpenCode folds a tool's call and result into one event when the tool finishes.
 * Returns `[]` for `step_start` / `step_finish` / `error` and for malformed lines. Never throws:
 * a bad line yields no events, it does not break the run.
 */
export function activityEventsFromLine(line: string): AgentActivityEvent[] {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return [];
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return [];
  }

  const part = parsed["part"];
  if (typeof part !== "object" || part === null) {
    return [];
  }
  const block = part as Record<string, unknown>;

  switch (parsed["type"]) {
    case "text":
      return typeof block["text"] === "string" ? [{ kind: "assistant_text", text: block["text"] }] : [];
    case "reasoning":
      return typeof block["text"] === "string" ? [{ kind: "thinking", text: block["text"] }] : [];
    case "tool_use":
      return toolActivityEvents(block);
    default:
      return [];
  }
}

/** Map one completed OpenCode tool part into its ordered call + result activity events. */
function toolActivityEvents(part: Record<string, unknown>): AgentActivityEvent[] {
  const callId = part["callID"];
  const name = part["tool"];
  if (typeof callId !== "string" || typeof name !== "string") {
    return [];
  }

  const state = part["state"];
  const toolState = typeof state === "object" && state !== null ? (state as Record<string, unknown>) : {};

  return [
    { kind: "tool_use", tool_call_id: callId, name, input: toolState["input"] },
    {
      kind: "tool_result",
      tool_call_id: callId,
      status: toolState["status"] === "completed" ? "ok" : "error",
      output: toolState["output"],
    },
  ];
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
    return this.spawnAndParse(
      args,
      prompt,
      request.trace_output_path ?? undefined,
      request.signal,
      request.on_activity,
    );
  }

  getCapabilities(): AgentCapabilities {
    return {
      model_id: this.config?.model ?? DEFAULT_OPENCODE_MODEL,
      supports_usage_reporting: true,
      supports_quota_reporting: false,
      supports_activity_streaming: true,
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
   * Consume one NDJSON line: accumulate the salvageable content/cost/usage, then emit live activity.
   *
   * Keeps the two concerns in one place so the stdout closure stays flat. Activity is
   * observation-only and best-effort — a throwing sink is swallowed so it can never break or slow
   * the run, and the result accumulation it follows is never affected.
   */
  private consumeStreamLine(
    line: string,
    parsed: StreamParseState,
    onActivity?: (event: AgentActivityEvent) => void,
  ): void {
    const result = processOpenCodeNdjsonLine(line);
    if (result.type === "text") {
      parsed.textParts.push(result.text);
    } else if (result.type === "step_finish") {
      parsed.costUsd = result.costUsd;
      parsed.usage = result.usage;
    }

    if (!onActivity) {
      return;
    }
    // Emit live activity (block level) — best-effort, never affects the run.
    try {
      for (const event of activityEventsFromLine(line)) {
        onActivity(event);
      }
    } catch {
      // Activity is observation-only — never let it surface into the run.
    }
  }

  /**
   * Spawn OpenCode CLI and stream-parse its NDJSON output.
   * Memory-safe: processes each line as it arrives. Optionally traces to disk.
   */
  private spawnAndParse(
    args: string[],
    stdinContent?: string,
    traceOutputPath?: string,
    signal?: AbortSignal,
    onActivity?: (event: AgentActivityEvent) => void,
  ): Promise<AgentRunResult> {
    const startMs = Date.now();
    return new Promise<AgentRunResult>((resolve, reject) => {
      // ── Streaming state ──
      let remainder = "";
      const parsed: StreamParseState = { textParts: [], costUsd: null, usage: null };
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
          this.consumeStreamLine(line, parsed, onActivity);
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

      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: CLI process lifecycle with rate limit + exit code + empty-output paths
      child.on("close", (code) => {
        this.activeProcesses.delete(child);
        if (traceStream) {
          traceStream.end();
        }

        // Process final incomplete line
        if (remainder.trim().length > 0) {
          this.consumeStreamLine(remainder, parsed, onActivity);
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
                `opencode CLI exited with code ${String(code)}: ${stderrBuf || parsed.textParts.join("")}`,
                { retryable: true, severity: AdapterErrorSeverities.error },
              ),
            ),
          );
          return;
        }

        const content = parsed.textParts.join("");
        if (content.length === 0 && parsed.costUsd === null) {
          reject(
            new AdapterMethodError(
              createAdapterError("internal_error", "No text or step_finish event found in OpenCode output"),
            ),
          );
          return;
        }

        resolve({
          content,
          cost_usd: parsed.costUsd,
          duration_ms: durationMs,
          usage: parsed.usage,
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
