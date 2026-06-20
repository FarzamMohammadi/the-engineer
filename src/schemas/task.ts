import { z } from "zod";

import { PrEventTypeSchema } from "./git-hosting-event-types.js";
import { ObservationLinkSchema } from "./observer.js";

// ── Enums ──────────────────────────────────────────────────────────────────────

export const TaskStateSchema = z.enum([
  "requirements_gathering",
  "queued",
  "active",
  "blocked",
  "completed",
  "failed",
  "cancelled",
]);
export type TaskState = z.infer<typeof TaskStateSchema>;

/** Constant enum values for TaskState. Use instead of raw strings. */
export const TaskStates = TaskStateSchema.enum;

/**
 * Terminal states — a task that has finished its lifecycle. `failed` is terminal yet independently
 * retryable (`failed → queued`); `completed` and `cancelled` have no exit. The single source of truth
 * for terminal-ness — `isTerminal`, completed-at stamping, `engineer status` filtering, and the DB
 * `idx_tasks_idempotency_key_active` partial index (a hand-kept SQL sibling in `001_schema.sql`, guarded by
 * tests). NOTE: the trigger's re-trigger *dedup* gate does NOT use this set — it uses the narrower
 * {@link KEY_FREEING_STATES}, because a failed task should be retried, not cloned.
 */
export const TERMINAL_STATES = [TaskStates.completed, TaskStates.failed, TaskStates.cancelled] as const;

/** Whether a task has reached a terminal (finished) state. */
export function isTerminal(state: TaskState): boolean {
  return (TERMINAL_STATES as readonly TaskState[]).includes(state);
}

/**
 * States that RELEASE a task's idempotency key for re-triggering: `completed` and `cancelled` only.
 * `failed` is deliberately excluded — it is recoverable (`failed → queued` via `engineer retry`), so it
 * HOLDS its key and the trigger resumes it rather than cloning a fresh duplicate. (The owner can still
 * force a fresh task by cancelling the failed one, which frees the key.) This is the source of truth for
 * the app-level dedup gate (`findByIdempotencyKey`) — narrower than {@link TERMINAL_STATES} on purpose.
 * It is kept SEPARATE from the reaper's identically-valued set and from the DB
 * `idx_tasks_idempotency_key_active` index (which excludes `failed` for a different reason: a failed task
 * is not *in-play*) — three distinct concerns that happen to overlap today and may diverge later.
 */
export const KEY_FREEING_STATES = TERMINAL_STATES.filter((state) => state !== TaskStates.failed);

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
  "pr_rework_cap_hit", // an open PR's automated blocker (conflict/CI) survived the re-entry cap without resolving
  // Waits — expected, not a failure. Someone or something must act.
  "awaiting_human", // a sub-phase needs a person to answer before it can proceed
  "awaiting_human_decision", // a discretionary decision the agent made that the owner's autonomy policy asks them to confirm
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

export const FeedbackRoundSchema = z.object({
  comments: z.array(z.string()),
  applied: z.boolean(),
});
export type FeedbackRound = z.infer<typeof FeedbackRoundSchema>;

