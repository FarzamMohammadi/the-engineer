import { describe, expect, it } from "vitest";

import { type CostEventLike, modelsFromCostEvents } from "../../../src/dashboard/client/src/lib/cost-events.js";

// ── cost-events ────────────────────────────────────────────────────────────────
//
// The agent's model id is NOT on the agent_call span; it rides the `cost.incurred` event payload. The Agent
// Calls tab joins them at the task level — the distinct model ids across a task's cost events are the model(s)
// it ran on. This reader extracts that honestly (no mislabeling a step name as a model) and de-dups in
// first-seen order. It takes the `{ type, payload }` slice, so the test builds that slice directly.

function makeEvent(type: string, payload: Record<string, unknown>): CostEventLike {
  return { type, payload };
}

describe("modelsFromCostEvents", () => {
  it("returns the distinct model ids from cost.incurred events in first-seen order", () => {
    const events = [
      makeEvent("cost.incurred", { model_id: "claude-opus-4" }),
      makeEvent("cost.incurred", { model_id: "claude-sonnet-4" }),
      makeEvent("cost.incurred", { model_id: "claude-opus-4" }),
    ];
    expect(modelsFromCostEvents(events)).toEqual(["claude-opus-4", "claude-sonnet-4"]);
  });

  it("ignores events that are not cost.incurred", () => {
    const events = [makeEvent("task.created", { model_id: "ghost" }), makeEvent("cost.incurred", { model_id: "real" })];
    expect(modelsFromCostEvents(events)).toEqual(["real"]);
  });

  it("skips a null or absent model_id (a CLI that omits pricing)", () => {
    const events = [
      makeEvent("cost.incurred", { model_id: null }),
      makeEvent("cost.incurred", {}),
      makeEvent("cost.incurred", { model_id: "claude-opus-4" }),
    ];
    expect(modelsFromCostEvents(events)).toEqual(["claude-opus-4"]);
  });

  it("returns an empty list when no cost events carry a model", () => {
    expect(modelsFromCostEvents([])).toEqual([]);
  });
});
