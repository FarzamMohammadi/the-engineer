import { describe, expect, it } from "vitest";
import type { Phase } from "../../schemas/orchestrator.js";
import { getPhaseToolConfig } from "./phase-tools.js";

const ALL_PHASES: Phase[] = [
  "requirements_gathering",
  "research",
  "planning",
  "execution",
  "self_review",
  "demo_prep",
  "integration",
];

describe("getPhaseToolConfig", () => {
  it("returns config for all 7 phases", () => {
    for (const phase of ALL_PHASES) {
      expect(getPhaseToolConfig(phase)).toBeDefined();
    }
  });

  it("every phase includes 'done' in allowed_actions", () => {
    for (const phase of ALL_PHASES) {
      expect(getPhaseToolConfig(phase).allowed_actions).toContain("done");
    }
  });

  it("read-only phases do not allow write_file or edit_file", () => {
    const readOnlyPhases: Phase[] = [
      "requirements_gathering",
      "research",
      "planning",
      "self_review",
    ];
    for (const phase of readOnlyPhases) {
      const config = getPhaseToolConfig(phase);
      expect(config.allowed_actions).not.toContain("write_file");
      expect(config.allowed_actions).not.toContain("edit_file");
    }
  });

  it("execution phase allows all file and command actions", () => {
    const config = getPhaseToolConfig("execution");
    expect(config.allowed_actions).toContain("read_file");
    expect(config.allowed_actions).toContain("write_file");
    expect(config.allowed_actions).toContain("edit_file");
    expect(config.allowed_actions).toContain("search_files");
    expect(config.allowed_actions).toContain("search_content");
    expect(config.allowed_actions).toContain("run_command");
    expect(config.allowed_actions).toContain("done");
  });

  it("all max_iterations are positive integers", () => {
    for (const phase of ALL_PHASES) {
      const config = getPhaseToolConfig(phase);
      expect(config.max_iterations).toBeGreaterThan(0);
      expect(Number.isInteger(config.max_iterations)).toBe(true);
    }
  });

  it("returns consistent references for same phase", () => {
    for (const phase of ALL_PHASES) {
      expect(getPhaseToolConfig(phase)).toBe(getPhaseToolConfig(phase));
    }
  });
});
