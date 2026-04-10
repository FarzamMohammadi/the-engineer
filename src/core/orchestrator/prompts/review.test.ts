import { describe, expect, it } from "vitest";
import { buildRefinementPrompt, buildReviewSubPhasePrompt } from "./review.js";

describe("buildReviewSubPhasePrompt", () => {
  const minimalCtx = {
    task: { title: "Test task", description: "A test" },
    repoContext: null,
    repoKnowledge: [],
    userKnowledge: [],
    thoughtsDir: "/tmp/thoughts",
    reviewPhaseName: "code_quality" as const,
    loopbackCount: 0,
  };

  it("should include skills section in review sub-phase prompt", () => {
    const result = buildReviewSubPhasePrompt(minimalCtx);
    expect(result).toContain("## Skills");
    expect(result).toContain("### Skill: commit");
    expect(result).toContain("### Skill: expert-panel-review");
    expect(result).toContain("Expert Panel Review");
  });

  it("should include persona content in review prompt", () => {
    const result = buildReviewSubPhasePrompt(minimalCtx);
    expect(result).toContain("## Persona: Technical Architect");
    expect(result).toContain("## Persona: Critical Reviewer");
    expect(result).toContain("## Persona: Pragmatic Senior Engineer");
  });
});

describe("buildRefinementPrompt", () => {
  const minimalCtx = {
    task: { title: "Test task", description: "A test" },
    repoContext: null,
    repoKnowledge: [],
    userKnowledge: [],
    thoughtsDir: "/tmp/thoughts",
    reviewPhases: ["code_quality" as const],
    loopbackCount: 0,
  };

  it("should include skills section in refinement prompt", () => {
    const result = buildRefinementPrompt(minimalCtx);
    expect(result).toContain("## Skills");
    expect(result).toContain("### Skill: commit");
  });

  it("should include expert-panel-review in refinement prompt", () => {
    const result = buildRefinementPrompt(minimalCtx);
    expect(result).toContain("### Skill: expert-panel-review");
    expect(result).toContain("Expert Panel Review");
  });
});
