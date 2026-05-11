import { describe, expect, it } from "vitest";
import { buildSkillsSection } from "../../../../../src/core/orchestrator/prompts/skills.js";
import { Phases } from "../../../../../src/schemas/orchestrator.js";
import { resolveSkillsDir } from "../../../../helpers/test-skills-dir.js";

const skillsDir = resolveSkillsDir();

describe("buildSkillsSection", () => {
  it("should return section with commit skill path for execution phase", () => {
    const result = buildSkillsSection(Phases.execution, skillsDir);
    expect(result).not.toBeNull();
    expect(result).toContain("## Skills");
    expect(result).toContain("### Skill: commit");
    expect(result).toContain("commit/SKILL.md");
    // Content must NOT be inlined
    expect(result).not.toContain("Grouping Priority");
  });

  it("should return section with both skill paths for self_review phase", () => {
    const result = buildSkillsSection(Phases.self_review, skillsDir);
    expect(result).not.toBeNull();
    expect(result).toContain("### Skill: commit");
    expect(result).toContain("commit/SKILL.md");
    expect(result).toContain("### Skill: expert-panel-review");
    expect(result).toContain("expert-panel-review/SKILL.md");
  });

  it("should include persona file paths in expert-panel-review skill", () => {
    const result = buildSkillsSection(Phases.self_review, skillsDir);
    expect(result).not.toBeNull();
    expect(result).toContain("personas/critical-reviewer.md");
    expect(result).toContain("personas/pragmatic-senior-engineer.md");
    expect(result).toContain("personas/technical-architect.md");
    // Persona content must NOT be inlined
    expect(result).not.toContain("Decision reversibility");
  });

  it("should return section with commit skill path for integration phase", () => {
    const result = buildSkillsSection(Phases.integration, skillsDir);
    expect(result).not.toBeNull();
    expect(result).toContain("### Skill: commit");
    expect(result).toContain("commit/SKILL.md");
    // Should not include expert-panel-review
    expect(result).not.toContain("expert-panel-review");
  });

  it("should return null for phases with no skills", () => {
    expect(buildSkillsSection(Phases.requirements_gathering, skillsDir)).toBeNull();
    expect(buildSkillsSection(Phases.research, skillsDir)).toBeNull();
    expect(buildSkillsSection(Phases.planning, skillsDir)).toBeNull();
    expect(buildSkillsSection(Phases.demo_prep, skillsDir)).toBeNull();
  });

  it("should contain absolute paths using the provided skillsDir", () => {
    const result = buildSkillsSection(Phases.execution, skillsDir);
    expect(result).not.toBeNull();
    expect(result).toContain(skillsDir);
  });

  it("should gracefully handle invalid skillsDir without crashing", () => {
    // With an invalid path, skill path blocks are still constructed (paths are strings).
    // The personas dir won't be found, but that's handled gracefully.
    const result = buildSkillsSection(Phases.execution, "/nonexistent/path/skills");
    expect(result).not.toBeNull();
    expect(result).toContain("/nonexistent/path/skills/commit/SKILL.md");
    // No persona paths since the directory doesn't exist
    expect(result).not.toContain("personas/");
  });

  it("should instruct the CLI to read skill files", () => {
    const result = buildSkillsSection(Phases.execution, skillsDir);
    expect(result).not.toBeNull();
    expect(result).toContain("You MUST read the following skill files");
  });
});
