import { LLMAdapter } from "../../../../src/adapters/llm.js";
import type {
  CompletionRequest,
  CompletionResult,
  HealthStatus,
  InitResult,
  LLMCapabilities,
} from "../../../../src/schemas/adapters.js";

/**
 * Fake LLM plugin for testing.
 *
 * Test control surface:
 * - `setCannedResponses(responses)` — configure responses returned by `complete()`
 * - `setUnhealthy(fail)` — make healthCheck return unhealthy
 * - `getCallCount()` — how many times `complete()` was called
 * - `getLastRequest()` — the most recent completion request
 * - `getInitConfig()` — what config was passed to initialize
 * - `wasShutdownCalled()` — whether shutdown was called
 */
export class FakeLLMPlugin extends LLMAdapter {
  private cannedResponses: CompletionResult[] = [];
  private callIndex = 0;
  private lastRequest: CompletionRequest | null = null;
  private shouldFailHealthCheck = false;
  private initConfig: Record<string, unknown> | null = null;
  private shutdownCalled = false;

  private static readonly DEFAULT_RESPONSE: CompletionResult = {
    content: "Fake LLM response",
    tool_calls: null,
    finish_reason: "stop",
    usage: {
      tokens_in: 100,
      tokens_out: 50,
      spend_usd: null,
      remaining: null,
      resets_at: null,
    },
  };

  // ── Test Control Surface ────────────────────────────────────────────────

  setCannedResponses(responses: CompletionResult[]): void {
    this.cannedResponses = responses;
    this.callIndex = 0;
  }

  setUnhealthy(fail: boolean): void {
    this.shouldFailHealthCheck = fail;
  }

  getCallCount(): number {
    return this.callIndex;
  }

  getLastRequest(): CompletionRequest | null {
    return this.lastRequest;
  }

  getInitConfig(): Record<string, unknown> | null {
    return this.initConfig;
  }

  wasShutdownCalled(): boolean {
    return this.shutdownCalled;
  }

  // ── Adapter Implementation ──────────────────────────────────────────────

  protected doComplete(request: CompletionRequest): Promise<CompletionResult> {
    this.lastRequest = request;
    const response = this.cannedResponses[this.callIndex] ?? FakeLLMPlugin.DEFAULT_RESPONSE;
    this.callIndex++;
    return Promise.resolve(response);
  }

  getCapabilities(): LLMCapabilities {
    return {
      max_context: 128_000,
      supports_tools: true,
      supports_vision: false,
      model_id: "fake-model-v1",
    };
  }

  protected doInitialize(config: Record<string, unknown>): Promise<InitResult> {
    this.initConfig = config;
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
