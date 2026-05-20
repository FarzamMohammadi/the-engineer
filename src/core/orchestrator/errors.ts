/** Base class for all orchestrator errors. Tagged for discriminated matching. */
export abstract class OrchestratorError extends Error {
  abstract readonly tag: string;
  abstract readonly retryable: boolean;
}

/** No LLM plugin is registered in the Registry. */
export class NoLlmPluginError extends OrchestratorError {
  readonly tag = "NoLlmPlugin" as const;
  readonly retryable = false;

  constructor() {
    super("Orchestrator: no LLM plugin registered");
    this.name = "NoLlmPluginError";
  }
}

/** LLM call was rejected by the ActionPipeline (safety gate or permission check). */
export class LlmCallRejectedError extends OrchestratorError {
  readonly tag = "LlmCallRejected" as const;
  readonly retryable = false;
  readonly outcome: string;
  readonly reason: string;

  constructor(outcome: string, reason: string) {
    super(`LLM call rejected: ${outcome} - ${reason}`);
    this.name = "LlmCallRejectedError";
    this.outcome = outcome;
    this.reason = reason;
  }
}

/** No handler registered for a pipeline phase. */
export class PhaseHandlerMissingError extends OrchestratorError {
  readonly tag = "PhaseHandlerMissing" as const;
  readonly retryable = false;
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
  readonly retryable = true;
  readonly taskId: string;

  constructor(taskId: string) {
    super(
      `Cannot run agent loop without a workspace for task ${taskId}. Ensure workspace setup completed before entering the phase pipeline.`,
    );
    this.name = "WorkspaceNotReadyError";
    this.taskId = taskId;
  }
}

/** All LLM retry attempts exhausted due to transient errors (API down, rate limits). */
export class LlmUnavailableError extends OrchestratorError {
  readonly tag = "LlmUnavailable" as const;
  readonly retryable = true;
  readonly attempts: number;
  readonly lastError: string;

  constructor(attempts: number, lastError: string, options?: { cause?: unknown }) {
    super(`LLM adapter unavailable after ${attempts} attempts: ${lastError}`, options);
    this.name = "LlmUnavailableError";
    this.attempts = attempts;
    this.lastError = lastError;
  }
}

/** Workspace verification failed during checkpoint resume. */
export class WorkspaceVerificationError extends OrchestratorError {
  readonly tag = "WorkspaceVerification" as const;
  readonly retryable = false;
  readonly detail: string;

  constructor(detail: string, options?: { cause?: unknown }) {
    super(`Cannot resume: workspace verification failed: ${detail}`, options);
    this.name = "WorkspaceVerificationError";
    this.detail = detail;
  }
}
