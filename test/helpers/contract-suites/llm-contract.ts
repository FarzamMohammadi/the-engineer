import { beforeEach, describe, expect, it } from "vitest";
import type { LLMAdapter } from "../../../src/adapters/llm.js";
import {
  type CompletionRequest,
  CompletionResultSchema,
  LLMCapabilitiesSchema,
  type PluginManifest,
} from "../../../src/schemas/adapters.js";

export interface LLMContractFixtures {
  validConfig: Record<string, unknown>;
  invalidConfig: Record<string, unknown>;
  manifest: PluginManifest;
  request: CompletionRequest;
}

/**
 * Contract compliance suite for LLMAdapter implementations.
 *
 * Tests behavioral expectations: lifecycle, usage data always present,
 * capabilities shape.
 */
export function runLLMContractSuite(
  factory: () => LLMAdapter,
  fixtures: LLMContractFixtures,
): void {
  describe("LLM Adapter Contract", () => {
    let adapter: LLMAdapter;

    beforeEach(() => {
      adapter = factory();
      adapter.manifest = fixtures.manifest;
    });

    // ── Lifecycle ────────────────────────────────────────────────────────

    describe("lifecycle", () => {
      it("initialize() with valid config returns success", async () => {
        const result = await adapter.initialize(fixtures.validConfig);
        expect(result.success).toBe(true);
      });

      it("initialize() with invalid config returns failure (does not throw)", async () => {
        const result = await adapter.initialize(fixtures.invalidConfig);
        expect(result.success).toBe(false);
        expect(result.message).not.toBeNull();
      });

      it("healthCheck() returns HealthStatus with required fields", async () => {
        await adapter.initialize(fixtures.validConfig);
        const status = await adapter.healthCheck();
        expect(status).toHaveProperty("healthy");
        expect(status).toHaveProperty("message");
        expect(status).toHaveProperty("details");
        expect(typeof status.healthy).toBe("boolean");
      });

      it("healthCheck() resolves within 5 seconds", async () => {
        await adapter.initialize(fixtures.validConfig);
        const start = Date.now();
        await adapter.healthCheck();
        const elapsed = Date.now() - start;
        expect(elapsed).toBeLessThan(5000);
      });

      it("shutdown() resolves without throwing", async () => {
        await adapter.initialize(fixtures.validConfig);
        await expect(adapter.shutdown()).resolves.toBeUndefined();
      });
    });

    // ── complete() ───────────────────────────────────────────────────────

    describe("complete()", () => {
      it("returns a valid CompletionResult", async () => {
        await adapter.initialize(fixtures.validConfig);
        const result = await adapter.complete(fixtures.request);
        const parsed = CompletionResultSchema.safeParse(result);
        expect(parsed.success).toBe(true);
      });

      it("result always includes usage data", async () => {
        await adapter.initialize(fixtures.validConfig);
        const result = await adapter.complete(fixtures.request);
        expect(result.usage).toBeDefined();
        expect(result.usage).toHaveProperty("tokens_in");
        expect(result.usage).toHaveProperty("tokens_out");
      });

      it("usage.tokens_in is a non-negative integer", async () => {
        await adapter.initialize(fixtures.validConfig);
        const result = await adapter.complete(fixtures.request);
        expect(Number.isInteger(result.usage.tokens_in)).toBe(true);
        expect(result.usage.tokens_in).toBeGreaterThanOrEqual(0);
      });

      it("usage.tokens_out is a non-negative integer", async () => {
        await adapter.initialize(fixtures.validConfig);
        const result = await adapter.complete(fixtures.request);
        expect(Number.isInteger(result.usage.tokens_out)).toBe(true);
        expect(result.usage.tokens_out).toBeGreaterThanOrEqual(0);
      });
    });

    // ── getCapabilities() ────────────────────────────────────────────────

    describe("getCapabilities()", () => {
      it("returns valid LLMCapabilities", () => {
        const caps = adapter.getCapabilities();
        const parsed = LLMCapabilitiesSchema.safeParse(caps);
        expect(parsed.success).toBe(true);
      });

      it("has required capability fields", () => {
        const caps = adapter.getCapabilities();
        expect(caps).toHaveProperty("max_context");
        expect(caps).toHaveProperty("supports_tools");
        expect(caps).toHaveProperty("supports_vision");
        expect(caps).toHaveProperty("model_id");
        expect(typeof caps.max_context).toBe("number");
        expect(typeof caps.model_id).toBe("string");
      });
    });
  });
}
