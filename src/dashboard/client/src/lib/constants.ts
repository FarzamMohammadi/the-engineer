import type { BlockCategory, BlockReason, ObservationType, Phase, TaskState } from "../types/api";
import { PHASES } from "./vocabulary";

/** Tailwind badge classes (background, text, border) for each task state. */
export const STATE_COLORS: Record<TaskState, string> = {
  requirements_gathering: "bg-purple-500/20 text-purple-400 border-purple-500/30",
  queued: "bg-zinc-500/20 text-zinc-400 border-zinc-500/30",
  active: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  blocked: "bg-amber-500/20 text-amber-400 border-amber-500/30",
  completed: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
  failed: "bg-red-500/20 text-red-400 border-red-500/30",
  cancelled: "bg-slate-500/20 text-slate-400 border-slate-500/30",
};

/** Human-readable short labels for each task state. */
export const STATE_LABELS: Record<TaskState, string> = {
  requirements_gathering: "Requirements",
  queued: "Queued",
  active: "Active",
  blocked: "Blocked",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

/** Tailwind background color for the small dot indicator beside each task state. */
export const STATE_DOT_COLORS: Record<TaskState, string> = {
  requirements_gathering: "bg-purple-400",
  queued: "bg-zinc-400",
  active: "bg-blue-400",
  blocked: "bg-amber-400",
  completed: "bg-emerald-400",
  failed: "bg-red-400",
  cancelled: "bg-slate-400",
};

/** Human-readable short labels for each pipeline phase. */
export const PHASE_LABELS: Record<Phase, string> = {
  requirements: "Requirements",
  research: "Research",
  planning: "Planning",
  execution: "Execution",
  review: "Review",
  delivery: "Delivery",
};

/** Canonical ordering of pipeline phases from first to last — sourced from the parity-tested vocabulary. */
export const PHASE_ORDER: readonly Phase[] = PHASES;

/**
 * Human-readable labels for each sub-phase, keyed by the runner's sub-phase name (`input.subPhase`).
 * Mirrors the sub-phase files under `src/core/orchestrator/pipeline/<phase>/`. Unknown sub-phases fall
 * back to their raw name at the call site, so a new sub-phase renders legibly until a label lands here.
 */
export const SUB_PHASE_LABELS: Record<string, string> = {
  // requirements
  gather: "Gather",
  // research
  investigate: "Investigate",
  // planning
  design: "Design",
  // execution
  implement: "Implement",
  verify: "Verify",
  // review
  "self-review": "Self Review",
  security: "Security",
  "code-quality": "Code Quality",
  architecture: "Architecture",
  refine: "Refine",
  // delivery
  "pr-description": "PR Description",
  push: "Push",
  "create-pr": "Create PR",
  "await-review": "Await Review",
  "auto-merge": "Auto Merge",
};

/** Human-readable short labels for each observation type in the timeline. */
export const OBSERVATION_TYPE_LABELS: Record<ObservationType, string> = {
  task_execution: "Task",
  agent_call: "Agent Call",
  tool_execution: "Tool",
  phase_transition: "Phase",
  decision_point: "Decision",
  safety_verdict: "Safety",
  state_transition: "State",
  workspace_op: "Workspace",
  plugin_call: "Plugin",
  error: "Error",
  lifecycle: "Lifecycle",
  quota_status: "Quota",
};

/** Human-readable labels for the coarse routing reason a task is blocked. */
export const BLOCK_REASON_LABELS: Record<BlockReason, string> = {
  need_more_info: "Needs Info",
  agent_unavailable: "Agent Unavailable",
  pipeline_failed: "Pipeline Failed",
  pr_review_pending: "PR Review Pending",
};

/** Tailwind badge classes for the coarse block reason. */
export const BLOCK_REASON_COLORS: Record<BlockReason, string> = {
  need_more_info: "bg-amber-500/20 text-amber-400 border-amber-500/30",
  agent_unavailable: "bg-orange-500/20 text-orange-400 border-orange-500/30",
  pipeline_failed: "bg-red-500/20 text-red-400 border-red-500/30",
  pr_review_pending: "bg-blue-500/20 text-blue-400 border-blue-500/30",
};

/** Human-readable labels for the complete cause vocabulary behind a block. */
export const BLOCK_CATEGORY_LABELS: Record<BlockCategory, string> = {
  no_result: "No Result",
  details_invalid: "Details Invalid",
  agent_failed: "Agent Failed",
  agent_unavailable: "Agent Unavailable",
  orchestrator_error: "Orchestrator Error",
  iteration_cap_hit: "Iteration Cap Hit",
  awaiting_human: "Awaiting Human",
  awaiting_pr_review: "Awaiting PR Review",
};

/** React Query staleTime values (ms) controlling refetch frequency per data type. */
export const STALE_TIMES = {
  systemStatus: 3_000,
  taskList: 5_000,
  taskDetail: 10_000,
  metrics: 30_000,
  blob: Number.POSITIVE_INFINITY,
} as const;
