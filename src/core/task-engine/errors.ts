/** Base class for all task-engine errors. Tagged for discriminated matching. */
export abstract class TaskEngineError extends Error {
  abstract readonly tag: string;
  abstract readonly retryable: boolean;
}

/** Task was not found by ID. */
export class TaskNotFoundError extends TaskEngineError {
  readonly tag = "TaskNotFound" as const;
  readonly retryable = false;
  readonly taskId: string;

  constructor(taskId: string) {
    super(`Task "${taskId}" not found`);
    this.name = "TaskNotFoundError";
    this.taskId = taskId;
  }
}

/** State transition is not valid per the state machine. */
export class InvalidTransitionError extends TaskEngineError {
  readonly tag = "InvalidTransition" as const;
  readonly retryable = false;
  readonly taskId: string;
  readonly fromLabel: string;
  readonly toLabel: string;

  constructor(taskId: string, fromLabel: string, toLabel: string) {
    super(`Invalid transition from ${fromLabel} to ${toLabel} for task "${taskId}"`);
    this.name = "InvalidTransitionError";
    this.taskId = taskId;
    this.fromLabel = fromLabel;
    this.toLabel = toLabel;
  }
}

/** Optimistic locking conflict — task was modified by another writer. */
export class VersionConflictError extends TaskEngineError {
  readonly tag = "VersionConflict" as const;
  readonly retryable = true;
  readonly taskId: string;
  readonly expectedVersion: number;
  readonly actualVersion: number;

  constructor(taskId: string, expectedVersion: number, actualVersion: number) {
    super(`Version conflict on task "${taskId}": expected ${expectedVersion}, got ${actualVersion}`);
    this.name = "VersionConflictError";
    this.taskId = taskId;
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
  }
}

/** Unknown field passed to updateTaskField. */
export class UnknownFieldError extends TaskEngineError {
  readonly tag = "UnknownField" as const;
  readonly retryable = false;
  readonly field: string;

  constructor(field: string) {
    super(`Unknown updatable field "${field}"`);
    this.name = "UnknownFieldError";
    this.field = field;
  }
}
