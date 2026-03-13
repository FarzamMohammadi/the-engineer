import type Database from "better-sqlite3";

import type { CostLimits, ResponseTimeout, SafetyConfig } from "../../schemas/config.js";
import type { CostIncurredPayload } from "../../schemas/events.js";
import type { Event } from "../../schemas/events.js";
import type { ActionClass } from "../../schemas/task.js";
import type { EventBus } from "../event-bus/index.js";

// ── Public Types ─────────────────────────────────────────────────────────────

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

/** Parsed threshold from autonomy config. */
export interface ParsedThreshold {
  metric: string;
  op: ">" | "<" | ">=" | "<=" | "=";
  value: number;
}

// ── Internal Types ───────────────────────────────────────────────────────────

interface ApiSpendWindow {
  cost_usd: number;
  window_start: string;
}

interface CliUsageRecord {
  requests_used: number;
  tokens_used: number;
  last_known_remaining: number | null;
  last_known_reset: string | null;
}

interface CostAccumulators {
  api_spend: {
    per_task: Map<string, number>;
    daily: ApiSpendWindow;
    monthly: ApiSpendWindow;
  };
  cli_usage: Map<string, CliUsageRecord>;
}

interface AccumulatorSnapshot {
  api_spend: {
    per_task: Record<string, number>;
    daily: ApiSpendWindow;
    monthly: ApiSpendWindow;
  };
  cli_usage: Record<string, CliUsageRecord>;
  last_sequence: number;
  snapshot_at: string;
}

// ── Pure Functions ───────────────────────────────────────────────────────────

const META_KEY = "safety_snapshot";
const COST_WARNING_THRESHOLD = 0.8;
const THRESHOLD_REGEX = /^(\w+)\s*(>=|<=|>|<|=)\s*(\d+(?:\.\d+)?)/;

/** Get the start of the daily window (midnight UTC) for a given date. */
export function getDailyWindowStart(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return d.toISOString();
}

/** Get the start of the monthly window (first of month, midnight UTC) for a given date. */
export function getMonthlyWindowStart(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return d.toISOString();
}

/**
 * Parse a threshold string like `"scope > 5 files"` or `"scope > 5"`.
 *
 * Format: `<metric> <op> <value> [unit]`
 * Supported operators: `>`, `<`, `>=`, `<=`, `=`
 * Returns null if the string cannot be parsed.
 */
export function parseThreshold(threshold: string): ParsedThreshold | null {
  const match = THRESHOLD_REGEX.exec(threshold.trim());
  const metric = match?.[1];
  const op = match?.[2];
  const val = match?.[3];
  if (!(metric && op && val)) {
    return null;
  }
  return {
    metric,
    op: op as ParsedThreshold["op"],
    value: Number(val),
  };
}

/**
 * Evaluate a parsed threshold against a details object.
 *
 * Returns true if the threshold is EXCEEDED (i.e., the condition that triggers
 * "ask_human" is met). Returns false if the metric is not found in details.
 */
export function evaluateThreshold(
  parsed: ParsedThreshold,
  details: Record<string, unknown>,
): boolean {
  const actual = details[parsed.metric];
  if (typeof actual !== "number") {
    return false;
  }
  switch (parsed.op) {
    case ">":
      return actual > parsed.value;
    case "<":
      return actual < parsed.value;
    case ">=":
      return actual >= parsed.value;
    case "<=":
      return actual <= parsed.value;
    case "=":
      return actual === parsed.value;
    default:
      return false;
  }
}

/**
 * Match a path/string against a glob-like pattern.
 *
 * Supports:
 * - `*` matches any single path segment (no slashes)
 * - `**` matches zero or more path segments
 * - `*` at the end of a string (no slashes) matches any suffix (e.g., `.env*` matches `.env.local`)
 * - Literal matching otherwise
 *
 * This is for file paths and branch names, NOT for dot-separated event types
 * (use EventBus's `matchesPattern` for those).
 */
