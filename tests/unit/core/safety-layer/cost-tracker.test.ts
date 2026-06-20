import { afterEach, describe, expect, it } from "vitest";

import { EventBus } from "../../../../src/core/event-bus/index.js";
import type { EventRow } from "../../../../src/core/event-bus/index.js";
import { rowToEvent } from "../../../../src/core/event-bus/index.js";
import {
  createCostTracker,
  getDailyWindowStart,
  getMonthlyWindowStart,
} from "../../../../src/core/safety-layer/cost-tracker.js";
import { SafetyConfigSchema } from "../../../../src/schemas/config.js";
import type { CostIncurredPayload, Event } from "../../../../src/schemas/events.js";
import { EventTypes } from "../../../../src/schemas/events.js";
import { SubStates, TaskStates } from "../../../../src/schemas/task.js";
import { type TestDatabaseHandle, createTestDatabase } from "../../../helpers/test-database.js";
import { createTestObserverFacade } from "../../../helpers/test-observer-facade.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

let testDb: TestDatabaseHandle;
let eventBus: EventBus;

afterEach(() => {
  testDb?.cleanup();
});

function createTracker(limitOverrides: Parameters<typeof SafetyConfigSchema.parse>[0] = {}) {
  testDb = createTestDatabase();
  const observer = createTestObserverFacade("event-bus");
  eventBus = new EventBus(testDb.db, { observer });
  const config = SafetyConfigSchema.parse(limitOverrides);
  const costObserver = createTestObserverFacade("safety-layer");
  const tracker = createCostTracker({
    db: testDb.db,
    eventBus,
    costLimits: config.cost_limits,
    observer: costObserver,
  });
  return { tracker, eventBus, db: testDb.db };
}

function simulateCostEvent(eb: EventBus, overrides: Partial<CostIncurredPayload> = {}): Event {
  const defaults: CostIncurredPayload = {
    task_id: "task-1",
    repo: "owner/repo",
    provider_id: "claude-api",
    operation: "agent_call",
    spend_usd: 0.01,
    duration_ms: null,
    input_tokens: null,
    output_tokens: null,
    total_tokens: null,
    cache_read_tokens: null,
    model_id: null,
  };
  return eb.publish({
    type: EventTypes["cost.incurred"],
    source: "test",
    task_id: overrides.task_id ?? defaults.task_id,
    payload: { ...defaults, ...overrides },
  });
}

function getEmittedEvents(db: import("better-sqlite3").Database, type: string): Event[] {
  const stmt = db.prepare("SELECT * FROM events WHERE type = ? ORDER BY sequence");
  const rows = stmt.all(type) as EventRow[];
  return rows.map(rowToEvent);
}

const ONE_DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * Insert a cost.incurred row directly with a chosen timestamp — the only way to place an event in a
 * past or future daily window, since `EventBus.publish` always stamps `now`. Returns its sequence.
 */
function insertRawCostEvent(
  db: import("better-sqlite3").Database,
  timestamp: Date,
  overrides: Partial<CostIncurredPayload> = {},
): number {
  const payload: CostIncurredPayload = {
    task_id: "task-1",
    repo: "owner/repo",
    provider_id: "claude-api",
    operation: "agent_call",
    spend_usd: 0.01,
    duration_ms: null,
    input_tokens: null,
    output_tokens: null,
    total_tokens: null,
    cache_read_tokens: null,
    model_id: null,
    ...overrides,
  };
  const result = db
    .prepare("INSERT INTO events (id, type, source, task_id, timestamp, payload) VALUES (?, ?, ?, ?, ?, ?)")
    .run(
      `evt-${timestamp.getTime()}-${Math.random().toString(36).slice(2)}`,
      EventTypes["cost.incurred"],
      "test",
      payload.task_id,
      timestamp.toISOString(),
      JSON.stringify(payload),
    );
  return Number(result.lastInsertRowid);
}

/** An observer that records every instant observation, so a test can assert how many times one fires. */
function createRecordingObserver(): {
  observer: ReturnType<typeof createTestObserverFacade>;
  observations: { type: string; name: string }[];
} {
  const observer = createTestObserverFacade("safety-layer");
  const observations: { type: string; name: string }[] = [];
  const original = observer.observe.bind(observer);
  observer.observe = (type, name, data, options) => {
    observations.push({ type, name });
    return original(type, name, data, options);
  };
  return { observer, observations };
}

