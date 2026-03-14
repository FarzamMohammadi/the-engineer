import { describe, expect, it } from "vitest";

import type {
  CompletionRequest,
  CompletionResult,
  HealthStatus,
  InitResult,
  LLMCapabilities,
  PluginManifest,
} from "../schemas/adapters.js";
import { BaseAdapter } from "./base.js";
import { AdapterMethodError, createAdapterError } from "./errors.js";
import { LLMAdapter } from "./llm.js";

class TestLLMAdapter extends LLMAdapter {
  completionResult: CompletionResult = {
    content: "Hello from LLM",
    tool_calls: null,
    finish_reason: "stop",
    usage: {
      tokens_in: 100,
      tokens_out: 50,
      spend_usd: 0.01,
      remaining: null,
      resets_at: null,
    },
  };
  completeError: Error | null = null;
  capabilities: LLMCapabilities = {
    max_context: 200_000,
    supports_tools: true,
    supports_vision: true,
    model_id: "test-model",
  };

  protected doComplete(_request: CompletionRequest): Promise<CompletionResult> {
    if (this.completeError) {
      return Promise.reject(this.completeError);
    }
    return Promise.resolve(this.completionResult);
  }

  getCapabilities(): LLMCapabilities {
    return this.capabilities;
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
    id: "test-llm",
    type: "llm",
    version: "1.0.0",
    name: "Test LLM",
    description: "A test LLM",
    config_schema: {},
    critical: true,
    enabled: true,
    entry: "index.ts",
    adapter_meta: { provider_type: "api" },
    contributes: { events: [], commands: [], config_keys: [], hooks: [] },
  };
}

const testRequest: CompletionRequest = {
  prompt: "Hello, world",
  system_prompt: null,
  options: {
    max_tokens: null,
    temperature: null,
    stop: null,
    tools: null,
  },
};

describe("LLMAdapter", () => {
  it("extends BaseAdapter", () => {
    const adapter = new TestLLMAdapter();
    expect(adapter).toBeInstanceOf(BaseAdapter);
    expect(adapter).toBeInstanceOf(LLMAdapter);
  });

  describe("complete (template-wrapped)", () => {
    it("returns CompletionResult from doComplete on success", async () => {
      const adapter = new TestLLMAdapter();
      adapter.manifest = createManifest();
      const result = await adapter.complete(testRequest);
      expect(result.content).toBe("Hello from LLM");
      expect(result.usage.tokens_in).toBe(100);
    });

    it("rethrows AdapterMethodError as-is", async () => {
      const adapter = new TestLLMAdapter();
      adapter.manifest = createManifest();
      adapter.completeError = new AdapterMethodError(
        createAdapterError("context_exceeded", "Prompt too long"),
      );

      try {
        await adapter.complete(testRequest);
        expect.unreachable("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(AdapterMethodError);
        if (error instanceof AdapterMethodError) {
          expect(error.adapterError.code).toBe("context_exceeded");
        }
      }
    });

    it("wraps unknown errors as internal_error", async () => {
      const adapter = new TestLLMAdapter();
      adapter.manifest = createManifest();
      adapter.completeError = new Error("API timeout");

      try {
        await adapter.complete(testRequest);
        expect.unreachable("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(AdapterMethodError);
        if (error instanceof AdapterMethodError) {
          expect(error.adapterError.code).toBe("internal_error");
          expect(error.adapterError.severity).toBe("fatal");
        }
      }
    });
  });

  describe("getCapabilities (sync, no wrapping)", () => {
    it("returns capabilities directly", () => {
      const adapter = new TestLLMAdapter();
      adapter.manifest = createManifest();
      const caps = adapter.getCapabilities();
      expect(caps.max_context).toBe(200_000);
      expect(caps.supports_tools).toBe(true);
      expect(caps.model_id).toBe("test-model");
    });
  });
});
