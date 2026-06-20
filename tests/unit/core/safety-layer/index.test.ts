import { afterEach, describe, expect, it, vi } from "vitest";

import { EventBus } from "../../../../src/core/event-bus/index.js";
import type { SafetyVerdict } from "../../../../src/core/interfaces/safety-layer.interface.js";
import type { IObserver } from "../../../../src/core/observer/index.js";
import {
  SafetyLayer,
  evaluateThreshold,
  getDailyWindowStart,
  getMonthlyWindowStart,
  matchesPathPattern,
  parseThreshold,
} from "../../../../src/core/safety-layer/index.js";
import { AutonomyLevels, SafetyConfigSchema } from "../../../../src/schemas/config.js";
import { ActionClasses } from "../../../../src/schemas/task.js";
import { createTestDatabase } from "../../../helpers/test-database.js";
import { createTestObserverFacade } from "../../../helpers/test-observer-facade.js";
import { type TestSafetyLayerHandle, createTestSafetyLayer } from "../../../helpers/test-safety-layer.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

let handle: TestSafetyLayerHandle;

afterEach(() => {
  handle?.cleanup();
});

// ── Pure Functions ───────────────────────────────────────────────────────────

describe("getDailyWindowStart", () => {
  it("returns midnight UTC for a given date", () => {
    const d = new Date("2026-03-11T14:32:00Z");
    expect(getDailyWindowStart(d)).toBe("2026-03-11T00:00:00.000Z");
  });

  it("handles dates near midnight", () => {
    const d = new Date("2026-03-11T00:00:01Z");
    expect(getDailyWindowStart(d)).toBe("2026-03-11T00:00:00.000Z");
  });
});

describe("getMonthlyWindowStart", () => {
  it("returns first of month midnight UTC", () => {
    const d = new Date("2026-03-15T10:00:00Z");
    expect(getMonthlyWindowStart(d)).toBe("2026-03-01T00:00:00.000Z");
  });

  it("returns first of month for date on the 1st", () => {
    const d = new Date("2026-03-01T00:00:00Z");
    expect(getMonthlyWindowStart(d)).toBe("2026-03-01T00:00:00.000Z");
  });
});

describe("parseThreshold", () => {
  it("parses 'scope > 5 files'", () => {
    expect(parseThreshold("scope > 5 files")).toEqual({ metric: "scope", op: ">", value: 5 });
  });

  it("parses 'scope >= 10'", () => {
    expect(parseThreshold("scope >= 10")).toEqual({ metric: "scope", op: ">=", value: 10 });
  });

  it("parses 'cost < 1.5'", () => {
    expect(parseThreshold("cost < 1.5")).toEqual({ metric: "cost", op: "<", value: 1.5 });
  });

  it("returns null for unparseable string", () => {
    expect(parseThreshold("invalid")).toBeNull();
    expect(parseThreshold("")).toBeNull();
  });
});

describe("evaluateThreshold", () => {
  it("returns exceeded when the threshold is crossed", () => {
    const parsed = parseThreshold("scope > 5")!;
    expect(evaluateThreshold(parsed, { scope: 10 })).toBe("exceeded");
  });

  it("returns within when below the threshold", () => {
    const parsed = parseThreshold("scope > 5")!;
    expect(evaluateThreshold(parsed, { scope: 3 })).toBe("within");
  });

  it("returns metric_absent when the metric is missing from details", () => {
    const parsed = parseThreshold("scope > 5")!;
    expect(evaluateThreshold(parsed, { files: 10 })).toBe("metric_absent");
  });

  it("handles equality operator", () => {
    const parsed = parseThreshold("count = 3")!;
    expect(evaluateThreshold(parsed, { count: 3 })).toBe("exceeded");
    expect(evaluateThreshold(parsed, { count: 4 })).toBe("within");
  });
});

