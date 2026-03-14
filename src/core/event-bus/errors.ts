/** Base class for all event-bus errors. Tagged for discriminated matching. */
export abstract class EventBusError extends Error {
  abstract readonly tag: string;
}

/** Event replay failed (payload validation in test mode). */
export class EventReplayError extends EventBusError {
  readonly tag = "EventReplay" as const;

  constructor(message: string) {
    super(message);
    this.name = "EventReplayError";
  }
}
