/** Base class for all orchestrator errors. Tagged for discriminated matching. */
export abstract class OrchestratorError extends Error {
  abstract readonly tag: string;
}

/** No LLM plugin is registered in the Registry. */
export class NoLlmPluginError extends OrchestratorError {
  readonly tag = "NoLlmPlugin" as const;

  constructor() {
    super("Orchestrator: no LLM plugin registered");
    this.name = "NoLlmPluginError";
  }
}

/** LLM call was rejected by the ActionPipeline (safety gate or permission check). */
export class LlmCallRejectedError extends OrchestratorError {
  readonly tag = "LlmCallRejected" as const;
  readonly outcome: string;
  readonly reason: string;

  constructor(outcome: string, reason: string) {
    super(`LLM call rejected: ${outcome} - ${reason}`);
    this.name = "LlmCallRejectedError";
    this.outcome = outcome;
    this.reason = reason;
  }
}

/** File path escapes the worktree boundary (security violation). */
export class WorkspaceEscapeError extends OrchestratorError {
  readonly tag = "WorkspaceEscape" as const;
  readonly filePath: string;

  constructor(filePath: string) {
    super(`Path escapes worktree: ${filePath}`);
    this.name = "WorkspaceEscapeError";
    this.filePath = filePath;
  }
}

/** No handler registered for a pipeline phase. */
export class PhaseHandlerMissingError extends OrchestratorError {
  readonly tag = "PhaseHandlerMissing" as const;
  readonly phase: string;

  constructor(phase: string) {
    super(`No handler registered for phase: ${phase}`);
    this.name = "PhaseHandlerMissingError";
    this.phase = phase;
  }
}

/** Agent loop entered without a workspace (workspace setup incomplete or skipped). */
export class WorkspaceNotReadyError extends OrchestratorError {
  readonly tag = "WorkspaceNotReady" as const;
  readonly taskId: string;

  constructor(taskId: string) {
    super(
      `Cannot run agent loop without a workspace for task ${taskId}. Ensure workspace setup completed before entering the phase pipeline.`,
    );
    this.name = "WorkspaceNotReadyError";
    this.taskId = taskId;
  }
}

/** Workspace verification failed during checkpoint resume. */
export class WorkspaceVerificationError extends OrchestratorError {
  readonly tag = "WorkspaceVerification" as const;
  readonly detail: string;

  constructor(detail: string) {
    super(`Cannot resume: workspace verification failed: ${detail}`);
    this.name = "WorkspaceVerificationError";
    this.detail = detail;
  }
}
