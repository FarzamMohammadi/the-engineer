import type { ResponseTimeout, SafetyConfig } from "../../schemas/config.js";
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

export interface ISafetyLayer {
  evaluateAction(
    taskId: string,
    actionClass: ActionClass,
    details: Record<string, unknown>,
  ): SafetyVerdict;
  consultJudgment(query: SafetyQuery): SafetyVerdict;
  getCostStatus(taskId?: string): CostStatus;
  getTimeoutPolicy(): ResponseTimeout;
  updateConfig(newConfig: SafetyConfig): void;
  checkAutoMergeAllowed(repo: string): boolean;
}
