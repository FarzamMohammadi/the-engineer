/** Base class for all task-engine errors. Tagged for discriminated matching. */
export abstract class TaskEngineError extends Error {
  abstract readonly tag: string;
}

/** Task was not found by ID. */
export class TaskNotFoundError extends TaskEngineError {
  readonly tag = "TaskNotFound" as const;

  constructor(readonly taskId: string) {
    super(`Task "${taskId}" not found`);
    this.name = "TaskNotFoundError";
  }
}

/** State transition is not valid per the state machine. */
export class InvalidTransitionError extends TaskEngineError {
  readonly tag = "InvalidTransition" as const;

  constructor(
    readonly taskId: string,
    readonly fromLabel: string,
    readonly toLabel: string,
  ) {
    super(`Invalid transition from ${fromLabel} to ${toLabel} for task "${taskId}"`);
    this.name = "InvalidTransitionError";
  }
}

/** Optimistic locking conflict — task was modified by another writer. */
export class VersionConflictError extends TaskEngineError {
  readonly tag = "VersionConflict" as const;

  constructor(
    readonly taskId: string,
    readonly expectedVersion: number,
    readonly actualVersion: number,
  ) {
    super(
      `Version conflict on task "${taskId}": expected ${expectedVersion}, got ${actualVersion}`,
    );
    this.name = "VersionConflictError";
  }
}

/** Unknown field passed to updateTaskField. */
export class UnknownFieldError extends TaskEngineError {
  readonly tag = "UnknownField" as const;

  constructor(readonly field: string) {
    super(`Unknown updatable field "${field}"`);
    this.name = "UnknownFieldError";
  }
}
