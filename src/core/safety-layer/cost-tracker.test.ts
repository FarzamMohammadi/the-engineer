import { afterEach, describe, expect, it } from "vitest";

import {
  type TestDatabaseHandle,
  createTestDatabase,
} from "../../../test/helpers/test-database.js";
import { createTestObserverFacade } from "../../../test/helpers/test-observer-facade.js";
import { SafetyConfigSchema } from "../../schemas/config.js";
import type { CostIncurredPayload, Event } from "../../schemas/events.js";
import { EventBus } from "../event-bus/index.js";
import type { EventRow } from "../event-bus/index.js";
import { rowToEvent } from "../event-bus/index.js";
import { createCostTracker, getDailyWindowStart, getMonthlyWindowStart } from "./cost-tracker.js";

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
  const tracker = createCostTracker({ db: testDb.db, eventBus, costLimits: config.cost_limits });
  return { tracker, eventBus, db: testDb.db };
}

function simulateCostEvent(eb: EventBus, overrides: Partial<CostIncurredPayload> = {}): Event {
  const defaults: CostIncurredPayload = {
    task_id: "task-1",
    repo: "owner/repo",
    provider_id: "claude-api",
    provider_type: "api",
    operation: "llm_call",
    tokens_in: 100,
    tokens_out: 200,
    spend_usd: 0.01,
    usage_units: null,
    remaining: null,
  };
  return eb.publish({
    type: "cost.incurred" as const,
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

// ── Pure Functions ───────────────────────────────────────────────────────────

describe("getDailyWindowStart", () => {
  it("returns midnight UTC", () => {
    expect(getDailyWindowStart(new Date("2026-03-11T14:32:00Z"))).toBe("2026-03-11T00:00:00.000Z");
  });
});

describe("getMonthlyWindowStart", () => {
  it("returns first of month midnight UTC", () => {
    expect(getMonthlyWindowStart(new Date("2026-03-15T10:00:00Z"))).toBe(
      "2026-03-01T00:00:00.000Z",
    );
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

  it("tracks CLI usage without affecting API spend", () => {
    const { tracker, eventBus: eb } = createTracker();
    simulateCostEvent(eb, {
      provider_type: "cli",
      provider_id: "claude-code",
      spend_usd: null,
      usage_units: 1,
      tokens_in: 500,
      tokens_out: 300,
    });

    expect(tracker.getCostStatus("task-1").daily_usd).toBe(0);
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
      type: "task.state_changed" as const,
      source: "task_engine",
      task_id: "task-1",
      payload: {
        task_id: "task-1",
        from_state: "active",
        from_sub: "working",
        to_state: "completed",
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
      type: "task.state_changed" as const,
      source: "task_engine",
      task_id: "task-1",
      payload: {
        task_id: "task-1",
        from_state: "blocked",
        from_sub: null,
        to_state: "failed",
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
      type: "task.state_changed" as const,
      source: "task_engine",
      task_id: "task-1",
      payload: {
        task_id: "task-1",
        from_state: "queued",
        from_sub: null,
        to_state: "active",
        to_sub: "working",
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
      cost_limits: { api: { per_task: { cost_usd: 0.1 } } },
    });
    simulateCostEvent(eb, { task_id: "task-1", spend_usd: 0.12 });

    const events = getEmittedEvents(db, "cost.limit_reached");
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => e.payload["limit_type"] === "per_task")).toBe(true);
  });

  it("emits cost.limit_reached when daily limit hit", () => {
    const { eventBus: eb, db } = createTracker({
      cost_limits: { api: { daily: { cost_usd: 0.2 } } },
    });
    simulateCostEvent(eb, { spend_usd: 0.12 });
    simulateCostEvent(eb, { spend_usd: 0.12 });

    const events = getEmittedEvents(db, "cost.limit_reached");
    expect(events.some((e) => e.payload["limit_type"] === "daily")).toBe(true);
  });

  it("does not emit when limits are null", () => {
    const { eventBus: eb, db } = createTracker({
      cost_limits: {
        api: {
          per_task: { cost_usd: null },
          daily: { cost_usd: null },
          monthly: { cost_usd: null },
        },
      },
    });
    simulateCostEvent(eb, { spend_usd: 100.0 });

    expect(getEmittedEvents(db, "cost.limit_reached")).toHaveLength(0);
  });

  it("detects CLI daily_requests limit", () => {
    const { eventBus: eb, db } = createTracker({
      cost_limits: { cli: { "claude-code": { daily_requests: 2 } } },
    });
    simulateCostEvent(eb, {
      provider_type: "cli",
      provider_id: "claude-code",
      spend_usd: null,
      usage_units: 1,
    });
    simulateCostEvent(eb, {
      provider_type: "cli",
      provider_id: "claude-code",
      spend_usd: null,
      usage_units: 1,
    });

    const events = getEmittedEvents(db, "cost.limit_reached");
    expect(events.some((e) => e.payload["provider_type"] === "cli")).toBe(true);
  });
});

// ── CostTracker — checkCostLimits & isAnyLimitBreached ───────────────────────

describe("CostTracker — checkCostLimits", () => {
  it("returns deny verdict when per-task limit breached", () => {
    const { tracker, eventBus: eb } = createTracker({
      cost_limits: { api: { per_task: { cost_usd: 0.05 } } },
    });
    simulateCostEvent(eb, { task_id: "task-1", spend_usd: 0.1 });

    const { verdict } = tracker.checkCostLimits("task-1");
    expect(verdict).not.toBeNull();
    expect(verdict?.action).toBe("deny");
  });

  it("returns null verdict and populates warnings when approaching limit", () => {
    const { tracker, eventBus: eb } = createTracker({
      cost_limits: { api: { per_task: { cost_usd: 1.0 } } },
    });
    simulateCostEvent(eb, { task_id: "task-1", spend_usd: 0.85 });

    const { verdict, warnings } = tracker.checkCostLimits("task-1");
    expect(verdict).toBeNull();
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain("85%");
  });

  it("returns null verdict when within limits", () => {
    const { tracker, eventBus: eb } = createTracker({
      cost_limits: { api: { per_task: { cost_usd: 1.0 } } },
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
      cost_limits: { api: { per_task: { cost_usd: 0.05 } } },
    });
    simulateCostEvent(eb, { task_id: "task-1", spend_usd: 0.1 });

    expect(tracker.isAnyLimitBreached("task-1")).toBe(true);
  });

  it("returns false when within limits", () => {
    const { tracker, eventBus: eb } = createTracker({
      cost_limits: { api: { per_task: { cost_usd: 1.0 } } },
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
    const restored = createCostTracker({ db, eventBus: eb, costLimits: config.cost_limits });

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
    const restored = createCostTracker({ db, eventBus: eb, costLimits: config.cost_limits });
    expect(restored.getCostStatus("task-1").per_task_usd).toBeCloseTo(0.1);
  });

  it("handles missing snapshot with full replay", () => {
    const { eventBus: eb, db } = createTracker();
    simulateCostEvent(eb, { task_id: "task-1", spend_usd: 0.1 });

    db.prepare("DELETE FROM _meta WHERE key = 'safety_snapshot'").run();

    const config = SafetyConfigSchema.parse({});
    const restored = createCostTracker({ db, eventBus: eb, costLimits: config.cost_limits });
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

    const tracker = createCostTracker({ db: testDb.db, eventBus, costLimits: config.cost_limits });
    expect(tracker.getCostStatus("task-1").per_task_usd).toBeCloseTo(0.5);
  });
});

// ── CostTracker — Hot-Reload ─────────────────────────────────────────────────

describe("CostTracker — updateLimits", () => {
  it("new limits take effect immediately", () => {
    const { tracker, eventBus: eb } = createTracker({
      cost_limits: { api: { per_task: { cost_usd: 1.0 } } },
    });
    simulateCostEvent(eb, { task_id: "task-1", spend_usd: 0.5 });

    // Within $1.00 limit
    expect(tracker.isAnyLimitBreached("task-1")).toBe(false);

    // Lower limit to $0.40
    const newConfig = SafetyConfigSchema.parse({
      cost_limits: { api: { per_task: { cost_usd: 0.4 } } },
    });
    tracker.updateLimits(newConfig.cost_limits);

    // Now breached
    expect(tracker.isAnyLimitBreached("task-1")).toBe(true);
  });
});

// ── CostTracker — getCostStatus warnings ─────────────────────────────────────

describe("CostTracker — getCostStatus warnings", () => {
  it("includes warning when approaching per-task limit", () => {
    const { tracker, eventBus: eb } = createTracker({
      cost_limits: { api: { per_task: { cost_usd: 1.0 } } },
    });
    simulateCostEvent(eb, { task_id: "task-1", spend_usd: 0.85 });

    const status = tracker.getCostStatus("task-1");
    expect(status.warnings.length).toBeGreaterThan(0);
    expect(status.warnings[0]).toContain("85%");
  });

  it("no warnings when well within limits", () => {
    const { tracker, eventBus: eb } = createTracker({
      cost_limits: { api: { per_task: { cost_usd: 10.0 } } },
    });
    simulateCostEvent(eb, { task_id: "task-1", spend_usd: 0.1 });

    expect(tracker.getCostStatus("task-1").warnings).toHaveLength(0);
  });
});
