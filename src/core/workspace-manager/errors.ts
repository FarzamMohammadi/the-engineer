/** Base class for all workspace-manager errors. Tagged for discriminated matching. */
export abstract class WorkspaceError extends Error {
  abstract readonly tag: string;
}

/** Workspace was not found for the given task. */
export class WorkspaceNotFoundError extends WorkspaceError {
  readonly tag = "WorkspaceNotFound" as const;
  readonly taskId: string;

  constructor(taskId: string) {
    super(`WorkspaceManager: no workspace for task ${taskId}`);
    this.name = "WorkspaceNotFoundError";
    this.taskId = taskId;
  }
}

/** Workspace creation failed (missing clone URL, path validation, etc.). */
export class WorkspaceCreationError extends WorkspaceError {
  readonly tag = "WorkspaceCreation" as const;

  constructor(message: string) {
    super(message);
    this.name = "WorkspaceCreationError";
  }
}
