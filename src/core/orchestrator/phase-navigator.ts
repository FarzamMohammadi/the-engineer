import type { Phase } from "../../schemas/orchestrator.js";

/**
 * Centralized cursor-based phase navigation for the pipeline runner.
 *
 * All index arithmetic, bounds checking, and phase lookups happen here.
 * The pipeline loop uses named operations (`advance`, `jumpTo`, `current`)
 * instead of raw index manipulation — eliminating the off-by-one class of bugs.
 */
export class PhaseNavigator {
  private phases: Phase[];
  private cursor: number;
  private readonly initialCursor: number;

  constructor(phases: Phase[], startIndex: number) {
    if (phases.length === 0) {
      throw new Error("PhaseNavigator: phases array must not be empty");
    }
    if (startIndex < 0 || startIndex > phases.length) {
      throw new Error(
        `PhaseNavigator: startIndex ${String(startIndex)} out of bounds [0, ${String(phases.length)}]`,
      );
    }
    this.phases = [...phases];
    this.cursor = startIndex;
    this.initialCursor = startIndex;
  }

  /** The current phase to execute. Throws if exhausted. */
  current(): Phase {
    const phase = this.phases[this.cursor];
    if (phase === undefined) {
      throw new Error(
        `PhaseNavigator: cursor ${String(this.cursor)} is past end of phases (length ${String(this.phases.length)})`,
      );
    }
    return phase;
  }

  /** Move to the next phase. Returns false if pipeline is exhausted. */
  advance(): boolean {
    this.cursor++;
    return this.cursor < this.phases.length;
  }

  /** Jump to a specific phase by name. Throws if phase not in sequence. */
  jumpTo(phase: Phase): void {
    const index = this.phases.indexOf(phase);
    if (index < 0) {
      throw new Error(
        `PhaseNavigator: phase "${phase}" not found in sequence [${this.phases.join(", ")}]`,
      );
    }
    this.cursor = index;
  }

  /** Replace the phase sequence (e.g., after skip_research). Preserves current phase position. */
  replaceSequence(phases: Phase[]): void {
    if (phases.length === 0) {
      throw new Error("PhaseNavigator: replacement phases array must not be empty");
    }
    // If cursor is within the current sequence, try to preserve position by phase name
    if (this.cursor < this.phases.length) {
      const currentPhase = this.phases[this.cursor];
      this.phases = [...phases];
      if (currentPhase !== undefined) {
        const newIndex = this.phases.indexOf(currentPhase);
        if (newIndex >= 0) {
          this.cursor = newIndex;
          return;
        }
      }
    }
    // Fallback: clamp cursor to the end (exhausted)
    this.phases = [...phases];
    if (this.cursor >= this.phases.length) {
      this.cursor = this.phases.length;
    }
  }

  /** Whether there are more phases to run. */
  hasMore(): boolean {
    return this.cursor < this.phases.length;
  }

  /** How many phases have been executed so far (distance from initial cursor). */
  phasesRun(): number {
    return this.cursor - this.initialCursor;
  }

  /** Get all phases from cursor onward (inclusive). Used for output clearing on loopback. */
  phasesFromCursor(): Phase[] {
    return this.phases.slice(this.cursor);
  }

  /** The raw cursor index — for logging/observation only, never for arithmetic. */
  currentIndex(): number {
    return this.cursor;
  }

  /** The current phase sequence. */
  getPhases(): Phase[] {
    return [...this.phases];
  }
}