// ── Pure Functions ───────────────────────────────────────────────────────────

describe("getDailyWindowStart", () => {
  it("returns midnight UTC", () => {
    expect(getDailyWindowStart(new Date("2026-03-11T14:32:00Z"))).toBe("2026-03-11T00:00:00.000Z");
  });
});

describe("getMonthlyWindowStart", () => {
  it("returns first of month midnight UTC", () => {
    expect(getMonthlyWindowStart(new Date("2026-03-15T10:00:00Z"))).toBe("2026-03-01T00:00:00.000Z");
  });
});

// ── CostTracker — Accumulation ───────────────────────────────────────────────

describe("CostTracker — accumulation", () => {
  it("accumulates API spend per task", () => {
    const { tracker, eventBus: eb } = createTracker();
    simulateCostEvent(eb, { task_id: "task-1", spend_usd: 0.1 });
    simulateCostEvent(eb, { task_id: "task-1", spend_usd: 0.05 });

    const status = tracker.getCostStatus("task-1");
    expect(status.per_task_usd).toBeCloseTo(0.15);
  });

  it("accumulates daily and monthly across tasks", () => {
    const { tracker, eventBus: eb } = createTracker();
    simulateCostEvent(eb, { task_id: "task-1", spend_usd: 0.1 });
    simulateCostEvent(eb, { task_id: "task-2", spend_usd: 0.2 });

    const status = tracker.getCostStatus();
    expect(status.daily_usd).toBeCloseTo(0.3);
    expect(status.monthly_usd).toBeCloseTo(0.3);
  });

  it("keeps per-task accumulators independent", () => {
    const { tracker, eventBus: eb } = createTracker();
    simulateCostEvent(eb, { task_id: "task-1", spend_usd: 0.1 });
    simulateCostEvent(eb, { task_id: "task-2", spend_usd: 0.2 });

    expect(tracker.getCostStatus("task-1").per_task_usd).toBeCloseTo(0.1);
    expect(tracker.getCostStatus("task-2").per_task_usd).toBeCloseTo(0.2);
  });

  it("ignores zero and null spend for API", () => {
    const { tracker, eventBus: eb } = createTracker();
    simulateCostEvent(eb, { spend_usd: null });
    simulateCostEvent(eb, { spend_usd: 0 });
    simulateCostEvent(eb, { spend_usd: 0.05 });

    expect(tracker.getCostStatus("task-1").per_task_usd).toBeCloseTo(0.05);
  });

  it("tracks provider usage without affecting spend when spend_usd is null", () => {
    const { tracker, eventBus: eb } = createTracker();
    simulateCostEvent(eb, {
      provider_id: "claude-code",
      spend_usd: null,
    });

    expect(tracker.getCostStatus("task-1").daily_usd).toBe(0);
  });
});

// ── CostTracker — Account-Wide Summary ───────────────────────────────────────

describe("CostTracker — getCostSummary", () => {
  it("returns daily and monthly spend with their configured limits", () => {
    const { tracker, eventBus: eb } = createTracker({
      cost_limits: { daily: { cost_usd: 25 }, monthly: { cost_usd: 250 } },
    });
    simulateCostEvent(eb, { task_id: "task-1", spend_usd: 3.2 });

    const summary = tracker.getCostSummary();
    expect(summary.daily_usd).toBeCloseTo(3.2);
    expect(summary.daily_limit_usd).toBe(25);
    expect(summary.monthly_usd).toBeCloseTo(3.2);
    expect(summary.monthly_limit_usd).toBe(250);
    expect(summary.breached).toBe(false);
  });

  it("is account-wide: a per-task breach does not mark the summary breached", () => {
    const { tracker, eventBus: eb } = createTracker({ cost_limits: { per_task: { cost_usd: 0.05 } } });
    simulateCostEvent(eb, { task_id: "task-1", spend_usd: 0.1 });

    expect(tracker.getCostSummary().breached).toBe(false);
  });

  it("flags breached once the daily limit is reached across tasks", () => {
    const { tracker, eventBus: eb } = createTracker({ cost_limits: { daily: { cost_usd: 0.25 } } });
    simulateCostEvent(eb, { task_id: "task-1", spend_usd: 0.1 });
    simulateCostEvent(eb, { task_id: "task-2", spend_usd: 0.2 });

    expect(tracker.getCostSummary().breached).toBe(true);
  });

  it("reports null limits for unbounded windows", () => {
    const { tracker, eventBus: eb } = createTracker({
      cost_limits: { daily: { cost_usd: null }, monthly: { cost_usd: null } },
    });
    simulateCostEvent(eb, { task_id: "task-1", spend_usd: 5.0 });

    const summary = tracker.getCostSummary();
    expect(summary.daily_limit_usd).toBeNull();
    expect(summary.monthly_limit_usd).toBeNull();
  });
});

