import { describe, expect, it } from "vitest";

import { implementNext } from "../../../../../../src/core/orchestrator/pipeline/execution/implement.js";

describe("implement", () => {
  describe("implementNext", () => {
    it("advances to verify when the implementation is complete", () => {
      expect(implementNext({ outcome: "ok", summary: "built" })).toEqual({ go: "advance" });
    });

    it("blocks for a human when execution gets stuck", () => {
      expect(implementNext({ outcome: "needs_human", summary: "ambiguous API" })).toMatchObject({
        go: "block",
        category: "awaiting_human",
      });
    });
  });
});
