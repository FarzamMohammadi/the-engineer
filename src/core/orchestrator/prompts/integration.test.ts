import { describe, expect, it } from "vitest";
import { buildIntegrationPrompt } from "./integration.js";

describe("buildIntegrationPrompt", () => {
  const minimalCtx = {
    task: { title: "Test task", description: "A test" },
    repoContext: null,
    thoughtsDir: "/tmp/thoughts",
    childSummaries: [],
  };

  it("should include skills section in integration prompt", () => {
    const result = buildIntegrationPrompt(minimalCtx);
    expect(result).toContain("## Skills");
    expect(result).toContain("### Skill: commit");
    expect(result).toContain("Grouping Priority");
  });

  it("should not include expert-panel-review skill in integration prompt", () => {
    const result = buildIntegrationPrompt(minimalCtx);
    expect(result).not.toContain("Expert Panel Review");
    expect(result).not.toContain("expert-panel-review");
  });
});
