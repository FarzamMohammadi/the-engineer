/** Base class for all event-bus errors. Tagged for discriminated matching. */
export abstract class EventBusError extends Error {
  abstract readonly tag: string;
  abstract readonly retryable: boolean;
}

/** Event replay failed (payload validation in test mode). */
export class EventReplayError extends EventBusError {
  readonly tag = "EventReplay" as const;
  readonly retryable = false;

  constructor(message: string) {
    super(message);
    this.name = "EventReplayError";
  }
}