// ── CostTracker — Terminal Task Cleanup ──────────────────────────────────────

describe("CostTracker — per_task cleanup on terminal state", () => {
  it("prunes per_task entry when task completes", () => {
    const { tracker, eventBus: eb } = createTracker();
    simulateCostEvent(eb, { task_id: "task-1", spend_usd: 0.5 });
    expect(tracker.getCostStatus("task-1").per_task_usd).toBeCloseTo(0.5);

    // Simulate task completion via state change event
    eb.publish({
      type: EventTypes["task.state_changed"],
      source: "task_engine",
      task_id: "task-1",
      payload: {
        task_id: "task-1",
        from_state: TaskStates.active,
        from_sub: SubStates.working,
        to_state: TaskStates.completed,
        to_sub: null,
        reason: "pipeline_completed",
        triggered_by: "daemon",
      },
    });

    expect(tracker.getCostStatus("task-1").per_task_usd).toBe(0);
  });

  it("prunes per_task entry when task fails", () => {
    const { tracker, eventBus: eb } = createTracker();
    simulateCostEvent(eb, { task_id: "task-1", spend_usd: 0.3 });

    eb.publish({
      type: EventTypes["task.state_changed"],
      source: "task_engine",
      task_id: "task-1",
      payload: {
        task_id: "task-1",
        from_state: TaskStates.blocked,
        from_sub: null,
        to_state: TaskStates.failed,
        to_sub: null,
        reason: "escalation",
        triggered_by: "daemon",
      },
    });

    expect(tracker.getCostStatus("task-1").per_task_usd).toBe(0);
  });

  it("does not prune active tasks", () => {
    const { tracker, eventBus: eb } = createTracker();
    simulateCostEvent(eb, { task_id: "task-1", spend_usd: 0.2 });

    eb.publish({
      type: EventTypes["task.state_changed"],
      source: "task_engine",
      task_id: "task-1",
      payload: {
        task_id: "task-1",
        from_state: TaskStates.queued,
        from_sub: null,
        to_state: TaskStates.active,
        to_sub: SubStates.working,
        reason: "scheduled",
        triggered_by: "daemon",
      },
    });

    expect(tracker.getCostStatus("task-1").per_task_usd).toBeCloseTo(0.2);
  });
});

// ── CostTracker — Limit Detection ────────────────────────────────────────────

