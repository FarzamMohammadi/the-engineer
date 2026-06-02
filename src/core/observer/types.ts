/**
 * Observer types — IObservationStore interface and ObservationSpan interface.
 *
 * Re-exports schema types and defines runtime interfaces that components
 * depend on for dependency injection.
 */
export type {
  Observation,
  ObservationLevel,
  ObservationQuery,
  ObservationStatus,
  ObservationTypeValue,
  SpanOptions,
} from "../../schemas/observer.js";

export { ObservationTypes } from "../../schemas/observer.js";

// ── ObservationSpan ───────────────────────────────────────────────────────────

/** Handle returned by startSpan(). Call end() to record duration. */
export interface ObservationSpan {
  readonly id: string;
  /** End the span, recording duration and optional output data. */
  end(output?: Record<string, unknown>): void;
  /** Start a child span nested under this one. */
  startChild(
    type: import("../../schemas/observer.js").ObservationTypeValue,
    name: string,
    input?: Record<string, unknown>,
  ): ObservationSpan;
  /** Record a point-in-time event within this span. */
  addEvent(name: string, data?: Record<string, unknown>): void;
  /** Mark this span as errored. */
  setError(error: unknown): void;
}

// ── IObservationStore ─────────────────────────────────────────────────────────

/** Observation-only store contract (SQLite persistence powering dashboard queries). */
export interface IObservationStore {
  /** Start an observation span. Returns a handle with end(). Duration auto-recorded. */
  startSpan(
    type: import("../../schemas/observer.js").ObservationTypeValue,
    name: string,
    input?: Record<string, unknown>,
    options?: import("../../schemas/observer.js").SpanOptions,
  ): ObservationSpan;

  /** Record an instant observation (no duration — a point-in-time fact). */
  observe(
    type: import("../../schemas/observer.js").ObservationTypeValue,
    name: string,
    data: Record<string, unknown>,
    options?: import("../../schemas/observer.js").SpanOptions,
  ): string;

  /** Record a decision point with alternatives and reasoning. */
  recordDecision(
    name: string,
    context: string,
    options: ReadonlyArray<{ id: string; description: string }>,
    chosen: string,
    reasoning: string,
    confidence: number,
    opts?: import("../../schemas/observer.js").SpanOptions,
  ): string;

  /** Record an error with full context and optional recovery info. */
  recordError(
    error: unknown,
    context: { operation: string; component: string },
    recovery?: { action: string; success: boolean },
    opts?: import("../../schemas/observer.js").SpanOptions,
  ): string;

  /** Query observations. Powers dashboard historical views. */
  query(
    filters: import("../../schemas/observer.js").ObservationQuery,
  ): import("../../schemas/observer.js").Observation[];

  /** Store large content (agent prompts/responses) in blob store. */
  storeBlob(content: string): string;

  /** Read content from blob store by hash reference. */
  readBlob(hash: string): string | null;
}
