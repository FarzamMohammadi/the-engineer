import { describe, expect, it } from "vitest";

import type {
  HealthStatus,
  InitResult,
  PluginManifest,
  TriggerEvent,
} from "../schemas/adapters.js";
import { BaseAdapter } from "./base.js";
import { AdapterMethodError, createAdapterError } from "./errors.js";
import { TriggerAdapter } from "./trigger.js";

class TestTriggerAdapter extends TriggerAdapter {
  events: TriggerEvent[] = [];
  pollError: Error | null = null;

  protected doPoll(): Promise<TriggerEvent[]> {
    if (this.pollError) {
      return Promise.reject(this.pollError);
    }
    return Promise.resolve(this.events);
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
    id: "test-trigger",
    type: "trigger",
    version: "1.0.0",
    name: "Test Trigger",
    description: "A test trigger",
    config_schema: {},
    critical: true,
    entry: "index.ts",
    adapter_meta: {},
    requirements: [],
    combined_with: [],
    contributes: { events: [], commands: [], config_keys: [], hooks: [] },
  };
}

function createTriggerEvent(overrides?: Partial<TriggerEvent>): TriggerEvent {
  return {
    idempotency_key: "test:issue:repo:1",
    source: "test-trigger",
    event_type: "issue_opened",
    external_ref: { type: "test_issue", repo: "test/repo", number: 1 },
    title: "Test Issue",
    body: null,
    repo: "test/repo",
    clone_url: "https://github.com/test/repo.git",
    metadata: null,
    thoughts_id: "test-1",
    ...overrides,
  };
}

describe("TriggerAdapter", () => {
  it("extends BaseAdapter", () => {
    const adapter = new TestTriggerAdapter();
    expect(adapter).toBeInstanceOf(BaseAdapter);
    expect(adapter).toBeInstanceOf(TriggerAdapter);
  });

  describe("poll", () => {
    it("returns events from doPoll on success", async () => {
      const adapter = new TestTriggerAdapter();
      adapter.manifest = createManifest();
      const event = createTriggerEvent();
      adapter.events = [event];
      const result = await adapter.poll();
      expect(result).toEqual([event]);
    });

    it("returns empty array when no events", async () => {
      const adapter = new TestTriggerAdapter();
      adapter.manifest = createManifest();
      const result = await adapter.poll();
      expect(result).toEqual([]);
    });

    it("rethrows AdapterMethodError as-is", async () => {
      const adapter = new TestTriggerAdapter();
      adapter.manifest = createManifest();
      const structured = createAdapterError("rate_limited", "Slow down", { retryable: true });
      adapter.pollError = new AdapterMethodError(structured);

      try {
        await adapter.poll();
        expect.unreachable("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(AdapterMethodError);
        if (error instanceof AdapterMethodError) {
          expect(error.adapterError.code).toBe("rate_limited");
          expect(error.adapterError.retryable).toBe(true);
        }
      }
    });

    it("wraps unknown errors as internal_error with severity fatal", async () => {
      const adapter = new TestTriggerAdapter();
      adapter.manifest = createManifest();
      adapter.pollError = new Error("Network failure");

      try {
        await adapter.poll();
        expect.unreachable("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(AdapterMethodError);
        if (error instanceof AdapterMethodError) {
          expect(error.adapterError.code).toBe("internal_error");
          expect(error.adapterError.severity).toBe("fatal");
          expect(error.adapterError.message).toBe("Network failure");
        }
      }
    });
  });
});
