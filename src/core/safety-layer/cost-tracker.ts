import type Database from "better-sqlite3";

import type { CostLimits } from "../../schemas/config.js";
import { EventTypes } from "../../schemas/events.js";
import type { CostIncurredPayload, Event } from "../../schemas/events.js";
import type { IEventBus } from "../interfaces/event-bus.interface.js";
import type { CostStatus, SafetyVerdict } from "../interfaces/safety-layer.interface.js";

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

// ── Constants ────────────────────────────────────────────────────────────────

const META_KEY = "safety_snapshot";
const COST_WARNING_THRESHOLD = 0.8;
const REPLAY_PAGE_SIZE = 1000;

// ── Pure Functions ───────────────────────────────────────────────────────────

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

// ── CostTracker ──────────────────────────────────────────────────────────────

/**
 * Tracks cumulative costs across API spend windows and CLI usage.
 *
 * Responsibilities:
 * - Subscribe to cost.incurred events and accumulate
 * - Maintain daily/monthly spend windows with automatic rollover
 * - Snapshot accumulators to _meta for crash recovery
 * - Restore from snapshot + replay missed events on startup
 * - Emit cost.limit_reached when thresholds are hit
 * - Provide getCostStatus() for passive queries
 */
export class CostTracker {
  private readonly eventBus: IEventBus;
  private costLimits: CostLimits;
  private accumulators: CostAccumulators;
  private lastSequence: number;

  private readonly getSnapshotStmt: Database.Statement;
  private readonly saveSnapshotStmt: Database.Statement;

  constructor(db: Database.Database, eventBus: IEventBus, costLimits: CostLimits) {
    this.eventBus = eventBus;
    this.costLimits = costLimits;
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

    eventBus.subscribe("safety_layer", EventTypes["cost.incurred"], (event) => {
      this.onCostEvent(event);
    });
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Get current cost status for a task or globally. */
  getCostStatus(taskId?: string): CostStatus {
    const warnings: string[] = [];

    const perTaskUsd = taskId ? (this.accumulators.api_spend.per_task.get(taskId) ?? 0) : 0;
    const dailyUsd = this.accumulators.api_spend.daily.cost_usd;
    const monthlyUsd = this.accumulators.api_spend.monthly.cost_usd;

    if (taskId && this.costLimits.api.per_task.cost_usd !== null) {
      const pct = perTaskUsd / this.costLimits.api.per_task.cost_usd;
      if (pct >= COST_WARNING_THRESHOLD) {
        warnings.push(`task ${taskId} at ${Math.round(pct * 100)}% of per-task cost limit`);
      }
    }

    if (this.costLimits.api.daily.cost_usd !== null) {
      const pct = dailyUsd / this.costLimits.api.daily.cost_usd;
      if (pct >= COST_WARNING_THRESHOLD) {
        warnings.push(`daily spend at ${Math.round(pct * 100)}% of limit`);
      }
    }

    if (this.costLimits.api.monthly.cost_usd !== null) {
      const pct = monthlyUsd / this.costLimits.api.monthly.cost_usd;
      if (pct >= COST_WARNING_THRESHOLD) {
        warnings.push(`monthly spend at ${Math.round(pct * 100)}% of limit`);
      }
    }

    return { per_task_usd: perTaskUsd, daily_usd: dailyUsd, monthly_usd: monthlyUsd, warnings };
  }

  /** Check if any cost limit is breached for the given task. */
  checkCostLimits(taskId: string, warnings: string[]): SafetyVerdict | null {
    const perTaskSpent = this.accumulators.api_spend.per_task.get(taskId) ?? 0;
    const perTaskResult = this.checkSingleCostLimit(
      perTaskSpent,
      this.costLimits.api.per_task.cost_usd,
      "per-task",
      `task ${taskId}`,
      warnings,
    );
    if (perTaskResult) {
      return perTaskResult;
    }

    const dailyResult = this.checkSingleCostLimit(
      this.accumulators.api_spend.daily.cost_usd,
      this.costLimits.api.daily.cost_usd,
      "daily",
      "daily spend",
      warnings,
    );
    if (dailyResult) {
      return dailyResult;
    }

    const monthlyResult = this.checkSingleCostLimit(
      this.accumulators.api_spend.monthly.cost_usd,
      this.costLimits.api.monthly.cost_usd,
      "monthly",
      "monthly spend",
      warnings,
    );
    if (monthlyResult) {
      return monthlyResult;
    }

    return null;
  }

  /** Check if any cost limit is breached. */
  isAnyLimitBreached(taskId?: string): boolean {
    if (taskId && this.costLimits.api.per_task.cost_usd !== null) {
      const spent = this.accumulators.api_spend.per_task.get(taskId) ?? 0;
      if (spent >= this.costLimits.api.per_task.cost_usd) {
        return true;
      }
    }

    if (this.costLimits.api.daily.cost_usd !== null) {
      if (this.accumulators.api_spend.daily.cost_usd >= this.costLimits.api.daily.cost_usd) {
        return true;
      }
    }

    if (this.costLimits.api.monthly.cost_usd !== null) {
      if (this.accumulators.api_spend.monthly.cost_usd >= this.costLimits.api.monthly.cost_usd) {
        return true;
      }
    }

    return false;
  }

  /** Update cost limits (hot-reload). */
  updateLimits(newLimits: CostLimits): void {
    this.costLimits = newLimits;
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
    if (payload.provider_type === "api") {
      this.checkApiLimitBreach("per_task", payload.task_id);
      this.checkApiLimitBreach("daily", payload.task_id);
      this.checkApiLimitBreach("monthly", payload.task_id);
    } else {
      this.checkCliLimitBreach(payload.provider_id, payload.task_id);
    }
  }

  private checkApiLimitBreach(limitType: "per_task" | "daily" | "monthly", taskId: string): void {
    const limitConfig = this.costLimits.api[limitType];
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
        type: EventTypes["cost.limit_reached"],
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

  private checkCliLimitBreach(providerId: string, taskId: string): void {
    const cliConfig = this.costLimits.cli[providerId];
    if (!cliConfig) {
      return;
    }

    const usage = this.accumulators.cli_usage.get(providerId);
    if (!usage) {
      return;
    }

    if (cliConfig.daily_requests !== null && usage.requests_used >= cliConfig.daily_requests) {
      this.eventBus.publish({
        type: EventTypes["cost.limit_reached"],
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
        type: EventTypes["cost.limit_reached"],
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
        type: EventTypes["cost.limit_reached"],
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

  // ── Private: Single Limit Check ────────────────────────────────────────────

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
    let lastSeq = this.lastSequence;
    const now = new Date();
    const dailyStart = getDailyWindowStart(now);
    const monthlyStart = getMonthlyWindowStart(now);

    // Paginated replay to avoid loading all events into memory at once
    while (true) {
      const events = this.eventBus.getEventsSince(lastSeq, REPLAY_PAGE_SIZE);
      if (events.length === 0) {
        break;
      }

      for (const event of events) {
        if (event.type !== EventTypes["cost.incurred"]) {
          lastSeq = event.sequence;
          continue;
        }

        const payload = event.payload as unknown as CostIncurredPayload;

        if (payload.provider_type === "api") {
          this.replayApiEvent(payload, new Date(event.timestamp), dailyStart, monthlyStart);
        } else {
          this.accumulateCliUsage(payload);
        }

        lastSeq = event.sequence;
      }

      this.lastSequence = lastSeq;

      if (events.length < REPLAY_PAGE_SIZE) {
        break;
      }
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
}
