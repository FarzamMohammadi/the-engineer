import type { InferenceRequest, InferenceResult, LLMCapabilities } from "../schemas/adapters.js";
import { BaseAdapter } from "./base.js";
import { AdapterMethodError, createAdapterError } from "./errors.js";

/**
 * Abstract base for LLM adapters.
 *
 * LLM adapters are inference-only (D143). The Engineer IS the agent —
 * LLMs receive a prompt and return text. Plugin-specific details (CLI flags,
 * output parsing, process management) belong in each plugin implementation.
 */
export abstract class LLMAdapter extends BaseAdapter {
  /**
   * Send an inference request to the LLM CLI tool.
   *
   * Wraps `doInfer()` with error handling.
   * Every `InferenceResult` MUST include cost data — this is the bridge
   * to the Safety Layer's cost tracking system.
   */
  async infer(request: InferenceRequest): Promise<InferenceResult> {
    try {
      return await this.doInfer(request);
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

  /** Plugin authors implement the actual CLI invocation. */
  protected abstract doInfer(request: InferenceRequest): Promise<InferenceResult>;

  /**
   * Return this provider's capabilities.
   * Synchronous, pure — no wrapping needed. Plugin authors implement directly.
   */
  abstract getCapabilities(): LLMCapabilities;
}
