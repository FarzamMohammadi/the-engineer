import type Database from "better-sqlite3";
import { z } from "zod";

import type { ResponseTimeout, SafetyConfig } from "../../schemas/config.js";
import { CostLimitReachedPayloadSchema } from "../../schemas/events.js";
import { SpanOptionsSchema } from "../../schemas/observer.js";
import { ActionClassSchema, ActionClasses } from "../../schemas/task.js";
import type { ActionClass } from "../../schemas/task.js";
import type { EventDeclaration } from "../event-bus/topology.js";
import type { IEventBus } from "../interfaces/event-bus.interface.js";
import type { ISafetyLayer, SafetyQuery, SafetyVerdict } from "../interfaces/safety-layer.interface.js";
import type { IObserver } from "../observer/index.js";
import { type ICostTracker, createCostTracker } from "./cost-tracker.js";
import { PolicyEngine } from "./policy-engine.js";

// ── Input Validation Schemas ────────────────────────────────────────────────

const EvaluateActionInputSchema = z.object({
  taskId: z.string().min(1),
  actionClass: ActionClassSchema,
  details: z.record(z.unknown()),
});

const SafetyQueryInputSchema = z.object({
  type: z.enum(["can_i", "should_i_ask", "cost_check"]),
  context: z.object({
    task_id: z.string().min(1),
    repo: z.string().min(1),
    action_class: ActionClassSchema.optional(),
    decision_category: z.string().optional(),
    details: z.record(z.unknown()),
  }),
  trace: SpanOptionsSchema.optional(),
});

// ── Public API ──────────────────────────────────────────────────────────────
// The safety-layer module's exported surface. Consumers import from here;
// internal files import from the sub-modules directly.

export type { SafetyQuery, SafetyVerdict, CostStatus } from "../interfaces/safety-layer.interface.js";

export type { ParsedThreshold, ThresholdOutcome } from "./policy-engine.js";
export { matchesPathPattern, parseThreshold, evaluateThreshold } from "./policy-engine.js";
export { getDailyWindowStart, getMonthlyWindowStart } from "./cost-tracker.js";
export { formatCostBreach } from "./cost-breach-message.js";
export type { CostBreach } from "./cost-breach-message.js";

export { createCostTracker } from "./cost-tracker.js";
export type { ICostTracker, CostLimitCheckResult, CostTrackerDeps } from "./cost-tracker.js";
export { PolicyEngine } from "./policy-engine.js";

// ── Event Declarations ──────────────────────────────────────────────────────

