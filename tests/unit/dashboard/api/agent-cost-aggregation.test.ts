import { describe, expect, it } from "vitest";

import { aggregateAgentCost } from "../../../../src/dashboard/api/agent-cost-aggregation.js";
import type { Observation } from "../../../../src/schemas/observer.js";

/** Build a minimal agent_call observation; override `output`/`input`/`phase`/`start_time` per test. */
function agentCall(overrides: Partial<Observation>): Observation {
  return {
    id: "obs",
    trace_id: null,
    parent_observation_id: null,
    type: "agent_call",
    name: "implement",
    task_id: "task-1",
    phase: "execution",
    session_id: null,
    start_time: "2026-06-02T10:00:00.000Z",
    end_time: "2026-06-02T10:01:00.000Z",
    duration_ms: 1000,
    input: null,
    output: null,
    metadata: null,
    level: "info",
    status: "ok",
    error_message: null,
    links: null,
    ...overrides,
  };
}

describe("aggregateAgentCost", () => {
  it("returns null totalSpend when no run reported a numeric cost", () => {
    const result = aggregateAgentCost([
      agentCall({ output: { cost_usd: null, tokens_in: 100, tokens_out: 50 } }),
      agentCall({ output: { tokens_in: 10 } }),
    ]);

    expect(result.totalSpend).toBeNull();
    // Tokens still aggregate even without cost data.
    expect(result.tokenTotals.input).toBe(110);
  });

  it("treats a real $0 run as cost data, so totalSpend is 0 rather than null", () => {
    const result = aggregateAgentCost([agentCall({ output: { cost_usd: 0, tokens_in: 5, tokens_out: 5 } })]);
    expect(result.totalSpend).toBe(0);
  });

  it("sums spend per phase and counts every agent_call, including zero-cost runs", () => {
    const result = aggregateAgentCost([
      agentCall({ phase: "execution", output: { cost_usd: 0.1, tokens_in: 100, tokens_out: 40 } }),
      agentCall({ phase: "execution", output: { cost_usd: 0, tokens_in: 5, tokens_out: 5 } }),
      agentCall({ phase: "review", output: { cost_usd: 0.25, tokens_in: 200, tokens_out: 80 } }),
    ]);

    expect(result.totalSpend).toBeCloseTo(0.35);
    expect(result.perPhase[0]?.phase).toBe("review"); // sorted by spend, highest first
    const execution = result.perPhase.find((p) => p.phase === "execution");
    expect(execution?.spend_usd).toBeCloseTo(0.1);
    expect(execution?.agent_calls).toBe(2);
  });

  it("buckets a phase-less observation under 'unknown'", () => {
    const result = aggregateAgentCost([agentCall({ phase: null, output: { cost_usd: 0.05 } })]);
    expect(result.perPhase[0]?.phase).toBe("unknown");
  });

  it("reads spend from input on the observe() path and honors the token-name fallbacks", () => {
    const result = aggregateAgentCost([
      agentCall({
        output: null,
        input: { cost_usd: 0.2, input_tokens: 70, output_tokens: 30, cache_read_tokens: 12, cache_creation_tokens: 9 },
      }),
    ]);

    expect(result.totalSpend).toBeCloseTo(0.2);
    expect(result.tokenTotals.input).toBe(70);
    expect(result.tokenTotals.output).toBe(30);
    expect(result.tokenTotals.cache_read).toBe(12);
    expect(result.tokenTotals.cache_creation).toBe(9);
  });

  it("sums cache-write tokens across runs and defaults a missing one to 0", () => {
    const result = aggregateAgentCost([
      agentCall({ output: { cost_usd: 0.1, cache_creation_tokens: 100 } }),
      agentCall({ output: { cost_usd: 0.1, cache_read_tokens: 5 } }), // no cache_creation_tokens
    ]);
    expect(result.tokenTotals.cache_creation).toBe(100);
  });

  it("caps the per-day breakdown at 30 entries, newest first", () => {
    const observations = Array.from({ length: 40 }, (_, i) => {
      const dayNumber = i + 1;
      const date =
        dayNumber <= 31
          ? `2026-01-${String(dayNumber).padStart(2, "0")}`
          : `2026-02-${String(dayNumber - 31).padStart(2, "0")}`;
      return agentCall({ start_time: `${date}T10:00:00.000Z`, output: { cost_usd: 0.01 } });
    });

    const result = aggregateAgentCost(observations);

    expect(result.perDay).toHaveLength(30);
    expect(result.perDay[0]?.day).toBe("2026-02-09");
  });
});
