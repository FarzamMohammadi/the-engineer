import { z } from "zod";

import { PrEventTypeSchema } from "./git-hosting-event-types.js";

// ── Enums ──────────────────────────────────────────────────────────────────────

export const TaskStateSchema = z.enum(["requirements_gathering", "queued", "active", "blocked", "completed", "failed"]);
export type TaskState = z.infer<typeof TaskStateSchema>;

/** Constant enum values for TaskState. Use instead of raw strings. */
export const TaskStates = TaskStateSchema.enum;

export const SubStateSchema = z.enum(["working"]);
export type SubState = z.infer<typeof SubStateSchema>;

/** Constant enum values for SubState. Use instead of raw strings. */
export const SubStates = SubStateSchema.enum;

export const ActionClassSchema = z.enum([
  "read",
  "write",
  "test",
  "git_local",
  "git_remote",
  "communicate",
  "merge",
  "deploy",
  "task_manage",
  "ask_human",
]);
export type ActionClass = z.infer<typeof ActionClassSchema>;

/** Constant enum values for ActionClass. Use instead of raw strings. */
export const ActionClasses = ActionClassSchema.enum;

/**
 * The coarse reason a task is blocked — the routing dimension the daemon switches on. Closed enum so
 * blocked tasks can be queried and routed. `pr_review_pending` is an expected wait on an external PR
 * event; `agent_unavailable` drives retry-policy backoff; `need_more_info` and `pipeline_failed` both
 * wait on the owner via the escalation ladder. Derived from the finer {@link BlockCategory} at the
 * pipeline boundary.
 */
export const BlockReasonSchema = z.enum([
  "need_more_info",
  "agent_unavailable",
  "pipeline_failed",
  "pr_review_pending",
]);
export type BlockReason = z.infer<typeof BlockReasonSchema>;

/** Constant enum values for BlockReason. Use instead of raw strings. */
export const BlockReasons = BlockReasonSchema.enum;

/**
 * The complete cause vocabulary behind a block — every block carries exactly one value, never null.
 * The first group are failures (a sub-phase or the runner could not proceed); the last two are
 * expected waits (a person or an external event must act before work resumes). The coarse
 * {@link BlockReason} the daemon routes on is derived from this; this is the single source of truth
 * for "why blocked", shared by the pipeline runner and the persisted block payload.
 */
export const BlockCategorySchema = z.enum([
  // Failures — the pipeline could not make progress.
  "no_result", // a CLI sub-phase produced no valid session-result.json
  "details_invalid", // a CLI sub-phase's details failed its detailsSchema
  "agent_failed", // a CLI sub-phase's agent reported status "failed"
  "agent_unavailable", // the agent adapter stayed unavailable after retries
  "orchestrator_error", // an orchestrator sub-phase's run threw
  "iteration_cap_hit", // a phase repeated past its cap without converging
  // Waits — expected, not a failure. Someone or something must act.
  "awaiting_human", // a sub-phase needs a person to answer before it can proceed
  "awaiting_pr_review", // delivery opened a PR and is waiting on an external review event
]);
export type BlockCategory = z.infer<typeof BlockCategorySchema>;

/** Constant enum values for BlockCategory. Use instead of raw strings. */
export const BlockCategories = BlockCategorySchema.enum;

// ── Sub-schemas ────────────────────────────────────────────────────────────────

export const PrDecorationsSchema = z.object({
  /** Prepended before the AI-generated PR title. Plugin owns delimiter (e.g., "#42:", "[JIRA-123]"). */
  title_prefix: z.string().optional(),
  /** Appended after the AI-generated PR title. */
  title_suffix: z.string().optional(),
  /** Inserted at the start of the PR description, before the trigger reference. */
  description_prefix: z.string().optional(),
  /** Inserted after the AI-generated PR description, before the branding footer (e.g., "Closes #42"). */
  description_suffix: z.string().optional(),
});
export type PrDecorations = z.infer<typeof PrDecorationsSchema>;

export const ExternalRefSchema = z.object({
  type: z.string(),
  repo: z.string(),
  id: z.string(),
  url: z.string().optional(),
  /** Plugin-provided PR decoration strings. Core treats all values as opaque. */
  pr_decorations: PrDecorationsSchema.optional(),
});
export type ExternalRef = z.infer<typeof ExternalRefSchema>;

export const TeamMemberRoleSchema = z.enum(["author", "reviewer", "domain_expert", "stakeholder"]);
export type TeamMemberRole = z.infer<typeof TeamMemberRoleSchema>;

