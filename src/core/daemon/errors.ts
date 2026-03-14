/** Base class for all daemon errors. Tagged for discriminated matching. */
export abstract class DaemonError extends Error {
  abstract readonly tag: string;
}

/** Daemon is already running (PID file exists with live process, or start() called twice). */
export class DaemonAlreadyRunningError extends DaemonError {
  readonly tag = "DaemonAlreadyRunning" as const;
  readonly existingPid: number | undefined;

  constructor(existingPid?: number) {
    const detail = existingPid != null ? ` (PID: ${String(existingPid)})` : "";
    super(`Another Daemon instance is already running${detail}`);
    this.name = "DaemonAlreadyRunningError";
    this.existingPid = existingPid;
  }
}
