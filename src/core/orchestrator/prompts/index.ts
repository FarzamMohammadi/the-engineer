// ── Prompt System Barrel ─────────────────────────────────────────────────────
//
// Public API for the orchestrator's prompt subsystem.
// All prompt builders are pure functions: context in, prompt string out.

export { gatherRepoContext, gatherRepoContextSafe, type RepoContext } from "./context.js";
export { buildCliNativeSystemPrompt } from "./system.js";

// Phase prompt builders
export {
  buildRequirementsGatheringPrompt,
  type RequirementsGatheringPromptContext,
} from "./requirements-gathering.js";
export { buildResearchPrompt, type ResearchPromptContext } from "./research.js";
export { buildPlanningPrompt, type PlanningPromptContext } from "./planning.js";
export { buildExecutionPrompt, type ExecutionPromptContext } from "./execution.js";
export { buildDemoPrepPrompt, type DemoPrepPromptContext } from "./demo-prep.js";
export {
  buildReviewSubPhasePrompt,
  type ReviewSubPhaseContext,
  buildRefinementPrompt,
  type RefinementPromptContext,
} from "./review.js";

// Skills
export { buildSkillsSection } from "./skills.js";

// Formatting utilities
export {
  section,
  buildTaskBrief,
  buildRRPIROverview,
  buildRepoOverview,
  type TaskBriefInput,
} from "./format.js";
