// ── Tagged Error Classes ─────────────────────────────────────────────────────

/** Base class for all safety-layer errors. */
export abstract class SafetyError extends Error {
  abstract readonly tag: string;
}

/** Cost limit has been exceeded. */
export class CostLimitExceededError extends SafetyError {
  readonly tag = "CostLimitExceeded" as const;
  readonly limitType: "per_task" | "daily" | "monthly";
  readonly spent: number;
  readonly limit: number;

  constructor(limitType: "per_task" | "daily" | "monthly", spent: number, limit: number) {
    super(`${limitType} cost limit reached (${spent.toFixed(2)} / ${limit.toFixed(2)})`);
    this.name = "CostLimitExceededError";
    this.limitType = limitType;
    this.spent = spent;
    this.limit = limit;
  }
}

/** An action was denied by scope policy. */
export class ScopeDeniedError extends SafetyError {
  readonly tag = "ScopeDenied" as const;
  readonly scopeType: "repo" | "branch" | "file" | "merge";
  readonly detail: string;

  constructor(scopeType: "repo" | "branch" | "file" | "merge", detail: string) {
    super(`${scopeType} scope denied: ${detail}`);
    this.name = "ScopeDeniedError";
    this.scopeType = scopeType;
    this.detail = detail;
  }
}

/** Snapshot data was corrupt and could not be restored. */
export class CorruptSnapshotError extends SafetyError {
  readonly tag = "CorruptSnapshot" as const;
  constructor(message: string) {
    super(message);
    this.name = "CorruptSnapshotError";
  }
}
