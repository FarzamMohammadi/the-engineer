import type { ZodType } from "zod";

import { matchesPattern } from "./index.js";

// ── Types ────────────────────────────────────────────────────────────────────

/** A single event type declaration — who publishes it, what its payload looks like. */
export interface EventDeclaration<T extends string = string> {
  /** The event type string (e.g., "task.created"). */
  readonly type: T;
  /** Human-readable description. */
  readonly description: string;
  /** Zod schema for runtime payload validation. */
  readonly payloadSchema: ZodType;
  /** Which component(s) publish this event. */
  publishers: string[];
  /** Which component(s) subscribe to this event (populated at registration time). */
  subscribers: string[];
}

/** JSON-serializable topology graph for dashboard visualization. */
export interface EventTopologyGraph {
  events: Array<{
    type: string;
    description: string;
    publishers: string[];
    subscribers: string[];
  }>;
  components: Array<{
    id: string;
    publishes: string[];
    subscribes: string[];
  }>;
}

/** Result of payload validation. */
export interface ValidationResult {
  valid: boolean;
  errors?: string[];
}

// ── EventTopology ────────────────────────────────────────────────────────────

/**
 * Declarative event topology — single source of truth for all event types,
 * their publishers, subscribers, and payload schemas.
 *
 * Built during bootstrap. Consumed by EventBus (optional runtime validation)
 * and the War Room dashboard (topology graph).
 */
export class EventTopology {
  private readonly declarations = new Map<string, EventDeclaration>();

  /**
   * Register event declarations from a component.
   * Called during bootstrap for each Core component and plugin.
   *
   * If an event type is already registered, the componentId is appended
   * to the existing declaration's publishers (supports shared events like
   * health.stuck_detected published by multiple daemon subsystems).
   */
  registerPublisher(componentId: string, events: EventDeclaration[]): void {
    for (const event of events) {
      const existing = this.declarations.get(event.type);
      if (existing) {
        if (!existing.publishers.includes(componentId)) {
          existing.publishers.push(componentId);
        }
      } else {
        this.declarations.set(event.type, {
          ...event,
          publishers: [...event.publishers],
          subscribers: [...event.subscribers],
        });
      }
    }
  }

  /**
   * Register a subscription interest.
   * Called during bootstrap. Records that `subscriberId` listens to `eventType`.
   *
   * For glob patterns (e.g., "task.*"), the subscriber is added to every
   * matching declaration. For exact types, only the specific declaration.
   */
  registerSubscriber(subscriberId: string, eventType: string): void {
    for (const [declType, decl] of this.declarations) {
      if (matchesPattern(eventType, declType)) {
        if (!decl.subscribers.includes(subscriberId)) {
          decl.subscribers.push(subscriberId);
        }
      }
    }
  }

  /**
   * Get the declaration for a specific event type.
   * Returns undefined if the event type is not registered.
   */
  getDeclaration(eventType: string): EventDeclaration | undefined {
    return this.declarations.get(eventType);
  }

  /** Get all registered declarations. */
  getAllDeclarations(): EventDeclaration[] {
    return [...this.declarations.values()];
  }

  /**
   * Validate a payload against the declared schema for the given event type.
   * Returns { valid: true } for unknown event types (forward compatibility).
   */
  validatePayload(eventType: string, payload: Record<string, unknown>): ValidationResult {
    const decl = this.declarations.get(eventType);
    if (!decl) {
      return { valid: true };
    }

    const result = decl.payloadSchema.safeParse(payload);
    if (result.success) {
      return { valid: true };
    }

    const errors = result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    return { valid: false, errors };
  }

  /**
   * Get the full event topology graph for dashboard visualization.
   * Returns a JSON-serializable object (no Zod schemas, no functions).
   */
  getGraph(): EventTopologyGraph {
    const events: EventTopologyGraph["events"] = [];
    const componentMap = new Map<string, { publishes: Set<string>; subscribes: Set<string> }>();

    for (const decl of this.declarations.values()) {
      events.push({
        type: decl.type,
        description: decl.description,
        publishers: [...decl.publishers],
        subscribers: [...decl.subscribers],
      });

      for (const pub of decl.publishers) {
        const entry = componentMap.get(pub) ?? { publishes: new Set(), subscribes: new Set() };
        entry.publishes.add(decl.type);
        componentMap.set(pub, entry);
      }

      for (const sub of decl.subscribers) {
        const entry = componentMap.get(sub) ?? { publishes: new Set(), subscribes: new Set() };
        entry.subscribes.add(decl.type);
        componentMap.set(sub, entry);
      }
    }

    const components: EventTopologyGraph["components"] = [];
    for (const [id, entry] of componentMap) {
      components.push({
        id,
        publishes: [...entry.publishes],
        subscribes: [...entry.subscribes],
      });
    }

    return { events, components };
  }
}
