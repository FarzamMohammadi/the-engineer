# Tool Adapter

Tool adapters are the Engineer's hands -- they execute actions in task workspaces. The design follows PI-Inspired Minimalism: few broad tools rather than many narrow ones. Bash is the meta-tool (it can do anything a shell can do), so new Tool plugins are only needed for fundamentally different execution models.

The contract is intentionally minimal: `describe()` for capability discovery and `execute()` for action execution. Everything else (workspace confinement, environment sanitization, signal handling, output limits) is the plugin's responsibility to enforce within `doExecute()`.

## Contract

The abstract class `ToolAdapter` extends `BaseAdapter`. Plugin authors implement `describe()` directly (sync, pure) and `doExecute()` (async, wrapped with error handling).

| Public Method | Signature | Returns |
|---|---|---|
| `describe` | `() => ToolDescription` | Tool name, description, JSON Schema parameters, action classes |
| `execute` | `(action: string, params: Record<string, unknown>, context: ToolExecutionContext) => Promise<ToolResult>` | `{ success, output, side_effects, error }` |

The `execute` method wraps `doExecute()` -- unknown errors become `AdapterMethodError` with `internal_error` code. `AdapterMethodError` instances pass through unchanged.

### Lifecycle (inherited from BaseAdapter)

| Method | Signature | Notes |
|---|---|---|
| `initialize` | `(config: Record<string, unknown>) => Promise<InitResult>` | Validate config. Never throws -- returns `{ success: false }` on failure. |
| `shutdown` | `() => Promise<void>` | Kill active processes, release resources. Errors are swallowed. |
| `healthCheck` | `() => Promise<HealthStatus>` | Verify the tool binary is available. Timeout handled by Registry. |

## Key Types

All types are Zod schemas exported from `src/schemas/adapters.ts`.

```typescript
// Workspace confinement context -- passed to every execute() call
type ToolExecutionContext = {
  workspace_path: string;  // Resolved worktree path (symlinks resolved)
  task_id: string;         // Owning task ID
};

// Tool capability description (returned by describe())
type ToolDescription = {
  name: string;                    // e.g. "bash"
  description: string;
  parameters: Record<string, unknown>;  // JSON Schema for params
  action_classes: string[];        // e.g. ["read", "write", "test", "git-local"]
};

// Execution result
type ToolResult = {
  success: boolean;
  output: string;                  // stdout + stderr combined
  side_effects: SideEffect[];     // Audit trail of what happened
  error: AdapterError | null;     // Structured error on failure
};

// Side effect tracking
type SideEffect = {
  type: "file_written" | "file_deleted" | "command_run" | "network_request" | "process_spawned";
  details: Record<string, unknown>;
};
```

## Developing a New Plugin

### Directory structure

```
src/plugins/tool/
  your-tool/
    your-tool.ts    # Plugin class
    config.ts       # Zod config schema
```

### Class skeleton

```typescript
import {
  ToolAdapter,
  type ToolDescription,
  type ToolExecutionContext,
  type ToolResult,
  type HealthStatus,
  type InitResult,
  createAdapterError,
} from "../../../adapters/index.js";
import { type YourToolConfig, YourToolConfigSchema } from "./config.js";

export class YourToolPlugin extends ToolAdapter {
  private config!: YourToolConfig;

  describe(): ToolDescription {
    return {
      name: "your-tool",
      description: "What this tool does",
      parameters: {
        type: "object",
        properties: {
          input: { type: "string", description: "The input to process" },
        },
        required: ["input"],
      },
      action_classes: ["read"],  // which action classes this tool serves
    };
  }

  protected async doExecute(
    _action: string,
    params: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    // 1. Validate params
    const input = params["input"];
    if (typeof input !== "string") {
      return {
        success: false,
        output: "",
        side_effects: [],
        error: createAdapterError("invalid_params", "params.input must be a string"),
      };
    }

    // 2. Execute within context.workspace_path
    //    IMPORTANT: resolve symlinks and verify the path stays inside the workspace

    // 3. Return result with side_effects for audit trail
    return {
      success: true,
      output: "result",
      side_effects: [{ type: "command_run", details: { input } }],
      error: null,
    };
  }

  protected async doInitialize(config: Record<string, unknown>): Promise<InitResult> {
    const parsed = YourToolConfigSchema.safeParse(config);
    if (!parsed.success) {
      return { success: false, message: `Invalid config: ${parsed.error.message}` };
    }
    this.config = parsed.data;
    return { success: true, message: null };
  }

  protected async doShutdown(): Promise<void> { /* kill active processes */ }
  protected async doHealthCheck(): Promise<HealthStatus> { /* verify binary exists */ }
}
```

### Key patterns to follow

These patterns are established by `BashToolPlugin` and should be followed by any Tool plugin:

**Workspace confinement.** The `context.workspace_path` is the task's worktree. Resolve symlinks with `realpathSync()` before using it as `cwd`. Never allow execution outside the workspace.

**Environment sanitization.** Use an allowlist approach -- only forward explicitly safe environment variables to child processes. The Bash plugin allows `PATH`, `HOME`, `NODE_ENV`, `LANG`, `TERM`, and git-related vars by default, plus user-configured `env_passthrough` (with secret var filtering).

