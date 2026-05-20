import type { AdapterError, AdapterErrorSeverity } from "../schemas/adapters.js";

/**
 * Factory for creating `AdapterError` data objects.
 *
 * Returns a plain object (not a thrown Error). Use in return values like
 * `SendResult.error`, `MergeResult.error`.
 *
 * Sensible defaults: not retryable, no retry delay, severity "error".
 */
export function createAdapterError(
  code: string,
  message: string,
  options?: {
    retryable?: boolean;
    retry_after_ms?: number | null;
    severity?: AdapterErrorSeverity;
  },
): AdapterError {
  return {
    code,
    message,
    retryable: options?.retryable ?? false,
    retry_after_ms: options?.retry_after_ms ?? null,
    severity: options?.severity ?? "error",
  };
}

/**
 * Throwable error class wrapping a structured `AdapterError` payload.
 *
 * Use inside `do*` methods when a plugin wants to signal failure via exception
 * rather than a return value. Template method wrappers check `instanceof
 * AdapterMethodError` to extract the structured error data.
 */
export class AdapterMethodError extends Error {
  readonly adapterError: AdapterError;

  constructor(adapterError: AdapterError, options?: { cause?: unknown }) {
    super(adapterError.message, options);
    this.name = "AdapterMethodError";
    this.adapterError = adapterError;
  }
}
