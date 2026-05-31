import { describe, expect, it } from "vitest";

import type { RoutableResult, Route } from "../../../../../src/core/orchestrator/pipeline/types.js";

// The routing payoff of the architecture: each sub-phase's `next` is a pure function from a
// result to a Route, testable in isolation without the runner. These two examples mirror the
// routing S3's real `verify` and `refine` sub-phases will use; testing them here proves the
// pattern and the Route/Result contract.

/** verify: clean gates advance; red gates repeat execution carrying the failures. */
function verifyNext(result: RoutableResult): Route {
  if (result.outcome === "needs_human") {
    return { go: "block", category: "awaiting_human", needed: "Resolve the ambiguity" };
  }
  const passed = (result.data as { passed?: boolean } | undefined)?.passed ?? false;
  return passed ? { go: "advance" } : { go: "repeat", carry: { summary: result.summary } };
}

/** refine: a ship verdict advances; otherwise jump to the phase that can fix the root cause. */
function refineNext(result: RoutableResult): Route {
  if (result.outcome === "needs_human") {
    return { go: "block", category: "awaiting_human", needed: "Clarify the requirement" };
  }
  const verdict = (result.data as { verdict?: string } | undefined)?.verdict ?? "ship";
  if (verdict === "rework_code") {
    return { go: "jump", to: "execution", carry: { summary: result.summary } };
  }
  if (verdict === "rework_plan") {
    return { go: "jump", to: "planning", carry: { summary: result.summary } };
  }
  return { go: "advance" };
}

describe("next functions (pure routing)", () => {
  describe("verifyNext", () => {
    it("advances when the gates pass", () => {
      expect(verifyNext({ outcome: "ok", summary: "green", data: { passed: true } })).toEqual({ go: "advance" });
    });

    it("repeats carrying the failure summary when the gates are red", () => {
      expect(verifyNext({ outcome: "ok", summary: "3 type errors", data: { passed: false } })).toEqual({
        go: "repeat",
        carry: { summary: "3 type errors" },
      });
    });

    it("blocks for a human when the step cannot decide", () => {
      expect(verifyNext({ outcome: "needs_human", summary: "ambiguous" })).toMatchObject({
        go: "block",
        category: "awaiting_human",
      });
    });
  });

  describe("refineNext", () => {
    it("advances on a ship verdict", () => {
      expect(refineNext({ outcome: "ok", summary: "good", data: { verdict: "ship" } })).toEqual({ go: "advance" });
    });

    it("jumps to execution to fix the code", () => {
      expect(refineNext({ outcome: "ok", summary: "bug", data: { verdict: "rework_code" } })).toMatchObject({
        go: "jump",
        to: "execution",
      });
    });

    it("jumps to planning when the plan is the problem", () => {
      expect(refineNext({ outcome: "ok", summary: "wrong approach", data: { verdict: "rework_plan" } })).toMatchObject({
        go: "jump",
        to: "planning",
      });
    });
  });
});
