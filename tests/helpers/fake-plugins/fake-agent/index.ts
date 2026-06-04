import { AgentAdapter } from "../../../../src/adapters/agent.js";
import type {
  AgentCapabilities,
  AgentRunRequest,
  AgentRunResult,
  HealthStatus,
  InitResult,
  QuotaStatus,
} from "../../../../src/schemas/adapters.js";

/** Callback invoked after each doRun call (e.g., to write session-result.json in e2e tests). */
export type InferSideEffect = (request: AgentRunRequest, response: AgentRunResult) => void;

/**
 * Fake LLM plugin for testing.
 *
 * Test control surface:
 * - `setCannedResponses(responses)` — configure responses returned by `infer()`
 * - `setInferSideEffect(fn)` — run a callback after each `infer()` (e.g., write session-result.json)
 * - `setUnhealthy(fail)` — make healthCheck return unhealthy
 * - `getCallCount()` — how many times `infer()` was called
 * - `getLastRequest()` — the most recent inference request
 * - `getInitConfig()` — what config was passed to initialize
 * - `wasShutdownCalled()` — whether shutdown was called
 */
export class FakeAgentPlugin extends AgentAdapter {
  private cannedResponses: AgentRunResult[] = [];
  private callIndex = 0;
  private lastRequest: AgentRunRequest | null = null;
  private shouldFailHealthCheck = false;
  private initConfig: Record<string, unknown> | null = null;
  private shutdownCalled = false;
  private inferSideEffect: InferSideEffect | null = null;

  private static readonly DEFAULT_RESPONSE: AgentRunResult = {
    content: "Fake LLM response",
    cost_usd: 0.01,
    duration_ms: 100,
    usage: null,
  };

  // ── Test Control Surface ────────────────────────────────────────────────

  setCannedResponses(responses: AgentRunResult[]): void {
    this.cannedResponses = responses;
    this.callIndex = 0;
  }

  setInferSideEffect(fn: InferSideEffect | null): void {
    this.inferSideEffect = fn;
  }

  setUnhealthy(fail: boolean): void {
    this.shouldFailHealthCheck = fail;
  }

  getCallCount(): number {
    return this.callIndex;
  }

  getLastRequest(): AgentRunRequest | null {
    return this.lastRequest;
  }

  getInitConfig(): Record<string, unknown> | null {
    return this.initConfig;
  }

  wasShutdownCalled(): boolean {
    return this.shutdownCalled;
  }

  // ── Adapter Implementation ──────────────────────────────────────────────

  protected doRun(request: AgentRunRequest): Promise<AgentRunResult> {
    this.lastRequest = request;
    const response = this.cannedResponses[this.callIndex] ?? FakeAgentPlugin.DEFAULT_RESPONSE;
    this.callIndex++;
    this.inferSideEffect?.(request, response);
    return Promise.resolve(response);
  }

  private cannedQuotaStatus: QuotaStatus | null = null;

  setCannedQuotaStatus(status: QuotaStatus | null): void {
    this.cannedQuotaStatus = status;
  }

  getCapabilities(): AgentCapabilities {
    return {
      model_id: "fake-model-v1",
      supports_usage_reporting: false,
      supports_quota_reporting: false,
      supports_activity_streaming: false,
      context_window: null,
    };
  }

  override getQuotaStatus(): Promise<QuotaStatus | null> {
    return Promise.resolve(this.cannedQuotaStatus);
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
      message: this.shouldFailHealthCheck ? "Fake LLM unhealthy" : null,
      details: null,
    });
  }
}

export function createPlugin(): AgentAdapter {
  return new FakeAgentPlugin();
}
