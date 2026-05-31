import { describe, expect, it } from "vitest";

import { gatherNext } from "../../../../../../src/core/orchestrator/pipeline/requirements/gather.js";

describe("gather", () => {
  describe("gatherNext", () => {
    it("advances when requirements are understood", () => {
      expect(gatherNext({ outcome: "ok", summary: "understood" })).toEqual({ go: "advance" });
    });

    it("blocks for a human when a person must answer", () => {
      expect(gatherNext({ outcome: "needs_human", summary: "which auth provider?" })).toMatchObject({
        go: "block",
        category: "awaiting_human",
      });
    });
  });
});
