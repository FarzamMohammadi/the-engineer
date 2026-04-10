import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildRefinementPrompt, buildReviewSubPhasePrompt } from "./review.js";

function resolveSkillsDir(): string {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  let current = thisDir;
  const root = resolve("/");

  while (current !== root) {
    try {
      readFileSync(join(current, "package.json"), "utf-8");
      return join(current, "resources", "skills");
    } catch {
      current = dirname(current);
    }
  }

  return join(resolve(thisDir, "../../../.."), "resources", "skills");
}

const skillsDir = resolveSkillsDir();

describe("buildReviewSubPhasePrompt", () => {
  const minimalCtx = {
    task: { title: "Test task", description: "A test" },
    repoContext: null,
    repoKnowledge: [],
    userKnowledge: [],
    thoughtsDir: "/tmp/thoughts",
    skillsDir,
    reviewPhaseName: "code_quality" as const,
    loopbackCount: 0,
  };

  it("should include skills section with path references in review sub-phase prompt", () => {
    const result = buildReviewSubPhasePrompt(minimalCtx);
    expect(result).toContain("## Skills");
    expect(result).toContain("### Skill: commit");
    expect(result).toContain("### Skill: expert-panel-review");
    expect(result).toContain("expert-panel-review/SKILL.md");
    // Content must NOT be inlined
    expect(result).not.toContain("Expert Panel Review");
  });

  it("should include persona file paths in review prompt", () => {
    const result = buildReviewSubPhasePrompt(minimalCtx);
    expect(result).toContain("personas/critical-reviewer.md");
    expect(result).toContain("personas/pragmatic-senior-engineer.md");
    expect(result).toContain("personas/technical-architect.md");
    // Persona content must NOT be inlined
    expect(result).not.toContain("Decision reversibility");
  });
});

describe("buildRefinementPrompt", () => {
  const minimalCtx = {
    task: { title: "Test task", description: "A test" },
    repoContext: null,
    repoKnowledge: [],
    userKnowledge: [],
    thoughtsDir: "/tmp/thoughts",
    skillsDir,
    reviewPhases: ["code_quality" as const],
    loopbackCount: 0,
  };

  it("should include skills section with path references in refinement prompt", () => {
    const result = buildRefinementPrompt(minimalCtx);
    expect(result).toContain("## Skills");
    expect(result).toContain("### Skill: commit");
    expect(result).toContain("commit/SKILL.md");
  });

  it("should include expert-panel-review path in refinement prompt", () => {
    const result = buildRefinementPrompt(minimalCtx);
    expect(result).toContain("### Skill: expert-panel-review");
    expect(result).toContain("expert-panel-review/SKILL.md");
    // Content must NOT be inlined
    expect(result).not.toContain("Expert Panel Review");
  });
});
