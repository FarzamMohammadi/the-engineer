/** Base class for all session-memory errors. Tagged for discriminated matching. */
export abstract class SessionMemoryError extends Error {
  abstract readonly tag: string;
  abstract readonly retryable: boolean;
}

/** Session was not found by ID. */
export class SessionNotFoundError extends SessionMemoryError {
  readonly tag = "SessionNotFound" as const;
  readonly retryable = false;
  readonly sessionId: string;

  constructor(sessionId: string) {
    super(`Session "${sessionId}" not found`);
    this.name = "SessionNotFoundError";
    this.sessionId = sessionId;
  }
}

/** Knowledge entry was not found by ID. */
export class KnowledgeNotFoundError extends SessionMemoryError {
  readonly tag = "KnowledgeNotFound" as const;
  readonly retryable = false;
  readonly entryId: string;

  constructor(entryId: string) {
    super(`Knowledge entry "${entryId}" not found`);
    this.name = "KnowledgeNotFoundError";
    this.entryId = entryId;
  }
}
