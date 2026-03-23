// ── Prompt System Barrel ─────────────────────────────────────────────────────
//
// Public API for the orchestrator's prompt subsystem.
// All prompt builders are pure functions: context in, prompt string out.

export { gatherRepoContext, gatherRepoContextSafe, type RepoContext } from "./context.js";
export { buildSystemPrompt, buildCliNativeSystemPrompt } from "./system.js";

// Phase prompt builders
export {
  buildRequirementsGatheringPrompt,
  type RequirementsGatheringPromptContext,
} from "./requirements-gathering.js";
export { buildResearchPrompt, type ResearchPromptContext } from "./research.js";
export { buildPlanningPrompt, type PlanningPromptContext } from "./planning.js";
export { buildExecutionPrompt, type ExecutionPromptContext } from "./execution.js";
export { buildSelfReviewPrompt, type SelfReviewPromptContext } from "./self-review.js";
export { buildDemoPrepPrompt, type DemoPrepPromptContext } from "./demo-prep.js";
export {
  buildIntegrationPrompt,
  type IntegrationPromptContext,
  type ChildTaskSummary,
} from "./integration.js";

// Formatting utilities
export {
  section,
  buildTaskBrief,
  formatOutputSchema,
  formatActionReference,
  formatKnowledge,
  formatPriorPhaseOutput,
  type TaskBriefInput,
} from "./format.js";
