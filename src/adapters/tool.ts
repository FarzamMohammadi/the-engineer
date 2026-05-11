import {
  AdapterErrorSeverities,
  type ToolDescription,
  type ToolExecutionContext,
  type ToolResult,
} from "../schemas/adapters.js";
import { BaseAdapter } from "./base.js";
import { AdapterMethodError, createAdapterError } from "./errors.js";

/**
 * Abstract base for tool adapters.
 *
 * Tool adapters are the Engineer's hands — how it interacts with the world
 * beyond thinking. Following PI-Inspired Minimalism: few broad tools,
 * not many narrow ones. Bash is the meta-tool.
 */
export abstract class ToolAdapter extends BaseAdapter {
  /**
   * Describe this tool's capabilities.
   * Synchronous, pure — no wrapping needed. Plugin authors implement directly.
   */
  abstract describe(): ToolDescription;

  /**
   * Execute a tool action within a task context.
   *
   * Wraps `doExecute()` with error handling. The `context` parameter provides
   * workspace path and task ID for workspace confinement (Decision #108).
   */
  async execute(action: string, params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
    try {
      return await this.doExecute(action, params, context);
    } catch (error) {
      if (error instanceof AdapterMethodError) {
        throw error;
      }
      throw new AdapterMethodError(
        createAdapterError("internal_error", error instanceof Error ? error.message : String(error), {
          severity: AdapterErrorSeverities.fatal,
        }),
      );
    }
  }

  /** Plugin authors implement the actual tool execution. */
  protected abstract doExecute(
    action: string,
    params: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult>;
}
