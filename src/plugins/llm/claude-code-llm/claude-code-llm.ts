import { type ChildProcess, spawn } from "node:child_process";
import {
  AdapterMethodError,
  type CompletionRequest,
  type CompletionResult,
  type HealthStatus,
  type InitResult,
  LLMAdapter,
  type LLMCapabilities,
  createAdapterError,
} from "../../../adapters/index.js";
import { type ClaudeCodeLLMConfig, ClaudeCodeLLMConfigSchema } from "./config.js";

/**
 * ClaudeCodeLLMPlugin — the Engineer's thinking engine.
 *
 * Invokes the Claude Code CLI (`claude --print --output-format json`)
 * as a child process, parses NDJSON output, and extracts the result
 * with usage data for cost tracking.
 */
export class ClaudeCodeLLMPlugin extends LLMAdapter {
  private config!: ClaudeCodeLLMConfig;
  private activeProcess: ChildProcess | null = null;

  protected doComplete(request: CompletionRequest): Promise<CompletionResult> {
    // --setting-sources user: prevent loading project-level CLAUDE.md and settings
    // from the CWD — the Engineer provides all context via the prompt.
    // --dangerously-skip-permissions: required for non-interactive tool use (read/write/bash)
    // --setting-sources user: prevent loading project-level CLAUDE.md and settings
    const args = [
      "--print",
      "--output-format",
      "json",
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
    return this.spawnAndParse(args, request.prompt, request.options?.cwd ?? undefined);
  }

  getCapabilities(): LLMCapabilities {
    return {
      max_context: 200_000,
      supports_tools: true,
      supports_vision: true,
      model_id: this.config?.model ?? "claude-sonnet-4-20250514",
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

  /** Build a clean env for child processes, stripping CLAUDECODE to avoid nested-session detection. */
  private cleanEnv(): NodeJS.ProcessEnv {
    const { CLAUDECODE: _, ...env } = process.env;
    return env;
  }

  private spawnAndParse(
    args: string[],
    stdinContent?: string,
    cwd?: string,
  ): Promise<CompletionResult> {
    return new Promise<CompletionResult>((resolve, reject) => {
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
          resolve(parsed);
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
}

// ── Module-level helpers ─────────────────────────────────────────────────

/**
 * Parse NDJSON output from `claude --print --output-format json`.
 *
 * Output is newline-delimited JSON events. We find the final `type: "result"`
 * event and extract content + usage data.
 *
 * Known result shapes:
 * - `--print` mode: `{ "type": "result", "subtype": "success", "cost_usd": 0.01, "result": "the text response" }`
 * - Object mode: `{ "type": "result", "subtype": "success", "result": { "type": "text", "text": "..." } }`
 *
 * Token counts are not yet available from the CLI (upstream GitHub #11917).
 * We set tokens_in/tokens_out to 0 and rely on cost_usd for cost tracking.
 */
export function parseCliOutput(raw: string): CompletionResult {
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  let resultEvent: Record<string, unknown> | null = null;

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed["type"] === "result") {
        resultEvent = parsed;
      }
    } catch {
      // Skip non-JSON lines
    }
  }

  if (!resultEvent) {
    throw new Error("No result event found in CLI output");
  }

  if (resultEvent["subtype"] === "error") {
    throw new Error(`CLI returned error: ${String(resultEvent["error"] ?? "unknown")}`);
  }

  // The `result` field may be a string (--print mode) or an object with a `text` field.
  // Handle both formats to support different CLI versions and modes.
  const rawResult = resultEvent["result"];
  let content: string;
  if (typeof rawResult === "string") {
    content = rawResult;
  } else if (typeof rawResult === "object" && rawResult !== null && "text" in rawResult) {
    content =
      typeof (rawResult as Record<string, unknown>)["text"] === "string"
        ? ((rawResult as Record<string, unknown>)["text"] as string)
        : "";
  } else {
    content = "";
  }
  const costUsd = typeof resultEvent["cost_usd"] === "number" ? resultEvent["cost_usd"] : null;

  return {
    content,
    tool_calls: null,
    finish_reason: "stop",
    usage: {
      // TODO: Token counts not yet available from Claude Code CLI (upstream GitHub #11917).
      // Once the CLI exposes usage_metrics, parse tokens_in/tokens_out here.
      tokens_in: 0,
      tokens_out: 0,
      spend_usd: costUsd,
      remaining: null,
      resets_at: null,
    },
  };
}