/** Constant enum values for TeamMemberRole. Use instead of raw strings. */
export const TeamMemberRoles = TeamMemberRoleSchema.enum;

export const TeamMemberSchema = z.object({
  person_id: z.string(),
  role: TeamMemberRoleSchema,
  context: z.string(),
});
export type TeamMember = z.infer<typeof TeamMemberSchema>;

export const RelatedTypeSchema = z.enum(["issue", "pr", "doc", "previous_attempt", "spec", "design"]);
export type RelatedType = z.infer<typeof RelatedTypeSchema>;

/** Constant enum values for RelatedType. Use instead of raw strings. */
export const RelatedTypes = RelatedTypeSchema.enum;

export const RelatedItemSchema = z.object({
  type: RelatedTypeSchema,
  ref: z.string(),
  relevance: z.string(),
});
export type RelatedItem = z.infer<typeof RelatedItemSchema>;

export const TaskDecisionSchema = z.object({
  what: z.string(),
  why: z.string(),
  alternatives_considered: z.array(z.string()),
  decided_by: z.enum(["agent", "human"]),
  timestamp: z.string().datetime(),
});
export type TaskDecision = z.infer<typeof TaskDecisionSchema>;

export const TaskWorkspaceSchema = z.object({
  repo: z.string(),
  branch: z.string(),
  base_branch: z.string(),
  worktree_path: z.string().nullable(),
  thoughts_dir: z.string().nullable(),
});
export type TaskWorkspace = z.infer<typeof TaskWorkspaceSchema>;

export const DemoArtifactSchema = z.object({
  type: z.enum(["screenshot", "recording", "tui", "preview_url"]),
  location: z.string(),
  permanent: z.boolean(),
});
export type DemoArtifact = z.infer<typeof DemoArtifactSchema>;

export const FeedbackRoundSchema = z.object({
  stage: z.literal("code"),
  comments: z.array(z.string()),
  applied: z.boolean(),
});
export type FeedbackRound = z.infer<typeof FeedbackRoundSchema>;

export const ReviewStateSchema = z.object({
  pr_number: z.number().int().positive().nullable(),
  pr_state: z.enum(["ready", "merged"]).nullable(),
  demo_artifacts: z.array(DemoArtifactSchema),
  feedback_rounds: z.array(FeedbackRoundSchema),
  /** PR comment IDs already accommodated (queued for rework). Prevents re-processing same feedback. */
  accommodated_comment_ids: z.array(z.string()).default([]),
  /** Last aggregate review state that was accommodated. Detects formal review state changes. */
  accommodated_review_state: z.string().nullable().default(null),
});
export type ReviewState = z.infer<typeof ReviewStateSchema>;

/**
 * The typed payload persisted on a blocked task. `reason` is the coarse routing value the daemon
 * switches on; `category` is the complete cause; `sub_phase` names where it blocked; `needed` is the
 * operator-facing next step. Typed keys, not prose, so the dashboard and alerting query them directly.
 */
export const BlockedDetailsSchema = z.object({
  reason: BlockReasonSchema,
  category: BlockCategorySchema,
  sub_phase: z.string(),
  needed: z.string(),
});
export type BlockedDetails = z.infer<typeof BlockedDetailsSchema>;

// ── Task ───────────────────────────────────────────────────────────────────────

