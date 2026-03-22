import type Database from "better-sqlite3";

import type { CostLimits } from "../../schemas/config.js";
import { EventTypes } from "../../schemas/events.js";
import type { CostIncurredPayload, Event, TaskStateChangedPayload } from "../../schemas/events.js";
import { TaskStates } from "../../schemas/task.js";
import type { IEventBus, PublishInput } from "../interfaces/event-bus.interface.js";
import type { CostStatus, SafetyVerdict } from "../interfaces/safety-layer.interface.js";
import type { IObserver } from "../observer/index.js";

// ── Internal Types ───────────────────────────────────────────────────────────

interface SpendWindow {
  cost_usd: number;
  window_start: string;
}

interface ProviderUsageRecord {
  requests_used: number;
}

interface SpendAccumulators {
  per_task: Map<string, number>;
  daily: SpendWindow;
  monthly: SpendWindow;
  providers: Map<string, ProviderUsageRecord>;
}

interface AccumulatorSnapshot {
  per_task: Record<string, number>;
  daily: SpendWindow;
  monthly: SpendWindow;
  providers: Record<string, ProviderUsageRecord>;
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
  observer: IObserver;
}

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create a cost tracker that subscribes to cost.incurred events and accumulates spend.
 *
 * On creation: restores from snapshot, replays missed events, subscribes to EventBus.
 */
