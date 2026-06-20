import type Database from "better-sqlite3";

import { fromSqliteJson, toSqliteJson } from "../../db/serialize.js";
import type { CostLimits } from "../../schemas/config.js";
import { EventTypes } from "../../schemas/events.js";
import type { CostIncurredPayload, Event, TaskStateChangedPayload } from "../../schemas/events.js";
import { isTerminal } from "../../schemas/task.js";
import { sanitizeErrorMessage } from "../../utils/sanitize.js";
import type { IEventBus, PublishInput } from "../interfaces/event-bus.interface.js";
import type { CostStatus, CostSummary, SafetyVerdict } from "../interfaces/safety-layer.interface.js";
import type { IObserver } from "../observer/index.js";

// ── Internal Types ───────────────────────────────────────────────────────────

interface SpendWindow {
  cost_usd: number;
  window_start: string;
}

/**
 * Provider request counter scoped to a daily UTC window. `window_start` mirrors
 * `SpendWindow` so the count resets at the day boundary like daily cost does —
 * `daily_requests` is a per-day cap, not an all-time one (see {@link rolloverWindows}).
 */
interface ProviderUsageRecord {
  requests_used: number;
  window_start: string;
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

/** Per-window latch tracking which cost limits have already crossed 80% (so the crossing emits once). */
interface WindowedThresholdLatch {
  per_task: Set<string>;
  daily: boolean;
  monthly: boolean;
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

/** Whether spend has reached the warning threshold (80%) of a limit. */
function hasCrossedWarning(spent: number, limit: number): boolean {
  return spent / limit >= COST_WARNING_THRESHOLD;
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
  /** Account-wide spend vs configured limits (daily + monthly), for the owner's `!cost` query. */
  getCostSummary(): CostSummary;
  checkCostLimits(taskId: string): CostLimitCheckResult;
  isAnyLimitBreached(taskId?: string): boolean;
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
  const costLimits = deps.costLimits;

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

  // Edge-trigger latches: each transition emits/publishes once, then re-arms on the
  // relevant rollover (or on terminal-task prune for per_task). Without these, a naive
  // per-event check would spam the observation trail and the breach event past the
  // threshold — the noise the observability discipline forbids (§14, observability.md).
  const crossed80: WindowedThresholdLatch = { per_task: new Set<string>(), daily: false, monthly: false };
  const spendBreached: WindowedThresholdLatch = { per_task: new Set<string>(), daily: false, monthly: false };
  const providerBreached = new Set<string>();

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

    return {
      per_task_usd: perTaskUsd,
      daily_usd: dailyUsd,
      monthly_usd: monthlyUsd,
      warnings,
    };
  }

  /**
   * Account-wide spend vs configured limits, daily and monthly only — no per-task scope. Backs the
   * owner's `!cost` query, which is a status read rather than a per-action verdict; reuses the
   * account-wide (no-taskId) reads so warning thresholds and null-limit handling stay in one place.
   */
  function getCostSummary(): CostSummary {
    const status = getCostStatus();
    return {
      daily_usd: status.daily_usd,
      daily_limit_usd: costLimits.daily.cost_usd,
      monthly_usd: status.monthly_usd,
      monthly_limit_usd: costLimits.monthly.cost_usd,
      breached: isAnyLimitBreached(),
      warnings: status.warnings,
    };
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
    // After rollover, daily.window_start is the current daily window — the one a provider count belongs to.
    accumulateSpend(payload, accumulators.daily.window_start);

    lastSequence = event.sequence;
    maybeSaveSnapshot();

    emitThresholdCrossings(payload.task_id);
    checkAndEmitLimitBreaches(payload);
  }

  function onTaskStateChanged(event: Event): void {
    const payload = event.payload as unknown as TaskStateChangedPayload;
    if (isTerminal(payload.to_state)) {
      accumulators.per_task.delete(payload.task_id);
      crossed80.per_task.delete(payload.task_id);
      spendBreached.per_task.delete(payload.task_id);
    }
  }

  function accumulateSpend(payload: CostIncurredPayload, windowStart: string): void {
    const spend = payload.spend_usd ?? 0;

    // Track provider request count regardless of spend, scoped to the current daily window.
    incrementProviderUsage(payload.provider_id, windowStart);

    if (spend <= 0) {
      return;
    }

    const taskCurrent = accumulators.per_task.get(payload.task_id) ?? 0;
    accumulators.per_task.set(payload.task_id, taskCurrent + spend);
    accumulators.daily.cost_usd += spend;
    accumulators.monthly.cost_usd += spend;
  }

