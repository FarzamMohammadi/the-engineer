import { describe, expect, it } from "vitest";

import { PIPELINE, Phases } from "../../../../../src/core/orchestrator/pipeline/pipeline.js";

// The pipeline map is the heart of the system — folders are phases, files are sub-phases.
// This pins the upstream shape so an accidental reorder or a dropped sub-phase is caught.
// Review and delivery join the map in the next session.

describe("PIPELINE", () => {
  it("runs the upstream phases in order", () => {
    expect(PIPELINE.map((phase) => phase.phase)).toEqual([
      Phases.requirements,
      Phases.research,
      Phases.planning,
      Phases.execution,
    ]);
  });

  it("declares each phase's sub-phases in order", () => {
    const subPhases = Object.fromEntries(
      PIPELINE.map((phase) => [phase.phase, phase.subPhases.map((sub) => sub.name)]),
    );
    expect(subPhases).toEqual({
      requirements: ["gather"],
      research: ["investigate"],
      planning: ["design"],
      execution: ["implement", "verify"],
    });
  });

  it("lets execution loop implement on a red gate, but runs single-pass phases once", () => {
    const execution = PIPELINE.find((phase) => phase.phase === Phases.execution);
    const requirements = PIPELINE.find((phase) => phase.phase === Phases.requirements);
    expect(execution?.maxIterations).toBe(3);
    expect(requirements?.maxIterations).toBe(1);
  });
});
