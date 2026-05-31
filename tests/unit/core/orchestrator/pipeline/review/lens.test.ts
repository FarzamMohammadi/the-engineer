import { describe, expect, it } from "vitest";

import { lensNext, skipWhenDisabled } from "../../../../../../src/core/orchestrator/pipeline/review/lens.js";
import { security } from "../../../../../../src/core/orchestrator/pipeline/review/security.js";
import { selfReview } from "../../../../../../src/core/orchestrator/pipeline/review/self-review.js";
import type { Ctx } from "../../../../../../src/core/orchestrator/pipeline/types.js";

/** A minimal ctx carrying only the review config a lens's skip reads. */
function ctxWithLenses(lenses: string[]): Ctx {
  return { config: { review: { lenses } } } as unknown as Ctx;
}

describe("review lens", () => {
  describe("lensNext", () => {
    it("advances after writing findings", () => {
      expect(lensNext({ outcome: "ok", summary: "3 findings" })).toEqual({ go: "advance" });
    });

    it("blocks for a human when the lens hits a question only a person can answer", () => {
      expect(lensNext({ outcome: "needs_human", summary: "is this intentional?" })).toMatchObject({
        go: "block",
        category: "awaiting_human",
      });
    });
  });

  describe("skipWhenDisabled", () => {
    it("runs a lens that is enabled in config", () => {
      expect(skipWhenDisabled("self-review", ctxWithLenses(["self-review"]))).toBeNull();
    });

    it("skips a lens that is not enabled in config", () => {
      expect(skipWhenDisabled("security", ctxWithLenses(["self-review"]))).toContain("not enabled");
    });
  });

  describe("the built lenses", () => {
    it("runs self-review by default and skips the opt-in lenses", () => {
      const ctx = ctxWithLenses(["self-review"]);
      expect(selfReview.skip?.(ctx)).toBeNull();
      expect(security.skip?.(ctx)).toContain("not enabled");
    });

    it("runs an opt-in lens once it is enabled", () => {
      expect(security.skip?.(ctxWithLenses(["self-review", "security"]))).toBeNull();
    });
  });
});
