import {
  AdapterErrorSeverities,
  type AgentCapabilities,
  type AgentRunRequest,
  type AgentRunResult,
  type QuotaStatus,
} from "../schemas/adapters.js";
import { BaseAdapter } from "./base.js";
import { AdapterMethodError, createAdapterError } from "./errors.js";

/**
 * Abstract base for Agent adapters.
 *
 * Agent adapters wrap autonomous coding CLIs (Claude Code, OpenCode, Gemini CLI,
 * Codex, Aider). The Engineer drives the agent through prompts; the agent reads
 * and writes files in the workspace, decides what tools to call, and returns
 * structured results. Plugin-specific details (CLI flags, output parsing, process
 * management) belong in each plugin implementation.
 *
 * ## Three-Layer Usage Contract
 *
 * Each plugin implements what it can. Core degrades gracefully when data is missing.
 *
 * 1. **Per-call usage** — `AgentRunResult.usage` (tokens, cache, model).
 *    Fill from CLI output. Return null if CLI doesn't report it.
 *
 * 2. **Quota status** — `getQuotaStatus()` (session/plan windows, rate limits).
 *    Override if your CLI exposes quota/rate limit info. Default returns null.
 *
 * 3. **Limit detection** — `QuotaStatus.is_rate_limited` flag.
 *    When true, The Engineer pauses and waits for `earliest_reset_at`.
 */
export abstract class AgentAdapter extends BaseAdapter {
  /**
   * Run the agent CLI against a prompt and workspace.
   *
   * Wraps `doRun()` with error handling.
   * Every `AgentRunResult` MUST include cost data — this is the bridge
   * to the Safety Layer's cost tracking system. Include `usage` when available.
   */
  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    try {
      return await this.doRun(request);
    } catch (error) {
      if (error instanceof AdapterMethodError) {
        throw error;
      }
      throw new AdapterMethodError(
        createAdapterError("internal_error", error instanceof Error ? error.message : String(error), {
          severity: AdapterErrorSeverities.fatal,
        }),
        { cause: error },
      );
    }
  }

  /** Plugin authors implement the actual CLI invocation. */
  protected abstract doRun(request: AgentRunRequest): Promise<AgentRunResult>;

  /**
   * Return this provider's capabilities.
   * Synchronous, pure — no wrapping needed. Plugin authors implement directly.
   */
  abstract getCapabilities(): AgentCapabilities;

  /**
   * Query the provider's current quota/rate limit status.
   *
   * Returns null if the provider doesn't support quota reporting.
   * Override in plugins that can report session/plan quota (e.g. Claude's
   * 5-hour and 7-day windows). Default implementation returns null.
   *
   * Core calls this periodically and after each agent run to detect
   * rate limiting and surface quota status on the dashboard.
   */
  getQuotaStatus(): Promise<QuotaStatus | null> {
    return Promise.resolve(null);
  }
}
