import { describe, expect, it } from "vitest";
import { resolveSkillsDir } from "../../../../test/helpers/test-skills-dir.js";
import { buildIntegrationPrompt } from "./integration.js";

describe("buildIntegrationPrompt", () => {
  const minimalCtx = {
    task: { title: "Test task", description: "A test" },
    repoContext: null,
    thoughtsDir: "/tmp/thoughts",
    skillsDir: resolveSkillsDir(),
    childSummaries: [],
  };

  it("should include skills section with path reference in integration prompt", () => {
    const result = buildIntegrationPrompt(minimalCtx);
    expect(result).toContain("## Skills");
    expect(result).toContain("### Skill: commit");
    expect(result).toContain("commit/SKILL.md");
    // Content must NOT be inlined
    expect(result).not.toContain("Grouping Priority");
  });

  it("should not include expert-panel-review skill in integration prompt", () => {
    const result = buildIntegrationPrompt(minimalCtx);
    expect(result).not.toContain("expert-panel-review");
  });
});
