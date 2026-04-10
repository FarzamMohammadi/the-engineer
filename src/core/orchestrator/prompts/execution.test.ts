import { describe, expect, it } from "vitest";
import { buildExecutionPrompt } from "./execution.js";

describe("buildExecutionPrompt", () => {
  const minimalCtx = {
    task: { title: "Test task", description: "A test" },
    repoContext: null,
    repoKnowledge: [],
    userKnowledge: [],
    thoughtsDir: "/tmp/thoughts",
  };

  it("should include skills section in execution prompt", () => {
    const result = buildExecutionPrompt(minimalCtx);
    expect(result).toContain("## Skills");
    expect(result).toContain("### Skill: commit");
    expect(result).toContain("Grouping Priority");
  });

  it("should not include expert-panel-review skill in execution prompt", () => {
    const result = buildExecutionPrompt(minimalCtx);
    expect(result).not.toContain("Expert Panel Review");
    expect(result).not.toContain("expert-panel-review");
  });
});
