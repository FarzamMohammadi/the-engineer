import type { Event, EventPayloads, EventType } from "../../schemas/events.js";

/** Subscriber callback invoked when a matching event is published or replayed. */
export type EventCallback = (event: Event) => void;

/** Input for publishing a known event type (type-safe payload). */
export interface PublishInput<T extends EventType> {
  type: T;
  source: string;
  task_id: string | null;
  payload: EventPayloads[T];
}

/** Input for publishing any event type (future/plugin event types). */
export interface PublishInputGeneral {
  type: string;
  source: string;
  task_id: string | null;
  payload: Record<string, unknown>;
}

export interface IEventBus {
  publish<T extends EventType>(input: PublishInput<T>): Event;
  publish(input: PublishInputGeneral): Event;
  subscribe(subscriberId: string, eventType: string, callback: EventCallback): void;
  unsubscribe(subscriberId: string): void;
  replay(fromSequence: number): void;
  getEventsForTask(taskId: string): Event[];
  getEventsSince(sequence: number, limit?: number): Event[];
}
