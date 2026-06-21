import { describe, expect, it } from "vitest";

import { PIPELINE } from "../../../../../src/core/orchestrator/pipeline/pipeline.js";
import { PREMISE_CONFLICT_CATEGORY, type Phase, Phases } from "../../../../../src/core/orchestrator/pipeline/types.js";

// The pipeline map is the heart of the system — folders are phases, files are sub-phases.
// This pins the shape so an accidental reorder or a dropped sub-phase is caught.

describe("PIPELINE", () => {
  it("runs the phases in order", () => {
    expect(PIPELINE.map((phase) => phase.phase)).toEqual([
      Phases.requirements,
      Phases.research,
      Phases.planning,
      Phases.execution,
      Phases.review,
      Phases.delivery,
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
      // auto-merge is entry-only — listed last, reached by an external event, not by advance.
      delivery: ["pr-description", "push", "create-pr", "await-review", "auto-merge"],
    });
  });

  it("loops the phases that converge by repeating, and runs single-pass phases once", () => {
    const capOf = (phase: Phase) => PIPELINE.find((p) => p.phase === phase)?.maxIterations;
    expect(capOf(Phases.execution)).toBe(3);
    expect(capOf(Phases.review)).toBe(3);
    expect(capOf(Phases.requirements)).toBe(1);
  });

  it("exempts the intent-forming phases from gating, but escalates a premise_conflict from each", () => {
    // requirements and research do not gate ordinary decisions (consultsDecisions: false), yet they still
    // escalate the one signal no later phase recovers — a wrong-or-already-solved premise — to the owner.
    const intake = (phase: Phase) => PIPELINE.find((p) => p.phase === phase);
    for (const phase of [Phases.requirements, Phases.research]) {
      expect(intake(phase)?.consultsDecisions).toBe(false);
      expect(intake(phase)?.escalatedCategories).toEqual([PREMISE_CONFLICT_CATEGORY]);
    }
    // The build phases gate every decision the normal way — no escalatedCategories carve-out.
    expect(intake(Phases.planning)?.escalatedCategories).toBeUndefined();
    expect(intake(Phases.execution)?.escalatedCategories).toBeUndefined();
  });
});
