import { describe, expect, it } from "vitest";
import { responseCarry } from "../../../../src/core/orchestrator/index.js";

// responseCarry builds the rework context a requirements re-run opens with after the owner answers a
// question the task raised. The regression it guards: the answer must reach the agent's prompt AND be
// framed as authoritative scope, so a narrowing reply ("just change the heading") cannot be re-widened
// into a full rebuild by the re-run re-deriving scope from repo artifacts.

describe("responseCarry", () => {
  it("embeds the owner's answer verbatim", () => {
    const carry = responseCarry('just update the first phase to say "Hi there, welcome to our presentation!"');
    expect(carry.summary).toContain('just update the first phase to say "Hi there, welcome to our presentation!"');
  });

  it("frames the answer as authoritative, scope-overriding", () => {
    const carry = responseCarry("only fix the typo");
    expect(carry.summary.toLowerCase()).toContain("authoritative");
    expect(carry.summary.toLowerCase()).toContain("overrides");
  });
});
