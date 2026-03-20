import type Database from "better-sqlite3";

import type { CostLimits } from "../../schemas/config.js";
import { EventTypes } from "../../schemas/events.js";
import type { CostIncurredPayload, Event, TaskStateChangedPayload } from "../../schemas/events.js";
import { TaskStates } from "../../schemas/task.js";
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
/** Minimum interval between snapshot saves (ms). Replay handles the gap on crash. */
const SNAPSHOT_DEBOUNCE_MS = 5_000;

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

// ── ICostTracker Interface ──────────────────────────────────────────────────

/** Cost limit check result — verdict + any accumulated warnings. */
export interface CostLimitCheckResult {
  verdict: SafetyVerdict | null;
  warnings: string[];
}

/** Cost tracking interface — accumulates spend, checks limits, snapshots for crash recovery. */
export interface ICostTracker {
  getCostStatus(taskId?: string): CostStatus;
  checkCostLimits(taskId: string): CostLimitCheckResult;
  isAnyLimitBreached(taskId?: string): boolean;
  updateLimits(newLimits: CostLimits): void;
  flush(): void;
}

// ── Dependencies ────────────────────────────────────────────────────────────

export interface CostTrackerDeps {
  db: Database.Database;
  eventBus: IEventBus;
  costLimits: CostLimits;
}

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create a cost tracker that subscribes to cost.incurred events and accumulates spend.
 *
 * On creation: restores from snapshot, replays missed events, subscribes to EventBus.
 */
