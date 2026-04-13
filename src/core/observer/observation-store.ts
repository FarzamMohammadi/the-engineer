/**
 * Centralized Observer — the War Room's eyes (Phase R-0).
 *
 * Every component calls observer.startSpan() or observer.observe() to report
 * what's happening. The Observer persists to SQLite, notifies real-time
 * subscribers, and powers dashboard queries.
 *
 * Complements (does not replace) EventBus (audit trail) and Logger (ops logs).
 */
import { ulid } from "ulid";
import { ObservationLevels, ObservationStatuses, ObservationType } from "../../schemas/observer.js";
import { sanitizeErrorMessage } from "../../utils/sanitize.js";
import type { BlobStore } from "./blob-store.js";
import { ObserverStore } from "./store.js";
import { ObserverStream } from "./stream.js";
import type { Observation, ObservationQuery, ObservationTypeValue, SpanOptions } from "./types.js";
import type { IObservationStore, ObservationSpan } from "./types.js";

// ── Re-exports ───────────────────────────────────────────────────────────────

export type { IObservationStore, ObservationSpan } from "./types.js";
export type { Observation, ObservationQuery, SpanOptions } from "./types.js";
export { ObservationType } from "./types.js";
export type { ObservationTypeValue } from "./types.js";

// ── Pure Helpers ─────────────────────────────────────────────────────────────

/** Extract a stack trace from an unknown value. */
function extractStack(error: unknown): string | undefined {
  if (error instanceof Error) {
    return error.stack;
  }
  return undefined;
}

/** Build an Observation record from parts. */
function buildObservation(
  id: string,
  type: ObservationTypeValue,
  name: string,
  input: Record<string, unknown> | null,
  options: SpanOptions | undefined,
  level: Observation["level"],
  status: Observation["status"],
): Observation {
  const now = new Date().toISOString();
  return {
    id,
    trace_id: options?.trace_id ?? null,
    parent_observation_id: options?.parent_observation_id ?? null,
    type,
    name,
    task_id: options?.task_id ?? null,
    phase: options?.phase ?? null,
    session_id: options?.session_id ?? null,
    start_time: now,
    end_time: null,
    duration_ms: null,
    input,
    output: null,
    metadata: null,
    level: options?.level ?? level,
    status,
    error_message: null,
  };
}

// ── Observer ─────────────────────────────────────────────────────────────────

export class ObservationStore implements IObservationStore {
  private readonly store: ObserverStore;
  private readonly stream: ObserverStream;
  private readonly blobStore: BlobStore | null;

  constructor(db: import("better-sqlite3").Database, blobStore: BlobStore | null) {
    this.store = new ObserverStore(db);
    this.stream = new ObserverStream();
    this.blobStore = blobStore;
  }

  startSpan(
    type: ObservationTypeValue,
    name: string,
    input?: Record<string, unknown>,
    options?: SpanOptions,
  ): ObservationSpan {
    const id = ulid();
    const startMs = Date.now();
    const obs = buildObservation(
      id,
      type,
      name,
      input ?? null,
      options,
      ObservationLevels.info,
      ObservationStatuses.ok,
    );

    this.store.insertObservation(obs);
    this.stream.notify(obs);

    return this.createSpan(id, type, name, startMs, options, obs);
  }

  observe(
    type: ObservationTypeValue,
    name: string,
    data: Record<string, unknown>,
    options?: SpanOptions,
  ): string {
    const id = ulid();
    const obs = buildObservation(
      id,
      type,
      name,
      data,
      options,
      ObservationLevels.info,
      ObservationStatuses.ok,
    );
    const now = obs.start_time;
    obs.end_time = now;

    this.store.insertObservation(obs);
    this.stream.notify(obs);

    return id;
  }

  recordDecision(
    name: string,
    context: string,
    options: ReadonlyArray<{ id: string; description: string }>,
    chosen: string,
    reasoning: string,
    confidence: number,
    opts?: SpanOptions,
  ): string {
    return this.observe(
      ObservationType.DECISION_POINT,
      name,
      {
        context,
        options: options.map((o) => ({ id: o.id, description: o.description })),
        chosen,
        reasoning,
        confidence,
      },
      opts,
    );
  }

  recordError(
    error: unknown,
    context: { operation: string; component: string },
    recovery?: { action: string; success: boolean },
    opts?: SpanOptions,
  ): string {
    const id = ulid();
    const obs = buildObservation(
      id,
      ObservationType.ERROR,
      context.operation,
      {
        component: context.component,
        error_message: sanitizeErrorMessage(error),
        stack: extractStack(error),
        recovery: recovery ?? null,
      },
      { ...opts, level: ObservationLevels.error },
      ObservationLevels.error,
      ObservationStatuses.error,
    );
    obs.end_time = obs.start_time;
    obs.error_message = sanitizeErrorMessage(error);

    this.store.insertObservation(obs);
    this.stream.notify(obs);

    return id;
  }

  query(filters: ObservationQuery): Observation[] {
    return this.store.queryObservations(filters);
  }

  subscribe(callback: (obs: Observation) => void): () => void {
    return this.stream.subscribe(callback);
  }

  storeBlob(content: string): string {
    if (this.blobStore === null) {
      return "";
    }
    return this.blobStore.store(content);
  }

  readBlob(hash: string): string | null {
    if (this.blobStore === null) {
      return null;
    }
    return this.blobStore.read(hash);
  }

  /** Create an ObservationSpan closure with idempotent end(). */
  private createSpan(
    id: string,
    _type: ObservationTypeValue,
    _name: string,
    startMs: number,
    options: SpanOptions | undefined,
    initialObs: Observation,
  ): ObservationSpan {
    let ended = false;
    let errorMessage: string | null = null;
    let status: Observation["status"] = ObservationStatuses.ok;

    const self = this;

    return {
      id,

      end(output?: Record<string, unknown>): void {
        if (ended) {
          return;
        }
        ended = true;

        const durationMs = Date.now() - startMs;
        const endTime = new Date().toISOString();

        self.store.updateSpanEnd(id, endTime, durationMs, output ?? null, status, errorMessage);

        const completedObs: Observation = {
          ...initialObs,
          end_time: endTime,
          duration_ms: durationMs,
          output: output ?? null,
          status,
          error_message: errorMessage,
        };
        self.stream.notify(completedObs);
      },

      startChild(
        childType: ObservationTypeValue,
        childName: string,
        childInput?: Record<string, unknown>,
      ): ObservationSpan {
        return self.startSpan(childType, childName, childInput, {
          ...options,
          parent_observation_id: id,
        });
      },

      addEvent(eventName: string, data?: Record<string, unknown>): void {
        self.observe(ObservationType.LIFECYCLE, eventName, data ?? {}, {
          ...options,
          parent_observation_id: id,
        });
      },

      setError(error: unknown): void {
        status = ObservationStatuses.error;
        errorMessage = sanitizeErrorMessage(error);
      },
    };
  }
}

// ── Factory ──────────────────────────────────────────────────────────────────

/** Create an ObservationStore instance (internal — prefer the Observer facade). */
export function createObservationStore(
  db: import("better-sqlite3").Database,
  blobStore?: BlobStore | null,
): ObservationStore {
  return new ObservationStore(db, blobStore ?? null);
}