  /** Increment a provider's request count within the given daily window, seeding the window on first sight. */
  function incrementProviderUsage(providerId: string, windowStart: string): void {
    const existing = accumulators.providers.get(providerId) ?? { requests_used: 0, window_start: windowStart };
    existing.requests_used += 1;
    accumulators.providers.set(providerId, existing);
  }

  function rolloverWindows(nowDate: Date): void {
    const dailyStart = getDailyWindowStart(nowDate);
    if (dailyStart !== accumulators.daily.window_start) {
      const previousStart = accumulators.daily.window_start;
      accumulators.daily = { cost_usd: 0, window_start: dailyStart };
      // Provider request caps are per-day too — reset every provider into the new window so a
      // provider that hit its cap yesterday is usable again today (the daily_requests contract).
      resetProviderWindows(dailyStart);
      crossed80.daily = false;
      spendBreached.daily = false;
      providerBreached.clear();
      emitWindowRollover("daily", previousStart, dailyStart);
    }

    const monthlyStart = getMonthlyWindowStart(nowDate);
    if (monthlyStart !== accumulators.monthly.window_start) {
      const previousStart = accumulators.monthly.window_start;
      accumulators.monthly = { cost_usd: 0, window_start: monthlyStart };
      crossed80.monthly = false;
      spendBreached.monthly = false;
      emitWindowRollover("monthly", previousStart, monthlyStart);
    }
  }

  /** Reset every provider's request counter into the new daily window (mirrors daily.cost_usd reset). */
  function resetProviderWindows(windowStart: string): void {
    for (const providerId of accumulators.providers.keys()) {
      accumulators.providers.set(providerId, { requests_used: 0, window_start: windowStart });
    }
  }

  // ── Private: Observability Emissions (edge-triggered) ──────────────────────

  /** Record a window rollover once per boundary, so the owner sees a day/month reset on the trace. */
  function emitWindowRollover(window: "daily" | "monthly", previousStart: string, newStart: string): void {
    observer.observe("state_transition", "cost_window_rolled_over", {
      window,
      previous_window_start: previousStart,
      new_window_start: newStart,
    });
  }

  /** Emit a cost-limit 80%-crossing once per window per limit, re-armed on the window's rollover. */
  function emitThresholdCrossings(taskId: string): void {
    if (taskId) {
      emitCrossingOnce("per_task", accumulators.per_task.get(taskId) ?? 0, costLimits.per_task.cost_usd, taskId, {
        isLatched: () => crossed80.per_task.has(taskId),
        latch: () => crossed80.per_task.add(taskId),
      });
    }
    emitCrossingOnce("daily", accumulators.daily.cost_usd, costLimits.daily.cost_usd, null, {
      isLatched: () => crossed80.daily,
      latch: () => {
        crossed80.daily = true;
      },
    });
    emitCrossingOnce("monthly", accumulators.monthly.cost_usd, costLimits.monthly.cost_usd, null, {
      isLatched: () => crossed80.monthly,
      latch: () => {
        crossed80.monthly = true;
      },
    });
  }

  /** Record one window's 80%-of-limit crossing as a state transition, but only on the first crossing. */
  function emitCrossingOnce(
    limitType: "per_task" | "daily" | "monthly",
    spent: number,
    limit: number | null,
    taskId: string | null,
    latch: { isLatched: () => boolean; latch: () => void },
  ): void {
    if (limit === null || !hasCrossedWarning(spent, limit) || latch.isLatched()) {
      return;
    }
    latch.latch();
    observer.observe(
      "state_transition",
      "cost_warning_threshold_crossed",
      {
        limit_type: limitType,
        spent_usd: spent,
        limit_usd: limit,
        percent: Math.round((spent / limit) * 100),
      },
      taskId ? { task_id: taskId } : undefined,
    );
  }

  function checkAndEmitLimitBreaches(payload: CostIncurredPayload): void {
    checkSpendLimitBreach("per_task", payload.task_id);
    checkSpendLimitBreach("daily", payload.task_id);
    checkSpendLimitBreach("monthly", payload.task_id);
    checkProviderLimitBreach(payload.provider_id, payload.task_id);
  }

