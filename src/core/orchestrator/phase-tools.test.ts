import { describe, expect, it } from "vitest";
import type { Phase } from "../../schemas/orchestrator.js";
import { PHASE_TOOL_CONFIG, getPhaseToolConfig } from "./phase-tools.js";

describe("PHASE_TOOL_CONFIG", () => {
  it("has config for all 7 phases", () => {
    const phases: Phase[] = [
      "intake_analysis",
      "research",
      "planning",
      "execution",
      "self_review",
      "demo_prep",
      "integration",
    ];
    for (const phase of phases) {
      expect(PHASE_TOOL_CONFIG[phase]).toBeDefined();
    }
    expect(Object.keys(PHASE_TOOL_CONFIG)).toHaveLength(7);
  });

  it("every phase includes 'done' in allowed_actions", () => {
    for (const config of Object.values(PHASE_TOOL_CONFIG)) {
      expect(config.allowed_actions).toContain("done");
    }
  });

  it("read-only phases do not allow write_file or edit_file", () => {
    const readOnlyPhases: Phase[] = ["intake_analysis", "research", "planning", "self_review"];
    for (const phase of readOnlyPhases) {
      const config = PHASE_TOOL_CONFIG[phase];
      expect(config.allowed_actions).not.toContain("write_file");
      expect(config.allowed_actions).not.toContain("edit_file");
    }
  });

  it("execution phase allows all file and command actions", () => {
    const config = PHASE_TOOL_CONFIG.execution;
    expect(config.allowed_actions).toContain("read_file");
    expect(config.allowed_actions).toContain("write_file");
    expect(config.allowed_actions).toContain("edit_file");
    expect(config.allowed_actions).toContain("search_files");
    expect(config.allowed_actions).toContain("search_content");
    expect(config.allowed_actions).toContain("run_command");
    expect(config.allowed_actions).toContain("done");
  });

  it("all max_iterations are positive integers", () => {
    for (const config of Object.values(PHASE_TOOL_CONFIG)) {
      expect(config.max_iterations).toBeGreaterThan(0);
      expect(Number.isInteger(config.max_iterations)).toBe(true);
    }
  });
});

describe("getPhaseToolConfig", () => {
  it("returns config matching the PHASE_TOOL_CONFIG record", () => {
    const phases: Phase[] = [
      "intake_analysis",
      "research",
      "planning",
      "execution",
      "self_review",
      "demo_prep",
      "integration",
    ];
    for (const phase of phases) {
      expect(getPhaseToolConfig(phase)).toBe(PHASE_TOOL_CONFIG[phase]);
    }
  });
});
