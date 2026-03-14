import type Database from "better-sqlite3";

import type { ResponseTimeout, SafetyConfig } from "../../schemas/config.js";
import { ActionClasses } from "../../schemas/task.js";
import type { ActionClass } from "../../schemas/task.js";
import type { IEventBus } from "../interfaces/event-bus.interface.js";
import type {
  CostStatus,
  ISafetyLayer,
  SafetyQuery,
  SafetyVerdict,
} from "../interfaces/safety-layer.interface.js";
import { CostTracker } from "./cost-tracker.js";
import { PolicyEngine } from "./policy-engine.js";

// Re-export interface types so existing consumers don't break
export type {
  SafetyQuery,
  SafetyVerdict,
  CostStatus,
} from "../interfaces/safety-layer.interface.js";

// Re-export sub-module types and pure functions for backward compatibility
export type { ParsedThreshold } from "./policy-engine.js";
export { matchesPathPattern, parseThreshold, evaluateThreshold } from "./policy-engine.js";
export { getDailyWindowStart, getMonthlyWindowStart } from "./cost-tracker.js";

// Re-export classes and errors
export { CostTracker } from "./cost-tracker.js";
export { PolicyEngine } from "./policy-engine.js";
export {
  SafetyError,
  CostLimitExceededError,
  ScopeDeniedError,
  CorruptSnapshotError,
} from "./errors.js";

// ── SafetyLayer ──────────────────────────────────────────────────────────────

/**
 * Policy enforcement authority for the system.
 *
 * Thin facade that delegates to CostTracker (cost accumulation, limit checks)
 * and PolicyEngine (scope boundaries, autonomy decisions, merge policy).
 *
 * Operates in two modes:
 * - **Gate 2 (evaluateAction):** Called by the Action Pipeline before every
 *   side-effect action. Checks scope boundaries and cost limits.
 * - **Passive consultation (consultJudgment):** Called by the Orchestrator for
 *   autonomy decisions, cost status checks, and ad-hoc scope queries.
 */
export class SafetyLayer implements ISafetyLayer {
  private readonly costTracker: CostTracker;
  private readonly policyEngine: PolicyEngine;

  constructor(db: Database.Database, eventBus: IEventBus, config: SafetyConfig) {
    this.costTracker = new CostTracker(db, eventBus, config.cost_limits);
    this.policyEngine = new PolicyEngine(config);
  }

  // ── Gate 2: Action Pipeline ────────────────────────────────────────────────

  /**
   * Evaluate whether an action is allowed by safety policy.
   *
   * This is Gate 2 of the Action Pipeline. Checks scope boundaries (repos,
   * branches, files), merge policy, and cost limits. Returns a SafetyVerdict.
   */
  evaluateAction(
    taskId: string,
    actionClass: ActionClass,
    details: Record<string, unknown>,
  ): SafetyVerdict {
    // 1. Policy scope checks (repo, branch, file, merge)
    const scopeResult = this.policyEngine.evaluateScope(actionClass, details);
    if (scopeResult) {
      return scopeResult;
    }

    // 2. Cost limit checks
    const warnings: string[] = [];
    const costResult = this.costTracker.checkCostLimits(taskId, warnings);
    if (costResult) {
      return costResult;
    }

    const result: SafetyVerdict = {
      allowed: true,
      action: "proceed",
      reason: "within policy",
    };
    if (warnings.length > 0) {
      result.warnings = warnings;
    }
    return result;
  }

  // ── Passive Consultation ───────────────────────────────────────────────────

  /** Passive consultation for autonomy decisions, cost status, and scope queries. */
  consultJudgment(query: SafetyQuery): SafetyVerdict {
    switch (query.type) {
      case "can_i":
        return this.evaluateAction(
          query.context.task_id,
          query.context.action_class ?? ActionClasses.read,
          {
            ...query.context.details,
            repo: query.context.repo,
          },
        );

      case "should_i_ask":
        return this.policyEngine.evaluateAutonomy(query);

      case "cost_check":
        return this.evaluateCostStatus(query.context.task_id);

      default:
        return { allowed: false, action: "deny", reason: "unknown query type" };
    }
  }

  // ── Cost Status ────────────────────────────────────────────────────────────

  /** Get current cost status for a task or globally. */
  getCostStatus(taskId?: string): CostStatus {
    return this.costTracker.getCostStatus(taskId);
  }

  // ── Timeout Policy ─────────────────────────────────────────────────────────

  /** Get the current response timeout policy. Queried by Daemon on each health tick. */
  getTimeoutPolicy(): ResponseTimeout {
    return this.policyEngine.getTimeoutPolicy();
  }

  // ── Hot-Reload ─────────────────────────────────────────────────────────────

  /** Replace the safety config. New rules take effect immediately. */
  updateConfig(newConfig: SafetyConfig): void {
    this.costTracker.updateLimits(newConfig.cost_limits);
    this.policyEngine.updateConfig(newConfig);
  }

  // ── Auto-Merge ─────────────────────────────────────────────────────────────

  /** Simple boolean check: is auto-merge allowed for this repo? */
  checkAutoMergeAllowed(repo: string): boolean {
    return this.policyEngine.checkAutoMergeAllowed(repo);
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private evaluateCostStatus(taskId: string): SafetyVerdict {
    const status = this.costTracker.getCostStatus(taskId);
    const anyLimitBreached = this.costTracker.isAnyLimitBreached(taskId);

    const result: SafetyVerdict = anyLimitBreached
      ? { allowed: false, action: "deny", reason: "cost limit breached" }
      : { allowed: true, action: "proceed", reason: "cost within limits" };

    if (status.warnings.length > 0) {
      result.warnings = status.warnings;
    }
    return result;
  }
}
