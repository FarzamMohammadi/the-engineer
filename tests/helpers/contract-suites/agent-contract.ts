import { beforeEach, describe, expect, it } from "vitest";
import type { AgentAdapter } from "../../../src/adapters/agent.js";
import {
  AgentCapabilitiesSchema,
  type AgentRunRequest,
  AgentRunResultSchema,
  type PluginManifest,
} from "../../../src/schemas/adapters.js";
import { createTestPluginContext } from "../test-plugin-context.js";

export interface LLMContractFixtures {
  validConfig: Record<string, unknown>;
  invalidConfig: Record<string, unknown>;
  manifest: PluginManifest;
  request: AgentRunRequest;
}

/**
 * Contract compliance suite for AgentAdapter implementations.
 *
 * Tests behavioral expectations: lifecycle, usage data always present,
 * capabilities shape.
 */
export function runContractSuite(factory: () => AgentAdapter, fixtures: LLMContractFixtures): void {
  describe("Agent Adapter Contract", () => {
    let adapter: AgentAdapter;

    beforeEach(() => {
      adapter = factory();
      adapter.manifest = fixtures.manifest;
      adapter.context = createTestPluginContext(fixtures.manifest.id);
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

    // ── infer() ────────────────────────────────────────────────────────

    describe("infer()", () => {
      it("returns a valid AgentRunResult", async () => {
        await adapter.initialize(fixtures.validConfig);
        const result = await adapter.run(fixtures.request);
        const parsed = AgentRunResultSchema.safeParse(result);
        expect(parsed.success).toBe(true);
      });

      it("result always includes cost and duration", async () => {
        await adapter.initialize(fixtures.validConfig);
        const result = await adapter.run(fixtures.request);
        expect(result).toHaveProperty("cost_usd");
        expect(result).toHaveProperty("duration_ms");
      });

      it("duration_ms is a non-negative integer", async () => {
        await adapter.initialize(fixtures.validConfig);
        const result = await adapter.run(fixtures.request);
        expect(Number.isInteger(result.duration_ms)).toBe(true);
        expect(result.duration_ms).toBeGreaterThanOrEqual(0);
      });

      it("usage is null or a valid AgentRunUsage", async () => {
        await adapter.initialize(fixtures.validConfig);
        const result = await adapter.run(fixtures.request);
        if (result.usage !== null) {
          expect(result.usage).toHaveProperty("tokens");
          expect(result.usage).toHaveProperty("model_id");
          expect(result.usage.tokens).toHaveProperty("input_tokens");
          expect(result.usage.tokens).toHaveProperty("output_tokens");
          expect(result.usage.tokens).toHaveProperty("total_tokens");
        } else {
          expect(result.usage).toBeNull();
        }
      });
    });

    // ── getCapabilities() ────────────────────────────────────────────────

    describe("getCapabilities()", () => {
      it("returns valid AgentCapabilities", () => {
        const caps = adapter.getCapabilities();
        const parsed = AgentCapabilitiesSchema.safeParse(caps);
        expect(parsed.success).toBe(true);
      });

      it("has required capability fields", () => {
        const caps = adapter.getCapabilities();
        expect(caps).toHaveProperty("model_id");
        expect(typeof caps.model_id).toBe("string");
        expect(caps).toHaveProperty("supports_usage_reporting");
        expect(typeof caps.supports_usage_reporting).toBe("boolean");
        expect(caps).toHaveProperty("supports_quota_reporting");
        expect(typeof caps.supports_quota_reporting).toBe("boolean");
        expect(caps).toHaveProperty("context_window");
      });
    });

    // ── getQuotaStatus() ────────────────────────────────────────────────

    describe("getQuotaStatus()", () => {
      it("returns null or a valid QuotaStatus", async () => {
        await adapter.initialize(fixtures.validConfig);
        const status = await adapter.getQuotaStatus();
        if (status !== null) {
          expect(status).toHaveProperty("windows");
          expect(status).toHaveProperty("is_rate_limited");
          expect(Array.isArray(status.windows)).toBe(true);
          expect(typeof status.is_rate_limited).toBe("boolean");
        } else {
          expect(status).toBeNull();
        }
      });
    });
  });
}
