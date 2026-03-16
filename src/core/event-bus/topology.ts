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
   * Called during bootstrap. Records that `componentId` listens to `eventType`.
   *
   * For glob patterns (e.g., "task.*"), the subscriber is added to every
   * matching declaration. For exact types, only the specific declaration.
   */
  registerSubscriber(componentId: string, eventType: string): void {
    for (const [registeredType, declaration] of this.declarations) {
      if (matchesPattern(eventType, registeredType)) {
        if (!declaration.subscribers.includes(componentId)) {
          declaration.subscribers.push(componentId);
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
    const declaration = this.declarations.get(eventType);
    if (!declaration) {
      return { valid: true };
    }

    const result = declaration.payloadSchema.safeParse(payload);
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

    for (const declaration of this.declarations.values()) {
      events.push({
        type: declaration.type,
        description: declaration.description,
        publishers: [...declaration.publishers],
        subscribers: [...declaration.subscribers],
      });

      for (const publisherId of declaration.publishers) {
        const component = componentMap.get(publisherId) ?? {
          publishes: new Set(),
          subscribes: new Set(),
        };
        component.publishes.add(declaration.type);
        componentMap.set(publisherId, component);
      }

      for (const subscriberId of declaration.subscribers) {
        const component = componentMap.get(subscriberId) ?? {
          publishes: new Set(),
          subscribes: new Set(),
        };
        component.subscribes.add(declaration.type);
        componentMap.set(subscriberId, component);
      }
    }

    const components: EventTopologyGraph["components"] = [];
    for (const [id, component] of componentMap) {
      components.push({
        id,
        publishes: [...component.publishes],
        subscribes: [...component.subscribes],
      });
    }

    return { events, components };
  }
}
