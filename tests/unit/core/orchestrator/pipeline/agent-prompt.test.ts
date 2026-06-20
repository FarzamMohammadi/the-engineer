import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../../../../../src/core/orchestrator/pipeline/agent-prompt.js";
import { PERSONA } from "../../../../../src/core/orchestrator/prompts/self-model/index.js";

describe("buildSystemPrompt", () => {
  const roleLine = "ROLE: investigate the codebase and report findings.";
  const brief = "BRIEF: how I am actually set up for this job.";

  it("injects the bundled self-model persona", () => {
    const prompt = buildSystemPrompt(roleLine, brief);
    // The whole persona is injected verbatim, not a summary of it.
    expect(prompt).toContain(PERSONA);
    // A distinctive persona line — present only in the self-model, never in the
    // old one-line IDENTITY stub — locks that the persona is what reached the prompt.
    expect(prompt).toContain("you architect realities");
  });

  it("keeps the operating standards alongside the persona", () => {
    const prompt = buildSystemPrompt(roleLine, brief);
    expect(prompt).toContain("These standards hold on every task, every repository, every step.");
    expect(prompt).toContain("GROUNDING BEFORE WORK");
    expect(prompt).toContain("You report an OUTCOME, never a destination.");
    expect(prompt).toContain("SURFACING DISCRETIONARY DECISIONS");
    expect(prompt).toContain("--- BEGIN USER-PROVIDED CONTENT");
  });

  it("injects the live brief between the static standards and the role line", () => {
    const prompt = buildSystemPrompt(roleLine, brief);
    expect(prompt).toContain(brief);
    // Cache order: persona -> static standards -> brief -> role line. The brief sits after the
    // security boundary (the last static section) and before the per-phase role line.
    expect(prompt.indexOf("--- BEGIN USER-PROVIDED CONTENT")).toBeLessThan(prompt.indexOf(brief));
    expect(prompt.indexOf(brief)).toBeLessThan(prompt.indexOf(roleLine));
  });

  it("appends the per-phase role line last", () => {
    const prompt = buildSystemPrompt(roleLine, brief);
    expect(prompt).toContain(roleLine);
    expect(prompt.trimEnd().endsWith(roleLine)).toBe(true);
  });
});
