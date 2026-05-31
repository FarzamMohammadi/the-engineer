import { describe, expect, it } from "vitest";

import { RefineDetailsSchema, refineNext } from "../../../../../../src/core/orchestrator/pipeline/review/refine.js";
import type { RoutableResult } from "../../../../../../src/core/orchestrator/pipeline/types.js";

/** An `ok` result carrying refine's verdict in `data`, as agentStep delivers it after validation. */
function withVerdict(verdict: string): RoutableResult {
  return { outcome: "ok", summary: `refine: ${verdict}`, data: { verdict } };
}

describe("refine", () => {
  describe("refineNext", () => {
    it("advances to delivery on a ship verdict", () => {
      expect(refineNext(withVerdict("ship"))).toEqual({ go: "advance" });
    });

    it("repeats the review to re-check in-place fixes on a revise verdict", () => {
      expect(refineNext(withVerdict("revise"))).toEqual({ go: "repeat", carry: { summary: "refine: revise" } });
    });

    it("jumps to execution when the code needs a fresh re-implementation", () => {
      expect(refineNext(withVerdict("rework_execution"))).toMatchObject({ go: "jump", to: "execution" });
    });

    it("jumps to planning when the approach itself is wrong", () => {
      expect(refineNext(withVerdict("rework_planning"))).toMatchObject({ go: "jump", to: "planning" });
    });

    it("jumps to requirements when the requirements are unclear", () => {
      expect(refineNext(withVerdict("rework_requirements"))).toMatchObject({ go: "jump", to: "requirements" });
    });

    it("carries refine's summary into the phase it hands back to", () => {
      expect(refineNext(withVerdict("rework_planning"))).toMatchObject({
        carry: { summary: "refine: rework_planning" },
      });
    });

    it("blocks for a human when refine cannot decide", () => {
      expect(refineNext({ outcome: "needs_human", summary: "?" })).toMatchObject({
        go: "block",
        category: "awaiting_human",
      });
    });

    it("blocks loudly when no recognized verdict is reported", () => {
      expect(refineNext({ outcome: "ok", summary: "no verdict", data: {} })).toMatchObject({
        go: "block",
        category: "orchestrator_error",
      });
    });
  });

  describe("RefineDetailsSchema", () => {
    it("accepts a known verdict", () => {
      expect(RefineDetailsSchema.safeParse({ verdict: "ship" }).success).toBe(true);
    });

    it("rejects an unknown verdict", () => {
      expect(RefineDetailsSchema.safeParse({ verdict: "merge_now" }).success).toBe(false);
    });
  });
});