  function checkSpendLimitBreach(limitType: "per_task" | "daily" | "monthly", taskId: string): void {
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

    if (spent < limitConfig.cost_usd) {
      return;
    }

    // Edge-trigger: warn + publish once on the crossing, then latch. Daily/monthly re-arm on their
    // window rollover; per_task re-arms when the task reaches a terminal state — mirroring crossed80
    // and providerBreached. Without this latch, every event past the limit re-fires the breach,
    // spamming the observation trail and the cost.limit_reached event (§14, observability.md).
    if (isSpendBreachLatched(limitType, taskId)) {
      return;
    }
    latchSpendBreach(limitType, taskId);

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

  /** Whether a spend-limit breach has already been emitted for this window/task (so it emits once). */
  function isSpendBreachLatched(limitType: "per_task" | "daily" | "monthly", taskId: string): boolean {
    return limitType === "per_task" ? spendBreached.per_task.has(taskId) : spendBreached[limitType];
  }

  /** Latch a spend-limit breach after its single emission, re-armed by rollover or terminal-task prune. */
  function latchSpendBreach(limitType: "per_task" | "daily" | "monthly", taskId: string): void {
    if (limitType === "per_task") {
      spendBreached.per_task.add(taskId);
    } else {
      spendBreached[limitType] = true;
    }
  }

  function checkProviderLimitBreach(providerId: string, taskId: string): void {
    const providerConfig = costLimits.providers[providerId];
    if (!providerConfig || providerConfig.daily_requests === null) {
      return;
    }

    const usage = accumulators.providers.get(providerId);
    if (!usage || usage.requests_used < providerConfig.daily_requests) {
      return;
    }

    // Edge-trigger: publish once on the crossing, then latch until the daily rollover re-arms it
    // (providerBreached.clear() in rolloverWindows) — not on every event past the cap.
    if (providerBreached.has(providerId)) {
      return;
    }
    providerBreached.add(providerId);

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
      saveSnapshotStmt.run(META_KEY, toSqliteJson(snapshot));
      snapshotDirty = false;
      lastSnapshotAt = Date.now();
    } catch (error) {
      // A persistent snapshot failure means crash recovery degrades from fast snapshot+replay
      // to a full replay from sequence 0 — slower, and undercounting if the events table has
      // since pruned below the monthly window. Loud so the operator can act, not a silent debug.
      // snapshotDirty stays true so the next event retries; in-memory accumulators stay authoritative.
      observer.warn("Cost snapshot save failed — crash recovery degrades to full event replay", {
        error: sanitizeErrorMessage(error),
        lastSequence,
      });
    }
  }

  function restoreFromSnapshot(): void {
    const row = getSnapshotStmt.get(META_KEY) as { value: string } | undefined;
    if (!row) {
      return;
    }

    try {
      const snapshot = fromSqliteJson<AccumulatorSnapshot>(row.value);
      if (!snapshot) {
        return;
      }
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
        accumulators.providers = restoreProviderWindows(snapshot.providers, currentDailyStart);
      }
      lastSequence = snapshot.last_sequence;
      observer.debug("Cost snapshot restored", {
        lastSequence,
        perTaskEntries: accumulators.per_task.size,
      });
    } catch (error) {
      // Corrupt or old-format snapshot — fall back to zero accumulators + full replay
      observer.warn("Cost snapshot corrupted — falling back to full replay", {
        error: sanitizeErrorMessage(error),
      });
      lastSequence = 0;
    }
  }

  /**
   * Adopt a provider's snapshot count only when its window is still today's (mirrors the daily-cost
   * restore guard); a stale or window-less (old-format) record starts fresh in the current window —
   * so a count from yesterday never carries forward past midnight on restart.
   */
  function restoreProviderWindows(
    snapshotProviders: Record<string, ProviderUsageRecord>,
    currentDailyStart: string,
  ): Map<string, ProviderUsageRecord> {
    const restored = new Map<string, ProviderUsageRecord>();
    for (const [providerId, record] of Object.entries(snapshotProviders)) {
      if (record.window_start === currentDailyStart) {
        restored.set(providerId, record);
      } else {
        restored.set(providerId, { requests_used: 0, window_start: currentDailyStart });
      }
    }
    return restored;
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
    const eventDailyStart = getDailyWindowStart(eventTime);

    // Provider request counts are per-day — only events within today's window count toward the
    // current cap, so a full replay spanning midnight excludes yesterday (mirrors the daily-cost filter).
    if (eventDailyStart === dailyStart) {
      incrementProviderUsage(payload.provider_id, dailyStart);
    }

    const spend = payload.spend_usd ?? 0;
    if (spend <= 0) {
      return;
    }

    const taskCurrent = accumulators.per_task.get(payload.task_id) ?? 0;
    accumulators.per_task.set(payload.task_id, taskCurrent + spend);

    if (eventDailyStart === dailyStart) {
      accumulators.daily.cost_usd += spend;
    }
    if (getMonthlyWindowStart(eventTime) === monthlyStart) {
      accumulators.monthly.cost_usd += spend;
    }
  }

  return { getCostStatus, getCostSummary, checkCostLimits, isAnyLimitBreached, flush };
}