export const ReviewStateSchema = z.object({
  pr_number: z.number().int().positive().nullable(),
  /** When the PR was merged (ISO 8601). The reaper's retention clock; null until a merge is recorded. */
  merged_at: z.string().datetime().nullable().default(null),
  feedback_rounds: z.array(FeedbackRoundSchema),
  /** PR comment IDs already accommodated (queued for rework). Prevents re-processing same feedback. */
  accommodated_comment_ids: z.array(z.string()).default([]),
  /** Last aggregate review state that was accommodated. Detects formal review state changes. */
  accommodated_review_state: z.string().nullable().default(null),
  /**
   * Consecutive automated-blocker (merge-conflict / CI-failure) re-entries that have not resolved.
   * The runner's per-dispatch rework caps reset on every PR-event re-entry, so they cannot see a
   * blocker that re-fires across dispatches; this cross-dispatch counter does. The poller increments
   * it each time it re-enters on a blocker, resets it when a human comment arrives or the blocker
   * clears, and escalates to the owner once it exceeds the configured cap.
   */
  consecutive_blocker_reentries: z.number().int().default(0),
  /**
   * sha256 of the diff-against-base (excluding the engine's own `thoughts/` deliverables) that the
   * PR's currently-shown title/body were generated from — the change-detection baseline so a re-push
   * regenerates the host presentation only when the PR's substance actually changed. `.optional()`
   * (not `.default`) keeps the parse output unchanged for existing literals; read it as
   * `review.presented_diff_digest ?? null`.
   */
  presented_diff_digest: z.string().nullable().optional(),
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
   *  non-terminal tasks (a terminal task frees its key for re-triggering). */
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

  // Pending human response — the owner's answer to a question this task raised. Captured when an
  // awaiting-human block is unblocked (see unblock-resolver); the next dispatch reads it into the
  // requirements re-run as authoritative scope (via the runner's carry) and clears it. The PR-event
  // sibling above carries only a routing type because the content lives elsewhere; a human answer has
  // no such home, so the answer text itself is stored here.
  pending_response: z.string().nullable().default(null),

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
  // The reaper's all-or-nothing reconciliation marker: set only after a fully-successful reap
  // (worktree + branch + any PR close). NULL means "not yet reconciled" — the reaper reconsiders the
  // task next sweep, so a partial reap retries instead of orphaning a branch. `workspace` is preserved
  // for the audit trail, so this column — not a nulled workspace — is the loop-termination signal.
  reaped_at: z.string().datetime().nullable().default(null),
  last_transition_at: z.string().datetime(),

  // Scheduling
  not_before: z.string().datetime().nullable().default(null),
  consecutive_crash_count: z.number().int().default(0),
  consecutive_agent_unavailable_count: z.number().int().default(0),

  // Session link
  session_id: z.string().nullable(),

  // Trace lineage — a single link to the previous dispatch's root span, so the next dispatch's root can
  // emit an OTLP "follows-from" edge and the task's lifecycle reads as one navigable chain of bounded
  // traces. Null on a fresh task. Stored as one value so the {trace_id, observation_id} pair is atomically
  // all-or-nothing — never half-set. It is exactly the link the next dispatch emits (see orchestrator).
  last_trace_link: ObservationLinkSchema.nullable(),
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
  { from: TaskStates.requirements_gathering, to: TaskStates.cancelled },
  { from: TaskStates.queued, to: TaskStates.active, to_sub: SubStates.working },
  { from: TaskStates.queued, to: TaskStates.cancelled },
  { from: TaskStates.active, from_sub: SubStates.working, to: TaskStates.blocked },
  { from: TaskStates.active, from_sub: SubStates.working, to: TaskStates.completed },
  { from: TaskStates.active, from_sub: SubStates.working, to: TaskStates.failed },
  { from: TaskStates.active, from_sub: SubStates.working, to: TaskStates.queued },
  { from: TaskStates.active, from_sub: SubStates.working, to: TaskStates.cancelled },
  { from: TaskStates.blocked, to: TaskStates.active, to_sub: SubStates.working },
  { from: TaskStates.blocked, to: TaskStates.completed },
  { from: TaskStates.blocked, to: TaskStates.failed },
  { from: TaskStates.blocked, to: TaskStates.queued },
  { from: TaskStates.blocked, to: TaskStates.cancelled },
  { from: TaskStates.failed, to: TaskStates.queued },
] as const satisfies ReadonlyArray<{
  readonly from: TaskState;
  readonly from_sub?: SubState;
  readonly to: TaskState;
  readonly to_sub?: SubState;
}>;

export type ValidTransition = (typeof ValidTransitions)[number];

/**
 * States from which a task can be cancelled — every state with a `→cancelled` edge in
 * {@link ValidTransitions}. The cross-process cancel writes (the dashboard API and `engineer cancel`) guard
 * on this set so a raw write serializes against a concurrent daemon transition: the guard matches zero rows
 * the moment the task has already left a cancellable state, and exactly one writer wins. Derived, never
 * hand-listed — a new `→cancelled` edge widens the guard automatically.
 */
export const CANCELLABLE_STATES = [
  ...new Set(ValidTransitions.filter((t) => t.to === TaskStates.cancelled).map((t) => t.from)),
] as const;

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
  { state: TaskStates.cancelled, sub_state: null, allowed: [] },
] as const;
