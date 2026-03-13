import { afterEach, describe, expect, it } from "vitest";

import {
  type TestSafetyLayerHandle,
  createTestSafetyLayer,
} from "../../../test/helpers/test-safety-layer.js";
import { SafetyConfigSchema } from "../../schemas/config.js";
import {
  SafetyLayer,
  evaluateThreshold,
  getDailyWindowStart,
  getMonthlyWindowStart,
  matchesPathPattern,
  parseThreshold,
} from "./index.js";

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
  it("returns true when threshold exceeded", () => {
    // biome-ignore lint/style/noNonNullAssertion: test knows parse succeeds
    const parsed = parseThreshold("scope > 5")!;
    expect(evaluateThreshold(parsed, { scope: 10 })).toBe(true);
  });

  it("returns false when within threshold", () => {
    // biome-ignore lint/style/noNonNullAssertion: test knows parse succeeds
    const parsed = parseThreshold("scope > 5")!;
    expect(evaluateThreshold(parsed, { scope: 3 })).toBe(false);
  });

  it("returns false when metric missing from details", () => {
    // biome-ignore lint/style/noNonNullAssertion: test knows parse succeeds
    const parsed = parseThreshold("scope > 5")!;
    expect(evaluateThreshold(parsed, { files: 10 })).toBe(false);
  });

  it("handles equality operator", () => {
    // biome-ignore lint/style/noNonNullAssertion: test knows parse succeeds
    const parsed = parseThreshold("count = 3")!;
    expect(evaluateThreshold(parsed, { count: 3 })).toBe(true);
    expect(evaluateThreshold(parsed, { count: 4 })).toBe(false);
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
    const verdict = handle.safetyLayer.evaluateAction("task-1", "write", {
      repo: "owner/repo-a",
    });
    expect(verdict.allowed).toBe(true);
    expect(verdict.action).toBe("proceed");
  });

  it("denies action when repo is not in allowed list", () => {
    handle = createTestSafetyLayer({
      scope: { repos: { allowed: ["owner/repo-a"] } },
    });
    const verdict = handle.safetyLayer.evaluateAction("task-1", "write", {
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
    const verdict = handle.safetyLayer.evaluateAction("task-1", "write", {
      repo: "any/repo",
    });
    expect(verdict.allowed).toBe(true);
  });

  it("allows push to branch matching push_to patterns", () => {
    handle = createTestSafetyLayer({
      scope: { branches: { push_to: ["engineer/*"] } },
    });
    const verdict = handle.safetyLayer.evaluateAction("task-1", "git_remote", {
      branch: "engineer/42-fix",
    });
    expect(verdict.allowed).toBe(true);
  });

  it("denies push to branch not matching push_to patterns", () => {
    handle = createTestSafetyLayer({
      scope: { branches: { push_to: ["engineer/*"] } },
    });
    const verdict = handle.safetyLayer.evaluateAction("task-1", "git_remote", {
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
    const verdict = handle.safetyLayer.evaluateAction("task-1", "merge", {
      branch: "main",
    });
    expect(verdict.allowed).toBe(true);
  });

  it("denies writing to excluded file patterns", () => {
    handle = createTestSafetyLayer();
    const verdict = handle.safetyLayer.evaluateAction("task-1", "write", {
      file: ".env.local",
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain(".env");
  });

  it("denies writing to files matching secrets/**", () => {
    handle = createTestSafetyLayer();
    const verdict = handle.safetyLayer.evaluateAction("task-1", "write", {
      file: "secrets/api.key",
    });
    expect(verdict.allowed).toBe(false);
  });

  it("denies writing to *.pem files", () => {
    handle = createTestSafetyLayer();
    const verdict = handle.safetyLayer.evaluateAction("task-1", "write", {
      file: "certs/server.pem",
    });
    expect(verdict.allowed).toBe(false);
  });

  it("allows writing to non-excluded files", () => {
    handle = createTestSafetyLayer();
    const verdict = handle.safetyLayer.evaluateAction("task-1", "write", {
      file: "src/main.ts",
    });
    expect(verdict.allowed).toBe(true);
  });

  it("checks multiple files and denies if any match", () => {
    handle = createTestSafetyLayer();
    const verdict = handle.safetyLayer.evaluateAction("task-1", "write", {
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
    const verdict = handle.safetyLayer.evaluateAction("task-1", "merge", {
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
    const verdict = handle.safetyLayer.evaluateAction("task-1", "merge", {
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
    const verdict = handle.safetyLayer.evaluateAction("task-1", "merge", {
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

describe("SafetyLayer — cost accumulation", () => {
  it("accumulates API spend per task", () => {
    handle = createTestSafetyLayer();
    handle.simulateCostEvent({ task_id: "task-1", spend_usd: 0.1 });
    handle.simulateCostEvent({ task_id: "task-1", spend_usd: 0.05 });

    const status = handle.safetyLayer.getCostStatus("task-1");
    expect(status.per_task_usd).toBeCloseTo(0.15);
  });

  it("accumulates API spend across tasks for daily/monthly", () => {
    handle = createTestSafetyLayer();
    handle.simulateCostEvent({ task_id: "task-1", spend_usd: 0.1 });
    handle.simulateCostEvent({ task_id: "task-2", spend_usd: 0.2 });

    const status = handle.safetyLayer.getCostStatus();
    expect(status.daily_usd).toBeCloseTo(0.3);
    expect(status.monthly_usd).toBeCloseTo(0.3);
  });

  it("keeps per-task accumulators independent", () => {
    handle = createTestSafetyLayer();
    handle.simulateCostEvent({ task_id: "task-1", spend_usd: 0.1 });
    handle.simulateCostEvent({ task_id: "task-2", spend_usd: 0.2 });

    expect(handle.safetyLayer.getCostStatus("task-1").per_task_usd).toBeCloseTo(0.1);
    expect(handle.safetyLayer.getCostStatus("task-2").per_task_usd).toBeCloseTo(0.2);
  });

  it("tracks CLI usage separately", () => {
    handle = createTestSafetyLayer();
    handle.simulateCostEvent({
      provider_type: "cli",
      provider_id: "claude-code",
      spend_usd: null,
      usage_units: 1,
      tokens_in: 500,
      tokens_out: 300,
    });
    handle.simulateCostEvent({
      provider_type: "cli",
      provider_id: "claude-code",
      spend_usd: null,
      usage_units: 1,
      tokens_in: 200,
      tokens_out: 100,
    });

    // CLI usage doesn't affect API spend
    const status = handle.safetyLayer.getCostStatus("task-1");
    expect(status.daily_usd).toBe(0);
  });

  it("ignores events with zero or null spend for API", () => {
    handle = createTestSafetyLayer();
    handle.simulateCostEvent({ spend_usd: null });
    handle.simulateCostEvent({ spend_usd: 0 });
    handle.simulateCostEvent({ spend_usd: 0.05 });

    const status = handle.safetyLayer.getCostStatus("task-1");
    expect(status.per_task_usd).toBeCloseTo(0.05);
  });
});

// ── Cost Limit Detection ─────────────────────────────────────────────────────

describe("SafetyLayer — cost limit detection", () => {
  it("emits cost.limit_reached when per-task limit hit", () => {
    handle = createTestSafetyLayer({
      cost_limits: { api: { per_task: { cost_usd: 0.1 } } },
    });
    handle.simulateCostEvent({ task_id: "task-1", spend_usd: 0.12 });

    handle.assertEventEmitted(
      "cost.limit_reached",
      (p) => p["limit_type"] === "per_task" && p["task_id"] === "task-1",
    );
  });

  it("emits cost.limit_reached when daily limit hit", () => {
    handle = createTestSafetyLayer({
      cost_limits: { api: { daily: { cost_usd: 0.2 } } },
    });
    handle.simulateCostEvent({ spend_usd: 0.12 });
    handle.simulateCostEvent({ spend_usd: 0.12 });

    handle.assertEventEmitted("cost.limit_reached", (p) => p["limit_type"] === "daily");
  });

  it("emits cost.limit_reached when monthly limit hit", () => {
    handle = createTestSafetyLayer({
      cost_limits: { api: { monthly: { cost_usd: 0.15 } } },
    });
    handle.simulateCostEvent({ spend_usd: 0.2 });

    handle.assertEventEmitted("cost.limit_reached", (p) => p["limit_type"] === "monthly");
  });

  it("does not emit when limits are null (unlimited)", () => {
    handle = createTestSafetyLayer({
      cost_limits: {
        api: {
          per_task: { cost_usd: null },
          daily: { cost_usd: null },
          monthly: { cost_usd: null },
        },
      },
    });
    handle.simulateCostEvent({ spend_usd: 100.0 });

    const events = handle.getEmittedEvents("cost.limit_reached");
    expect(events).toHaveLength(0);
  });

  it("cost.limit_reached has correct payload shape", () => {
    handle = createTestSafetyLayer({
      cost_limits: { api: { per_task: { cost_usd: 0.05 } } },
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
      provider_type: "api",
    });
    expect(typeof payload?.["current_spend"]).toBe("number");
    expect(typeof payload?.["limit_value"]).toBe("number");
  });

  it("detects CLI daily_requests limit", () => {
    handle = createTestSafetyLayer({
      cost_limits: { cli: { "claude-code": { daily_requests: 2 } } },
    });
    handle.simulateCostEvent({
      provider_type: "cli",
      provider_id: "claude-code",
      spend_usd: null,
      usage_units: 1,
    });
    handle.simulateCostEvent({
      provider_type: "cli",
      provider_id: "claude-code",
      spend_usd: null,
      usage_units: 1,
    });

    handle.assertEventEmitted(
      "cost.limit_reached",
      (p) => p["provider_type"] === "cli" && p["limit_scope"] === "claude-code",
    );
  });

  it("evaluateAction denies when cost limit is breached", () => {
    handle = createTestSafetyLayer({
      cost_limits: { api: { per_task: { cost_usd: 0.05 } } },
    });
    handle.simulateCostEvent({ task_id: "task-1", spend_usd: 0.1 });

    const verdict = handle.safetyLayer.evaluateAction("task-1", "read", {});
    expect(verdict.allowed).toBe(false);
    expect(verdict.action).toBe("deny");
    expect(verdict.reason).toContain("per-task cost limit");
  });

  it("evaluateAction includes cost warnings when approaching limit", () => {
    handle = createTestSafetyLayer({
      cost_limits: { api: { per_task: { cost_usd: 1.0 } } },
    });
    handle.simulateCostEvent({ task_id: "task-1", spend_usd: 0.85 });

    const verdict = handle.safetyLayer.evaluateAction("task-1", "read", {});
    expect(verdict.allowed).toBe(true);
    expect(verdict.warnings).toBeDefined();
    expect(verdict.warnings?.length).toBeGreaterThan(0);
    expect(verdict.warnings?.[0]).toContain("85%");
  });
});

// ── Snapshot Save/Restore ────────────────────────────────────────────────────

describe("SafetyLayer — snapshot", () => {
  it("round-trips: save → new instance → accumulators match", () => {
    handle = createTestSafetyLayer();
    handle.simulateCostEvent({ task_id: "task-1", spend_usd: 0.25 });
    handle.simulateCostEvent({ task_id: "task-2", spend_usd: 0.1 });

    // Create new SafetyLayer on same DB — should restore from snapshot
    const config = SafetyConfigSchema.parse({});
    const restored = new SafetyLayer(handle.db, handle.eventBus, config);

    const status1 = restored.getCostStatus("task-1");
    expect(status1.per_task_usd).toBeCloseTo(0.25);

    const status2 = restored.getCostStatus("task-2");
    expect(status2.per_task_usd).toBeCloseTo(0.1);
  });

  it("replays events after snapshot", () => {
    handle = createTestSafetyLayer();
    handle.simulateCostEvent({ task_id: "task-1", spend_usd: 0.1 });

    // Simulate: new event arrives after snapshot was taken
    // (We can't easily test this perfectly, but we can verify the
    // new instance sees the right total by adding another event before constructing)
    handle.simulateCostEvent({ task_id: "task-1", spend_usd: 0.05 });

    const config = SafetyConfigSchema.parse({});
    const restored = new SafetyLayer(handle.db, handle.eventBus, config);
    const status = restored.getCostStatus("task-1");
    expect(status.per_task_usd).toBeCloseTo(0.15);
  });

  it("handles missing snapshot gracefully (full replay)", () => {
    handle = createTestSafetyLayer();

    // Manually delete the snapshot from _meta
    handle.db.prepare("DELETE FROM _meta WHERE key = 'safety_snapshot'").run();

    // Publish some events directly (bypasses snapshot saving by the original instance)
    handle.eventBus.publish({
      type: "cost.incurred" as const,
      source: "test",
      task_id: "task-1",
      payload: {
        task_id: "task-1",
        repo: "owner/repo",
        provider_id: "claude-api",
        provider_type: "api" as const,
        operation: "llm_call",
        tokens_in: 100,
        tokens_out: 200,
        spend_usd: 0.3,
        usage_units: null,
        remaining: null,
      },
    });

    // New instance should replay from sequence 0 and find the event
    const config = SafetyConfigSchema.parse({});
    const restored = new SafetyLayer(handle.db, handle.eventBus, config);
    const status = restored.getCostStatus("task-1");
    // Should include both the original events' amounts and the new 0.30
    expect(status.per_task_usd).toBeGreaterThan(0);
  });

  it("handles corrupt snapshot gracefully", () => {
    handle = createTestSafetyLayer();
    handle.simulateCostEvent({ task_id: "task-1", spend_usd: 0.1 });

    // Corrupt the snapshot
    handle.db.prepare("UPDATE _meta SET value = 'not-json' WHERE key = 'safety_snapshot'").run();

    // Should not throw — falls back to full replay
    const config = SafetyConfigSchema.parse({});
    const restored = new SafetyLayer(handle.db, handle.eventBus, config);
    const status = restored.getCostStatus("task-1");
    expect(status.per_task_usd).toBeCloseTo(0.1);
  });
});

// ── Autonomy Verdicts ────────────────────────────────────────────────────────

describe("SafetyLayer — autonomy (consultJudgment)", () => {
  it("returns proceed for always_decide category", () => {
    handle = createTestSafetyLayer({
      autonomy: {
        decisions: {
          code_style: { level: "always_decide", description: "formatting" },
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
          architectural: { level: "always_ask", description: "architecture" },
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
            level: "threshold",
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
            level: "threshold",
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
          test_cat: { level: "threshold", threshold: "invalid!!!", description: "" },
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
            level: "always_decide",
            description: "base: always decide",
          },
        },
        repo_overrides: {
          "owner/critical-repo": {
            decisions: {
              refactoring: { level: "always_ask" },
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

  it("cost_check returns status with warnings", () => {
    handle = createTestSafetyLayer({
      cost_limits: { api: { per_task: { cost_usd: 1.0 } } },
    });
    handle.simulateCostEvent({ task_id: "task-1", spend_usd: 0.85 });

    const verdict = handle.safetyLayer.consultJudgment({
      type: "cost_check",
      context: { task_id: "task-1", repo: "owner/repo", details: {} },
    });
    expect(verdict.allowed).toBe(true);
    expect(verdict.action).toBe("proceed");
    expect(verdict.warnings).toBeDefined();
    expect(verdict.warnings?.length).toBeGreaterThan(0);
  });

  it("cost_check denies when limit is breached", () => {
    handle = createTestSafetyLayer({
      cost_limits: { api: { per_task: { cost_usd: 0.05 } } },
    });
    handle.simulateCostEvent({ task_id: "task-1", spend_usd: 0.1 });

    const verdict = handle.safetyLayer.consultJudgment({
      type: "cost_check",
      context: { task_id: "task-1", repo: "owner/repo", details: {} },
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.action).toBe("deny");
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

describe("SafetyLayer — hot-reload", () => {
  it("new scope rules apply immediately", () => {
    handle = createTestSafetyLayer({
      scope: { repos: { allowed: ["owner/repo-a"] } },
    });

    // Initially denied
    let verdict = handle.safetyLayer.evaluateAction("task-1", "write", {
      repo: "owner/repo-b",
    });
    expect(verdict.allowed).toBe(false);

    // Update config to allow repo-b
    handle.safetyLayer.updateConfig(
      SafetyConfigSchema.parse({
        scope: { repos: { allowed: ["owner/repo-a", "owner/repo-b"] } },
      }),
    );

    verdict = handle.safetyLayer.evaluateAction("task-1", "write", {
      repo: "owner/repo-b",
    });
    expect(verdict.allowed).toBe(true);
  });

  it("new cost limits take effect immediately", () => {
    handle = createTestSafetyLayer({
      cost_limits: { api: { per_task: { cost_usd: 1.0 } } },
    });
    handle.simulateCostEvent({ task_id: "task-1", spend_usd: 0.5 });

    // Still within $1.00 limit
    let verdict = handle.safetyLayer.evaluateAction("task-1", "read", {});
    expect(verdict.allowed).toBe(true);

    // Lower the limit to $0.40 — now breached
    handle.safetyLayer.updateConfig(
      SafetyConfigSchema.parse({
        cost_limits: { api: { per_task: { cost_usd: 0.4 } } },
      }),
    );

    verdict = handle.safetyLayer.evaluateAction("task-1", "read", {});
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("per-task cost limit");
  });

  it("new autonomy rules change verdicts", () => {
    handle = createTestSafetyLayer({
      autonomy: {
        decisions: {
          refactoring: { level: "always_decide", description: "" },
        },
      },
    });

    let verdict = handle.safetyLayer.consultJudgment({
      type: "should_i_ask",
      context: {
        task_id: "task-1",
        repo: "owner/repo",
        decision_category: "refactoring",
        details: {},
      },
    });
    expect(verdict.action).toBe("proceed");

    // Change to always_ask
    handle.safetyLayer.updateConfig(
      SafetyConfigSchema.parse({
        autonomy: {
          decisions: {
            refactoring: { level: "always_ask", description: "" },
          },
        },
      }),
    );

    verdict = handle.safetyLayer.consultJudgment({
      type: "should_i_ask",
      context: {
        task_id: "task-1",
        repo: "owner/repo",
        decision_category: "refactoring",
        details: {},
      },
    });
    expect(verdict.action).toBe("ask_human");
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

  it("reflects hot-reloaded config", () => {
    handle = createTestSafetyLayer();

    handle.safetyLayer.updateConfig(
      SafetyConfigSchema.parse({
        response_timeout: {
          review_pending: { reminder_after_ms: 3_600_000 },
        },
      }),
    );

    const policy = handle.safetyLayer.getTimeoutPolicy();
    expect(policy.review_pending.reminder_after_ms).toBe(3_600_000);
  });
});