describe("CostTracker — limit detection", () => {
  it("emits cost.limit_reached when per-task limit hit", () => {
    const { eventBus: eb, db } = createTracker({
      cost_limits: { per_task: { cost_usd: 0.1 } },
    });
    simulateCostEvent(eb, { task_id: "task-1", spend_usd: 0.12 });

    const events = getEmittedEvents(db, "cost.limit_reached");
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => e.payload["limit_type"] === "per_task")).toBe(true);
  });

  it("emits cost.limit_reached when daily limit hit", () => {
    const { eventBus: eb, db } = createTracker({
      cost_limits: { daily: { cost_usd: 0.2 } },
    });
    simulateCostEvent(eb, { spend_usd: 0.12 });
    simulateCostEvent(eb, { spend_usd: 0.12 });

    const events = getEmittedEvents(db, "cost.limit_reached");
    expect(events.some((e) => e.payload["limit_type"] === "daily")).toBe(true);
  });

  it("does not emit when limits are null", () => {
    const { eventBus: eb, db } = createTracker({
      cost_limits: {
        per_task: { cost_usd: null },
        daily: { cost_usd: null },
        monthly: { cost_usd: null },
      },
    });
    simulateCostEvent(eb, { spend_usd: 100.0 });

    expect(getEmittedEvents(db, "cost.limit_reached")).toHaveLength(0);
  });

  it("detects provider daily_requests limit", () => {
    const { eventBus: eb, db } = createTracker({
      cost_limits: { providers: { "claude-code": { daily_requests: 2 } } },
    });
    simulateCostEvent(eb, {
      provider_id: "claude-code",
      spend_usd: null,
    });
    simulateCostEvent(eb, {
      provider_id: "claude-code",
      spend_usd: null,
    });

    const events = getEmittedEvents(db, "cost.limit_reached");
    expect(events.some((e) => e.payload["limit_scope"] === "claude-code")).toBe(true);
  });

  it("publishes the provider breach once per window, not on every event past the cap", () => {
    const { eventBus: eb, db } = createTracker({
      cost_limits: { providers: { "claude-code": { daily_requests: 2 } } },
    });

    // Four requests today against a cap of 2: the breach publishes once on the crossing (request 2),
    // then stays latched for requests 3 and 4 — an edge-trigger, not one owner alert per event past the cap.
    for (let i = 0; i < 4; i++) {
      simulateCostEvent(eb, { provider_id: "claude-code", spend_usd: null });
    }

    const breaches = getEmittedEvents(db, "cost.limit_reached").filter(
      (e) => e.payload["limit_scope"] === "claude-code",
    );
    expect(breaches).toHaveLength(1);
  });

  it("publishes a per-task breach once, not on every event past the limit", () => {
    const { eventBus: eb, db } = createTracker({
      cost_limits: { per_task: { cost_usd: 0.1 } },
    });

    // Three over-limit events on one task: the breach publishes once on the crossing,
    // then stays latched — an edge-trigger, not one owner alert per event past the limit.
    simulateCostEvent(eb, { task_id: "task-1", spend_usd: 0.12 });
    simulateCostEvent(eb, { task_id: "task-1", spend_usd: 0.05 });
    simulateCostEvent(eb, { task_id: "task-1", spend_usd: 0.05 });

    const breaches = getEmittedEvents(db, "cost.limit_reached").filter((e) => e.payload["limit_type"] === "per_task");
    expect(breaches).toHaveLength(1);
  });

  it("publishes a daily breach once, not on every event past the limit", () => {
    const { eventBus: eb, db } = createTracker({
      cost_limits: { daily: { cost_usd: 0.2 } },
    });

    // Three events that together exceed the daily limit and then stay above it: one breach only.
    simulateCostEvent(eb, { spend_usd: 0.12 });
    simulateCostEvent(eb, { spend_usd: 0.12 });
    simulateCostEvent(eb, { spend_usd: 0.12 });

    const breaches = getEmittedEvents(db, "cost.limit_reached").filter((e) => e.payload["limit_type"] === "daily");
    expect(breaches).toHaveLength(1);
  });

  it("re-arms the daily breach after a UTC daily rollover", () => {
    const {
      tracker,
      eventBus: eb,
      db,
    } = createTracker({
      cost_limits: { daily: { cost_usd: 0.2 } },
    });

    // Today: cross the daily limit — one breach published, then latched.
    simulateCostEvent(eb, { spend_usd: 0.12 });
    const todaySeq = simulateCostEvent(eb, { spend_usd: 0.12 }).sequence;
    expect(getEmittedEvents(db, "cost.limit_reached").filter((e) => e.payload["limit_type"] === "daily")).toHaveLength(
      1,
    );

    // A next-day event rolls the daily window over, which resets the accumulator and re-arms the
    // breach latch. (A breach published mid-replay would not persist — better-sqlite3 forbids
    // writing through a live read iterator — so this event stays under the limit and only drives
    // the rollover; its effect is observed through the reset accumulator, not a breach event.)
    insertRawCostEvent(db, new Date(Date.now() + ONE_DAY_MS), { spend_usd: 0.12 });
    eb.replay(todaySeq);
    expect(tracker.getCostStatus().daily_usd).toBeCloseTo(0.12);

    // Fresh live spend opens a clean daily window and crosses the limit again. Because the latch
    // re-armed on the rollover, this publishes a second daily breach — proving the latch does not
    // suppress every later breach forever once the first one fires.
    simulateCostEvent(eb, { spend_usd: 0.12 });
    simulateCostEvent(eb, { spend_usd: 0.12 });
    expect(getEmittedEvents(db, "cost.limit_reached").filter((e) => e.payload["limit_type"] === "daily")).toHaveLength(
      2,
    );
  });
});

