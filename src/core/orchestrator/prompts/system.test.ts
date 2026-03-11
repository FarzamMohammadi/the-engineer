import { describe, expect, it } from "vitest";
import type { Phase } from "../../../schemas/orchestrator.js";
import { buildSystemPrompt } from "./system.js";

const ALL_PHASES: Phase[] = [
  "intake_analysis",
  "research",
  "planning",
  "execution",
  "self_review",
  "demo_prep",
  "integration",
];

describe("buildSystemPrompt", () => {
  it("includes identity section for all phases", () => {
    for (const phase of ALL_PHASES) {
      const result = buildSystemPrompt(phase);
      expect(result).toContain("The Engineer");
      expect(result).toContain("autonomous software engineering agent");
    }
  });

  it("includes output protocol for all phases", () => {
    for (const phase of ALL_PHASES) {
      const result = buildSystemPrompt(phase);
      expect(result).toContain("JSON");
      expect(result).toContain('"action"');
      expect(result).toContain('"done"');
    }
  });

  it("includes action type descriptions", () => {
    const result = buildSystemPrompt("research");
    expect(result).toContain("read_file");
    expect(result).toContain("search_files");
    expect(result).toContain("search_content");
    expect(result).toContain("run_command");
  });

  it("includes thinking field mention", () => {
    const result = buildSystemPrompt("intake_analysis");
    expect(result).toContain("thinking");
  });

  it("produces different phase guidance for each phase", () => {
    const intakePrompt = buildSystemPrompt("intake_analysis");
    const researchPrompt = buildSystemPrompt("research");
    const executionPrompt = buildSystemPrompt("execution");

    expect(intakePrompt).toContain("intake analysis phase");
    expect(researchPrompt).toContain("research phase");
    expect(executionPrompt).toContain("execution phase");
  });

  it("intake guidance emphasizes understanding before action", () => {
    const result = buildSystemPrompt("intake_analysis");
    expect(result).toContain("understand");
    expect(result).toContain("complexity");
    expect(result).toContain("ambiguity");
  });

  it("research guidance emphasizes systematic exploration", () => {
    const result = buildSystemPrompt("research");
    expect(result).toContain("systematic");
    expect(result).toContain("patterns");
    expect(result).toContain("conventions");
  });

  it("identity includes key persona traits", () => {
    const result = buildSystemPrompt("intake_analysis");
    expect(result).toContain("Requirement clarity");
    expect(result).toContain("Ruthless clarity");
    expect(result).toContain("pattern recognition");
    expect(result).toContain("Extreme ownership");
    expect(result).toContain("Minimal footprint");
  });

  it("returns a non-empty string for every phase", () => {
    for (const phase of ALL_PHASES) {
      const result = buildSystemPrompt(phase);
      expect(result.length).toBeGreaterThan(100);
    }
  });
});