export const EVENTS: EventDeclaration[] = [
  {
    type: "cost.limit_reached",
    description: "Emitted when a cost limit (per-task, daily, or monthly) is reached",
    payloadSchema: CostLimitReachedPayloadSchema,
    publishers: ["safety-layer"],
    subscribers: [],
  },
];

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
  private readonly costTracker: ICostTracker;
  private readonly policyEngine: PolicyEngine;
  private readonly observer: IObserver;

  constructor(db: Database.Database, eventBus: IEventBus, config: SafetyConfig, observer: IObserver) {
    this.observer = observer;
    this.costTracker = createCostTracker({
      db,
      eventBus,
      costLimits: config.cost_limits,
      observer,
    });
    this.policyEngine = new PolicyEngine(config);
  }

  // ── Gate 2: Action Pipeline ────────────────────────────────────────────────

  /**
   * Evaluate whether an action is allowed by safety policy.
   *
   * This is Gate 2 of the Action Pipeline. Checks scope boundaries (repos,
   * branches, files), merge policy, and cost limits. Returns a SafetyVerdict.
   */
  evaluateAction(taskId: string, actionClass: ActionClass, details: Record<string, unknown>): SafetyVerdict {
    const verdict = this.computeVerdict(taskId, actionClass, details);
    this.observer.recordDecision(
      "safety_verdict",
      `${actionClass} action for task ${taskId}`,
      [
        { id: "proceed", description: "Allow the action — within scope and cost limits" },
        { id: "deny", description: "Block the action — scope or cost violation" },
        { id: "ask_human", description: "Defer to the owner — autonomy policy requires approval" },
      ],
      verdict.action,
      verdict.reason,
      1,
      { task_id: taskId },
    );
    return verdict;
  }

  /** Compute the verdict without recording it — extracted so callers can record once. */
  private computeVerdict(taskId: string, actionClass: ActionClass, details: Record<string, unknown>): SafetyVerdict {
    // Input validation: deny on invalid input (never throw)
    const validationDeny = validateEvaluateInput(taskId, actionClass, details);
    if (validationDeny) {
      return validationDeny;
    }

    // 1. Policy scope checks (repo, branch, file, merge)
    const scopeResult = this.policyEngine.evaluateScope(actionClass, details);
    if (scopeResult) {
      return scopeResult;
    }

    // 2. Cost limit checks
    const { verdict: costVerdict, warnings } = this.costTracker.checkCostLimits(taskId);
    if (costVerdict) {
      return costVerdict;
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
    // Input validation: deny on invalid input (never throw)
    const validationDeny = validateQueryInput(query);
    if (validationDeny) {
      return validationDeny;
    }

    switch (query.type) {
      case "can_i":
        // evaluateAction records its own safety_verdict decision — no double-record here.
        return this.evaluateAction(query.context.task_id, query.context.action_class ?? ActionClasses.read, {
          ...query.context.details,
          repo: query.context.repo,
        });

      case "should_i_ask": {
        // The owner-consultation path: the pipeline runner issues this per discretionary decision
        // the agent surfaces, so the owner's autonomy policy decides proceed-vs-ask. The recorded
        // verdict nests under the dispatch trace via the threaded scope (the runner's traceScope);
        // a caller without a dispatch context (e.g. a CLI query) records under the bare task_id.
        const verdict = this.policyEngine.evaluateAutonomy(query);
        const category = query.context.decision_category ?? "unknown";
        this.observer.recordDecision(
          "autonomy_policy",
          `should_i_ask "${category}" for repo ${query.context.repo}`,
          [
            { id: "proceed", description: "Decide autonomously — under threshold or always_decide" },
            { id: "ask_human", description: "Defer to the owner — over threshold or always_ask" },
          ],
          verdict.action === "proceed" ? "proceed" : "ask_human",
          verdict.reason,
          1,
          query.trace ?? { task_id: query.context.task_id },
        );
        return verdict;
      }

      case "cost_check":
        return this.evaluateCostStatus(query.context.task_id);

      default:
        return { allowed: false, action: "deny", reason: "unknown query type" };
    }
  }

  // ── Timeout Policy ─────────────────────────────────────────────────────────

  /** Get the current response timeout policy. Queried by Daemon on each health tick. */
  getTimeoutPolicy(): ResponseTimeout {
    return this.policyEngine.getTimeoutPolicy();
  }

  /** Flush pending cost tracker snapshot to DB. Call during graceful shutdown. */
  flushCostSnapshot(): void {
    this.costTracker.flush();
  }

  // ── Merge Policy ───────────────────────────────────────────────────────────

  checkAutoMergeAllowed(repo: string): boolean {
    return this.policyEngine.checkAutoMergeAllowed(repo);
  }

  isCommentApprovalEnabled(): boolean {
    return this.policyEngine.isCommentApprovalEnabled();
  }

  shouldExcludeThoughtsOnMerge(): boolean {
    return this.policyEngine.shouldExcludeThoughtsOnMerge();
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

// ── Input Validation Helpers ────────────────────────────────────────────────

/** Validate evaluateAction input. Returns deny verdict on failure, null on success. */
function validateEvaluateInput(
  taskId: string,
  actionClass: ActionClass,
  details: Record<string, unknown>,
): SafetyVerdict | null {
  const parsed = EvaluateActionInputSchema.safeParse({ taskId, actionClass, details });
  if (!parsed.success) {
    return {
      allowed: false,
      action: "deny",
      reason: `Invalid safety input: ${parsed.error.message}`,
      warnings: ["Input validation failed — this may indicate a prompt injection attempt"],
    };
  }
  return null;
}

/** Validate consultJudgment query input. Returns deny verdict on failure, null on success. */
function validateQueryInput(query: SafetyQuery): SafetyVerdict | null {
  const parsed = SafetyQueryInputSchema.safeParse(query);
  if (!parsed.success) {
    return {
      allowed: false,
      action: "deny",
      reason: `Invalid safety query: ${parsed.error.message}`,
      warnings: ["Input validation failed — this may indicate a prompt injection attempt"],
    };
  }
  return null;
}