export const TaskSchema = z.object({
  // Identity
  id: z.string(),
  external_ref: ExternalRefSchema.nullable(),
  /** Stable dedup identity. Every task carries one; uniqueness is enforced among
   *  non-terminal tasks (a completed/failed task frees its key for re-triggering). */
  idempotency_key: z.string(),

  // State
  state: TaskStateSchema,
  sub_state: SubStateSchema.nullable(),
  phase: z.string().nullable(),
  sub_phase: z.string().nullable(),

  // Context
  title: z.string(),
  description: z.string(),
  source_text: z.string(),
  acceptance_criteria: z.array(z.string()),
  team: z.array(TeamMemberSchema),
  related: z.array(RelatedItemSchema),
  decisions: z.array(TaskDecisionSchema),

  // Workspace
  repo: z.string().nullable(),
  clone_url: z.string().nullable(),
  /** Trigger-provided identifier for the thoughts/ directory (e.g., "issue-42"). */
  thoughts_id: z.string().nullable(),
  workspace: TaskWorkspaceSchema.nullable(),

  // Review
  review: ReviewStateSchema.nullable(),

  // Blocked
  blocked: BlockedDetailsSchema.nullable(),

  // Pending external PR event — when set, the next dispatch re-enters the pipeline at this event's
  // entry point (via entryFor) instead of resuming a checkpoint. The daemon's PR-event poller writes
  // the arbitrated winner's type here and re-queues the task; the orchestrator reads it, seeds the
  // re-entry, and clears it. Only the type is stored (the routing signal): the rework content rides
  // `review.feedback_rounds`, and richer CI/conflict detail is re-derived live, per the thin-payload rule.
  pending_pr_event: PrEventTypeSchema.nullable().default(null),

  // Pipeline loop counters — persisted on the task row (and each checkpoint) so a preempt-and-resume
  // does not reset the caps. phase_iteration is the intra-phase repeat count (resets on phase entry);
  // total_reworks is the inter-phase backward-jump count for one dispatch. Both reset on a fresh dispatch.
  phase_iteration: z.number().int().default(0),
  total_reworks: z.number().int().default(0),

  // Tracking
  priority: z.number().int().min(1).max(100).default(50),
  agent_tokens: z.number().int(),
  agent_cost_usd: z.number(),
  compute_time_ms: z.number().int(),

  // Timestamps
  created_at: z.string().datetime(),
  started_at: z.string().datetime().nullable(),
  completed_at: z.string().datetime().nullable(),
  last_transition_at: z.string().datetime(),

  // Scheduling
  not_before: z.string().datetime().nullable().default(null),
  consecutive_crash_count: z.number().int().default(0),
  consecutive_agent_unavailable_count: z.number().int().default(0),

  // Session link
  session_id: z.string().nullable(),
});
export type Task = z.infer<typeof TaskSchema>;

// ── StateTransition ────────────────────────────────────────────────────────────

export const StateTransitionSchema = z.object({
  id: z.string(),
  task_id: z.string(),
  from_state: TaskStateSchema,
  to_state: TaskStateSchema,
  from_sub: SubStateSchema.nullable(),
  to_sub: SubStateSchema.nullable(),
  reason: z.string(),
  timestamp: z.string().datetime(),
  triggered_by: z.string(),
});
export type StateTransition = z.infer<typeof StateTransitionSchema>;

// ── Valid Transitions (const data) ─────────────────────────────────────────────

export const ValidTransitions = [
  { from: TaskStates.requirements_gathering, to: TaskStates.queued },
  { from: TaskStates.requirements_gathering, to: TaskStates.failed },
  { from: TaskStates.queued, to: TaskStates.active, to_sub: SubStates.working },
  { from: TaskStates.active, from_sub: SubStates.working, to: TaskStates.blocked },
  { from: TaskStates.active, from_sub: SubStates.working, to: TaskStates.completed },
  { from: TaskStates.active, from_sub: SubStates.working, to: TaskStates.failed },
  { from: TaskStates.active, from_sub: SubStates.working, to: TaskStates.queued },
  { from: TaskStates.blocked, to: TaskStates.active, to_sub: SubStates.working },
  { from: TaskStates.blocked, to: TaskStates.completed },
  { from: TaskStates.blocked, to: TaskStates.failed },
  { from: TaskStates.blocked, to: TaskStates.queued },
  { from: TaskStates.failed, to: TaskStates.queued },
] as const satisfies ReadonlyArray<{
  readonly from: TaskState;
  readonly from_sub?: SubState;
  readonly to: TaskState;
  readonly to_sub?: SubState;
}>;

export type ValidTransition = (typeof ValidTransitions)[number];

// ── Permission Table (const data) ──────────────────────────────────────────────

export type PermissionEntry = {
  readonly state: TaskState;
  readonly sub_state: SubState | null;
  readonly allowed: readonly ActionClass[];
  readonly conditional?: Partial<Record<ActionClass, string>>;
};

export const PermissionTable: readonly PermissionEntry[] = [
  { state: TaskStates.requirements_gathering, sub_state: null, allowed: [ActionClasses.read] },
  { state: TaskStates.queued, sub_state: null, allowed: [ActionClasses.read] },
  {
    state: TaskStates.active,
    sub_state: SubStates.working,
    allowed: [
      ActionClasses.read,
      ActionClasses.write,
      ActionClasses.test,
      ActionClasses.git_local,
      ActionClasses.git_remote,
      ActionClasses.communicate,
      ActionClasses.task_manage,
      ActionClasses.ask_human,
    ],
  },
  {
    state: TaskStates.blocked,
    sub_state: null,
    allowed: [ActionClasses.read, ActionClasses.communicate, ActionClasses.ask_human],
  },
  { state: TaskStates.completed, sub_state: null, allowed: [] },
  { state: TaskStates.failed, sub_state: null, allowed: [ActionClasses.communicate] },
] as const;
