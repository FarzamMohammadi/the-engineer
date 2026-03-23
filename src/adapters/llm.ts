import type {
  InferenceRequest,
  InferenceResult,
  LLMCapabilities,
  QuotaStatus,
} from "../schemas/adapters.js";
import { BaseAdapter } from "./base.js";
import { AdapterMethodError, createAdapterError } from "./errors.js";

/**
 * Abstract base for LLM adapters.
 *
 * LLM adapters are inference-only (D143). The Engineer IS the agent —
 * LLMs receive a prompt and return text. Plugin-specific details (CLI flags,
 * output parsing, process management) belong in each plugin implementation.
 *
 * ## Three-Layer Usage Contract
 *
 * Each plugin implements what it can. Core degrades gracefully when data is missing.
 *
 * 1. **Per-call usage** — `InferenceResult.usage` (tokens, cache, model).
 *    Fill from CLI output. Return null if CLI doesn't report it.
 *
 * 2. **Quota status** — `getQuotaStatus()` (session/plan windows, rate limits).
 *    Override if your CLI exposes quota/rate limit info. Default returns null.
 *
 * 3. **Limit detection** — `QuotaStatus.is_rate_limited` flag.
 *    When true, The Engineer pauses and waits for `earliest_reset_at`.
 */
export abstract class LLMAdapter extends BaseAdapter {
  /**
   * Send an inference request to the LLM CLI tool.
   *
   * Wraps `doInfer()` with error handling.
   * Every `InferenceResult` MUST include cost data — this is the bridge
   * to the Safety Layer's cost tracking system. Include `usage` when available.
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

  /** CLI arguments for continuing an existing session (e.g., ["--continue"] for Claude Code). */
  abstract getContinueArgs(): string[];

  /**
   * Query the provider's current quota/rate limit status.
   *
   * Returns null if the provider doesn't support quota reporting.
   * Override in plugins that can report session/plan quota (e.g. Claude's
   * 5-hour and 7-day windows). Default implementation returns null.
   *
   * Core calls this periodically and after each inference call to detect
   * rate limiting and surface quota status on the dashboard.
   */
  getQuotaStatus(): Promise<QuotaStatus | null> {
    return Promise.resolve(null);
  }
}
