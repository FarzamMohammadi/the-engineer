import type { Phase, PhaseToolConfig } from "../../schemas/orchestrator.js";

/**
 * Per-phase tool restrictions (Decision #141).
 *
 * Maps each Orchestrator phase to its allowed actions, iteration limit,
 * and action classes. Principle of least privilege: research can't write files,
 * execution can't merge PRs.
 */
export const PHASE_TOOL_CONFIG: Record<Phase, PhaseToolConfig> = {
  intake_analysis: {
    allowed_actions: ["read_file", "search_files", "search_content", "done"],
    max_iterations: 5,
    action_classes: ["read"],
  },
  research: {
    allowed_actions: ["read_file", "search_files", "search_content", "run_command", "done"],
    max_iterations: 15,
    action_classes: ["read", "communicate"],
  },
  planning: {
    allowed_actions: ["read_file", "search_files", "search_content", "done"],
    max_iterations: 10,
    action_classes: ["read", "communicate", "task-manage"],
  },
  execution: {
    allowed_actions: [
      "read_file",
      "write_file",
      "edit_file",
      "search_files",
      "search_content",
      "run_command",
      "done",
    ],
    max_iterations: 25,
    action_classes: ["read", "write", "test", "git-local"],
  },
  self_review: {
    allowed_actions: ["read_file", "search_files", "search_content", "run_command", "done"],
    max_iterations: 15,
    action_classes: ["read", "write", "test"],
  },
  demo_prep: {
    allowed_actions: ["read_file", "write_file", "run_command", "done"],
    max_iterations: 10,
    action_classes: ["read", "git-remote", "communicate"],
  },
  integration: {
    allowed_actions: [
      "read_file",
      "write_file",
      "edit_file",
      "search_files",
      "search_content",
      "run_command",
      "done",
    ],
    max_iterations: 20,
    action_classes: ["read", "write", "test", "git-local", "git-remote", "merge"],
  },
};

/** Get tool config for a specific phase. */
export function getPhaseToolConfig(phase: Phase): PhaseToolConfig {
  return PHASE_TOOL_CONFIG[phase];
}
