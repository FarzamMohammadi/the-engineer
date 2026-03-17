import { type Phase, type PhaseToolConfig, Phases } from "../../schemas/orchestrator.js";

/**
 * Per-phase tool restrictions (Decision #141).
 *
 * Maps each Orchestrator phase to its allowed actions, iteration limit,
 * and action classes. Principle of least privilege: research can't write files,
 * execution can't merge PRs.
 */
const PHASE_TOOL_CONFIG: Record<Phase, PhaseToolConfig> = {
  [Phases.intake_analysis]: {
    allowed_actions: ["read_file", "search_files", "search_content", "done"],
    max_iterations: 5,
    action_classes: ["read"],
  },
  [Phases.research]: {
    allowed_actions: ["read_file", "search_files", "search_content", "run_command", "done"],
    max_iterations: 15,
    action_classes: ["read", "communicate"],
  },
  [Phases.planning]: {
    allowed_actions: ["read_file", "search_files", "search_content", "done"],
    max_iterations: 10,
    action_classes: ["read", "communicate", "task-manage"],
  },
  [Phases.execution]: {
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
  [Phases.self_review]: {
    allowed_actions: ["read_file", "search_files", "search_content", "run_command", "done"],
    max_iterations: 15,
    action_classes: ["read", "write", "test"],
  },
  [Phases.demo_prep]: {
    allowed_actions: ["read_file", "write_file", "run_command", "done"],
    max_iterations: 10,
    action_classes: ["read", "git-remote", "communicate"],
  },
  [Phases.integration]: {
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
