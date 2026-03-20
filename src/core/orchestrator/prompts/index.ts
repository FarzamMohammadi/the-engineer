// ── Prompt System Barrel ─────────────────────────────────────────────────────
//
// Public API for the orchestrator's prompt subsystem.
// All prompt builders are pure functions: context in, prompt string out.

export { gatherRepoContext, gatherRepoContextSafe, type RepoContext } from "./context.js";
export { buildSystemPrompt } from "./system.js";

// Phase prompt builders
export { buildIntakePrompt, type IntakePromptContext } from "./intake.js";
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
  formatOutputSchema,
  formatActionReference,
  formatKnowledge,
  formatPriorPhaseOutput,
} from "./format.js";