describe("matchesPathPattern", () => {
  it("matches exact file name", () => {
    expect(matchesPathPattern(".env", ".env")).toBe(true);
  });

  it("matches .env* pattern", () => {
    expect(matchesPathPattern(".env*", ".env")).toBe(true);
    expect(matchesPathPattern(".env*", ".env.local")).toBe(true);
    expect(matchesPathPattern(".env*", ".envrc")).toBe(true);
    expect(matchesPathPattern(".env*", "other")).toBe(false);
  });

  it("matches *.pem pattern", () => {
    expect(matchesPathPattern("*.pem", "server.pem")).toBe(true);
    expect(matchesPathPattern("*.pem", "server.key")).toBe(false);
  });

  it("matches secrets/** pattern", () => {
    expect(matchesPathPattern("secrets/**", "secrets/api.key")).toBe(true);
    expect(matchesPathPattern("secrets/**", "secrets/nested/file.txt")).toBe(true);
    expect(matchesPathPattern("secrets/**", "other/file.txt")).toBe(false);
  });

  it("matches engineer/* branch pattern", () => {
    expect(matchesPathPattern("engineer/*", "engineer/42-fix-bug")).toBe(true);
    expect(matchesPathPattern("engineer/*", "main")).toBe(false);
  });

  it("matches literal branch name", () => {
    expect(matchesPathPattern("main", "main")).toBe(true);
    expect(matchesPathPattern("main", "develop")).toBe(false);
  });

  it("matches basename of path against non-slash patterns", () => {
    expect(matchesPathPattern(".env*", "config/.env.local")).toBe(true);
    expect(matchesPathPattern("*.key", "certs/server.key")).toBe(true);
  });
});

// ── Scope Boundary Enforcement ───────────────────────────────────────────────

