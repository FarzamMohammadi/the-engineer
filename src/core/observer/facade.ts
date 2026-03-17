/**
 * Unified Observer facade — one interface for logging + observation.
 *
 * Wraps pino (structured ops logs → rolling JSON files) and the ObservationStore
 * (traces → SQLite for War Room) behind a single component-scoped API.
 *
 * Every component receives `observer: IObserver`. No more optional loggers,
 * no more console fallbacks.
 *
 * Design:
 * - IObserver: what components use (logging + tracing + child creation)
 * - Observer class: the concrete implementation, also exposes upgrade() for bootstrap
 * - SharedContext: shared mutable container for late-binding the observation store
 *   (logging works from second 1, tracing joins when DB is ready)
 */
import type { Logger } from "pino";

import { sanitizeErrorMessage } from "../../utils/sanitize.js";
import type { ComponentTag } from "./logging.js";
import type { ObservationTypeValue, SpanOptions } from "./types.js";
import type { IObservationStore, ObservationSpan } from "./types.js";

// ── No-Op Span ───────────────────────────────────────────────────────────

/** Returned when observation store is not yet available. All methods are no-ops. */
const NO_OP_SPAN: ObservationSpan = {
  id: "",
  // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op
  end() {},
  startChild() {
    return NO_OP_SPAN;
  },
  // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op
  addEvent() {},
  // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op
  setError() {},
};

// ── Shared Context ───────────────────────────────────────────────────────

/**
 * Shared mutable context passed to all Observer children.
 *
 * The root pino logger lives here so children create flat siblings
 * (tagged with their own component) rather than nested children-of-children.
 * The observation store starts null and is set once via Observer.upgrade().
 */
interface SharedContext {
  readonly rootPino: Logger;
  store: IObservationStore | null;
}

// ── IObserver ────────────────────────────────────────────────────────────

/** Unified observability facade. Every component gets one. */
export interface IObserver {
  // ── Structured Logging (→ pino rolling JSON files) ──────────────────
  //
  // SECURITY: These methods do NOT auto-sanitize `data` payloads. Callers MUST
  // use `sanitizeErrorMessage()` for any error messages or values that could
  // contain secrets. Only `recordError()` sanitizes automatically.
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  debug(msg: string, data?: Record<string, unknown>): void;

  // ── Tracing (→ SQLite for War Room) ─────────────────────────────────
  startSpan(
    type: ObservationTypeValue,
    name: string,
    input?: Record<string, unknown>,
    options?: SpanOptions,
  ): ObservationSpan;

  observe(
    type: ObservationTypeValue,
    name: string,
    data: Record<string, unknown>,
    options?: SpanOptions,
  ): string;

  recordDecision(
    name: string,
    context: string,
    options: ReadonlyArray<{ id: string; description: string }>,
    chosen: string,
    reasoning: string,
    confidence: number,
    opts?: SpanOptions,
  ): string;

  /** DUAL: writes to pino AND observation store. */
  recordError(
    error: unknown,
    context: { operation: string; component: string },
    recovery?: { action: string; success: boolean },
    opts?: SpanOptions,
  ): string;

  // ── Child creation ──────────────────────────────────────────────────
  child(component: ComponentTag): IObserver;

  // ── Escape hatch (for code that needs raw pino, e.g. pino-pretty) ──
  readonly pino: Logger;
}

// ── Observer ─────────────────────────────────────────────────────────────

export class Observer implements IObserver {
  readonly pino: Logger;
  private readonly ctx: SharedContext;

  constructor(ctx: SharedContext, component: ComponentTag) {
    this.ctx = ctx;
    this.pino = ctx.rootPino.child({ component });
  }

  // ── Logging ─────────────────────────────────────────────────────────

  info(msg: string, data?: Record<string, unknown>): void {
    if (data) {
      this.pino.info(data, msg);
    } else {
      this.pino.info(msg);
    }
  }

  warn(msg: string, data?: Record<string, unknown>): void {
    if (data) {
      this.pino.warn(data, msg);
    } else {
      this.pino.warn(msg);
    }
  }

  error(msg: string, data?: Record<string, unknown>): void {
    if (data) {
      this.pino.error(data, msg);
    } else {
      this.pino.error(msg);
    }
  }

  debug(msg: string, data?: Record<string, unknown>): void {
    if (data) {
      this.pino.debug(data, msg);
    } else {
      this.pino.debug(msg);
    }
  }

  // ── Tracing (delegated to store, no-op when null) ───────────────────

  startSpan(
    type: ObservationTypeValue,
    name: string,
    input?: Record<string, unknown>,
    options?: SpanOptions,
  ): ObservationSpan {
    return this.ctx.store?.startSpan(type, name, input, options) ?? NO_OP_SPAN;
  }

  observe(
    type: ObservationTypeValue,
    name: string,
    data: Record<string, unknown>,
    options?: SpanOptions,
  ): string {
    return this.ctx.store?.observe(type, name, data, options) ?? "";
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
    return (
      this.ctx.store?.recordDecision(name, context, options, chosen, reasoning, confidence, opts) ??
      ""
    );
  }

  recordError(
    error: unknown,
    context: { operation: string; component: string },
    recovery?: { action: string; success: boolean },
    opts?: SpanOptions,
  ): string {
    // DUAL: always log to pino, regardless of store availability.
    // Sanitize the error message to prevent secret leakage to log files
    // (e.g., HTTP errors containing token-bearing URLs).
    const sanitizedMsg = sanitizeErrorMessage(error);
    this.pino.error(
      { err: sanitizedMsg, operation: context.operation, component: context.component },
      `Error in ${context.operation}`,
    );
    return this.ctx.store?.recordError(error, context, recovery, opts) ?? "";
  }

  // ── Child ───────────────────────────────────────────────────────────

  child(component: ComponentTag): IObserver {
    return new Observer(this.ctx, component);
  }

  // ── Lifecycle (only called on the root instance from bootstrap) ─────

  /**
   * Attach the observation store after DB initialization.
   * All existing children automatically gain tracing capabilities
   * because they share the same context object.
   */
  upgrade(store: IObservationStore): void {
    this.ctx.store = store;
  }
}

// ── Factory ──────────────────────────────────────────────────────────────

/** Create a root Observer facade. Call observer.upgrade(store) after DB init. */
export function createObserverFacade(pinoLogger: Logger, component: ComponentTag): Observer {
  return new Observer({ rootPino: pinoLogger, store: null }, component);
}
