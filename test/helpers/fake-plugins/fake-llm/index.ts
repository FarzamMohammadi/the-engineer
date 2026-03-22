import { LLMAdapter } from "../../../../src/adapters/llm.js";
import type {
  HealthStatus,
  InferenceRequest,
  InferenceResult,
  InitResult,
  LLMCapabilities,
} from "../../../../src/schemas/adapters.js";

/**
 * Fake LLM plugin for testing.
 *
 * Test control surface:
 * - `setCannedResponses(responses)` — configure responses returned by `infer()`
 * - `setUnhealthy(fail)` — make healthCheck return unhealthy
 * - `getCallCount()` — how many times `infer()` was called
 * - `getLastRequest()` — the most recent inference request
 * - `getInitConfig()` — what config was passed to initialize
 * - `wasShutdownCalled()` — whether shutdown was called
 */
export class FakeLLMPlugin extends LLMAdapter {
  private cannedResponses: InferenceResult[] = [];
  private callIndex = 0;
  private lastRequest: InferenceRequest | null = null;
  private shouldFailHealthCheck = false;
  private initConfig: Record<string, unknown> | null = null;
  private shutdownCalled = false;

  private static readonly DEFAULT_RESPONSE: InferenceResult = {
    content: "Fake LLM response",
    cost_usd: 0.01,
    duration_ms: 100,
  };

  // ── Test Control Surface ────────────────────────────────────────────────

  setCannedResponses(responses: InferenceResult[]): void {
    this.cannedResponses = responses;
    this.callIndex = 0;
  }

  setUnhealthy(fail: boolean): void {
    this.shouldFailHealthCheck = fail;
  }

  getCallCount(): number {
    return this.callIndex;
  }

  getLastRequest(): InferenceRequest | null {
    return this.lastRequest;
  }

  getInitConfig(): Record<string, unknown> | null {
    return this.initConfig;
  }

  wasShutdownCalled(): boolean {
    return this.shutdownCalled;
  }

  // ── Adapter Implementation ──────────────────────────────────────────────

  protected doInfer(request: InferenceRequest): Promise<InferenceResult> {
    this.lastRequest = request;
    const response = this.cannedResponses[this.callIndex] ?? FakeLLMPlugin.DEFAULT_RESPONSE;
    this.callIndex++;
    return Promise.resolve(response);
  }

  getCapabilities(): LLMCapabilities {
    return {
      model_id: "fake-model-v1",
    };
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

export function createPlugin(): LLMAdapter {
  return new FakeLLMPlugin();
}
