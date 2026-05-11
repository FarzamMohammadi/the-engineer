import { describe, expect, it, vi } from "vitest";

import { BaseAdapter } from "../../../src/adapters/base.js";
import type { HealthStatus, InitResult, PluginManifest } from "../../../src/schemas/adapters.js";

/** Minimal concrete subclass for testing BaseAdapter. */
class TestAdapter extends BaseAdapter {
  initResult: InitResult = { success: true, message: null };
  healthResult: HealthStatus = { healthy: true, message: null, details: null };
  shutdownError: Error | null = null;
  initError: Error | null = null;
  healthError: Error | null = null;

  protected doInitialize(_config: Record<string, unknown>): Promise<InitResult> {
    if (this.initError) {
      return Promise.reject(this.initError);
    }
    return Promise.resolve(this.initResult);
  }

  protected doShutdown(): Promise<void> {
    if (this.shutdownError) {
      return Promise.reject(this.shutdownError);
    }
    return Promise.resolve();
  }

  protected doHealthCheck(): Promise<HealthStatus> {
    if (this.healthError) {
      return Promise.reject(this.healthError);
    }
    return Promise.resolve(this.healthResult);
  }
}

function createManifest(overrides?: Partial<PluginManifest>): PluginManifest {
  return {
    id: "test-plugin",
    type: "trigger",
    version: "1.0.0",
    name: "Test Plugin",
    description: "A test plugin",
    config_schema: {},
    critical: true,
    entry: "index.ts",
    adapter_meta: {},
    requirements: [],
    combined_with: [],
    contributes: { events: [], commands: [], config_keys: [], hooks: [] },
    startup_hints: [],
    ...overrides,
  };
}

describe("BaseAdapter", () => {
  describe("manifest injection", () => {
    it("stores manifest set by Registry", () => {
      const adapter = new TestAdapter();
      const manifest = createManifest();
      adapter.manifest = manifest;
      expect(adapter.manifest).toBe(manifest);
    });
  });

  describe("hasCapability", () => {
    it("returns true when capability exists in adapter_meta.capabilities", () => {
      const adapter = new TestAdapter();
      adapter.manifest = createManifest({
        adapter_meta: { capabilities: ["send", "receive", "query"] },
      });
      expect(adapter.hasCapability("send")).toBe(true);
      expect(adapter.hasCapability("receive")).toBe(true);
    });

    it("returns false when capability is absent", () => {
      const adapter = new TestAdapter();
      adapter.manifest = createManifest({
        adapter_meta: { capabilities: ["send"] },
      });
      expect(adapter.hasCapability("receive")).toBe(false);
    });

    it("returns false when adapter_meta has no capabilities array", () => {
      const adapter = new TestAdapter();
      adapter.manifest = createManifest({ adapter_meta: {} });
      expect(adapter.hasCapability("send")).toBe(false);
    });

    it("returns false when capabilities is not an array", () => {
      const adapter = new TestAdapter();
      adapter.manifest = createManifest({
        adapter_meta: { capabilities: "send" },
      });
      expect(adapter.hasCapability("send")).toBe(false);
    });
  });

  describe("initialize", () => {
    it("returns InitResult from doInitialize on success", async () => {
      const adapter = new TestAdapter();
      adapter.manifest = createManifest();
      const result = await adapter.initialize({});
      expect(result).toEqual({ success: true, message: null });
    });

    it("catches thrown error and returns { success: false }", async () => {
      const adapter = new TestAdapter();
      adapter.manifest = createManifest();
      adapter.initError = new Error("Connection refused");
      const result = await adapter.initialize({});
      expect(result.success).toBe(false);
      expect(result.message).toBe("Connection refused");
    });

    it("calls observer.info on success", async () => {
      const obs = { info: vi.fn(), error: vi.fn() };
      const adapter = new TestAdapter();
      adapter.manifest = createManifest({ id: "my-plugin" });
      adapter.observer = obs;
      await adapter.initialize({});
      expect(obs.info).toHaveBeenCalledWith(
        expect.stringContaining("my-plugin"),
        expect.objectContaining({ pluginId: "my-plugin" }),
      );
    });

    it("calls observer.error on failure", async () => {
      const obs = { info: vi.fn(), error: vi.fn() };
      const adapter = new TestAdapter();
      adapter.manifest = createManifest({ id: "broken-plugin" });
      adapter.observer = obs;
      adapter.initError = new Error("Oops");
      await adapter.initialize({});
      expect(obs.error).toHaveBeenCalledWith(
        expect.stringContaining("broken-plugin"),
        expect.objectContaining({ pluginId: "broken-plugin", error: "Oops" }),
      );
    });

    it("does not throw when observer is not set", async () => {
      const adapter = new TestAdapter();
      adapter.manifest = createManifest({ id: "no-observer" });
      // No observer set — should silently skip logging
      const result = await adapter.initialize({});
      expect(result.success).toBe(true);
    });
  });

  describe("shutdown", () => {
    it("completes normally on success", async () => {
      const adapter = new TestAdapter();
      adapter.manifest = createManifest();
      await expect(adapter.shutdown()).resolves.toBeUndefined();
    });

    it("swallows errors and calls observer.error", async () => {
      const obs = { info: vi.fn(), error: vi.fn() };
      const adapter = new TestAdapter();
      adapter.manifest = createManifest();
      adapter.observer = obs;
      adapter.shutdownError = new Error("Shutdown failed");
      await expect(adapter.shutdown()).resolves.toBeUndefined();
      expect(obs.error).toHaveBeenCalledWith(
        expect.stringContaining("shutdown error"),
        expect.objectContaining({ error: "Shutdown failed" }),
      );
    });

    it("swallows errors silently when observer is not set", async () => {
      const adapter = new TestAdapter();
      adapter.manifest = createManifest();
      adapter.shutdownError = new Error("Shutdown failed");
      // No observer — should not throw
      await expect(adapter.shutdown()).resolves.toBeUndefined();
    });
  });

  describe("healthCheck", () => {
    it("returns HealthStatus from doHealthCheck on success", async () => {
      const adapter = new TestAdapter();
      adapter.manifest = createManifest();
      adapter.healthResult = { healthy: true, message: "All good", details: null };
      const result = await adapter.healthCheck();
      expect(result).toEqual({ healthy: true, message: "All good", details: null });
    });

    it("catches thrown error and returns { healthy: false }", async () => {
      const adapter = new TestAdapter();
      adapter.manifest = createManifest();
      adapter.healthError = new Error("API unreachable");
      const result = await adapter.healthCheck();
      expect(result.healthy).toBe(false);
      expect(result.message).toBe("API unreachable");
      expect(result.details).toBeNull();
    });
  });
});
