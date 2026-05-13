/**
 * Observer module — unified observability for The Engineer.
 *
 * Public API:
 * - IObserver / Observer / createObserverFacade — the facade every component receives
 * - ObservationStore / createObservationStore — persistence layer (dashboard queries)
 * - BlobStore — content-addressable storage for large payloads
 * - createLogger — pino logger factory (rolling JSON files)
 * - Types — Observation, ObservationSpan, SpanOptions, etc.
 */

// ── Facade (primary consumer API) ───────────────────────────────────────────

export { Observer, createObserverFacade } from "./facade.js";
export type { IObserver } from "./facade.js";

// ── Observation Store (persistence + streaming) ─────────────────────────────

export { ObservationStore, createObservationStore } from "./observation-store.js";

// ── Blob Store ──────────────────────────────────────────────────────────────

export { BlobStore } from "./blob-store.js";

// ── Logger ──────────────────────────────────────────────────────────────────

export { createLogger, createSilentLogger } from "./logging.js";
export type { ComponentTag } from "./logging.js";

// ── Types ───────────────────────────────────────────────────────────────────

export type { IObservationStore, ObservationSpan } from "./types.js";
export type { Observation, ObservationQuery, SpanOptions } from "./types.js";
export { ObservationTypes } from "./types.js";
export type { ObservationTypeValue } from "./types.js";