**Signal forwarding.** When spawning processes, send `SIGTERM` first, then `SIGKILL` after a grace period (5 seconds in BashToolPlugin). Track active processes in a `Set<ChildProcess>` and clean them all up on `shutdown()`.

**Output limits.** Cap output size to prevent memory exhaustion (default 10MB in BashToolPlugin). Kill the process if the limit is exceeded.

**Command validation.** Block dangerous patterns via configurable regex list (case-insensitive). BashToolPlugin blocks credential exfiltration (`curl.*\benv\b`), destructive system ops (`rm -rf /`), process manipulation (`killall`), and env dumping (`printenv`).

**Side effects.** Always report what happened in the `side_effects` array. This is the audit trail.

### Config schema

```typescript
import { z } from "zod";

export const YourToolConfigSchema = z.object({
  timeout_ms: z.number().int().positive().default(60_000),
});

export type YourToolConfig = z.output<typeof YourToolConfigSchema>;
```

### Registration

Add your plugin to `src/plugins/builtin.ts`:

1. Import your class.
2. Add a manifest entry to the `manifests` array with `type: "tool"`.
3. Add a factory entry to the `factories` map.

```typescript
// In manifests array:
{
  id: "your-tool",
  type: "tool",
  version: "1.0.0",
  name: "Your Tool",
  description: "What it does",
  critical: true,
  requirements: [{ type: "binary", name: "your-binary" }],
  entry: "builtin",
  adapter_meta: { action_classes: ["read"] },
  contributes: { config_keys: ["your_tool"] },
}

// In factories map:
"your-tool": () => new YourToolPlugin(),
```

### Contract tests

Use the reusable contract suite in `test/helpers/contract-suites/tool-contract.ts`:

```typescript
import { describe } from "vitest";
import { runToolContractSuite, type ToolContractFixtures } from "../../helpers/contract-suites/tool-contract.js";
import { YourToolPlugin } from "../../../src/plugins/tool/your-tool/your-tool.js";

const fixtures: ToolContractFixtures = {
  validConfig: { timeout_ms: 5000 },
  invalidConfig: { timeout_ms: "not-a-number" },
  manifest: {
    id: "your-tool",
    type: "tool",
    version: "1.0.0",
    name: "Your Tool",
    description: "Test",
    critical: true,
    requirements: [],
    entry: "builtin",
    adapter_meta: {},
    contributes: {},
  },
  action: "run",
  params: { input: "test" },
  context: { workspace_path: "/tmp/test-workspace", task_id: "task-001" },
};

describe("YourToolPlugin", () => {
  runToolContractSuite(() => new YourToolPlugin(), fixtures);
});
```

The contract suite validates: lifecycle (init, health, shutdown), `describe()` returns valid `ToolDescription`, and `execute()` returns valid `ToolResult` with `side_effects` array.

## Built-in Plugins

| Plugin | Tool Name | Action Classes | Binary | Key Safety Features |
|---|---|---|---|---|
| `BashToolPlugin` | `bash` | `read`, `write`, `test`, `git-local` | `bash` | Env allowlist, blocked command patterns, output cap (10MB), timeout (5min), SIGTERM/SIGKILL signal forwarding, symlink-resolved workspace confinement |

The Bash plugin is the meta-tool -- it can do anything a shell command can do. It uses `spawn("bash", ["-c", cmd])` (Decision #108 Rule 1: explicit shell selection). The blocked patterns list is configurable and defaults to blocking credential exfiltration, destructive system operations, process manipulation, and environment dumping.

### BashToolPlugin config

| Key | Type | Default | Description |
|---|---|---|---|
| `max_output_bytes` | `number` | `10485760` (10MB) | Max combined stdout+stderr before kill |
| `command_timeout_ms` | `number` | `300000` (5min) | Per-command timeout |
| `env_passthrough` | `string[]` | `[]` | Extra env vars to forward (secret vars auto-filtered) |
| `blocked_patterns` | `string[]` | 15 default regexes | Case-insensitive patterns that block execution |
| `audit_commands` | `boolean` | `true` | Include full command in side_effects |

## Reference

| File | Description |
|---|---|
| `src/adapters/tool.ts` | Abstract class: `describe()` + `execute()`/`doExecute()` |
| `src/adapters/base.ts` | `BaseAdapter` -- lifecycle template methods, manifest, `hasCapability()` |
| `src/adapters/errors.ts` | `AdapterMethodError` and `createAdapterError()` |
| `src/schemas/adapters.ts` | Zod schemas: `ToolExecutionContextSchema`, `ToolDescriptionSchema`, `ToolResultSchema`, `SideEffectSchema` |
| `src/plugins/tool/bash-tool/bash-tool.ts` | Reference implementation (Bash via `spawn`) |
| `src/plugins/tool/bash-tool/config.ts` | Bash-specific config schema with blocked patterns |
| `src/plugins/builtin.ts` | Manifest definitions and factory registration |
| `test/helpers/contract-suites/tool-contract.ts` | Reusable contract compliance test suite |
