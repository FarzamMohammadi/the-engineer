import type { ObservationType, Phase, TaskState } from "../types/api";

/** Tailwind badge classes (background, text, border) for each task state. */
export const STATE_COLORS: Record<TaskState, string> = {
  requirements_gathering: "bg-purple-500/20 text-purple-400 border-purple-500/30",
  queued: "bg-zinc-500/20 text-zinc-400 border-zinc-500/30",
  active: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  blocked: "bg-amber-500/20 text-amber-400 border-amber-500/30",
  review_pending: "bg-cyan-500/20 text-cyan-400 border-cyan-500/30",
  completed: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
  failed: "bg-red-500/20 text-red-400 border-red-500/30",
};

/** Human-readable short labels for each task state. */
export const STATE_LABELS: Record<TaskState, string> = {
  requirements_gathering: "Requirements",
  queued: "Queued",
  active: "Active",
  blocked: "Blocked",
  review_pending: "Review",
  completed: "Completed",
  failed: "Failed",
};

/** Tailwind background color for the small dot indicator beside each task state. */
export const STATE_DOT_COLORS: Record<TaskState, string> = {
  requirements_gathering: "bg-purple-400",
  queued: "bg-zinc-400",
  active: "bg-blue-400",
  blocked: "bg-amber-400",
  review_pending: "bg-cyan-400",
  completed: "bg-emerald-400",
  failed: "bg-red-400",
};

/** Human-readable short labels for each RRPIR pipeline phase. */
export const PHASE_LABELS: Record<Phase, string> = {
  requirements_gathering: "Requirements",
  research: "Research",
  planning: "Planning",
  execution: "Execution",
  self_review: "Review",
  demo_prep: "Demo",
};

/** Canonical ordering of pipeline phases from first to last. */
export const PHASE_ORDER: Phase[] = [
  "requirements_gathering",
  "research",
  "planning",
  "execution",
  "self_review",
  "demo_prep",
];

/** Human-readable short labels for each observation type in the timeline. */
export const OBSERVATION_TYPE_LABELS: Record<ObservationType, string> = {
  agent_iteration: "Agent Loop",
  agent_call: "Agent Call",
  tool_execution: "Tool",
  phase_transition: "Phase",
  decision_point: "Decision",
  safety_verdict: "Safety",
  state_transition: "State",
  workspace_op: "Workspace",
  plugin_call: "Plugin",
  error: "Error",
  cost_snapshot: "Cost",
  lifecycle: "Lifecycle",
  config_change: "Config",
  quota_status: "Quota",
};

/** React Query staleTime values (ms) controlling refetch frequency per data type. */
export const STALE_TIMES = {
  systemStatus: 3_000,
  taskList: 5_000,
  taskDetail: 10_000,
  metrics: 30_000,
  blob: Number.POSITIVE_INFINITY,
} as const;
