import { type ChildProcess, spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import {
  type HealthStatus,
  type InitResult,
  type SideEffect,
  ToolAdapter,
  type ToolDescription,
  type ToolExecutionContext,
  type ToolResult,
  createAdapterError,
} from "../../../adapters/index.js";
import { SideEffectTypes } from "../../../schemas/adapters.js";
import { killProcess } from "../../../utils/process.js";
import { getSecretEnvVars } from "../../../utils/secret-registry.js";
import { type BashToolConfig, BashToolConfigSchema } from "./config.js";

/**
 * Default environment variable allowlist (Decision #108 Rule 4).
 * Only these variables (plus user-configured env_passthrough) are forwarded
 * to child processes. Prevents leaking sensitive vars like API tokens.
 */
const ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "NODE_ENV",
  "LANG",
  "TERM",
  "GIT_AUTHOR_NAME",
  "GIT_COMMITTER_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_EMAIL",
  "GIT_SSH_COMMAND",
  "GIT_TERMINAL_PROMPT",
];

/**
 * BashToolPlugin — the Engineer's hands.
 *
 * Executes shell commands via `spawn("bash", ["-c", cmd])` in task workspaces.
 * Follows all process safety rules from Decision #108:
 * - Rule 1: Explicit shell selection (bash -c)
 * - Rule 2: Signal forwarding (SIGTERM → SIGKILL grace)
 * - Rule 3: Workspace confinement (cwd)
 * - Rule 4: Environment sanitization (allowlist)
 * - Rule 5: Output size limits + command timeout
 */
export class BashToolPlugin extends ToolAdapter {
  private config!: BashToolConfig;
  private activeProcesses = new Set<ChildProcess>();

  describe(): ToolDescription {
    return {
      name: "bash",
      description: "Execute shell commands in the task workspace",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The bash command to execute" },
        },
        required: ["command"],
      },
      action_classes: ["read", "write", "test", "git-local"],
    };
  }

  protected doExecute(
    _action: string,
    params: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const command = params["command"];
    if (typeof command !== "string" || command.length === 0) {
      return Promise.resolve({
        success: false,
        output: "",
        side_effects: [],
        error: createAdapterError("invalid_params", "params.command must be a non-empty string"),
      });
    }

    // Command validation: block dangerous patterns
    const blockReason = validateCommand(command, this.config.blocked_patterns);
    if (blockReason) {
      return Promise.resolve({
        success: false,
        output: "",
        side_effects: [{ type: SideEffectTypes.command_run, details: { command, blocked: true } }],
        error: createAdapterError("command_blocked", blockReason),
      });
    }

    // Workspace path validation: resolve symlinks to prevent escape
    let resolvedCwd: string;
    try {
      resolvedCwd = realpathSync(context.workspace_path);
    } catch {
      return Promise.resolve({
        success: false,
        output: "",
        side_effects: [],
        error: createAdapterError("workspace_invalid", "Workspace path could not be resolved"),
      });
    }

    const env = this.buildSanitizedEnv();
    return this.spawnAndCollect(command, resolvedCwd, env);
  }

  protected doInitialize(config: Record<string, unknown>): Promise<InitResult> {
    const parsed = BashToolConfigSchema.safeParse(config);
    if (!parsed.success) {
      return Promise.resolve({
        success: false,
        message: `Invalid config: ${parsed.error.message}`,
      });
    }
    this.config = parsed.data;

    // Validate env_passthrough doesn't include known secret env vars
    const secretSet = getSecretEnvVars();
    const leaked = this.config.env_passthrough.filter((v) => secretSet.has(v));
    if (leaked.length > 0) {
      this.config = {
        ...this.config,
        env_passthrough: this.config.env_passthrough.filter((v) => !secretSet.has(v)),
      };
      return Promise.resolve({
        success: true,
        message: `env_passthrough contained secret vars (${leaked.join(", ")}), removed for safety`,
      });
    }

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
      const child = spawn("bash", ["-c", "echo ok"], { timeout: 5000 });
      child.on("close", (code) => {
        resolve({
          healthy: code === 0,
          message: code === 0 ? "bash available" : "bash not available",
          details: null,
        });
      });
      child.on("error", () => {
        resolve({ healthy: false, message: "bash not found", details: null });
      });
    });
  }

  // ── Private Helpers ──────────────────────────────────────────────────

  private spawnAndCollect(
    command: string,
    cwd: string,
    env: Record<string, string>,
  ): Promise<ToolResult> {
    return new Promise<ToolResult>((resolve) => {
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      let outputExceeded = false;
      let timedOut = false;

      const child = spawn("bash", ["-c", command], {
        cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });

      this.activeProcesses.add(child);

      const timeout = setTimeout(() => {
        timedOut = true;
        killProcess(child);
      }, this.config.command_timeout_ms);

      const onData = (chunk: Buffer): void => {
        totalBytes += chunk.length;
        if (totalBytes > this.config.max_output_bytes) {
          if (!outputExceeded) {
            outputExceeded = true;
            killProcess(child);
          }
          return;
        }
        chunks.push(chunk);
      };

      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);

      child.on("close", (code) => {
        clearTimeout(timeout);
        this.activeProcesses.delete(child);
        resolve(
          buildResult(
            command,
            Buffer.concat(chunks).toString("utf-8"),
            code,
            timedOut,
            outputExceeded,
            this.config,
          ),
        );
      });

      child.on("error", (err) => {
        clearTimeout(timeout);
        this.activeProcesses.delete(child);
        resolve({
          success: false,
          output: "",
          side_effects: [],
          error: createAdapterError("spawn_error", err.message),
        });
      });

      child.stdin?.end();
    });
  }

  private buildSanitizedEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    const allowed = new Set([...ENV_ALLOWLIST, ...this.config.env_passthrough]);
    for (const key of allowed) {
      const value = process.env[key];
      if (value !== undefined) {
        env[key] = value;
      }
    }
    return env;
  }
}

// ── Module-level helpers (keep class methods thin for Biome complexity) ───

/**
 * Validate a command against blocked patterns.
 * Returns null if the command is safe, or a rejection reason if blocked.
 */
export function validateCommand(command: string, blockedPatterns: string[]): string | null {
  for (const pattern of blockedPatterns) {
    const regex = new RegExp(pattern, "i");
    if (regex.test(command)) {
      return `Command blocked: matches pattern "${pattern}"`;
    }
  }
  return null;
}

function buildResult(
  command: string,
  output: string,
  code: number | null,
  timedOut: boolean,
  outputExceeded: boolean,
  config: BashToolConfig,
): ToolResult {
  if (timedOut) {
    return {
      success: false,
      output,
      side_effects: [{ type: SideEffectTypes.command_run, details: { command, timed_out: true } }],
      error: createAdapterError(
        "timeout",
        `Command timed out after ${String(config.command_timeout_ms)}ms`,
        { retryable: true },
      ),
    };
  }

  if (outputExceeded) {
    return {
      success: false,
      output,
      side_effects: [
        { type: SideEffectTypes.command_run, details: { command, output_exceeded: true } },
      ],
      error: createAdapterError(
        "output_limit",
        `Output exceeded ${String(config.max_output_bytes)} bytes`,
      ),
    };
  }

  const sideEffects: SideEffect[] = [
    { type: SideEffectTypes.command_run, details: { command, exit_code: code ?? -1 } },
  ];

  return {
    success: code === 0,
    output,
    side_effects: sideEffects,
    error:
      code !== 0
        ? createAdapterError("command_failed", `Command exited with code ${String(code)}`, {
            retryable: false,
          })
        : null,
  };
}
