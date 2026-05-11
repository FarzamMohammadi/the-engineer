import { ToolAdapter } from "../../../../src/adapters/tool.js";
import type {
  HealthStatus,
  InitResult,
  ToolDescription,
  ToolExecutionContext,
  ToolResult,
} from "../../../../src/schemas/adapters.js";

interface ExecutedAction {
  action: string;
  params: Record<string, unknown>;
  context: ToolExecutionContext;
}

/**
 * Fake tool plugin for testing.
 *
 * Test control surface:
 * - `setResult(action, result)` — configure what `execute()` returns for a given action
 * - `setUnhealthy(fail)` — make healthCheck return unhealthy
 * - `getExecutedActions()` — all actions executed through this plugin
 * - `getInitConfig()` — what config was passed to initialize
 * - `wasShutdownCalled()` — whether shutdown was called
 */
export class FakeToolPlugin extends ToolAdapter {
  private executedActions: ExecutedAction[] = [];
  private resultMap = new Map<string, ToolResult>();
  private shouldFailHealthCheck = false;
  private initConfig: Record<string, unknown> | null = null;
  private shutdownCalled = false;

  private static readonly DEFAULT_RESULT: ToolResult = {
    success: true,
    output: "Fake tool output",
    side_effects: [],
    error: null,
  };

  // ── Test Control Surface ────────────────────────────────────────────────

  setResult(action: string, result: ToolResult): void {
    this.resultMap.set(action, result);
  }

  setUnhealthy(fail: boolean): void {
    this.shouldFailHealthCheck = fail;
  }

  getExecutedActions(): ExecutedAction[] {
    return [...this.executedActions];
  }

  getInitConfig(): Record<string, unknown> | null {
    return this.initConfig;
  }

  wasShutdownCalled(): boolean {
    return this.shutdownCalled;
  }

  // ── Adapter Implementation ──────────────────────────────────────────────

  describe(): ToolDescription {
    return {
      name: "fake-tool",
      description: "A fake tool for testing",
      parameters: {},
      action_classes: ["read", "write"],
    };
  }

  protected doExecute(
    action: string,
    params: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    this.executedActions.push({ action, params, context });
    return Promise.resolve(this.resultMap.get(action) ?? FakeToolPlugin.DEFAULT_RESULT);
  }

  protected doInitialize(config: Record<string, unknown>): Promise<InitResult> {
    this.initConfig = config;
    if (config["_force_fail"] === true) {
      return Promise.resolve({ success: false, message: "Forced failure for testing" });
    }
    return Promise.resolve({ success: true, message: null });
  }

  protected doShutdown(): Promise<void> {
    this.shutdownCalled = true;
    return Promise.resolve();
  }

  protected doHealthCheck(): Promise<HealthStatus> {
    return Promise.resolve({
      healthy: !this.shouldFailHealthCheck,
      message: this.shouldFailHealthCheck ? "Fake tool unhealthy" : null,
      details: null,
    });
  }
}

export function createPlugin(): ToolAdapter {
  return new FakeToolPlugin();
}
