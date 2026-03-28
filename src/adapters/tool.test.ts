import { describe, expect, it } from "vitest";

import type {
  HealthStatus,
  InitResult,
  PluginManifest,
  ToolDescription,
  ToolExecutionContext,
  ToolResult,
} from "../schemas/adapters.js";
import { BaseAdapter } from "./base.js";
import { AdapterMethodError, createAdapterError } from "./errors.js";
import { ToolAdapter } from "./tool.js";

class TestToolAdapter extends ToolAdapter {
  lastAction: string | null = null;
  lastParams: Record<string, unknown> | null = null;
  lastContext: ToolExecutionContext | null = null;
  executeResult: ToolResult = {
    success: true,
    output: "command output",
    side_effects: [],
    error: null,
  };
  executeError: Error | null = null;

  describe(): ToolDescription {
    return {
      name: "test-tool",
      description: "A test tool",
      parameters: {},
      action_classes: ["read", "write"],
    };
  }

  protected doExecute(
    action: string,
    params: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    if (this.executeError) {
      return Promise.reject(this.executeError);
    }
    this.lastAction = action;
    this.lastParams = params;
    this.lastContext = context;
    return Promise.resolve(this.executeResult);
  }

  protected doInitialize(_config: Record<string, unknown>): Promise<InitResult> {
    return Promise.resolve({ success: true, message: null });
  }

  protected doShutdown(): Promise<void> {
    // No-op for test double
    return Promise.resolve();
  }

  protected doHealthCheck(): Promise<HealthStatus> {
    return Promise.resolve({ healthy: true, message: null, details: null });
  }
}

function createManifest(): PluginManifest {
  return {
    id: "test-tool",
    type: "tool",
    version: "1.0.0",
    name: "Test Tool",
    description: "A test tool",
    config_schema: {},
    critical: false,
    entry: "index.ts",
    adapter_meta: { action_classes: ["read", "write"] },
    requirements: [],
    combined_with: [],
    contributes: { events: [], commands: [], config_keys: [], hooks: [] },
  };
}

const testContext: ToolExecutionContext = {
  workspace_path: "/tmp/engineer/worktrees/task-abc",
  task_id: "task-abc",
};

describe("ToolAdapter", () => {
  it("extends BaseAdapter", () => {
    const adapter = new TestToolAdapter();
    expect(adapter).toBeInstanceOf(BaseAdapter);
    expect(adapter).toBeInstanceOf(ToolAdapter);
  });

  describe("describe (sync, no wrapping)", () => {
    it("returns ToolDescription directly", () => {
      const adapter = new TestToolAdapter();
      adapter.manifest = createManifest();
      const desc = adapter.describe();
      expect(desc.name).toBe("test-tool");
      expect(desc.action_classes).toEqual(["read", "write"]);
    });
  });

  describe("execute (template-wrapped)", () => {
    it("delegates to doExecute with action, params, and context", async () => {
      const adapter = new TestToolAdapter();
      adapter.manifest = createManifest();
      const params = { command: "npm test" };
      const result = await adapter.execute("run_command", params, testContext);
      expect(result.success).toBe(true);
      expect(adapter.lastAction).toBe("run_command");
      expect(adapter.lastParams).toBe(params);
      expect(adapter.lastContext).toBe(testContext);
    });

    it("passes workspace_path and task_id through context", async () => {
      const adapter = new TestToolAdapter();
      adapter.manifest = createManifest();
      await adapter.execute("read_file", { path: "src/index.ts" }, testContext);
      expect(adapter.lastContext?.workspace_path).toBe("/tmp/engineer/worktrees/task-abc");
      expect(adapter.lastContext?.task_id).toBe("task-abc");
    });

    it("wraps unknown errors as internal_error", async () => {
      const adapter = new TestToolAdapter();
      adapter.manifest = createManifest();
      adapter.executeError = new Error("Permission denied");

      try {
        await adapter.execute("write_file", {}, testContext);
        expect.unreachable("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(AdapterMethodError);
        if (error instanceof AdapterMethodError) {
          expect(error.adapterError.code).toBe("internal_error");
          expect(error.adapterError.message).toBe("Permission denied");
        }
      }
    });

    it("rethrows AdapterMethodError as-is", async () => {
      const adapter = new TestToolAdapter();
      adapter.manifest = createManifest();
      adapter.executeError = new AdapterMethodError(
        createAdapterError("timeout", "Command timed out", { retryable: true }),
      );

      try {
        await adapter.execute("run_command", {}, testContext);
        expect.unreachable("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(AdapterMethodError);
        if (error instanceof AdapterMethodError) {
          expect(error.adapterError.code).toBe("timeout");
          expect(error.adapterError.retryable).toBe(true);
        }
      }
    });
  });
});
