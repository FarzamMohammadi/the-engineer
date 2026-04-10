import { describe, expect, it } from "vitest";
import { resolveSkillsDir } from "../../../../test/helpers/test-skills-dir.js";
import { buildExecutionPrompt } from "./execution.js";

describe("buildExecutionPrompt", () => {
  const minimalCtx = {
    task: { title: "Test task", description: "A test" },
    repoContext: null,
    repoKnowledge: [],
    userKnowledge: [],
    thoughtsDir: "/tmp/thoughts",
    skillsDir: resolveSkillsDir(),
  };

  it("should include skills section with path reference in execution prompt", () => {
    const result = buildExecutionPrompt(minimalCtx);
    expect(result).toContain("## Skills");
    expect(result).toContain("### Skill: commit");
    expect(result).toContain("commit/SKILL.md");
    // Content must NOT be inlined
    expect(result).not.toContain("Grouping Priority");
  });

  it("should not include expert-panel-review skill in execution prompt", () => {
    const result = buildExecutionPrompt(minimalCtx);
    expect(result).not.toContain("expert-panel-review");
  });
});