export function createCostTracker(deps: CostTrackerDeps): ICostTracker {
  const { db, eventBus, observer } = deps;
  let costLimits = deps.costLimits;

  const getSnapshotStmt = db.prepare("SELECT value FROM _meta WHERE key = ?");
  const saveSnapshotStmt = db.prepare("INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)");

  let lastSequence = 0;
  let snapshotDirty = false;
  let lastSnapshotAt = 0;

  const now = new Date();
  const accumulators: SpendAccumulators = {
    per_task: new Map(),
    daily: { cost_usd: 0, window_start: getDailyWindowStart(now) },
    monthly: { cost_usd: 0, window_start: getMonthlyWindowStart(now) },
    providers: new Map(),
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

    const perTaskUsd = taskId ? (accumulators.per_task.get(taskId) ?? 0) : 0;
    const dailyUsd = accumulators.daily.cost_usd;
    const monthlyUsd = accumulators.monthly.cost_usd;

    if (taskId && costLimits.per_task.cost_usd !== null) {
      const pct = perTaskUsd / costLimits.per_task.cost_usd;
      if (pct >= COST_WARNING_THRESHOLD) {
        warnings.push(`task ${taskId} at ${Math.round(pct * 100)}% of per-task cost limit`);
      }
    }

    if (costLimits.daily.cost_usd !== null) {
      const pct = dailyUsd / costLimits.daily.cost_usd;
      if (pct >= COST_WARNING_THRESHOLD) {
        warnings.push(`daily spend at ${Math.round(pct * 100)}% of limit`);
      }
    }

    if (costLimits.monthly.cost_usd !== null) {
      const pct = monthlyUsd / costLimits.monthly.cost_usd;
      if (pct >= COST_WARNING_THRESHOLD) {
        warnings.push(`monthly spend at ${Math.round(pct * 100)}% of limit`);
      }
    }

    return { per_task_usd: perTaskUsd, daily_usd: dailyUsd, monthly_usd: monthlyUsd, warnings };
  }

  function checkCostLimits(taskId: string): CostLimitCheckResult {
    const warnings: string[] = [];

    const perTaskSpent = accumulators.per_task.get(taskId) ?? 0;
    const perTaskResult = checkSingleCostLimit(
      perTaskSpent,
      costLimits.per_task.cost_usd,
      "per-task",
      `task ${taskId}`,
    );
    if (perTaskResult.verdict) {
      return { verdict: perTaskResult.verdict, warnings: [...warnings, ...perTaskResult.warnings] };
    }
    warnings.push(...perTaskResult.warnings);

    const dailyResult = checkSingleCostLimit(
      accumulators.daily.cost_usd,
      costLimits.daily.cost_usd,
      "daily",
      "daily spend",
    );
    if (dailyResult.verdict) {
      return { verdict: dailyResult.verdict, warnings: [...warnings, ...dailyResult.warnings] };
    }
    warnings.push(...dailyResult.warnings);

    const monthlyResult = checkSingleCostLimit(
      accumulators.monthly.cost_usd,
      costLimits.monthly.cost_usd,
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
    if (taskId && costLimits.per_task.cost_usd !== null) {
      const spent = accumulators.per_task.get(taskId) ?? 0;
      if (spent >= costLimits.per_task.cost_usd) {
        return true;
      }
    }

    if (costLimits.daily.cost_usd !== null) {
      if (accumulators.daily.cost_usd >= costLimits.daily.cost_usd) {
        return true;
      }
    }

    if (costLimits.monthly.cost_usd !== null) {
      if (accumulators.monthly.cost_usd >= costLimits.monthly.cost_usd) {
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
    accumulateSpend(payload);

    lastSequence = event.sequence;
    maybeSaveSnapshot();

    checkAndEmitLimitBreaches(payload);
  }

  function onTaskStateChanged(event: Event): void {
    const payload = event.payload as unknown as TaskStateChangedPayload;
    if (payload.to_state === TaskStates.completed || payload.to_state === TaskStates.failed) {
      accumulators.per_task.delete(payload.task_id);
    }
  }

  function accumulateSpend(payload: CostIncurredPayload): void {
    const spend = payload.spend_usd ?? 0;

    // Track provider request count regardless of spend
    const existing = accumulators.providers.get(payload.provider_id) ?? { requests_used: 0 };
    existing.requests_used += 1;
    accumulators.providers.set(payload.provider_id, existing);

    if (spend <= 0) {
      return;
    }

    const taskCurrent = accumulators.per_task.get(payload.task_id) ?? 0;
    accumulators.per_task.set(payload.task_id, taskCurrent + spend);
    accumulators.daily.cost_usd += spend;
    accumulators.monthly.cost_usd += spend;
  }

  function rolloverWindows(nowDate: Date): void {
    const dailyStart = getDailyWindowStart(nowDate);
    if (dailyStart !== accumulators.daily.window_start) {
      observer.debug("Cost window rolled over", { window: "daily", newStart: dailyStart });
      accumulators.daily = { cost_usd: 0, window_start: dailyStart };
    }

    const monthlyStart = getMonthlyWindowStart(nowDate);
    if (monthlyStart !== accumulators.monthly.window_start) {
      observer.debug("Cost window rolled over", { window: "monthly", newStart: monthlyStart });
      accumulators.monthly = { cost_usd: 0, window_start: monthlyStart };
    }
  }

  function checkAndEmitLimitBreaches(payload: CostIncurredPayload): void {
    checkSpendLimitBreach("per_task", payload.task_id);
    checkSpendLimitBreach("daily", payload.task_id);
    checkSpendLimitBreach("monthly", payload.task_id);
    checkProviderLimitBreach(payload.provider_id, payload.task_id);
  }

  function checkSpendLimitBreach(
    limitType: "per_task" | "daily" | "monthly",
    taskId: string,
  ): void {
    const limitConfig = costLimits[limitType];
    if (limitConfig.cost_usd === null) {
      return;
    }

    let spent: number;
    if (limitType === "per_task") {
      spent = accumulators.per_task.get(taskId) ?? 0;
    } else if (limitType === "daily") {
      spent = accumulators.daily.cost_usd;
    } else {
      spent = accumulators.monthly.cost_usd;
    }

    if (spent >= limitConfig.cost_usd) {
      observer.warn("Cost limit breached", {
        limitType,
        spent,
        limit: limitConfig.cost_usd,
        taskId,
      });
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
          resets_at: null,
        },
      } satisfies PublishInput<"cost.limit_reached">);
    }
  }

  function checkProviderLimitBreach(providerId: string, taskId: string): void {
    const providerConfig = costLimits.providers[providerId];
    if (!providerConfig) {
      return;
    }

    const usage = accumulators.providers.get(providerId);
    if (!usage) {
      return;
    }

    if (
      providerConfig.daily_requests !== null &&
      usage.requests_used >= providerConfig.daily_requests
    ) {
      observer.warn("Provider usage limit breached", {
        providerId,
        limitType: "daily_requests",
        used: usage.requests_used,
        limit: providerConfig.daily_requests,
        taskId,
      });
      eventBus.publish({
        type: EventTypes["cost.limit_reached"],
        source: "safety_layer",
        task_id: taskId,
        payload: {
          task_id: taskId,
          limit_type: "daily" as const,
          limit_scope: providerId,
          current_spend: usage.requests_used,
          limit_value: providerConfig.daily_requests,
          resets_at: null,
        },
      } satisfies PublishInput<"cost.limit_reached">);
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
      per_task: Object.fromEntries(accumulators.per_task),
      daily: accumulators.daily,
      monthly: accumulators.monthly,
      providers: Object.fromEntries(accumulators.providers),
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
      observer.debug("Cost snapshot save failed — will retry on next event");
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

      accumulators.per_task = new Map(Object.entries(snapshot.per_task));

      if (snapshot.daily.window_start === currentDailyStart) {
        accumulators.daily = snapshot.daily;
      }

      if (snapshot.monthly.window_start === currentMonthlyStart) {
        accumulators.monthly = snapshot.monthly;
      }

      if (snapshot.providers) {
        accumulators.providers = new Map(Object.entries(snapshot.providers));
      }
      lastSequence = snapshot.last_sequence;
      observer.debug("Cost snapshot restored", {
        lastSequence,
        perTaskEntries: accumulators.per_task.size,
      });
    } catch {
      // Corrupt or old-format snapshot — fall back to zero accumulators + full replay
      observer.warn("Cost snapshot corrupted — falling back to full replay");
      lastSequence = 0;
    }
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: paginated event replay with window-aware accumulation
  function replayEvents(): void {
    const startSeq = lastSequence;
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
        replaySpendEvent(payload, new Date(event.timestamp), dailyStart, monthlyStart);

        lastSeq = event.sequence;
      }

      lastSequence = lastSeq;

      if (events.length < REPLAY_PAGE_SIZE) {
        break;
      }
    }

    if (lastSequence > startSeq) {
      observer.debug("Cost event replay completed", {
        fromSequence: startSeq,
        toSequence: lastSequence,
      });
    }
  }

  function replaySpendEvent(
    payload: CostIncurredPayload,
    eventTime: Date,
    dailyStart: string,
    monthlyStart: string,
  ): void {
    // Track provider request count
    const existing = accumulators.providers.get(payload.provider_id) ?? { requests_used: 0 };
    existing.requests_used += 1;
    accumulators.providers.set(payload.provider_id, existing);

    const spend = payload.spend_usd ?? 0;
    if (spend <= 0) {
      return;
    }

    const taskCurrent = accumulators.per_task.get(payload.task_id) ?? 0;
    accumulators.per_task.set(payload.task_id, taskCurrent + spend);

    if (getDailyWindowStart(eventTime) === dailyStart) {
      accumulators.daily.cost_usd += spend;
    }
    if (getMonthlyWindowStart(eventTime) === monthlyStart) {
      accumulators.monthly.cost_usd += spend;
    }
  }

  return { getCostStatus, checkCostLimits, isAnyLimitBreached, updateLimits, flush };
}