// ── CostTracker — Provider Daily Window Reset ────────────────────────────────

describe("CostTracker — provider daily window", () => {
  it("resets provider requests on UTC daily rollover", () => {
    const { eventBus: eb, db } = createTracker({
      cost_limits: { providers: { "claude-api": { daily_requests: 2 } } },
    });

    // One request today — under the cap of 2, so no breach yet.
    const todaySeq = simulateCostEvent(eb, { provider_id: "claude-api", spend_usd: null }).sequence;
    expect(getEmittedEvents(db, "cost.limit_reached")).toHaveLength(0);

    // A request dated tomorrow crosses the day boundary: rollover resets the provider counter to 0,
    // so this counts as request 1 of the new day — not request 2 — and stays under the cap.
    insertRawCostEvent(db, new Date(Date.now() + ONE_DAY_MS), { provider_id: "claude-api", spend_usd: null });
    eb.replay(todaySeq);

    expect(getEmittedEvents(db, "cost.limit_reached")).toHaveLength(0);
  });

  it("drops yesterday's provider count on restore across a rollover (window_start mismatch)", () => {
    const { eventBus: eb, db } = createTracker({
      cost_limits: { providers: { "claude-api": { daily_requests: 2 } } },
    });

    // Seed a snapshot whose provider already sits at its cap of 2 — but in yesterday's window.
    const yesterdayStart = getDailyWindowStart(new Date(Date.now() - ONE_DAY_MS));
    const todayStart = getDailyWindowStart(new Date());
    const snapshot = {
      per_task: {},
      daily: { cost_usd: 0, window_start: todayStart },
      monthly: { cost_usd: 0, window_start: getMonthlyWindowStart(new Date()) },
      providers: { "claude-api": { requests_used: 2, window_start: yesterdayStart } },
      last_sequence: 0,
      snapshot_at: new Date().toISOString(),
    };
    db.prepare("INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)").run(
      "safety_snapshot",
      JSON.stringify(snapshot),
    );

    // A fresh tracker restores the snapshot; the provider's window is yesterday's, so its count is dropped
    // to 0 in today's window. A single new request today must NOT breach the cap of 2.
    const config = SafetyConfigSchema.parse({ cost_limits: { providers: { "claude-api": { daily_requests: 2 } } } });
    createCostTracker({
      db,
      eventBus: eb,
      costLimits: config.cost_limits,
      observer: createTestObserverFacade("safety-layer"),
    });
    simulateCostEvent(eb, { provider_id: "claude-api", spend_usd: null });

    expect(getEmittedEvents(db, "cost.limit_reached")).toHaveLength(0);
  });

  it("counts only today's provider requests on a snapshot-loss full replay across midnight", () => {
    testDb = createTestDatabase();
    const observer = createTestObserverFacade("event-bus");
    eventBus = new EventBus(testDb.db, { observer });
    const db = testDb.db;

    // Two requests yesterday, one request today — all in the event log, no snapshot.
    insertRawCostEvent(db, new Date(Date.now() - ONE_DAY_MS), { provider_id: "claude-api", spend_usd: null });
    insertRawCostEvent(db, new Date(Date.now() - ONE_DAY_MS), { provider_id: "claude-api", spend_usd: null });
    insertRawCostEvent(db, new Date(), { provider_id: "claude-api", spend_usd: null });
    db.prepare("DELETE FROM _meta WHERE key = 'safety_snapshot'").run();

    // Full replay from sequence 0 (snapshot loss). Only today's single request counts; yesterday's two
    // are excluded by window. A breach payload reports requests_used, so one more live request today must
    // bring the count to 2 (today's replayed 1 + this 1) — proving yesterday's 2 were NOT folded in.
    const config = SafetyConfigSchema.parse({ cost_limits: { providers: { "claude-api": { daily_requests: 2 } } } });
    createCostTracker({
      db,
      eventBus,
      costLimits: config.cost_limits,
      observer: createTestObserverFacade("safety-layer"),
    });
    simulateCostEvent(eventBus, { provider_id: "claude-api", spend_usd: null });

    const breaches = getEmittedEvents(db, "cost.limit_reached");
    expect(breaches).toHaveLength(1);
    expect(breaches[0]?.payload["current_spend"]).toBe(2);
  });
});

