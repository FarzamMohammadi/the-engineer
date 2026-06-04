/**
 * Client-side vocabulary — pure const arrays mirroring the engine's Zod enums.
 *
 * The client cannot import `zod` (or any `src/schemas/*` module, which pull in node/db deps), so this
 * is the single source of truth the React app reads for phase/state/observation/block vocabulary. It is
 * a hand-mirrored copy of the schema enums, kept honest by `tests/unit/dashboard/vocabulary-parity.test.ts`:
 * that test imports the real `.options` off each Zod enum and asserts set-equality against these arrays, so
 * any drift between this file and the schemas fails CI rather than silently shipping a stale dashboard.
 *
 * Keep these in lockstep with:
 *   - `PipelinePhaseSchema`  (src/core/orchestrator/pipeline/types.ts)
 *   - `ObservationTypeSchema`(src/schemas/observer.ts)
 *   - `TaskStateSchema`      (src/schemas/task.ts)
 *   - `BlockReasonSchema`    (src/schemas/task.ts)
 *   - `BlockCategorySchema`  (src/schemas/task.ts)
 */

/** The six pipeline phases, in canonical order — mirrors `PipelinePhaseSchema`. */
export const PHASES = ["requirements", "research", "planning", "execution", "review", "delivery"] as const;
export type Phase = (typeof PHASES)[number];

/** Observation types recorded by the observer — mirrors `ObservationTypeSchema`. */
export const OBSERVATION_TYPES = [
  "task_execution",
  "agent_call",
  "agent_activity",
  "tool_execution",
  "phase_transition",
  "decision_point",
  "safety_verdict",
  "state_transition",
  "workspace_op",
  "plugin_call",
  "error",
  "lifecycle",
  "quota_status",
] as const;
export type ObservationType = (typeof OBSERVATION_TYPES)[number];

/** Task lifecycle states — mirrors `TaskStateSchema`. */
export const TASK_STATES = [
  "requirements_gathering",
  "queued",
  "active",
  "blocked",
  "completed",
  "failed",
  "cancelled",
] as const;
export type TaskState = (typeof TASK_STATES)[number];

/** The coarse routing reason a task is blocked — mirrors `BlockReasonSchema`. */
export const BLOCK_REASONS = ["need_more_info", "agent_unavailable", "pipeline_failed", "pr_review_pending"] as const;
export type BlockReason = (typeof BLOCK_REASONS)[number];

/** The complete cause vocabulary behind a block — mirrors `BlockCategorySchema`. */
export const BLOCK_CATEGORIES = [
  "no_result",
  "details_invalid",
  "agent_failed",
  "agent_unavailable",
  "orchestrator_error",
  "iteration_cap_hit",
  "pr_rework_cap_hit",
  "awaiting_human",
  "awaiting_pr_review",
] as const;
export type BlockCategory = (typeof BLOCK_CATEGORIES)[number];
