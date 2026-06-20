import type { ResponseTimeout } from "../../schemas/config.js";
import type { SpanOptions } from "../../schemas/observer.js";
import type { ActionClass } from "../../schemas/task.js";

/** Query for passive consultation (called by Orchestrator). Always task- and repo-scoped. */
export interface SafetyQuery {
  type: "can_i" | "should_i_ask";
  context: {
    task_id: string;
    repo: string;
    action_class?: ActionClass;
    decision_category?: string;
    details: Record<string, unknown>;
  };
  /**
   * The trace-correlation scope the recorded verdict observation nests under. When the runner
   * consults per surfaced decision it passes the dispatch's full scope (task/session/trace/phase
   * + parent span) so the `autonomy_policy` decision lands inside the dispatch trace tree rather
   * than orphaned. Absent for callers outside a dispatch, where the verdict still records under
   * the bare `task_id`.
   */
  trace?: SpanOptions;
}

/** Verdict returned by evaluateAction and consultJudgment. */
export interface SafetyVerdict {
  allowed: boolean;
  action: "proceed" | "ask_human" | "deny";
  reason: string;
  warnings?: string[];
}

/** Cost status summary. */
export interface CostStatus {
  per_task_usd: number;
  daily_usd: number;
  monthly_usd: number;
  warnings: string[];
}

/**
 * Account-wide spend vs configured limits for the owner's `!cost` query. Daily and monthly only —
 * there is no task scope, so per-task spend is deliberately absent. A limit field is `null` when that
 * window is unbounded (no limit configured).
 */
export interface CostSummary {
  daily_usd: number;
  daily_limit_usd: number | null;
  monthly_usd: number;
  monthly_limit_usd: number | null;
  /** True when any account-wide (daily or monthly) limit has been reached. */
  breached: boolean;
  /** Per-window percent-of-limit warnings the layer raises near a ceiling (e.g. "daily spend at 85% of limit"). */
  warnings: string[];
}

export interface ISafetyLayer {
  evaluateAction(taskId: string, actionClass: ActionClass, details: Record<string, unknown>): SafetyVerdict;
  consultJudgment(query: SafetyQuery): SafetyVerdict;
  /** Account-wide spend vs limits for the owner's `!cost` query — a status read, no task/repo scope. */
  getCostSummary(): CostSummary;
  getTimeoutPolicy(): ResponseTimeout;
  checkAutoMergeAllowed(repo: string): boolean;
  /** Whether /approve PR comments are treated as approval signals (solo-dev workflow). */
  isCommentApprovalEnabled(): boolean;
  /** Whether thoughts/ directory should be removed from the branch before merge. */
  shouldExcludeThoughtsOnMerge(): boolean;
  /** Flush pending cost tracker snapshot to DB. Call during graceful shutdown. */
  flushCostSnapshot(): void;
}
