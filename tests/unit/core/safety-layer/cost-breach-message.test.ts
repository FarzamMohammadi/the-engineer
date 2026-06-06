import { describe, expect, it } from "vitest";

import { formatCostBreach } from "../../../../src/core/safety-layer/cost-breach-message.js";

describe("formatCostBreach", () => {
  it("renders a USD spend breach with dollar-prefixed spend and limit", () => {
    const message = formatCostBreach({
      limit_type: "monthly",
      limit_scope: null,
      current_spend: 512.5,
      limit_value: 500,
    });
    expect(message).toBe("monthly cost limit reached: $512.5 of $500");
  });

  it("renders a provider breach as a request-count cap without a dollar sign", () => {
    const message = formatCostBreach({
      limit_type: "daily",
      limit_scope: "claude-code-agent",
      current_spend: 200,
      limit_value: 200,
    });
    expect(message).toBe("claude-code-agent daily request cap reached: 200 of 200");
    expect(message).not.toContain("$");
  });
});
