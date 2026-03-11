import { beforeEach, describe, expect, it } from "vitest";
import type { TriggerAdapter } from "../../../src/adapters/trigger.js";
import { type PluginManifest, TriggerEventSchema } from "../../../src/schemas/adapters.js";

export interface TriggerContractFixtures {
  validConfig: Record<string, unknown>;
  invalidConfig: Record<string, unknown>;
  manifest: PluginManifest;
}

/**
 * Contract compliance suite for TriggerAdapter implementations.
 *
 * Tests behavioral expectations that TypeScript signatures cannot express:
 * idempotency key stability, lifecycle correctness, schema compliance.
 *
 * Usage: call at top level of a test file — Vitest discovers the describe blocks.
 */
export function runTriggerContractSuite(
  factory: () => TriggerAdapter,
  fixtures: TriggerContractFixtures,
): void {
  describe("Trigger Adapter Contract", () => {
    let adapter: TriggerAdapter;

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

    // ── poll() ───────────────────────────────────────────────────────────

    describe("poll()", () => {
      it("returns an array", async () => {
        await adapter.initialize(fixtures.validConfig);
        const events = await adapter.poll();
        expect(Array.isArray(events)).toBe(true);
      });

      it("each event validates against TriggerEventSchema", async () => {
        await adapter.initialize(fixtures.validConfig);
        const events = await adapter.poll();
        for (const event of events) {
          const parsed = TriggerEventSchema.safeParse(event);
          expect(parsed.success).toBe(true);
        }
      });

      it("idempotency keys are stable across polls", async () => {
        await adapter.initialize(fixtures.validConfig);
        const events1 = await adapter.poll();
        const events2 = await adapter.poll();
        if (events1.length > 0 && events2.length > 0) {
          const keys1 = events1.map((e) => e.idempotency_key).sort();
          const keys2 = events2.map((e) => e.idempotency_key).sort();
          expect(keys1).toEqual(keys2);
        }
      });
    });
  });
}
