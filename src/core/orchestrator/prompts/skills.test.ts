import { describe, expect, it, vi } from "vitest";
import { Phases } from "../../../schemas/orchestrator.js";
import { buildSkillsSection, loadSkillContent } from "./skills.js";

describe("loadSkillContent", () => {
  it("should load commit skill content", () => {
    const content = loadSkillContent("commit");
    expect(content).toBeTruthy();
    expect(content).toContain("Grouping Priority");
    expect(content).toContain("HEREDOC");
    expect(content).toContain("Levels of Detail");
  });

  it("should load expert-panel-review skill with inlined personas", () => {
    const content = loadSkillContent("expert-panel-review");
    expect(content).toBeTruthy();
    // Main SKILL.md content
    expect(content).toContain("Expert Panel Review");
    expect(content).toContain("Synthesize Convergence");
    // Persona content inlined
    expect(content).toContain("## Persona: Technical Architect");
    expect(content).toContain("## Persona: Critical Reviewer");
    expect(content).toContain("## Persona: Pragmatic Senior Engineer");
    // Verify actual persona content is present (not just headings)
    expect(content).toContain("Decision reversibility");
    expect(content).toContain("Assumption mapping");
    expect(content).toContain("Implementation-first thinking");
  });

  it("should return empty string for non-existent skill and warn", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const content = loadSkillContent("nonexistent" as never);
    expect(content).toBe("");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("nonexistent"));
    warnSpy.mockRestore();
  });
});

describe("buildSkillsSection", () => {
  it("should return section with commit skill for execution phase", () => {
    const result = buildSkillsSection(Phases.execution);
    expect(result).not.toBeNull();
    expect(result).toContain("## Skills");
    expect(result).toContain("### Skill: commit");
    expect(result).toContain("Grouping Priority");
  });

  it("should return section with both skills for self_review phase", () => {
    const result = buildSkillsSection(Phases.self_review);
    expect(result).not.toBeNull();
    expect(result).toContain("### Skill: commit");
    expect(result).toContain("### Skill: expert-panel-review");
    expect(result).toContain("Expert Panel Review");
  });

  it("should include persona content in expert-panel-review skill", () => {
    const result = buildSkillsSection(Phases.self_review);
    expect(result).not.toBeNull();
    expect(result).toContain("## Persona: Technical Architect");
    expect(result).toContain("## Persona: Critical Reviewer");
    expect(result).toContain("## Persona: Pragmatic Senior Engineer");
  });

  it("should return section with commit skill for integration phase", () => {
    const result = buildSkillsSection(Phases.integration);
    expect(result).not.toBeNull();
    expect(result).toContain("### Skill: commit");
    // Should not include expert-panel-review
    expect(result).not.toContain("Expert Panel Review");
  });

  it("should return null for phases with no skills", () => {
    expect(buildSkillsSection(Phases.requirements_gathering)).toBeNull();
    expect(buildSkillsSection(Phases.research)).toBeNull();
    expect(buildSkillsSection(Phases.planning)).toBeNull();
    expect(buildSkillsSection(Phases.demo_prep)).toBeNull();
  });
});
