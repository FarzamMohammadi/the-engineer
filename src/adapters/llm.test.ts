import { describe, expect, it } from "vitest";

import type {
  HealthStatus,
  InferenceRequest,
  InferenceResult,
  InitResult,
  LLMCapabilities,
  PluginManifest,
} from "../schemas/adapters.js";
import { BaseAdapter } from "./base.js";
import { AdapterMethodError, createAdapterError } from "./errors.js";
import { LLMAdapter } from "./llm.js";

class TestLLMAdapter extends LLMAdapter {
  inferResult: InferenceResult = {
    content: "Hello from LLM",
    cost_usd: 0.01,
    duration_ms: 150,
    usage: null,
  };
  inferError: Error | null = null;
  capabilities: LLMCapabilities = {
    model_id: "test-model",
    supports_usage_reporting: false,
    supports_quota_reporting: false,
    context_window: null,
  };

  protected doInfer(_request: InferenceRequest): Promise<InferenceResult> {
    if (this.inferError) {
      return Promise.reject(this.inferError);
    }
    return Promise.resolve(this.inferResult);
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
    entry: "index.ts",
    adapter_meta: { provider_type: "api" },
    requirements: [],
    combined_with: [],
    contributes: { events: [], commands: [], config_keys: [], hooks: [] },
    startup_hints: [],
  };
}

const testRequest: InferenceRequest = {
  prompt: "Hello, world",
  system_prompt: null,
  cwd: null,
};

describe("LLMAdapter", () => {
  it("extends BaseAdapter", () => {
    const adapter = new TestLLMAdapter();
    expect(adapter).toBeInstanceOf(BaseAdapter);
    expect(adapter).toBeInstanceOf(LLMAdapter);
  });

  describe("infer (template-wrapped)", () => {
    it("returns InferenceResult from doInfer on success", async () => {
      const adapter = new TestLLMAdapter();
      adapter.manifest = createManifest();
      const result = await adapter.infer(testRequest);
      expect(result.content).toBe("Hello from LLM");
      expect(result.cost_usd).toBe(0.01);
    });

    it("rethrows AdapterMethodError as-is", async () => {
      const adapter = new TestLLMAdapter();
      adapter.manifest = createManifest();
      adapter.inferError = new AdapterMethodError(
        createAdapterError("context_exceeded", "Prompt too long"),
      );

      try {
        await adapter.infer(testRequest);
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
      adapter.inferError = new Error("API timeout");

      try {
        await adapter.infer(testRequest);
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
      expect(caps.model_id).toBe("test-model");
    });
  });
});
