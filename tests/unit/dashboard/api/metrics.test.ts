import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { metricsRoutes } from "../../../../src/dashboard/api/metrics.js";
import { systemRoutes } from "../../../../src/dashboard/api/system.js";
import { ObservationTypes } from "../../../../src/schemas/observer.js";
import { createTestObserverFacade } from "../../../helpers/test-observer-facade.js";
import { type TestObserverHandle, createTestObserver } from "../../../helpers/test-observer.js";

// ── Helpers ──────────────────────────────────────────────────────────────────────

/** Record a finished agent_call span carrying real cost/token spend in the phase a dashboard view groups by. */
function recordAgentCall(
  handle: TestObserverHandle,
  phase: string,
  spend: {
    cost_usd: number;
    tokens_in: number;
    tokens_out: number;
    cache_read_tokens?: number;
    cache_creation_tokens?: number;
  },
): void {
  const span = handle.observer.startSpan(ObservationTypes.agent_call, "implement", { step: "implement" }, { phase });
  span.end({ outcome: "ok", ...spend });
}

// ── Tests ────────────────────────────────────────────────────────────────────────

describe("metricsRoutes — GET /cost", () => {
  let handle: TestObserverHandle;
  let app: ReturnType<typeof metricsRoutes>;

  beforeEach(() => {
    handle = createTestObserver();
    app = metricsRoutes({
      db: handle.db.db,
      observationStore: handle.observer,
      observer: createTestObserverFacade("cli"),
    });
  });

  afterEach(() => {
    handle.cleanup();
  });

  it("aggregates per-phase cost and agent-call count from agent_call spans", async () => {
    recordAgentCall(handle, "execution", {
      cost_usd: 0.5,
      tokens_in: 1000,
      tokens_out: 200,
      cache_creation_tokens: 400,
    });
    recordAgentCall(handle, "execution", { cost_usd: 0.25, tokens_in: 500, tokens_out: 100 });
    recordAgentCall(handle, "research", { cost_usd: 0.1, tokens_in: 300, tokens_out: 50, cache_creation_tokens: 600 });

    const res = await app.request("/cost");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      per_phase: Array<{ phase: string; spend_usd: number; agent_calls: number }>;
      today_spend_usd: number;
      token_totals: { input: number; output: number; cache_creation: number };
    };

    const execution = body.per_phase.find((p) => p.phase === "execution");
    expect(execution).toMatchObject({ spend_usd: 0.75, agent_calls: 2 });

    const research = body.per_phase.find((p) => p.phase === "research");
    expect(research).toMatchObject({ spend_usd: 0.1, agent_calls: 1 });

    expect(body.token_totals).toMatchObject({ input: 1800, output: 350, cache_creation: 1000 });
  });

  it("counts a zero-cost agent call as an agent call without inflating spend", async () => {
    recordAgentCall(handle, "planning", { cost_usd: 0, tokens_in: 100, tokens_out: 20 });

    const res = await app.request("/cost");
    const body = (await res.json()) as { per_phase: Array<{ phase: string; spend_usd: number; agent_calls: number }> };

    const planning = body.per_phase.find((p) => p.phase === "planning");
    expect(planning).toMatchObject({ spend_usd: 0, agent_calls: 1 });
  });
});

describe("systemRoutes — GET /status total_spend_usd", () => {
  let handle: TestObserverHandle;
  let app: ReturnType<typeof systemRoutes>;

  beforeEach(() => {
    handle = createTestObserver();
    app = systemRoutes({
      db: handle.db.db,
      observationStore: handle.observer,
      runDir: "/tmp/does-not-exist",
      telemetryEnabled: false,
      telemetryUiBase: "http://localhost:16686",
    });
  });

  afterEach(() => {
    handle.cleanup();
  });

  it("sums total spend from agent_call spans", async () => {
    recordAgentCall(handle, "execution", { cost_usd: 0.4, tokens_in: 100, tokens_out: 20 });
    recordAgentCall(handle, "self_review", { cost_usd: 0.6, tokens_in: 200, tokens_out: 40 });

    const res = await app.request("/status");
    const body = (await res.json()) as { total_spend_usd: number | null };

    expect(body.total_spend_usd).toBeCloseTo(1.0, 5);
  });

  it("reports null total spend when no agent has run, not a confidently-wrong 0", async () => {
    const res = await app.request("/status");
    const body = (await res.json()) as { total_spend_usd: number | null };

    expect(body.total_spend_usd).toBeNull();
  });
});

describe("systemRoutes — GET /status telemetry surface", () => {
  let handle: TestObserverHandle;

  beforeEach(() => {
    handle = createTestObserver();
  });

  afterEach(() => {
    handle.cleanup();
  });

  async function statusBody(telemetryEnabled: boolean, telemetryUiBase: string): Promise<Record<string, unknown>> {
    const app = systemRoutes({
      db: handle.db.db,
      observationStore: handle.observer,
      runDir: "/tmp/does-not-exist",
      telemetryEnabled,
      telemetryUiBase,
    });
    const res = await app.request("/status");
    return (await res.json()) as Record<string, unknown>;
  }

  it("surfaces telemetry_enabled and telemetry_ui_base so the client can build the Jaeger link", async () => {
    const body = await statusBody(true, "http://localhost:16686");

    expect(body["telemetry_enabled"]).toBe(true);
    expect(body["telemetry_ui_base"]).toBe("http://localhost:16686");
  });

  it("reports telemetry_enabled false when export is off (the link stays hidden)", async () => {
    const body = await statusBody(false, "http://localhost:16686");

    expect(body["telemetry_enabled"]).toBe(false);
  });
});