export function matchesPathPattern(pattern: string, value: string): boolean {
  // No slashes in pattern — treat as a simple glob against the full value or basename
  if (!pattern.includes("/")) {
    return simpleGlob(pattern, value) || simpleGlob(pattern, basename(value));
  }

  // Path-based matching with slash segments
  const patternParts = pattern.split("/");
  const valueParts = value.split("/");
  return matchSegments(patternParts, 0, valueParts, 0);
}

function simpleGlob(pattern: string, value: string): boolean {
  if (pattern === "*") {
    return true;
  }
  if (pattern === "**") {
    return true;
  }

  // Handle patterns like `.env*` or `*.pem` — convert to regex
  if (pattern.includes("*")) {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${escaped}$`).test(value);
  }

  return pattern === value;
}

function matchSegments(
  pattern: readonly string[],
  patternStart: number,
  value: readonly string[],
  valueStart: number,
): boolean {
  let pi = patternStart;
  let vi = valueStart;

  while (pi < pattern.length && vi < value.length) {
    const seg = pattern[pi];
    if (seg === "**") {
      return matchDoublestar(pattern, pi, value, vi);
    }
    if (seg === undefined || !simpleGlob(seg, value[vi] ?? "")) {
      return false;
    }
    pi++;
    vi++;
  }

  // Skip trailing ** patterns
  while (pi < pattern.length && pattern[pi] === "**") {
    pi++;
  }

  return pi === pattern.length && vi === value.length;
}

function matchDoublestar(
  pattern: readonly string[],
  pi: number,
  value: readonly string[],
  vi: number,
): boolean {
  for (let skip = vi; skip <= value.length; skip++) {
    if (matchSegments(pattern, pi + 1, value, skip)) {
      return true;
    }
  }
  return false;
}

function basename(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? path : path.slice(idx + 1);
}

// ── SafetyLayer ──────────────────────────────────────────────────────────────

/**
 * Policy enforcement authority for the system.
 *
 * Operates in two modes:
 * - **Gate 2 (evaluateAction):** Called by the Action Pipeline before every
 *   side-effect action. Checks scope boundaries and cost limits.
 * - **Passive consultation (consultJudgment):** Called by the Orchestrator for
 *   autonomy decisions, cost status checks, and ad-hoc scope queries.
 *
 * Cost tracking: subscribes to `cost.incurred` events, maintains ephemeral
 * accumulators, emits `cost.limit_reached` when thresholds are hit. Accumulators
 * are snapshot to `_meta` after every cost event and restored on startup.
 */
export class SafetyLayer {
  private readonly db: Database.Database;
  private readonly eventBus: EventBus;
  private config: SafetyConfig;
  private accumulators: CostAccumulators;
  private lastSequence: number;

  private readonly getSnapshotStmt: Database.Statement;
  private readonly saveSnapshotStmt: Database.Statement;

  constructor(db: Database.Database, eventBus: EventBus, config: SafetyConfig) {
    this.db = db;
    this.eventBus = eventBus;
    this.config = config;
    this.lastSequence = 0;

    this.getSnapshotStmt = db.prepare("SELECT value FROM _meta WHERE key = ?");
    this.saveSnapshotStmt = db.prepare("INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)");

    const now = new Date();
    this.accumulators = {
      api_spend: {
        per_task: new Map(),
        daily: { cost_usd: 0, window_start: getDailyWindowStart(now) },
        monthly: { cost_usd: 0, window_start: getMonthlyWindowStart(now) },
      },
      cli_usage: new Map(),
    };

    this.restoreFromSnapshot();
    this.replayEvents();

    eventBus.subscribe("safety_layer", "cost.incurred", (event) => {
      this.onCostEvent(event);
    });
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
    const warnings: string[] = [];

    // 1. Repo scope check
    const repoCheck = this.checkRepoScope(details);
    if (repoCheck) {
      return repoCheck;
    }

    // 2. Branch scope check (for git_remote and merge actions)
    if (actionClass === "git_remote" || actionClass === "merge") {
      const branchCheck = this.checkBranchScope(actionClass, details);
      if (branchCheck) {
        return branchCheck;
      }
    }

    // 3. File scope check (for write actions)
    if (actionClass === "write") {
      const fileCheck = this.checkFileScope(details);
      if (fileCheck) {
        return fileCheck;
      }
    }

    // 4. Merge policy check
    if (actionClass === "merge") {
      const mergeCheck = this.checkMergePolicy(details);
      if (mergeCheck) {
        return mergeCheck;
      }
    }

    // 5. Cost limit check
    const costCheck = this.checkCostLimits(taskId, warnings);
    if (costCheck) {
      return costCheck;
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
        return this.evaluateAction(query.context.task_id, query.context.action_class ?? "read", {
          ...query.context.details,
          repo: query.context.repo,
        });

      case "should_i_ask":
        return this.evaluateAutonomy(query);

      case "cost_check":
        return this.evaluateCostStatus(query.context.task_id);

      default:
        return { allowed: false, action: "deny", reason: "unknown query type" };
    }
  }

  // ── Cost Status ────────────────────────────────────────────────────────────

  /** Get current cost status for a task or globally. */
  getCostStatus(taskId?: string): CostStatus {
    const warnings: string[] = [];
    const limits = this.config.cost_limits;

    const perTaskUsd = taskId ? (this.accumulators.api_spend.per_task.get(taskId) ?? 0) : 0;
    const dailyUsd = this.accumulators.api_spend.daily.cost_usd;
    const monthlyUsd = this.accumulators.api_spend.monthly.cost_usd;

    if (taskId && limits.api.per_task.cost_usd !== null) {
      const pct = perTaskUsd / limits.api.per_task.cost_usd;
      if (pct >= COST_WARNING_THRESHOLD) {
        warnings.push(`task ${taskId} at ${Math.round(pct * 100)}% of per-task cost limit`);
      }
    }

    if (limits.api.daily.cost_usd !== null) {
      const pct = dailyUsd / limits.api.daily.cost_usd;
      if (pct >= COST_WARNING_THRESHOLD) {
        warnings.push(`daily spend at ${Math.round(pct * 100)}% of limit`);
      }
    }

    if (limits.api.monthly.cost_usd !== null) {
      const pct = monthlyUsd / limits.api.monthly.cost_usd;
      if (pct >= COST_WARNING_THRESHOLD) {
        warnings.push(`monthly spend at ${Math.round(pct * 100)}% of limit`);
      }
    }

    return { per_task_usd: perTaskUsd, daily_usd: dailyUsd, monthly_usd: monthlyUsd, warnings };
  }

  // ── Timeout Policy ─────────────────────────────────────────────────────────

  /** Get the current response timeout policy. Queried by Daemon on each health tick. */
  getTimeoutPolicy(): ResponseTimeout {
    return this.config.response_timeout;
  }

  // ── Hot-Reload ─────────────────────────────────────────────────────────────

  /** Replace the safety config. New rules take effect immediately. */
  updateConfig(newConfig: SafetyConfig): void {
    this.config = newConfig;
  }

  // ── Private: Scope Checks ──────────────────────────────────────────────────

  private checkRepoScope(details: Record<string, unknown>): SafetyVerdict | null {
    const allowed = this.config.scope.repos.allowed;
    if (allowed === null) {
      return null;
    }
    const repo = details["repo"];
    if (typeof repo !== "string") {
      return null;
    }
    if (!allowed.includes(repo)) {
      return {
        allowed: false,
        action: "deny",
        reason: `repo "${repo}" is not in the allowed list`,
      };
    }
    return null;
  }

  private checkBranchScope(
    actionClass: "git_remote" | "merge",
    details: Record<string, unknown>,
  ): SafetyVerdict | null {
    const branch = details["branch"];
    if (typeof branch !== "string") {
      return null;
    }

    const patterns =
      actionClass === "merge"
        ? this.config.scope.branches.merge_to
        : this.config.scope.branches.push_to;

    const matches = patterns.some((p) => matchesPathPattern(p, branch));
    if (!matches) {
      const verb = actionClass === "merge" ? "merge into" : "push to";
      return {
        allowed: false,
        action: "deny",
        reason: `cannot ${verb} branch "${branch}" — not in allowed patterns`,
      };
    }
    return null;
  }

  private checkFileScope(details: Record<string, unknown>): SafetyVerdict | null {
    const patterns = this.config.scope.files.exclude_patterns;
    if (patterns.length === 0) {
      return null;
    }

    const files = this.extractFiles(details);
    for (const file of files) {
      for (const pattern of patterns) {
        if (matchesPathPattern(pattern, file)) {
          return {
            allowed: false,
            action: "deny",
            reason: `file "${file}" matches exclude pattern "${pattern}"`,
          };
        }
      }
    }
    return null;
  }

  private checkMergePolicy(details: Record<string, unknown>): SafetyVerdict | null {
    const repo = details["repo"];
    if (typeof repo !== "string") {
      return null;
    }

    const mergeConfig = this.config.merge.auto_merge_after_approval;
    const repoSetting = mergeConfig.repos[repo];
    const autoMergeAllowed = repoSetting ?? mergeConfig.default;

    if (!autoMergeAllowed) {
      return {
        allowed: false,
        action: "ask_human",
        reason: `auto-merge is not enabled for repo "${repo}"`,
      };
    }
    return null;
  }

  /** Simple boolean check: is auto-merge allowed for this repo? */
  checkAutoMergeAllowed(repo: string): boolean {
    const mergeConfig = this.config.merge.auto_merge_after_approval;
    const repoSetting = mergeConfig.repos[repo];
    return repoSetting ?? mergeConfig.default;
  }

  private checkCostLimits(taskId: string, warnings: string[]): SafetyVerdict | null {
    const limits = this.config.cost_limits;

    const perTaskSpent = this.accumulators.api_spend.per_task.get(taskId) ?? 0;
    const perTaskResult = this.checkSingleCostLimit(
      perTaskSpent,
      limits.api.per_task.cost_usd,
      "per-task",
      `task ${taskId}`,
      warnings,
    );
    if (perTaskResult) {
      return perTaskResult;
    }

    const dailyResult = this.checkSingleCostLimit(
      this.accumulators.api_spend.daily.cost_usd,
      limits.api.daily.cost_usd,
      "daily",
      "daily spend",
      warnings,
    );
    if (dailyResult) {
      return dailyResult;
    }

    const monthlyResult = this.checkSingleCostLimit(
      this.accumulators.api_spend.monthly.cost_usd,
      limits.api.monthly.cost_usd,
      "monthly",
      "monthly spend",
      warnings,
    );
    if (monthlyResult) {
      return monthlyResult;
    }

    return null;
  }

  private checkSingleCostLimit(
    spent: number,
    limit: number | null,
    label: string,
    warningPrefix: string,
    warnings: string[],
  ): SafetyVerdict | null {
    if (limit === null) {
      return null;
    }

    if (spent >= limit) {
      return {
        allowed: false,
        action: "deny",
        reason: `${label} cost limit reached ($${spent.toFixed(2)} / $${limit.toFixed(2)})`,
      };
    }
    const pct = spent / limit;
    if (pct >= COST_WARNING_THRESHOLD) {
      warnings.push(`${warningPrefix} at ${Math.round(pct * 100)}% of ${label} cost limit`);
    }
    return null;
  }

  // ── Private: Autonomy ──────────────────────────────────────────────────────

  private evaluateAutonomy(query: SafetyQuery): SafetyVerdict {
    const category = query.context.decision_category;
    if (!category) {
      return { allowed: false, action: "ask_human", reason: "no decision category provided" };
    }

    // Check for repo override first
    const repoOverride = this.findRepoOverride(query.context.repo, category);
    const decision = repoOverride ?? this.config.autonomy.decisions[category];

    if (!decision) {
      return {
        allowed: false,
        action: "ask_human",
        reason: `unknown decision category "${category}" — defaulting to ask_human`,
      };
    }

    switch (decision.level) {
      case "always_decide":
        return { allowed: true, action: "proceed", reason: `"${category}" is always_decide` };

      case "always_ask":
        return {
          allowed: false,
          action: "ask_human",
          reason: `"${category}" requires human approval`,
        };

      case "threshold": {
        if (!decision.threshold) {
          return {
            allowed: false,
            action: "ask_human",
            reason: `"${category}" has threshold level but no threshold defined`,
          };
        }
        const parsed = parseThreshold(decision.threshold);
        if (!parsed) {
          return {
            allowed: false,
            action: "ask_human",
            reason: `unparseable threshold "${decision.threshold}" for "${category}"`,
          };
        }
        const exceeded = evaluateThreshold(parsed, query.context.details);
        if (exceeded) {
          return {
            allowed: false,
            action: "ask_human",
            reason: `${category} ${parsed.metric} (${query.context.details[parsed.metric]}) exceeds threshold (${parsed.value})`,
          };
        }
        return {
          allowed: true,
          action: "proceed",
          reason: `${category} within threshold`,
        };
      }

      default:
        return { allowed: false, action: "ask_human", reason: "unknown autonomy level" };
    }
  }

  private findRepoOverride(
    repo: string,
    category: string,
  ): { level: "always_ask" | "threshold" | "always_decide"; threshold: string | null } | null {
    for (const [repoPattern, override] of Object.entries(this.config.autonomy.repo_overrides)) {
      if (matchesPathPattern(repoPattern, repo)) {
        const decision = override.decisions[category];
        if (decision?.level) {
          return {
            level: decision.level,
            threshold: decision.threshold ?? null,
          };
        }
      }
    }
    return null;
  }

  // ── Private: Cost Status ───────────────────────────────────────────────────

  private evaluateCostStatus(taskId: string): SafetyVerdict {
    const status = this.getCostStatus(taskId);
    const anyLimitBreached = this.isAnyLimitBreached(taskId);

    const result: SafetyVerdict = anyLimitBreached
      ? { allowed: false, action: "deny", reason: "cost limit breached" }
      : { allowed: true, action: "proceed", reason: "cost within limits" };

    if (status.warnings.length > 0) {
      result.warnings = status.warnings;
    }
    return result;
  }

  private isAnyLimitBreached(taskId?: string): boolean {
    const limits = this.config.cost_limits;

    if (taskId && limits.api.per_task.cost_usd !== null) {
      const spent = this.accumulators.api_spend.per_task.get(taskId) ?? 0;
      if (spent >= limits.api.per_task.cost_usd) {
        return true;
      }
    }

    if (limits.api.daily.cost_usd !== null) {
      if (this.accumulators.api_spend.daily.cost_usd >= limits.api.daily.cost_usd) {
        return true;
      }
    }

    if (limits.api.monthly.cost_usd !== null) {
      if (this.accumulators.api_spend.monthly.cost_usd >= limits.api.monthly.cost_usd) {
        return true;
      }
    }

    return false;
  }

  // ── Private: Cost Event Handling ───────────────────────────────────────────

  private onCostEvent(event: Event): void {
    const payload = event.payload as unknown as CostIncurredPayload;
    const eventTime = new Date(event.timestamp);

    this.rolloverWindows(eventTime);

    if (payload.provider_type === "api") {
      this.accumulateApiSpend(payload);
    } else {
      this.accumulateCliUsage(payload);
    }

    this.lastSequence = event.sequence;
    this.saveSnapshot();

    this.checkAndEmitLimitBreaches(payload);
  }

  private accumulateApiSpend(payload: CostIncurredPayload): void {
    const spend = payload.spend_usd ?? 0;
    if (spend <= 0) {
      return;
    }

    const taskCurrent = this.accumulators.api_spend.per_task.get(payload.task_id) ?? 0;
    this.accumulators.api_spend.per_task.set(payload.task_id, taskCurrent + spend);
    this.accumulators.api_spend.daily.cost_usd += spend;
    this.accumulators.api_spend.monthly.cost_usd += spend;
  }

  private accumulateCliUsage(payload: CostIncurredPayload): void {
    const existing = this.accumulators.cli_usage.get(payload.provider_id) ?? {
      requests_used: 0,
      tokens_used: 0,
      last_known_remaining: null,
      last_known_reset: null,
    };

    existing.requests_used += payload.usage_units ?? 1;
    existing.tokens_used += (payload.tokens_in ?? 0) + (payload.tokens_out ?? 0);

    if (payload.remaining !== null) {
      existing.last_known_remaining = payload.remaining;
    }

    this.accumulators.cli_usage.set(payload.provider_id, existing);
  }

  private rolloverWindows(now: Date): void {
    const dailyStart = getDailyWindowStart(now);
    if (dailyStart !== this.accumulators.api_spend.daily.window_start) {
      this.accumulators.api_spend.daily = { cost_usd: 0, window_start: dailyStart };
    }

    const monthlyStart = getMonthlyWindowStart(now);
    if (monthlyStart !== this.accumulators.api_spend.monthly.window_start) {
      this.accumulators.api_spend.monthly = { cost_usd: 0, window_start: monthlyStart };
    }
  }

  private checkAndEmitLimitBreaches(payload: CostIncurredPayload): void {
    const limits = this.config.cost_limits;

    if (payload.provider_type === "api") {
      this.checkApiLimitBreach("per_task", payload.task_id, limits);
      this.checkApiLimitBreach("daily", payload.task_id, limits);
      this.checkApiLimitBreach("monthly", payload.task_id, limits);
    } else {
      this.checkCliLimitBreach(payload.provider_id, payload.task_id, limits);
    }
  }

  private checkApiLimitBreach(
    limitType: "per_task" | "daily" | "monthly",
    taskId: string,
    limits: CostLimits,
  ): void {
    const limitConfig = limits.api[limitType];
    if (limitConfig.cost_usd === null) {
      return;
    }

    let spent: number;
    if (limitType === "per_task") {
      spent = this.accumulators.api_spend.per_task.get(taskId) ?? 0;
    } else if (limitType === "daily") {
      spent = this.accumulators.api_spend.daily.cost_usd;
    } else {
      spent = this.accumulators.api_spend.monthly.cost_usd;
    }

    if (spent >= limitConfig.cost_usd) {
      this.eventBus.publish({
        type: "cost.limit_reached" as const,
        source: "safety_layer",
        task_id: limitType === "per_task" ? taskId : null,
        payload: {
          task_id: limitType === "per_task" ? taskId : null,
          limit_type: limitType,
          limit_scope: null,
          current_spend: spent,
          limit_value: limitConfig.cost_usd,
          provider_type: "api" as const,
          resets_at: null,
        },
      });
    }
  }

  private checkCliLimitBreach(providerId: string, taskId: string, limits: CostLimits): void {
    const cliConfig = limits.cli[providerId];
    if (!cliConfig) {
      return;
    }

    const usage = this.accumulators.cli_usage.get(providerId);
    if (!usage) {
      return;
    }

    if (cliConfig.daily_requests !== null && usage.requests_used >= cliConfig.daily_requests) {
      this.eventBus.publish({
        type: "cost.limit_reached" as const,
        source: "safety_layer",
        task_id: taskId,
        payload: {
          task_id: taskId,
          limit_type: "daily" as const,
          limit_scope: providerId,
          current_spend: usage.requests_used,
          limit_value: cliConfig.daily_requests,
          provider_type: "cli" as const,
          resets_at: usage.last_known_reset,
        },
      });
    }

    if (cliConfig.daily_tokens !== null && usage.tokens_used >= cliConfig.daily_tokens) {
      this.eventBus.publish({
        type: "cost.limit_reached" as const,
        source: "safety_layer",
        task_id: taskId,
        payload: {
          task_id: taskId,
          limit_type: "daily" as const,
          limit_scope: providerId,
          current_spend: usage.tokens_used,
          limit_value: cliConfig.daily_tokens,
          provider_type: "cli" as const,
          resets_at: usage.last_known_reset,
        },
      });
    }

    // CLI self-reporting: remaining === 0 means provider exhausted
    if (usage.last_known_remaining === 0) {
      this.eventBus.publish({
        type: "cost.limit_reached" as const,
        source: "safety_layer",
        task_id: taskId,
        payload: {
          task_id: taskId,
          limit_type: "daily" as const,
          limit_scope: providerId,
          current_spend: usage.requests_used,
          limit_value: usage.requests_used,
          provider_type: "cli" as const,
          resets_at: usage.last_known_reset,
        },
      });
    }
  }

  // ── Private: Snapshot ──────────────────────────────────────────────────────

  private saveSnapshot(): void {
    const snapshot: AccumulatorSnapshot = {
      api_spend: {
        per_task: Object.fromEntries(this.accumulators.api_spend.per_task),
        daily: this.accumulators.api_spend.daily,
        monthly: this.accumulators.api_spend.monthly,
      },
      cli_usage: Object.fromEntries(this.accumulators.cli_usage),
      last_sequence: this.lastSequence,
      snapshot_at: new Date().toISOString(),
    };
    this.saveSnapshotStmt.run(META_KEY, JSON.stringify(snapshot));
  }

  private restoreFromSnapshot(): void {
    const row = this.getSnapshotStmt.get(META_KEY) as { value: string } | undefined;
    if (!row) {
      return;
    }

    try {
      const snapshot = JSON.parse(row.value) as AccumulatorSnapshot;
      const now = new Date();

      // Only restore if windows are still current
      const currentDailyStart = getDailyWindowStart(now);
      const currentMonthlyStart = getMonthlyWindowStart(now);

      this.accumulators.api_spend.per_task = new Map(Object.entries(snapshot.api_spend.per_task));

      if (snapshot.api_spend.daily.window_start === currentDailyStart) {
        this.accumulators.api_spend.daily = snapshot.api_spend.daily;
      }

      if (snapshot.api_spend.monthly.window_start === currentMonthlyStart) {
        this.accumulators.api_spend.monthly = snapshot.api_spend.monthly;
      }

      this.accumulators.cli_usage = new Map(Object.entries(snapshot.cli_usage));
      this.lastSequence = snapshot.last_sequence;
    } catch {
      // Corrupt snapshot — fall back to zero accumulators + full replay
      this.lastSequence = 0;
    }
  }

  private replayEvents(): void {
    const events = this.eventBus.getEventsSince(this.lastSequence);
    const now = new Date();
    const dailyStart = getDailyWindowStart(now);
    const monthlyStart = getMonthlyWindowStart(now);

    for (const event of events) {
      if (event.type !== "cost.incurred") {
        continue;
      }

      const payload = event.payload as unknown as CostIncurredPayload;

      if (payload.provider_type === "api") {
        this.replayApiEvent(payload, new Date(event.timestamp), dailyStart, monthlyStart);
      } else {
        this.accumulateCliUsage(payload);
      }

      this.lastSequence = event.sequence;
    }
  }

  private replayApiEvent(
    payload: CostIncurredPayload,
    eventTime: Date,
    dailyStart: string,
    monthlyStart: string,
  ): void {
    const spend = payload.spend_usd ?? 0;
    if (spend <= 0) {
      return;
    }

    const taskCurrent = this.accumulators.api_spend.per_task.get(payload.task_id) ?? 0;
    this.accumulators.api_spend.per_task.set(payload.task_id, taskCurrent + spend);

    if (getDailyWindowStart(eventTime) === dailyStart) {
      this.accumulators.api_spend.daily.cost_usd += spend;
    }
    if (getMonthlyWindowStart(eventTime) === monthlyStart) {
      this.accumulators.api_spend.monthly.cost_usd += spend;
    }
  }

  // ── Private: Utilities ─────────────────────────────────────────────────────

  private extractFiles(details: Record<string, unknown>): string[] {
    const file = details["file"];
    const files = details["files"];

    if (typeof file === "string") {
      return [file];
    }
    if (Array.isArray(files)) {
      return files.filter((f): f is string => typeof f === "string");
    }
    return [];
  }
}
