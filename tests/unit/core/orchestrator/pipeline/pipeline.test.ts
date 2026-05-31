import { describe, expect, it } from "vitest";

import { PIPELINE } from "../../../../../src/core/orchestrator/pipeline/pipeline.js";
import { type Phase, Phases } from "../../../../../src/core/orchestrator/pipeline/types.js";

// The pipeline map is the heart of the system — folders are phases, files are sub-phases.
// This pins the shape so an accidental reorder or a dropped sub-phase is caught. Delivery
// joins the map in the next session.

describe("PIPELINE", () => {
  it("runs the phases in order", () => {
    expect(PIPELINE.map((phase) => phase.phase)).toEqual([
      Phases.requirements,
      Phases.research,
      Phases.planning,
      Phases.execution,
      Phases.review,
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
      // Every lens is listed; the opt-in lenses skip themselves when not enabled in config.
      review: ["self-review", "security", "code-quality", "architecture", "refine"],
    });
  });

  it("loops the phases that converge by repeating, and runs single-pass phases once", () => {
    const capOf = (phase: Phase) => PIPELINE.find((p) => p.phase === phase)?.maxIterations;
    expect(capOf(Phases.execution)).toBe(3);
    expect(capOf(Phases.review)).toBe(3);
    expect(capOf(Phases.requirements)).toBe(1);
  });
});
