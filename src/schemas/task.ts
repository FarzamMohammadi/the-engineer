import { z } from "zod";
import { PhaseSchema } from "./orchestrator.js";

// ── Enums ──────────────────────────────────────────────────────────────────────

export const TaskStateSchema = z.enum([
  "intake",
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

export const SubStateSchema = z.enum(["working", "supervising", "integrating", "demo", "code"]);
export type SubState = z.infer<typeof SubStateSchema>;

/** Constant enum values for SubState. Use instead of raw strings. */
export const SubStates = SubStateSchema.enum;

export const CascadePolicySchema = z.enum(["pause_siblings", "fail_fast", "best_effort", "manual"]);
export type CascadePolicy = z.infer<typeof CascadePolicySchema>;

/** Constant enum values for CascadePolicy. Use instead of raw strings. */
export const CascadePolicies = CascadePolicySchema.enum;

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

export const ExternalRefSchema = z.object({
  type: z.string(),
  repo: z.string(),
  number: z.number().int().positive(),
});
export type ExternalRef = z.infer<typeof ExternalRefSchema>;

export const ChildEntrySchema = z.object({
  id: z.string(),
  state: TaskStateSchema,
  depends_on: z.array(z.string()),
});
export type ChildEntry = z.infer<typeof ChildEntrySchema>;

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

export const RelatedTypeSchema = z.enum([
  "issue",
  "pr",
  "doc",
  "previous_attempt",
  "spec",
  "design",
]);
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

export const ChildCompletionSummarySchema = z.object({
  child_id: z.string(),
  child_title: z.string(),
  summary: z.string(),
  key_outputs: z.array(
    z.object({
      type: z.enum(["file", "endpoint", "module", "config", "schema", "test"]),
      path: z.string(),
      description: z.string(),
    }),
  ),
  patterns_introduced: z.array(z.string()),
  gotchas: z.array(z.string()),
  decisions_made: z.array(z.string()),
  pr_number: z.number().int().positive().nullable(),
  branch: z.string(),
  test_status: z.enum(["passing", "failing", "no_tests"]),
});
export type ChildCompletionSummary = z.infer<typeof ChildCompletionSummarySchema>;

export const TaskWorkspaceSchema = z.object({
  repo: z.string(),
  branch: z.string(),
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
  stage: z.enum(["demo", "code"]),
  comments: z.array(z.string()),
  applied: z.boolean(),
});
export type FeedbackRound = z.infer<typeof FeedbackRoundSchema>;

export const ReviewStateSchema = z.object({
  pr_number: z.number().int().positive().nullable(),
  pr_state: z.enum(["draft", "ready", "merged"]).nullable(),
  demo_artifacts: z.array(DemoArtifactSchema),
  feedback_rounds: z.array(FeedbackRoundSchema),
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

  // State
  state: TaskStateSchema,
  sub_state: SubStateSchema.nullable(),
  phase: z.string().nullable(),

  // Hierarchy
  parent_id: z.string().nullable(),
  children: z.array(ChildEntrySchema),
  cascade_policy: CascadePolicySchema,

  // Context
  title: z.string(),
  description: z.string(),
  source_text: z.string(),
  acceptance_criteria: z.array(z.string()),
  team: z.array(TeamMemberSchema),
  related: z.array(RelatedItemSchema),
  decisions: z.array(TaskDecisionSchema),
  child_summaries: z.array(ChildCompletionSummarySchema),

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

  // Tracking
  priority: z.number().int(),
  llm_tokens: z.number().int(),
  llm_cost_usd: z.number(),
  compute_time_ms: z.number().int(),

  // Timestamps
  created_at: z.string().datetime(),
  started_at: z.string().datetime().nullable(),
  completed_at: z.string().datetime().nullable(),
  last_transition_at: z.string().datetime(),

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
  { from: "intake", to: "queued" },
  { from: "intake", to: "failed" },
  { from: "queued", to: "active", to_sub: "working" },
  { from: "active", from_sub: "working", to: "blocked" },
  { from: "active", from_sub: "working", to: "review_pending", to_sub: "demo" },
  { from: "active", from_sub: "working", to: "review_pending", to_sub: "code" },
  { from: "active", from_sub: "working", to: "completed" },
  { from: "active", from_sub: "working", to: "failed" },
  { from: "active", from_sub: "working", to: "queued" },
  { from: "active", from_sub: "working", to: "active", to_sub: "supervising" },
  { from: "active", from_sub: "supervising", to: "active", to_sub: "working" },
  { from: "active", from_sub: "supervising", to: "blocked" },
  { from: "active", from_sub: "supervising", to: "active", to_sub: "integrating" },
  { from: "active", from_sub: "supervising", to: "failed" },
  { from: "active", from_sub: "integrating", to: "review_pending", to_sub: "demo" },
  { from: "active", from_sub: "integrating", to: "review_pending", to_sub: "code" },
  { from: "active", from_sub: "integrating", to: "completed" },
  { from: "active", from_sub: "integrating", to: "failed" },
  { from: "blocked", to: "active", to_sub: "working" },
  { from: "blocked", to: "active", to_sub: "supervising" },
  { from: "blocked", to: "failed" },
  { from: "blocked", to: "queued" },
  { from: "review_pending", from_sub: "demo", to: "active", to_sub: "working" },
  { from: "review_pending", from_sub: "demo", to: "review_pending", to_sub: "code" },
  { from: "review_pending", from_sub: "demo", to: "queued" },
  { from: "review_pending", from_sub: "code", to: "active", to_sub: "working" },
  { from: "review_pending", from_sub: "code", to: "completed" },
  { from: "review_pending", from_sub: "code", to: "queued" },
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
  { state: "intake", sub_state: null, allowed: ["read"] },
  { state: "queued", sub_state: null, allowed: ["read"] },
  {
    state: "active",
    sub_state: "working",
    allowed: [
      "read",
      "write",
      "test",
      "git_local",
      "git_remote",
      "communicate",
      "task_manage",
      "ask_human",
    ],
  },
  {
    state: "active",
    sub_state: "supervising",
    allowed: ["read", "communicate", "task_manage", "ask_human"],
  },
  {
    state: "active",
    sub_state: "integrating",
    allowed: ["read", "write", "test", "git_local", "git_remote", "communicate", "ask_human"],
  },
  { state: "review_pending", sub_state: "demo", allowed: ["read", "communicate"] },
  {
    state: "review_pending",
    sub_state: "code",
    allowed: ["read", "communicate"],
    conditional: { merge: "auto_merge_after_approval configured for repo" },
  },
  { state: "blocked", sub_state: null, allowed: ["read", "communicate", "ask_human"] },
  { state: "completed", sub_state: null, allowed: [] },
  { state: "failed", sub_state: null, allowed: ["communicate"] },
] as const;
