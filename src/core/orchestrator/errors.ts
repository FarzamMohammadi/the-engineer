/** Base class for all orchestrator errors. Tagged for discriminated matching. */
export abstract class OrchestratorError extends Error {
  abstract readonly tag: string;
  abstract readonly retryable: boolean;
}

/** An agent sub-phase needs a workspace but none was created (no repo/clone URL on the task). */
export class WorkspaceNotReadyError extends OrchestratorError {
  readonly tag = "WorkspaceNotReady" as const;
  readonly retryable = true;
  readonly taskId: string;

  constructor(taskId: string) {
    super(`Cannot run an agent sub-phase without a workspace for task "${taskId}"`);
    this.name = "WorkspaceNotReadyError";
    this.taskId = taskId;
  }
}
