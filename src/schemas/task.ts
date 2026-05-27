import { z } from "zod";
import { PhaseSchema } from "./orchestrator.js";

// ── Enums ──────────────────────────────────────────────────────────────────────

export const TaskStateSchema = z.enum([
  "requirements_gathering",
  "queued",
  "active",
  "blocked",
  "review_pending",
  "completed",
  "failed",
]);
export type TaskState = z.infer<typeof TaskStateSchema>;

/** Constant enum values for TaskState. Use instead of raw strings. */
export const TaskStates = TaskStateSchema.enum;

export const SubStateSchema = z.enum(["working", "code"]);
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

export const BlockedDetailsSchema = z.object({
  reason: z.string(),
  efforts_made: z.array(z.string()),
  contacted: z.array(
    z.object({
      person: z.string(),
      channel: z.string(),
      timestamp: z.string().datetime(),
    }),
  ),
  needed: z.string(),
  waiting_for: z.string(),
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

  // Universal fallback: phase to return to after requirements_gathering unblocks
  return_to_phase: PhaseSchema.nullable(),

  // Pipeline loop counters (persisted across crashes)
  loopback_count: z.number().int().default(0),
  requirements_loop_count: z.number().int().default(0),

  // Complexity-based research skip (persisted for crash recovery)
  skip_research: z.boolean().default(false),

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
  {
    from: TaskStates.active,
    from_sub: SubStates.working,
    to: TaskStates.review_pending,
    to_sub: SubStates.code,
  },
  { from: TaskStates.active, from_sub: SubStates.working, to: TaskStates.completed },
  { from: TaskStates.active, from_sub: SubStates.working, to: TaskStates.failed },
  { from: TaskStates.active, from_sub: SubStates.working, to: TaskStates.queued },
  { from: TaskStates.blocked, to: TaskStates.active, to_sub: SubStates.working },
  { from: TaskStates.blocked, to: TaskStates.failed },
  { from: TaskStates.blocked, to: TaskStates.queued },
  {
    from: TaskStates.review_pending,
    from_sub: SubStates.code,
    to: TaskStates.active,
    to_sub: SubStates.working,
  },
  { from: TaskStates.review_pending, from_sub: SubStates.code, to: TaskStates.completed },
  { from: TaskStates.review_pending, from_sub: SubStates.code, to: TaskStates.queued },
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
    state: TaskStates.review_pending,
    sub_state: SubStates.code,
    allowed: [ActionClasses.read, ActionClasses.communicate],
    conditional: { [ActionClasses.merge]: "auto_merge_after_approval configured for repo" },
  },
  {
    state: TaskStates.blocked,
    sub_state: null,
    allowed: [ActionClasses.read, ActionClasses.communicate, ActionClasses.ask_human],
  },
  { state: TaskStates.completed, sub_state: null, allowed: [] },
  { state: TaskStates.failed, sub_state: null, allowed: [ActionClasses.communicate] },
] as const;
