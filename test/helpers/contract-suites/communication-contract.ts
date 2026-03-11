import { beforeEach, describe, expect, it } from "vitest";
import type { CommunicationAdapter } from "../../../src/adapters/communication.js";
import {
  type FormattedMessage,
  type PluginManifest,
  SendResultSchema,
  type Target,
} from "../../../src/schemas/adapters.js";

export interface CommunicationContractFixtures {
  validConfig: Record<string, unknown>;
  invalidConfig: Record<string, unknown>;
  manifest: PluginManifest;
  target: Target;
  message: FormattedMessage;
}

/**
 * Contract compliance suite for CommunicationAdapter implementations.
 *
 * Tests behavioral expectations: lifecycle, sendMessage shape, formatMessage for all types.
 */
export function runCommunicationContractSuite(
  factory: () => CommunicationAdapter,
  fixtures: CommunicationContractFixtures,
): void {
  describe("Communication Adapter Contract", () => {
    let adapter: CommunicationAdapter;

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

    // ── sendMessage() ────────────────────────────────────────────────────

    describe("sendMessage()", () => {
      it("returns a valid SendResult", async () => {
        await adapter.initialize(fixtures.validConfig);
        const result = await adapter.sendMessage(fixtures.target, fixtures.message);
        const parsed = SendResultSchema.safeParse(result);
        expect(parsed.success).toBe(true);
      });

      it("SendResult has required fields", async () => {
        await adapter.initialize(fixtures.validConfig);
        const result = await adapter.sendMessage(fixtures.target, fixtures.message);
        expect(result).toHaveProperty("success");
        expect(result).toHaveProperty("message_id");
        expect(result).toHaveProperty("error");
        expect(typeof result.success).toBe("boolean");
      });
    });

    // ── formatMessage() ──────────────────────────────────────────────────

    describe("formatMessage()", () => {
      const messageTypes = [
        "notification",
        "question",
        "status_response",
        "milestone",
        "alert",
      ] as const;

      for (const type of messageTypes) {
        it(`returns a string for type "${type}"`, () => {
          const result = adapter.formatMessage("Test content", type);
          expect(typeof result).toBe("string");
          expect(result.length).toBeGreaterThan(0);
        });
      }
    });
  });
}