describe("SafetyLayer — scope boundaries", () => {
  it("allows action when repo is in allowed list", () => {
    handle = createTestSafetyLayer({
      scope: { repos: { allowed: ["owner/repo-a", "owner/repo-b"] } },
    });
    const verdict = handle.safetyLayer.evaluateAction("task-1", ActionClasses.write, {
      repo: "owner/repo-a",
    });
    expect(verdict.allowed).toBe(true);
    expect(verdict.action).toBe("proceed");
  });

  it("denies action when repo is not in allowed list", () => {
    handle = createTestSafetyLayer({
      scope: { repos: { allowed: ["owner/repo-a"] } },
    });
    const verdict = handle.safetyLayer.evaluateAction("task-1", ActionClasses.write, {
      repo: "owner/repo-b",
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.action).toBe("deny");
    expect(verdict.reason).toContain("repo-b");
  });

  it("allows any repo when allowed is null (unrestricted)", () => {
    handle = createTestSafetyLayer({
      scope: { repos: { allowed: null } },
    });
    const verdict = handle.safetyLayer.evaluateAction("task-1", ActionClasses.write, {
      repo: "any/repo",
    });
    expect(verdict.allowed).toBe(true);
  });

  it("allows push to branch matching push_to patterns", () => {
    handle = createTestSafetyLayer({
      scope: { branches: { push_to: ["engineer/*"] } },
    });
    const verdict = handle.safetyLayer.evaluateAction("task-1", ActionClasses.git_remote, {
      branch: "engineer/42-fix",
    });
    expect(verdict.allowed).toBe(true);
  });

  it("denies push to branch not matching push_to patterns", () => {
    handle = createTestSafetyLayer({
      scope: { branches: { push_to: ["engineer/*"] } },
    });
    const verdict = handle.safetyLayer.evaluateAction("task-1", ActionClasses.git_remote, {
      branch: "main",
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("push to");
  });

  it("allows merge to branch matching merge_to patterns", () => {
    handle = createTestSafetyLayer({
      scope: { branches: { merge_to: ["main", "develop"] } },
      merge: { auto_merge_after_approval: { default: true } },
    });
    const verdict = handle.safetyLayer.evaluateAction("task-1", ActionClasses.merge, {
      branch: "main",
    });
    expect(verdict.allowed).toBe(true);
  });

  it("denies writing to excluded file patterns", () => {
    handle = createTestSafetyLayer();
    const verdict = handle.safetyLayer.evaluateAction("task-1", ActionClasses.write, {
      file: ".env.local",
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain(".env");
  });

  it("denies writing to files matching secrets/**", () => {
    handle = createTestSafetyLayer();
    const verdict = handle.safetyLayer.evaluateAction("task-1", ActionClasses.write, {
      file: "secrets/api.key",
    });
    expect(verdict.allowed).toBe(false);
  });

  it("denies writing to *.pem files", () => {
    handle = createTestSafetyLayer();
    const verdict = handle.safetyLayer.evaluateAction("task-1", ActionClasses.write, {
      file: "certs/server.pem",
    });
    expect(verdict.allowed).toBe(false);
  });

  it("allows writing to non-excluded files", () => {
    handle = createTestSafetyLayer();
    const verdict = handle.safetyLayer.evaluateAction("task-1", ActionClasses.write, {
      file: "src/main.ts",
    });
    expect(verdict.allowed).toBe(true);
  });

  it("checks multiple files and denies if any match", () => {
    handle = createTestSafetyLayer();
    const verdict = handle.safetyLayer.evaluateAction("task-1", ActionClasses.write, {
      files: ["src/main.ts", ".env"],
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain(".env");
  });
});

// ── Merge Policy ─────────────────────────────────────────────────────────────

describe("SafetyLayer — merge policy", () => {
  it("allows merge when auto_merge_after_approval is enabled for repo", () => {
    handle = createTestSafetyLayer({
      scope: { branches: { merge_to: ["main"] } },
      merge: { auto_merge_after_approval: { default: false, repos: { "owner/repo": true } } },
    });
    const verdict = handle.safetyLayer.evaluateAction("task-1", ActionClasses.merge, {
      repo: "owner/repo",
      branch: "main",
    });
    expect(verdict.allowed).toBe(true);
  });

  it("returns ask_human when auto_merge_after_approval is disabled", () => {
    handle = createTestSafetyLayer({
      scope: { branches: { merge_to: ["main"] } },
      merge: { auto_merge_after_approval: { default: false } },
    });
    const verdict = handle.safetyLayer.evaluateAction("task-1", ActionClasses.merge, {
      repo: "owner/repo",
      branch: "main",
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.action).toBe("ask_human");
    expect(verdict.reason).toContain("auto-merge");
  });

  it("uses default when repo not in overrides", () => {
    handle = createTestSafetyLayer({
      scope: { branches: { merge_to: ["main"] } },
      merge: { auto_merge_after_approval: { default: true } },
    });
    const verdict = handle.safetyLayer.evaluateAction("task-1", ActionClasses.merge, {
      repo: "some/other-repo",
      branch: "main",
    });
    expect(verdict.allowed).toBe(true);
  });
});

// ── checkAutoMergeAllowed ────────────────────────────────────────────────────

describe("SafetyLayer — checkAutoMergeAllowed", () => {
  it("returns true when default is true", () => {
    handle = createTestSafetyLayer({
      merge: { auto_merge_after_approval: { default: true } },
    });
    expect(handle.safetyLayer.checkAutoMergeAllowed("any/repo")).toBe(true);
  });

  it("returns false when default is false and no repo override", () => {
    handle = createTestSafetyLayer({
      merge: { auto_merge_after_approval: { default: false } },
    });
    expect(handle.safetyLayer.checkAutoMergeAllowed("any/repo")).toBe(false);
  });

  it("returns true when repo override is true", () => {
    handle = createTestSafetyLayer({
      merge: { auto_merge_after_approval: { default: false, repos: { "owner/repo": true } } },
    });
    expect(handle.safetyLayer.checkAutoMergeAllowed("owner/repo")).toBe(true);
  });

  it("returns false when repo override is false", () => {
    handle = createTestSafetyLayer({
      merge: { auto_merge_after_approval: { default: true, repos: { "owner/repo": false } } },
    });
    expect(handle.safetyLayer.checkAutoMergeAllowed("owner/repo")).toBe(false);
  });
});

// ── Cost Accumulation ────────────────────────────────────────────────────────
//
// SafetyLayer surfaces accumulated spend two ways: through evaluateAction (Gate 2 — per-task plus the
// daily/monthly windows) and through getCostSummary (account-wide, for the owner's `!cost` query, exercised
// below). Exact per-window USD totals are asserted directly against the cost tracker in
// cost-tracker.test.ts; here we assert the verdict evaluateAction yields from that accumulation.

function costCheck(handle: TestSafetyLayerHandle, taskId: string): SafetyVerdict {
  return handle.safetyLayer.evaluateAction(taskId, ActionClasses.read, {});
}

describe("SafetyLayer — cost accumulation", () => {
  it("denies once accumulated per-task spend crosses the limit", () => {
    handle = createTestSafetyLayer({ cost_limits: { per_task: { cost_usd: 0.12 } } });
    handle.simulateCostEvent({ task_id: "task-1", spend_usd: 0.1 });
    handle.simulateCostEvent({ task_id: "task-1", spend_usd: 0.05 });

    expect(costCheck(handle, "task-1").action).toBe("deny");
  });

  it("denies once accumulated daily spend across tasks crosses the limit", () => {
    handle = createTestSafetyLayer({ cost_limits: { daily: { cost_usd: 0.25 } } });
    handle.simulateCostEvent({ task_id: "task-1", spend_usd: 0.1 });
    handle.simulateCostEvent({ task_id: "task-2", spend_usd: 0.2 });

    expect(costCheck(handle, "task-1").action).toBe("deny");
  });

  it("keeps per-task accumulators independent", () => {
    handle = createTestSafetyLayer({ cost_limits: { per_task: { cost_usd: 0.15 } } });
    handle.simulateCostEvent({ task_id: "task-1", spend_usd: 0.1 });
    handle.simulateCostEvent({ task_id: "task-2", spend_usd: 0.2 });

    // task-2 breached its limit; task-1 stayed under its own.
    expect(costCheck(handle, "task-1").action).toBe("proceed");
    expect(costCheck(handle, "task-2").action).toBe("deny");
  });

  it("tracks provider usage without affecting spend when spend_usd is null", () => {
    handle = createTestSafetyLayer({ cost_limits: { daily: { cost_usd: 0.01 } } });
    handle.simulateCostEvent({ provider_id: "claude-code", spend_usd: null });
    handle.simulateCostEvent({ provider_id: "claude-code", spend_usd: null });

    // Null spend doesn't accumulate cost, so the daily limit is not breached.
    expect(costCheck(handle, "task-1").action).toBe("proceed");
  });

  it("ignores events with zero or null spend for API", () => {
    handle = createTestSafetyLayer({ cost_limits: { per_task: { cost_usd: 0.04 } } });
    handle.simulateCostEvent({ task_id: "task-1", spend_usd: null });
    handle.simulateCostEvent({ task_id: "task-1", spend_usd: 0 });
    handle.simulateCostEvent({ task_id: "task-1", spend_usd: 0.05 });

    // Only the 0.05 event counts, which alone crosses the 0.04 limit.
    expect(costCheck(handle, "task-1").action).toBe("deny");
  });
});

// ── Cost Summary (account-wide !cost query) ──────────────────────────────────
//
// getCostSummary backs the owner's `!cost` query: account-wide spend vs the daily/monthly limits, a breach
// flag, and the near-ceiling warnings — no per-task scope, and no consultJudgment (so there is no task/repo
// to validate, and blanks can never reach the validator). This is the read the `!cost` chat reply formats.

describe("SafetyLayer — cost summary", () => {
  it("reports spend and configured limits per window when within limits", () => {
    handle = createTestSafetyLayer({ cost_limits: { daily: { cost_usd: 25 }, monthly: { cost_usd: 250 } } });
    handle.simulateCostEvent({ task_id: "task-1", spend_usd: 3.2 });

    const summary = handle.safetyLayer.getCostSummary();
    expect(summary.daily_usd).toBeCloseTo(3.2);
    expect(summary.daily_limit_usd).toBe(25);
    expect(summary.monthly_usd).toBeCloseTo(3.2);
    expect(summary.monthly_limit_usd).toBe(250);
    expect(summary.breached).toBe(false);
  });

  it("flags breached once an account-wide limit is reached", () => {
    handle = createTestSafetyLayer({ cost_limits: { daily: { cost_usd: 0.25 } } });
    handle.simulateCostEvent({ task_id: "task-1", spend_usd: 0.1 });
    handle.simulateCostEvent({ task_id: "task-2", spend_usd: 0.2 });

    expect(handle.safetyLayer.getCostSummary().breached).toBe(true);
  });

  it("surfaces percent-of-limit warnings near a ceiling without breaching", () => {
    handle = createTestSafetyLayer({ cost_limits: { daily: { cost_usd: 1.0 } } });
    handle.simulateCostEvent({ task_id: "task-1", spend_usd: 0.85 });

    const summary = handle.safetyLayer.getCostSummary();
    expect(summary.breached).toBe(false);
    expect(summary.warnings.length).toBeGreaterThan(0);
    expect(summary.warnings[0]).toContain("85%");
  });

  it("reports null limits for unbounded windows", () => {
    handle = createTestSafetyLayer({
      cost_limits: { daily: { cost_usd: null }, monthly: { cost_usd: null } },
    });
    handle.simulateCostEvent({ task_id: "task-1", spend_usd: 5.0 });

    const summary = handle.safetyLayer.getCostSummary();
    expect(summary.daily_limit_usd).toBeNull();
    expect(summary.monthly_limit_usd).toBeNull();
    expect(summary.breached).toBe(false);
  });
});

// ── Cost Limit Detection ─────────────────────────────────────────────────────

describe("SafetyLayer — cost limit detection", () => {
  it("emits cost.limit_reached when per-task limit hit", () => {
    handle = createTestSafetyLayer({
      cost_limits: { per_task: { cost_usd: 0.1 } },
    });
    handle.simulateCostEvent({ task_id: "task-1", spend_usd: 0.12 });

    handle.assertEventEmitted("cost.limit_reached", (p) => p["limit_type"] === "per_task" && p["task_id"] === "task-1");
  });

  it("emits cost.limit_reached when daily limit hit", () => {
    handle = createTestSafetyLayer({
      cost_limits: { daily: { cost_usd: 0.2 } },
    });
    handle.simulateCostEvent({ spend_usd: 0.12 });
    handle.simulateCostEvent({ spend_usd: 0.12 });

    handle.assertEventEmitted("cost.limit_reached", (p) => p["limit_type"] === "daily");
  });

  it("emits cost.limit_reached when monthly limit hit", () => {
    handle = createTestSafetyLayer({
      cost_limits: { monthly: { cost_usd: 0.15 } },
    });
    handle.simulateCostEvent({ spend_usd: 0.2 });

    handle.assertEventEmitted("cost.limit_reached", (p) => p["limit_type"] === "monthly");
  });

  it("does not emit when limits are null (unlimited)", () => {
    handle = createTestSafetyLayer({
      cost_limits: {
        per_task: { cost_usd: null },
        daily: { cost_usd: null },
        monthly: { cost_usd: null },
      },
    });
    handle.simulateCostEvent({ spend_usd: 100.0 });

    const events = handle.getEmittedEvents("cost.limit_reached");
    expect(events).toHaveLength(0);
  });

  it("cost.limit_reached has correct payload shape", () => {
    handle = createTestSafetyLayer({
      cost_limits: { per_task: { cost_usd: 0.05 } },
    });
    handle.simulateCostEvent({ task_id: "task-1", spend_usd: 0.1 });

    const events = handle.getEmittedEvents("cost.limit_reached");
    expect(events.length).toBeGreaterThan(0);
    const event = events[0];
    expect(event).toBeDefined();
    const payload = event?.payload;
    expect(payload).toMatchObject({
      task_id: "task-1",
      limit_type: "per_task",
    });
    expect(typeof payload?.["current_spend"]).toBe("number");
    expect(typeof payload?.["limit_value"]).toBe("number");
  });

  it("detects provider daily_requests limit", () => {
    handle = createTestSafetyLayer({
      cost_limits: { providers: { "claude-code": { daily_requests: 2 } } },
    });
    handle.simulateCostEvent({
      provider_id: "claude-code",
      spend_usd: null,
    });
    handle.simulateCostEvent({
      provider_id: "claude-code",
      spend_usd: null,
    });

    handle.assertEventEmitted("cost.limit_reached", (p) => p["limit_scope"] === "claude-code");
  });

  it("evaluateAction denies when cost limit is breached", () => {
    handle = createTestSafetyLayer({
      cost_limits: { per_task: { cost_usd: 0.05 } },
    });
    handle.simulateCostEvent({ task_id: "task-1", spend_usd: 0.1 });

    const verdict = handle.safetyLayer.evaluateAction("task-1", ActionClasses.read, {});
    expect(verdict.allowed).toBe(false);
    expect(verdict.action).toBe("deny");
    expect(verdict.reason).toContain("per-task cost limit");
  });

  it("evaluateAction includes cost warnings when approaching limit", () => {
    handle = createTestSafetyLayer({
      cost_limits: { per_task: { cost_usd: 1.0 } },
    });
    handle.simulateCostEvent({ task_id: "task-1", spend_usd: 0.85 });

    const verdict = handle.safetyLayer.evaluateAction("task-1", ActionClasses.read, {});
    expect(verdict.allowed).toBe(true);
    expect(verdict.warnings).toBeDefined();
    expect(verdict.warnings?.length).toBeGreaterThan(0);
    expect(verdict.warnings?.[0]).toContain("85%");
  });
});

// ── Snapshot Save/Restore ────────────────────────────────────────────────────

describe("SafetyLayer — snapshot", () => {
  function restoredCostCheck(handle: TestSafetyLayerHandle, taskId: string): SafetyVerdict {
    const config = SafetyConfigSchema.parse({ cost_limits: { per_task: { cost_usd: 0.2 } } });
    const restored = new SafetyLayer(handle.db, handle.eventBus, config, createTestObserverFacade("safety-layer"));
    return restored.evaluateAction(taskId, ActionClasses.read, {});
  }

  it("round-trips: a new instance restores per-task spend from the snapshot", () => {
    handle = createTestSafetyLayer();
    handle.simulateCostEvent({ task_id: "task-1", spend_usd: 0.25 });
    handle.simulateCostEvent({ task_id: "task-2", spend_usd: 0.1 });

    // task-1 (0.25) breached the restored 0.2 limit; task-2 (0.1) did not.
    expect(restoredCostCheck(handle, "task-1").action).toBe("deny");
    expect(restoredCostCheck(handle, "task-2").action).toBe("proceed");
  });

  it("replays events accumulated after the snapshot", () => {
    handle = createTestSafetyLayer();
    handle.simulateCostEvent({ task_id: "task-1", spend_usd: 0.15 });
    handle.simulateCostEvent({ task_id: "task-1", spend_usd: 0.1 });

    // Both events (0.25 total) restore, crossing the 0.2 limit.
    expect(restoredCostCheck(handle, "task-1").action).toBe("deny");
  });

  it("handles missing snapshot gracefully (full replay)", () => {
    handle = createTestSafetyLayer();

    // Manually delete the snapshot from _meta
    handle.db.prepare("DELETE FROM _meta WHERE key = 'safety_snapshot'").run();

    // Publish an event directly (bypasses snapshot saving by the original instance)
    handle.eventBus.publish({
      type: "cost.incurred" as const,
      source: "test",
      task_id: "task-1",
      payload: {
        task_id: "task-1",
        repo: "owner/repo",
        provider_id: "claude-api",
        operation: "agent_call",
        spend_usd: 0.3,
        duration_ms: null,
      },
    });

    // New instance replays from sequence 0 and finds the 0.3 event, crossing 0.2.
    expect(restoredCostCheck(handle, "task-1").action).toBe("deny");
  });

  it("handles corrupt snapshot gracefully", () => {
    handle = createTestSafetyLayer();
    handle.simulateCostEvent({ task_id: "task-1", spend_usd: 0.25 });

    // Corrupt the snapshot
    handle.db.prepare("UPDATE _meta SET value = 'not-json' WHERE key = 'safety_snapshot'").run();

    // Should not throw — falls back to full replay and still sees the 0.25 spend.
    expect(restoredCostCheck(handle, "task-1").action).toBe("deny");
  });
});

// ── Autonomy Verdicts ────────────────────────────────────────────────────────

describe("SafetyLayer — autonomy (consultJudgment)", () => {
  it("returns proceed for always_decide category", () => {
    handle = createTestSafetyLayer({
      autonomy: {
        decisions: {
          code_style: { level: AutonomyLevels.always_decide, description: "formatting" },
        },
      },
    });
    const verdict = handle.safetyLayer.consultJudgment({
      type: "should_i_ask",
      context: {
        task_id: "task-1",
        repo: "owner/repo",
        decision_category: "code_style",
        details: {},
      },
    });
    expect(verdict.allowed).toBe(true);
    expect(verdict.action).toBe("proceed");
  });

  it("returns ask_human for always_ask category", () => {
    handle = createTestSafetyLayer({
      autonomy: {
        decisions: {
          architectural: { level: AutonomyLevels.always_ask, description: "architecture" },
        },
      },
    });
    const verdict = handle.safetyLayer.consultJudgment({
      type: "should_i_ask",
      context: {
        task_id: "task-1",
        repo: "owner/repo",
        decision_category: "architectural",
        details: {},
      },
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.action).toBe("ask_human");
  });

  it("returns proceed for threshold within limit", () => {
    handle = createTestSafetyLayer({
      autonomy: {
        decisions: {
          refactoring: {
            level: AutonomyLevels.threshold,
            threshold: "scope > 5 files",
            description: "refactoring",
          },
        },
      },
    });
    const verdict = handle.safetyLayer.consultJudgment({
      type: "should_i_ask",
      context: {
        task_id: "task-1",
        repo: "owner/repo",
        decision_category: "refactoring",
        details: { scope: 3 },
      },
    });
    expect(verdict.allowed).toBe(true);
    expect(verdict.action).toBe("proceed");
  });

  it("returns ask_human for threshold exceeded", () => {
    handle = createTestSafetyLayer({
      autonomy: {
        decisions: {
          refactoring: {
            level: AutonomyLevels.threshold,
            threshold: "scope > 5 files",
            description: "refactoring",
          },
        },
      },
    });
    const verdict = handle.safetyLayer.consultJudgment({
      type: "should_i_ask",
      context: {
        task_id: "task-1",
        repo: "owner/repo",
        decision_category: "refactoring",
        details: { scope: 12 },
      },
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.action).toBe("ask_human");
    expect(verdict.reason).toContain("12");
    expect(verdict.reason).toContain("5");
  });

  it("returns ask_human for unknown category (fail-safe)", () => {
    handle = createTestSafetyLayer();
    const verdict = handle.safetyLayer.consultJudgment({
      type: "should_i_ask",
      context: {
        task_id: "task-1",
        repo: "owner/repo",
        decision_category: "unknown_category",
        details: {},
      },
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.action).toBe("ask_human");
  });

  it("returns ask_human for unparseable threshold", () => {
    handle = createTestSafetyLayer({
      autonomy: {
        decisions: {
          test_cat: { level: AutonomyLevels.threshold, threshold: "invalid!!!", description: "" },
        },
      },
    });
    const verdict = handle.safetyLayer.consultJudgment({
      type: "should_i_ask",
      context: {
        task_id: "task-1",
        repo: "owner/repo",
        decision_category: "test_cat",
        details: {},
      },
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.action).toBe("ask_human");
  });

  it("repo override takes precedence over base config", () => {
    handle = createTestSafetyLayer({
      autonomy: {
        decisions: {
          refactoring: {
            level: AutonomyLevels.always_decide,
            description: "base: always decide",
          },
        },
        repo_overrides: {
          "owner/critical-repo": {
            decisions: {
              refactoring: { level: AutonomyLevels.always_ask },
            },
          },
        },
      },
    });

    // Base config: always_decide
    const baseVerdict = handle.safetyLayer.consultJudgment({
      type: "should_i_ask",
      context: {
        task_id: "task-1",
        repo: "owner/other-repo",
        decision_category: "refactoring",
        details: {},
      },
    });
    expect(baseVerdict.action).toBe("proceed");

    // Override: always_ask for critical-repo
    const overrideVerdict = handle.safetyLayer.consultJudgment({
      type: "should_i_ask",
      context: {
        task_id: "task-1",
        repo: "owner/critical-repo",
        decision_category: "refactoring",
        details: {},
      },
    });
    expect(overrideVerdict.action).toBe("ask_human");
  });

  it("can_i delegates to evaluateAction", () => {
    handle = createTestSafetyLayer({
      scope: { repos: { allowed: ["owner/repo-a"] } },
    });
    const verdict = handle.safetyLayer.consultJudgment({
      type: "can_i",
      context: {
        task_id: "task-1",
        repo: "owner/repo-b",
        action_class: "write",
        details: { repo: "owner/repo-b" },
      },
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.action).toBe("deny");
  });
});

// ── Hot-Reload ───────────────────────────────────────────────────────────────

// ── Input Validation (Security Hardening R8) ─────────────────────────────────

describe("SafetyLayer — input validation", () => {
  it("valid input passes through to existing logic", () => {
    handle = createTestSafetyLayer();
    const verdict = handle.safetyLayer.evaluateAction("task-1", ActionClasses.read, {});
    expect(verdict.allowed).toBe(true);
    expect(verdict.action).toBe("proceed");
  });

  it("empty task_id returns deny verdict", () => {
    handle = createTestSafetyLayer();
    const verdict = handle.safetyLayer.evaluateAction("", "read", {});
    expect(verdict.allowed).toBe(false);
    expect(verdict.action).toBe("deny");
    expect(verdict.reason).toContain("Invalid safety input");
    expect(verdict.warnings).toBeDefined();
  });

  it("invalid action_class returns deny verdict", () => {
    handle = createTestSafetyLayer();
    const verdict = handle.safetyLayer.evaluateAction("task-1", "destroy_everything" as any, {});
    expect(verdict.allowed).toBe(false);
    expect(verdict.action).toBe("deny");
    expect(verdict.reason).toContain("Invalid safety input");
  });

  it("consultJudgment denies with empty task_id in query", () => {
    handle = createTestSafetyLayer();
    const verdict = handle.safetyLayer.consultJudgment({
      type: "can_i",
      context: {
        task_id: "",
        repo: "owner/repo",
        details: {},
      },
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.action).toBe("deny");
    expect(verdict.reason).toContain("Invalid safety query");
  });

  it("consultJudgment denies with empty repo in query", () => {
    handle = createTestSafetyLayer();
    const verdict = handle.safetyLayer.consultJudgment({
      type: "can_i",
      context: {
        task_id: "task-1",
        repo: "",
        details: {},
      },
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.action).toBe("deny");
  });
});

// ── Timeout Policy ───────────────────────────────────────────────────────────

describe("SafetyLayer — getTimeoutPolicy", () => {
  it("returns the configured response timeout", () => {
    handle = createTestSafetyLayer();
    const policy = handle.safetyLayer.getTimeoutPolicy();

    // Defaults from schema
    expect(policy.blocked.stages).toHaveLength(3);
    expect(policy.blocked.stages[0]?.name).toBe("reminder");
    expect(policy.review_pending.reminder_after_ms).toBe(86_400_000);
  });
});

// ── Autonomy Decision Trace Threading ────────────────────────────────────────

describe("SafetyLayer — should_i_ask records the autonomy_policy decision under the threaded trace", () => {
  /** Build a SafetyLayer whose observer is a spy, so a test can assert the recorded decision's scope. */
  function withSpyObserver() {
    const testDb = createTestDatabase();
    const recordDecision = vi.fn<IObserver["recordDecision"]>(() => "obs-1");
    const observer = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      recordDecision,
    } as unknown as IObserver;
    const eventBus = new EventBus(testDb.db, { observer });
    const config = SafetyConfigSchema.parse({
      autonomy: { decisions: { architecture: { level: AutonomyLevels.always_ask, description: "" } } },
    });
    const safetyLayer = new SafetyLayer(testDb.db, eventBus, config, observer);
    return { safetyLayer, recordDecision, cleanup: () => testDb.cleanup() };
  }

  it("nests the verdict under the dispatch trace passed in the query", () => {
    const { safetyLayer, recordDecision, cleanup } = withSpyObserver();
    try {
      const trace = { task_id: "task-1", trace_id: "trace-7", phase: "execution", parent_observation_id: "root-9" };
      safetyLayer.consultJudgment({
        type: "should_i_ask",
        context: { task_id: "task-1", repo: "owner/repo", decision_category: "architecture", details: {} },
        trace,
      });
      expect(recordDecision).toHaveBeenCalledTimes(1);
      expect(recordDecision.mock.calls[0]?.[0]).toBe("autonomy_policy");
      expect(recordDecision.mock.calls[0]?.[6]).toEqual(trace);
    } finally {
      cleanup();
    }
  });

  it("falls back to the bare task_id when no trace is supplied", () => {
    const { safetyLayer, recordDecision, cleanup } = withSpyObserver();
    try {
      safetyLayer.consultJudgment({
        type: "should_i_ask",
        context: { task_id: "task-1", repo: "owner/repo", decision_category: "architecture", details: {} },
      });
      expect(recordDecision.mock.calls[0]?.[6]).toEqual({ task_id: "task-1" });
    } finally {
      cleanup();
    }
  });
});