export function createCostTracker(deps: CostTrackerDeps): ICostTracker {
  const { db, eventBus } = deps;
  let costLimits = deps.costLimits;

  const getSnapshotStmt = db.prepare("SELECT value FROM _meta WHERE key = ?");
  const saveSnapshotStmt = db.prepare("INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)");

  let lastSequence = 0;
  let snapshotDirty = false;
  let lastSnapshotAt = 0;

  const now = new Date();
  const accumulators: CostAccumulators = {
    api_spend: {
      per_task: new Map(),
      daily: { cost_usd: 0, window_start: getDailyWindowStart(now) },
      monthly: { cost_usd: 0, window_start: getMonthlyWindowStart(now) },
    },
    cli_usage: new Map(),
  };

  // ── Initialization ──────────────────────────────────────────────────────

  restoreFromSnapshot();
  replayEvents();

  eventBus.subscribe("safety_layer", EventTypes["cost.incurred"], (event) => {
    onCostEvent(event);
  });

  // Prune per_task entries when tasks reach terminal state (prevents unbounded growth)
  eventBus.subscribe("safety_layer:cleanup", EventTypes["task.state_changed"], (event) => {
    onTaskStateChanged(event);
  });

  // ── Public API ──────────────────────────────────────────────────────────

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: multi-window cost status with per-limit warning thresholds
  function getCostStatus(taskId?: string): CostStatus {
    const warnings: string[] = [];

    const perTaskUsd = taskId ? (accumulators.api_spend.per_task.get(taskId) ?? 0) : 0;
    const dailyUsd = accumulators.api_spend.daily.cost_usd;
    const monthlyUsd = accumulators.api_spend.monthly.cost_usd;

    if (taskId && costLimits.api.per_task.cost_usd !== null) {
      const pct = perTaskUsd / costLimits.api.per_task.cost_usd;
      if (pct >= COST_WARNING_THRESHOLD) {
        warnings.push(`task ${taskId} at ${Math.round(pct * 100)}% of per-task cost limit`);
      }
    }

    if (costLimits.api.daily.cost_usd !== null) {
      const pct = dailyUsd / costLimits.api.daily.cost_usd;
      if (pct >= COST_WARNING_THRESHOLD) {
        warnings.push(`daily spend at ${Math.round(pct * 100)}% of limit`);
      }
    }

    if (costLimits.api.monthly.cost_usd !== null) {
      const pct = monthlyUsd / costLimits.api.monthly.cost_usd;
      if (pct >= COST_WARNING_THRESHOLD) {
        warnings.push(`monthly spend at ${Math.round(pct * 100)}% of limit`);
      }
    }

    return { per_task_usd: perTaskUsd, daily_usd: dailyUsd, monthly_usd: monthlyUsd, warnings };
  }

  function checkCostLimits(taskId: string): CostLimitCheckResult {
    const warnings: string[] = [];

    const perTaskSpent = accumulators.api_spend.per_task.get(taskId) ?? 0;
    const perTaskResult = checkSingleCostLimit(
      perTaskSpent,
      costLimits.api.per_task.cost_usd,
      "per-task",
      `task ${taskId}`,
    );
    if (perTaskResult.verdict) {
      return { verdict: perTaskResult.verdict, warnings: [...warnings, ...perTaskResult.warnings] };
    }
    warnings.push(...perTaskResult.warnings);

    const dailyResult = checkSingleCostLimit(
      accumulators.api_spend.daily.cost_usd,
      costLimits.api.daily.cost_usd,
      "daily",
      "daily spend",
    );
    if (dailyResult.verdict) {
      return { verdict: dailyResult.verdict, warnings: [...warnings, ...dailyResult.warnings] };
    }
    warnings.push(...dailyResult.warnings);

    const monthlyResult = checkSingleCostLimit(
      accumulators.api_spend.monthly.cost_usd,
      costLimits.api.monthly.cost_usd,
      "monthly",
      "monthly spend",
    );
    if (monthlyResult.verdict) {
      return { verdict: monthlyResult.verdict, warnings: [...warnings, ...monthlyResult.warnings] };
    }
    warnings.push(...monthlyResult.warnings);

    return { verdict: null, warnings };
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: multi-window limit breach check
  function isAnyLimitBreached(taskId?: string): boolean {
    if (taskId && costLimits.api.per_task.cost_usd !== null) {
      const spent = accumulators.api_spend.per_task.get(taskId) ?? 0;
      if (spent >= costLimits.api.per_task.cost_usd) {
        return true;
      }
    }

    if (costLimits.api.daily.cost_usd !== null) {
      if (accumulators.api_spend.daily.cost_usd >= costLimits.api.daily.cost_usd) {
        return true;
      }
    }

    if (costLimits.api.monthly.cost_usd !== null) {
      if (accumulators.api_spend.monthly.cost_usd >= costLimits.api.monthly.cost_usd) {
        return true;
      }
    }

    return false;
  }

  function updateLimits(newLimits: CostLimits): void {
    costLimits = newLimits;
  }

  function flush(): void {
    if (snapshotDirty) {
      saveSnapshot();
    }
  }

  // ── Private: Cost Event Handling ───────────────────────────────────────────

  function onCostEvent(event: Event): void {
    const payload = event.payload as unknown as CostIncurredPayload;
    const eventTime = new Date(event.timestamp);

    rolloverWindows(eventTime);

    if (payload.provider_type === "api") {
      accumulateApiSpend(payload);
    } else {
      accumulateCliUsage(payload);
    }

    lastSequence = event.sequence;
    maybeSaveSnapshot();

    checkAndEmitLimitBreaches(payload);
  }

  function onTaskStateChanged(event: Event): void {
    const payload = event.payload as unknown as TaskStateChangedPayload;
    if (payload.to_state === TaskStates.completed || payload.to_state === TaskStates.failed) {
      accumulators.api_spend.per_task.delete(payload.task_id);
    }
  }

  function accumulateApiSpend(payload: CostIncurredPayload): void {
    const spend = payload.spend_usd ?? 0;
    if (spend <= 0) {
      return;
    }

    const taskCurrent = accumulators.api_spend.per_task.get(payload.task_id) ?? 0;
    accumulators.api_spend.per_task.set(payload.task_id, taskCurrent + spend);
    accumulators.api_spend.daily.cost_usd += spend;
    accumulators.api_spend.monthly.cost_usd += spend;
  }

  function accumulateCliUsage(payload: CostIncurredPayload): void {
    const existing = accumulators.cli_usage.get(payload.provider_id) ?? {
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

    accumulators.cli_usage.set(payload.provider_id, existing);
  }

  function rolloverWindows(nowDate: Date): void {
    const dailyStart = getDailyWindowStart(nowDate);
    if (dailyStart !== accumulators.api_spend.daily.window_start) {
      accumulators.api_spend.daily = { cost_usd: 0, window_start: dailyStart };
    }

    const monthlyStart = getMonthlyWindowStart(nowDate);
    if (monthlyStart !== accumulators.api_spend.monthly.window_start) {
      accumulators.api_spend.monthly = { cost_usd: 0, window_start: monthlyStart };
    }
  }

  function checkAndEmitLimitBreaches(payload: CostIncurredPayload): void {
    if (payload.provider_type === "api") {
      checkApiLimitBreach("per_task", payload.task_id);
      checkApiLimitBreach("daily", payload.task_id);
      checkApiLimitBreach("monthly", payload.task_id);
    } else {
      checkCliLimitBreach(payload.provider_id, payload.task_id);
    }
  }

  function checkApiLimitBreach(limitType: "per_task" | "daily" | "monthly", taskId: string): void {
    const limitConfig = costLimits.api[limitType];
    if (limitConfig.cost_usd === null) {
      return;
    }

    let spent: number;
    if (limitType === "per_task") {
      spent = accumulators.api_spend.per_task.get(taskId) ?? 0;
    } else if (limitType === "daily") {
      spent = accumulators.api_spend.daily.cost_usd;
    } else {
      spent = accumulators.api_spend.monthly.cost_usd;
    }

    if (spent >= limitConfig.cost_usd) {
      eventBus.publish({
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

  function checkCliLimitBreach(providerId: string, taskId: string): void {
    const cliConfig = costLimits.cli[providerId];
    if (!cliConfig) {
      return;
    }

    const usage = accumulators.cli_usage.get(providerId);
    if (!usage) {
      return;
    }

    if (cliConfig.daily_requests !== null && usage.requests_used >= cliConfig.daily_requests) {
      eventBus.publish({
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
      eventBus.publish({
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
      eventBus.publish({
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

  function checkSingleCostLimit(
    spent: number,
    limit: number | null,
    limitType: string,
    warningSubject: string,
  ): CostLimitCheckResult {
    if (limit === null) {
      return { verdict: null, warnings: [] };
    }

    if (spent >= limit) {
      return {
        verdict: {
          allowed: false,
          action: "deny",
          reason: `${limitType} cost limit reached ($${spent.toFixed(2)} / $${limit.toFixed(2)})`,
        },
        warnings: [],
      };
    }
    const pct = spent / limit;
    if (pct >= COST_WARNING_THRESHOLD) {
      return {
        verdict: null,
        warnings: [`${warningSubject} at ${Math.round(pct * 100)}% of ${limitType} cost limit`],
      };
    }
    return { verdict: null, warnings: [] };
  }

  // ── Private: Snapshot ──────────────────────────────────────────────────────

  function maybeSaveSnapshot(): void {
    snapshotDirty = true;
    const nowMs = Date.now();
    if (nowMs - lastSnapshotAt >= SNAPSHOT_DEBOUNCE_MS) {
      saveSnapshot();
    }
  }

  function saveSnapshot(): void {
    const snapshot: AccumulatorSnapshot = {
      api_spend: {
        per_task: Object.fromEntries(accumulators.api_spend.per_task),
        daily: accumulators.api_spend.daily,
        monthly: accumulators.api_spend.monthly,
      },
      cli_usage: Object.fromEntries(accumulators.cli_usage),
      last_sequence: lastSequence,
      snapshot_at: new Date().toISOString(),
    };
    try {
      saveSnapshotStmt.run(META_KEY, JSON.stringify(snapshot));
      snapshotDirty = false;
      lastSnapshotAt = Date.now();
    } catch {
      // Snapshot save failed — keep snapshotDirty=true so next event triggers retry.
      // In-memory accumulators remain authoritative; replay covers the gap on restart.
    }
  }

  function restoreFromSnapshot(): void {
    const row = getSnapshotStmt.get(META_KEY) as { value: string } | undefined;
    if (!row) {
      return;
    }

    try {
      const snapshot = JSON.parse(row.value) as AccumulatorSnapshot;
      const nowDate = new Date();

      // Only restore if windows are still current
      const currentDailyStart = getDailyWindowStart(nowDate);
      const currentMonthlyStart = getMonthlyWindowStart(nowDate);

      accumulators.api_spend.per_task = new Map(Object.entries(snapshot.api_spend.per_task));

      if (snapshot.api_spend.daily.window_start === currentDailyStart) {
        accumulators.api_spend.daily = snapshot.api_spend.daily;
      }

      if (snapshot.api_spend.monthly.window_start === currentMonthlyStart) {
        accumulators.api_spend.monthly = snapshot.api_spend.monthly;
      }

      accumulators.cli_usage = new Map(Object.entries(snapshot.cli_usage));
      lastSequence = snapshot.last_sequence;
    } catch {
      // Corrupt snapshot — fall back to zero accumulators + full replay
      lastSequence = 0;
    }
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: paginated event replay with window-aware accumulation
  function replayEvents(): void {
    let lastSeq = lastSequence;
    const nowDate = new Date();
    const dailyStart = getDailyWindowStart(nowDate);
    const monthlyStart = getMonthlyWindowStart(nowDate);

    // Paginated replay to avoid loading all events into memory at once
    while (true) {
      const events = eventBus.getEventsSince(lastSeq, REPLAY_PAGE_SIZE);
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
          replayApiEvent(payload, new Date(event.timestamp), dailyStart, monthlyStart);
        } else {
          accumulateCliUsage(payload);
        }

        lastSeq = event.sequence;
      }

      lastSequence = lastSeq;

      if (events.length < REPLAY_PAGE_SIZE) {
        break;
      }
    }
  }

  function replayApiEvent(
    payload: CostIncurredPayload,
    eventTime: Date,
    dailyStart: string,
    monthlyStart: string,
  ): void {
    const spend = payload.spend_usd ?? 0;
    if (spend <= 0) {
      return;
    }

    const taskCurrent = accumulators.api_spend.per_task.get(payload.task_id) ?? 0;
    accumulators.api_spend.per_task.set(payload.task_id, taskCurrent + spend);

    if (getDailyWindowStart(eventTime) === dailyStart) {
      accumulators.api_spend.daily.cost_usd += spend;
    }
    if (getMonthlyWindowStart(eventTime) === monthlyStart) {
      accumulators.api_spend.monthly.cost_usd += spend;
    }
  }

  return { getCostStatus, checkCostLimits, isAnyLimitBreached, updateLimits, flush };
}
