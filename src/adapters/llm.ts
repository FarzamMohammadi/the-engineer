import type { CompletionRequest, CompletionResult, LLMCapabilities } from "../schemas/adapters.js";
import { BaseAdapter } from "./base.js";
import { AdapterMethodError, createAdapterError } from "./errors.js";

/**
 * Abstract base for LLM adapters.
 *
 * LLM adapters are the Engineer's thinking engine. They execute reasoning,
 * code generation, analysis, and all LLM-powered operations. The Orchestrator
 * interacts with LLM adapters exclusively through this contract.
 */
export abstract class LLMAdapter extends BaseAdapter {
  /**
   * Send a completion request to the LLM provider.
   *
   * Wraps `doComplete()` with error handling.
   * Every `CompletionResult` MUST include usage data — this is the bridge
   * to the Safety Layer's cost tracking system.
   */
  async complete(request: CompletionRequest): Promise<CompletionResult> {
    try {
      return await this.doComplete(request);
    } catch (error) {
      if (error instanceof AdapterMethodError) {
        throw error;
      }
      throw new AdapterMethodError(
        createAdapterError(
          "internal_error",
          error instanceof Error ? error.message : String(error),
          {
            severity: "fatal",
          },
        ),
      );
    }
  }

  /** Plugin authors implement the actual LLM call. */
  protected abstract doComplete(request: CompletionRequest): Promise<CompletionResult>;

  /**
   * Return this provider's capabilities.
   * Synchronous, pure — no wrapping needed. Plugin authors implement directly.
   */
  abstract getCapabilities(): LLMCapabilities;
}
