import { beforeEach, describe, expect, it } from "vitest";
import type { ToolAdapter } from "../../../src/adapters/tool.js";
import {
  type PluginManifest,
  ToolDescriptionSchema,
  type ToolExecutionContext,
  ToolResultSchema,
} from "../../../src/schemas/adapters.js";

export interface ToolContractFixtures {
  validConfig: Record<string, unknown>;
  invalidConfig: Record<string, unknown>;
  manifest: PluginManifest;
  action: string;
  params: Record<string, unknown>;
  context: ToolExecutionContext;
}

/**
 * Contract compliance suite for ToolAdapter implementations.
 *
 * Tests behavioral expectations: lifecycle, describe() shape, execute() returns
 * ToolResult with side_effects array.
 */
export function runToolContractSuite(
  factory: () => ToolAdapter,
  fixtures: ToolContractFixtures,
): void {
  describe("Tool Adapter Contract", () => {
    let adapter: ToolAdapter;

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

    // ── describe() ───────────────────────────────────────────────────────

    describe("describe()", () => {
      it("returns a valid ToolDescription", () => {
        const desc = adapter.describe();
        const parsed = ToolDescriptionSchema.safeParse(desc);
        expect(parsed.success).toBe(true);
      });

      it("has required description fields", () => {
        const desc = adapter.describe();
        expect(desc).toHaveProperty("name");
        expect(desc).toHaveProperty("description");
        expect(desc).toHaveProperty("parameters");
        expect(desc).toHaveProperty("action_classes");
        expect(typeof desc.name).toBe("string");
        expect(Array.isArray(desc.action_classes)).toBe(true);
      });
    });

    // ── execute() ────────────────────────────────────────────────────────

    describe("execute()", () => {
      it("returns a valid ToolResult", async () => {
        await adapter.initialize(fixtures.validConfig);
        const result = await adapter.execute(fixtures.action, fixtures.params, fixtures.context);
        const parsed = ToolResultSchema.safeParse(result);
        expect(parsed.success).toBe(true);
      });

      it("result has side_effects array", async () => {
        await adapter.initialize(fixtures.validConfig);
        const result = await adapter.execute(fixtures.action, fixtures.params, fixtures.context);
        expect(Array.isArray(result.side_effects)).toBe(true);
      });

      it("result has required fields", async () => {
        await adapter.initialize(fixtures.validConfig);
        const result = await adapter.execute(fixtures.action, fixtures.params, fixtures.context);
        expect(result).toHaveProperty("success");
        expect(result).toHaveProperty("output");
        expect(result).toHaveProperty("side_effects");
        expect(result).toHaveProperty("error");
        expect(typeof result.success).toBe("boolean");
        expect(typeof result.output).toBe("string");
      });
    });
  });
}
