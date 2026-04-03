import { describe, expect, it } from "vitest";
import type { Phase } from "../../schemas/orchestrator.js";
import { Phases } from "../../schemas/orchestrator.js";
import { PhaseNavigator } from "./phase-navigator.js";

const ALL_PHASES: Phase[] = [
  Phases.requirements_gathering,
  Phases.research,
  Phases.planning,
  Phases.execution,
  Phases.self_review,
  Phases.demo_prep,
  Phases.integration,
];

describe("PhaseNavigator", () => {
  // ── Constructor ─────────────────────────────────────────────────────────

  it("throws on empty phases array", () => {
    expect(() => new PhaseNavigator([], 0)).toThrow("must not be empty");
  });

  it("throws on negative startIndex", () => {
    expect(() => new PhaseNavigator(ALL_PHASES, -1)).toThrow("out of bounds");
  });

  it("throws on startIndex beyond phases length", () => {
    expect(() => new PhaseNavigator(ALL_PHASES, 8)).toThrow("out of bounds");
  });

  it("allows startIndex equal to phases length (exhausted from start)", () => {
    const nav = new PhaseNavigator(ALL_PHASES, 7);
    expect(nav.hasMore()).toBe(false);
  });

  // ── current() ──────────────────────────────────────────────────────────

  it("returns the phase at startIndex", () => {
    const nav = new PhaseNavigator(ALL_PHASES, 0);
    expect(nav.current()).toBe(Phases.requirements_gathering);
  });

  it("returns the phase at a non-zero startIndex", () => {
    const nav = new PhaseNavigator(ALL_PHASES, 3);
    expect(nav.current()).toBe(Phases.execution);
  });

  it("throws when cursor is past end", () => {
    const nav = new PhaseNavigator(ALL_PHASES, 7);
    expect(() => nav.current()).toThrow("past end of phases");
  });

  // ── advance() ──────────────────────────────────────────────────────────

  it("advances through all phases sequentially", () => {
    const nav = new PhaseNavigator(ALL_PHASES, 0);
    const visited: Phase[] = [];
    while (nav.hasMore()) {
      visited.push(nav.current());
      nav.advance();
    }
    expect(visited).toEqual(ALL_PHASES);
  });

  it("returns true while more phases remain, false when exhausted", () => {
    const nav = new PhaseNavigator([Phases.execution, Phases.self_review], 0);
    expect(nav.advance()).toBe(true); // moved to self_review
    expect(nav.advance()).toBe(false); // exhausted
  });

  it("advance past end makes hasMore false", () => {
    const nav = new PhaseNavigator([Phases.execution], 0);
    nav.advance();
    expect(nav.hasMore()).toBe(false);
  });

  // ── jumpTo() ───────────────────────────────────────────────────────────

  it("jumps to a named phase", () => {
    const nav = new PhaseNavigator(ALL_PHASES, 0);
    nav.jumpTo(Phases.execution);
    expect(nav.current()).toBe(Phases.execution);
    expect(nav.currentIndex()).toBe(3);
  });

  it("jumps backward", () => {
    const nav = new PhaseNavigator(ALL_PHASES, 5);
    nav.jumpTo(Phases.requirements_gathering);
    expect(nav.current()).toBe(Phases.requirements_gathering);
    expect(nav.currentIndex()).toBe(0);
  });

  it("throws when jumping to a phase not in the sequence", () => {
    const shortened: Phase[] = [Phases.planning, Phases.execution];
    const nav = new PhaseNavigator(shortened, 0);
    expect(() => nav.jumpTo(Phases.research)).toThrow('phase "research" not found');
  });

  // ── replaceSequence() ──────────────────────────────────────────────────

  it("preserves cursor position when current phase exists in new sequence", () => {
    const nav = new PhaseNavigator(ALL_PHASES, 3); // execution
    const noResearch = ALL_PHASES.filter((p) => p !== Phases.research);
    nav.replaceSequence(noResearch);
    expect(nav.current()).toBe(Phases.execution);
    // execution is now at index 2 in the shortened sequence
    expect(nav.currentIndex()).toBe(2);
  });

  it("clamps cursor when current phase is removed from new sequence", () => {
    const nav = new PhaseNavigator(ALL_PHASES, 1); // research
    const noResearch = ALL_PHASES.filter((p) => p !== Phases.research);
    nav.replaceSequence(noResearch);
    // research is gone, cursor clamps — shouldn't exceed new length
    expect(nav.currentIndex()).toBeLessThanOrEqual(noResearch.length);
  });

  it("throws on empty replacement", () => {
    const nav = new PhaseNavigator(ALL_PHASES, 0);
    expect(() => nav.replaceSequence([])).toThrow("must not be empty");
  });

  // ── phasesRun() ────────────────────────────────────────────────────────

  it("counts phases run from start", () => {
    const nav = new PhaseNavigator(ALL_PHASES, 0);
    expect(nav.phasesRun()).toBe(0);
    nav.advance();
    expect(nav.phasesRun()).toBe(1);
    nav.advance();
    nav.advance();
    expect(nav.phasesRun()).toBe(3);
  });

  it("counts correctly with non-zero startIndex", () => {
    const nav = new PhaseNavigator(ALL_PHASES, 2); // planning
    expect(nav.phasesRun()).toBe(0);
    nav.advance();
    expect(nav.phasesRun()).toBe(1);
  });

  it("counts correctly across jumpTo (measures distance, not steps)", () => {
    const nav = new PhaseNavigator(ALL_PHASES, 0);
    nav.jumpTo(Phases.execution); // cursor = 3
    expect(nav.phasesRun()).toBe(3);
    nav.jumpTo(Phases.requirements_gathering); // cursor = 0
    expect(nav.phasesRun()).toBe(0);
  });

  // ── phasesFromCursor() ─────────────────────────────────────────────────

  it("returns all remaining phases including current", () => {
    const nav = new PhaseNavigator(ALL_PHASES, 4); // self_review
    expect(nav.phasesFromCursor()).toEqual([
      Phases.self_review,
      Phases.demo_prep,
      Phases.integration,
    ]);
  });

  it("returns empty when exhausted", () => {
    const nav = new PhaseNavigator(ALL_PHASES, 7);
    expect(nav.phasesFromCursor()).toEqual([]);
  });

  // ── getPhases() ────────────────────────────────────────────────────────

  it("returns a copy of the phases array", () => {
    const nav = new PhaseNavigator(ALL_PHASES, 0);
    const phases = nav.getPhases();
    phases.pop(); // mutate the copy
    expect(nav.getPhases()).toEqual(ALL_PHASES); // original unchanged
  });

  // ── Integration: loopback simulation ───────────────────────────────────

  it("simulates self-review → execution loopback correctly", () => {
    const nav = new PhaseNavigator(ALL_PHASES, 0);
    // Advance to self_review
    while (nav.current() !== Phases.self_review) {
      nav.advance();
    }
    expect(nav.current()).toBe(Phases.self_review);

    // Loopback to execution
    nav.jumpTo(Phases.execution);
    expect(nav.current()).toBe(Phases.execution);

    // Continue from execution
    nav.advance();
    expect(nav.current()).toBe(Phases.self_review);
  });

  it("simulates requirements fallback from planning correctly", () => {
    const nav = new PhaseNavigator(ALL_PHASES, 0);
    // Advance to planning
    nav.jumpTo(Phases.planning);
    expect(nav.current()).toBe(Phases.planning);

    // Fallback to requirements_gathering
    nav.jumpTo(Phases.requirements_gathering);
    expect(nav.current()).toBe(Phases.requirements_gathering);
    expect(nav.currentIndex()).toBe(0);

    // After requirements, jump back to planning
    nav.jumpTo(Phases.planning);
    expect(nav.current()).toBe(Phases.planning);
  });

  it("simulates requirements_gathering blocking and resuming without self-loop", () => {
    // First dispatch: starts at 0, runs requirements_gathering, blocks
    const nav1 = new PhaseNavigator(ALL_PHASES, 0);
    expect(nav1.current()).toBe(Phases.requirements_gathering);
    // Phase completes, no returnToPhase — would advance normally

    // Second dispatch after unblock: starts fresh at 0 again (no checkpoint)
    const nav2 = new PhaseNavigator(ALL_PHASES, 0);
    expect(nav2.current()).toBe(Phases.requirements_gathering);
    // After requirements_gathering completes, advance to research
    nav2.advance();
    expect(nav2.current()).toBe(Phases.research);
    // No self-loop!
  });
});