// ── CostTracker — checkCostLimits & isAnyLimitBreached ───────────────────────

describe("CostTracker — checkCostLimits", () => {
  it("returns deny verdict when per-task limit breached", () => {
    const { tracker, eventBus: eb } = createTracker({
      cost_limits: { per_task: { cost_usd: 0.05 } },
    });
    simulateCostEvent(eb, { task_id: "task-1", spend_usd: 0.1 });

    const { verdict } = tracker.checkCostLimits("task-1");
    expect(verdict).not.toBeNull();
    expect(verdict?.action).toBe("deny");
  });

  it("returns null verdict and populates warnings when approaching limit", () => {
    const { tracker, eventBus: eb } = createTracker({
      cost_limits: { per_task: { cost_usd: 1.0 } },
    });
    simulateCostEvent(eb, { task_id: "task-1", spend_usd: 0.85 });

    const { verdict, warnings } = tracker.checkCostLimits("task-1");
    expect(verdict).toBeNull();
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain("85%");
  });

  it("returns null verdict when within limits", () => {
    const { tracker, eventBus: eb } = createTracker({
      cost_limits: { per_task: { cost_usd: 1.0 } },
    });
    simulateCostEvent(eb, { task_id: "task-1", spend_usd: 0.1 });

    const { verdict, warnings } = tracker.checkCostLimits("task-1");
    expect(verdict).toBeNull();
    expect(warnings).toHaveLength(0);
  });
});

describe("CostTracker — isAnyLimitBreached", () => {
  it("returns true when per-task limit breached", () => {
    const { tracker, eventBus: eb } = createTracker({
      cost_limits: { per_task: { cost_usd: 0.05 } },
    });
    simulateCostEvent(eb, { task_id: "task-1", spend_usd: 0.1 });

    expect(tracker.isAnyLimitBreached("task-1")).toBe(true);
  });

  it("returns false when within limits", () => {
    const { tracker, eventBus: eb } = createTracker({
      cost_limits: { per_task: { cost_usd: 1.0 } },
    });
    simulateCostEvent(eb, { task_id: "task-1", spend_usd: 0.1 });

    expect(tracker.isAnyLimitBreached("task-1")).toBe(false);
  });
});

// ── CostTracker — Snapshot ───────────────────────────────────────────────────

describe("CostTracker — snapshot", () => {
  it("round-trips: save → new instance → accumulators match", () => {
    const { eventBus: eb, db } = createTracker();
    simulateCostEvent(eb, { task_id: "task-1", spend_usd: 0.25 });
    simulateCostEvent(eb, { task_id: "task-2", spend_usd: 0.1 });

    // Create new CostTracker on same DB
    const config = SafetyConfigSchema.parse({});
    const restored = createCostTracker({
      db,
      eventBus: eb,
      costLimits: config.cost_limits,
      observer: createTestObserverFacade("safety-layer"),
    });

    expect(restored.getCostStatus("task-1").per_task_usd).toBeCloseTo(0.25);
    expect(restored.getCostStatus("task-2").per_task_usd).toBeCloseTo(0.1);
  });

  it("handles corrupt snapshot gracefully", () => {
    const { eventBus: eb, db } = createTracker();
    simulateCostEvent(eb, { task_id: "task-1", spend_usd: 0.1 });

    // Corrupt the snapshot
    db.prepare("UPDATE _meta SET value = 'not-json' WHERE key = 'safety_snapshot'").run();

    // Should not throw — falls back to full replay
    const config = SafetyConfigSchema.parse({});
    const restored = createCostTracker({
      db,
      eventBus: eb,
      costLimits: config.cost_limits,
      observer: createTestObserverFacade("safety-layer"),
    });
    expect(restored.getCostStatus("task-1").per_task_usd).toBeCloseTo(0.1);
  });

  it("handles missing snapshot with full replay", () => {
    const { eventBus: eb, db } = createTracker();
    simulateCostEvent(eb, { task_id: "task-1", spend_usd: 0.1 });

    db.prepare("DELETE FROM _meta WHERE key = 'safety_snapshot'").run();

    const config = SafetyConfigSchema.parse({});
    const restored = createCostTracker({
      db,
      eventBus: eb,
      costLimits: config.cost_limits,
      observer: createTestObserverFacade("safety-layer"),
    });
    expect(restored.getCostStatus("task-1").per_task_usd).toBeGreaterThan(0);
  });
});

