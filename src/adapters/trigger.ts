import { AdapterErrorSeverities, type TriggerEvent } from "../schemas/adapters.js";
import { BaseAdapter } from "./base.js";
import { AdapterMethodError, createAdapterError } from "./errors.js";

/**
 * Abstract base for trigger adapters.
 *
 * Trigger adapters discover new work from external sources (GitHub Issues,
 * Jira, manual CLI). The Daemon polls trigger adapters on their declared interval.
 */
export abstract class TriggerAdapter extends BaseAdapter {
  /**
   * Poll for new trigger events from the external source.
   *
   * Wraps `doPoll()` with error handling. If the plugin throws an
   * `AdapterMethodError`, it is rethrown as-is. Other errors are wrapped
   * with code `"internal_error"` and severity `"fatal"`.
   */
  async poll(): Promise<TriggerEvent[]> {
    try {
      return await this.doPoll();
    } catch (error) {
      if (error instanceof AdapterMethodError) {
        throw error;
      }
      throw new AdapterMethodError(
        createAdapterError("internal_error", error instanceof Error ? error.message : String(error), {
          severity: AdapterErrorSeverities.fatal,
        }),
        { cause: error },
      );
    }
  }

  /** Plugin authors implement this to poll their external source. */
  protected abstract doPoll(): Promise<TriggerEvent[]>;
}
