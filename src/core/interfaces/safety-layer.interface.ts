import type { ResponseTimeout } from "../../schemas/config.js";
import type { SpanOptions } from "../../schemas/observer.js";
import type { ActionClass } from "../../schemas/task.js";

/** Query for passive consultation (called by Orchestrator). */
export interface SafetyQuery {
  type: "can_i" | "should_i_ask" | "cost_check";
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
   * than orphaned. Absent for callers outside a dispatch (a CLI cost_check), where the verdict
   * still records under the bare `task_id`.
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
  daily_tokens?: { input: number; output: number; total: number };
}

export interface ISafetyLayer {
  evaluateAction(taskId: string, actionClass: ActionClass, details: Record<string, unknown>): SafetyVerdict;
  consultJudgment(query: SafetyQuery): SafetyVerdict;
  getTimeoutPolicy(): ResponseTimeout;
  checkAutoMergeAllowed(repo: string): boolean;
  /** Whether /approve PR comments are treated as approval signals (solo-dev workflow). */
  isCommentApprovalEnabled(): boolean;
  /** Whether thoughts/ directory should be removed from the branch before merge. */
  shouldExcludeThoughtsOnMerge(): boolean;
  /** Flush pending cost tracker snapshot to DB. Call during graceful shutdown. */
  flushCostSnapshot(): void;
}
