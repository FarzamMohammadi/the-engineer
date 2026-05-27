/** Base class for all orchestrator errors. Tagged for discriminated matching. */
export abstract class OrchestratorError extends Error {
  abstract readonly tag: string;
  abstract readonly retryable: boolean;
}

/** No agent plugin is registered in the Registry. */
export class NoAgentPluginError extends OrchestratorError {
  readonly tag = "NoAgentPlugin" as const;
  readonly retryable = false;

  constructor() {
    super("Orchestrator: no agent plugin registered");
    this.name = "NoAgentPluginError";
  }
}

/** Agent run was rejected by the ActionPipeline (safety gate or permission check). */
export class AgentRunRejectedError extends OrchestratorError {
  readonly tag = "AgentRunRejected" as const;
  readonly retryable = false;
  readonly outcome: string;
  readonly reason: string;

  constructor(outcome: string, reason: string) {
    super(`Agent run rejected: ${outcome} - ${reason}`);
    this.name = "AgentRunRejectedError";
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

/** All agent retry attempts exhausted due to transient errors (API down, rate limits). */
export class AgentUnavailableError extends OrchestratorError {
  readonly tag = "AgentUnavailable" as const;
  readonly retryable = true;
  readonly attempts: number;
  readonly lastError: string;

  constructor(attempts: number, lastError: string, options?: { cause?: unknown }) {
    super(`Agent adapter unavailable after ${attempts} attempts: ${lastError}`, options);
    this.name = "AgentUnavailableError";
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
