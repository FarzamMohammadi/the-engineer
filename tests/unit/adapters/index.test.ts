import { describe, expect, it } from "vitest";

import * as sdk from "../../../src/adapters/index.js";

describe("SDK boundary (src/adapters/index.ts)", () => {
  describe("exports adapter classes", () => {
    it("exports BaseAdapter", () => {
      expect(sdk.BaseAdapter).toBeDefined();
      expect(typeof sdk.BaseAdapter).toBe("function");
    });

    it("exports TriggerAdapter", () => {
      expect(sdk.TriggerAdapter).toBeDefined();
      expect(sdk.TriggerAdapter.prototype).toBeInstanceOf(sdk.BaseAdapter);
    });

    it("exports CommunicationAdapter", () => {
      expect(sdk.CommunicationAdapter).toBeDefined();
      expect(sdk.CommunicationAdapter.prototype).toBeInstanceOf(sdk.BaseAdapter);
    });

    it("exports AgentAdapter", () => {
      expect(sdk.AgentAdapter).toBeDefined();
      expect(sdk.AgentAdapter.prototype).toBeInstanceOf(sdk.BaseAdapter);
    });

    it("exports GitHostingAdapter", () => {
      expect(sdk.GitHostingAdapter).toBeDefined();
      expect(sdk.GitHostingAdapter.prototype).toBeInstanceOf(sdk.BaseAdapter);
    });
  });

  describe("exports error helpers", () => {
    it("exports createAdapterError function", () => {
      expect(typeof sdk.createAdapterError).toBe("function");
      const error = sdk.createAdapterError("test", "test message");
      expect(error.code).toBe("test");
    });

    it("exports AdapterMethodError class", () => {
      expect(typeof sdk.AdapterMethodError).toBe("function");
      const adapterError = sdk.createAdapterError("test", "msg");
      const error = new sdk.AdapterMethodError(adapterError);
      expect(error).toBeInstanceOf(Error);
    });
  });

  describe("exports adapter schemas and types", () => {
    const expectedSchemas = [
      // Universal
      "AdapterTypeSchema",
      "PluginManifestSchema",
      "InitResultSchema",
      "HealthStatusSchema",
      "AdapterErrorSchema",
      "AdapterErrorSeveritySchema",
      // Trigger
      "TriggerEventSchema",
      // Communication
      "TargetSchema",
      "FormattedMessageSchema",
      "SendResultSchema",
      "MessageTypeSchema",
      "InboundMessageSchema",
      "SyncMetadataSchema",
      "TicketOptionsSchema",
      "TicketResultSchema",
      "TicketUpdatesSchema",
      "TaskReconciliationInputSchema",
      "ReconciliationResultSchema",
      // LLM
      "AgentRunRequestSchema",
      "AgentRunResultSchema",
      "AgentCapabilitiesSchema",
      // Git Hosting
      "PROptionsSchema",
      "PRResultSchema",
      "PRUpdatesSchema",
      "MergeResultSchema",
      "MergeStrategySchema",
      "PRStatusSchema",
      "ReviewStatusSchema",
      "ReviewerStateSchema",
      "CommentResultSchema",
      "BranchProtectionSchema",
    ];

    for (const name of expectedSchemas) {
      it(`exports ${name}`, () => {
        expect((sdk as Record<string, unknown>)[name]).toBeDefined();
      });
    }
  });

  describe("does not export Core internals", () => {
    it("does not export EventBus", () => {
      expect((sdk as Record<string, unknown>)["EventBus"]).toBeUndefined();
    });

    it("does not export database utilities", () => {
      expect((sdk as Record<string, unknown>)["createDatabase"]).toBeUndefined();
    });

    it("does not export config utilities", () => {
      expect((sdk as Record<string, unknown>)["loadConfig"]).toBeUndefined();
    });
  });
});