// ── CostTracker — Paginated Replay ───────────────────────────────────────────

describe("CostTracker — paginated replay", () => {
  it("replays correctly when events exceed page size", () => {
    testDb = createTestDatabase();
    const observer = createTestObserverFacade("event-bus");
    eventBus = new EventBus(testDb.db, { observer });
    const config = SafetyConfigSchema.parse({});

    // Generate 50 cost events (small but tests pagination logic path)
    for (let i = 0; i < 50; i++) {
      simulateCostEvent(eventBus, { task_id: "task-1", spend_usd: 0.01 });
    }

    // Delete snapshot so new CostTracker must replay everything
    testDb.db.prepare("DELETE FROM _meta WHERE key = 'safety_snapshot'").run();

    const tracker = createCostTracker({
      db: testDb.db,
      eventBus,
      costLimits: config.cost_limits,
      observer: createTestObserverFacade("safety-layer"),
    });
    expect(tracker.getCostStatus("task-1").per_task_usd).toBeCloseTo(0.5);
  });
});

// ── CostTracker — getCostStatus warnings ─────────────────────────────────────

describe("CostTracker — getCostStatus warnings", () => {
  it("includes warning when approaching per-task limit", () => {
    const { tracker, eventBus: eb } = createTracker({
      cost_limits: { per_task: { cost_usd: 1.0 } },
    });
    simulateCostEvent(eb, { task_id: "task-1", spend_usd: 0.85 });

    const status = tracker.getCostStatus("task-1");
    expect(status.warnings.length).toBeGreaterThan(0);
    expect(status.warnings[0]).toContain("85%");
  });

  it("no warnings when well within limits", () => {
    const { tracker, eventBus: eb } = createTracker({
      cost_limits: { per_task: { cost_usd: 10.0 } },
    });
    simulateCostEvent(eb, { task_id: "task-1", spend_usd: 0.1 });

    expect(tracker.getCostStatus("task-1").warnings).toHaveLength(0);
  });
});

// ── CostTracker — 80%-Crossing Observation (edge-triggered) ──────────────────

describe("CostTracker — warning-threshold observation", () => {
  it("emits the 80%-crossing observation exactly once while spend stays above 80%", () => {
    testDb = createTestDatabase();
    const busObserver = createTestObserverFacade("event-bus");
    const eb = new EventBus(testDb.db, { observer: busObserver });
    const config = SafetyConfigSchema.parse({ cost_limits: { daily: { cost_usd: 1.0 } } });
    const { observer, observations } = createRecordingObserver();
    createCostTracker({ db: testDb.db, eventBus: eb, costLimits: config.cost_limits, observer });

    // First event crosses 80% of the daily limit; the next two stay above it without crossing again.
    simulateCostEvent(eb, { task_id: "task-1", spend_usd: 0.85 });
    simulateCostEvent(eb, { task_id: "task-2", spend_usd: 0.05 });
    simulateCostEvent(eb, { task_id: "task-3", spend_usd: 0.05 });

    const crossings = observations.filter((o) => o.name === "cost_warning_threshold_crossed");
    expect(crossings).toHaveLength(1);
  });
});
