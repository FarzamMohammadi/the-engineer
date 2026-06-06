import type { CostLimitReachedPayload } from "../../schemas/events.js";

/** The cost-breach facts the prose is composed from — the message-relevant slice of a breach payload. */
export type CostBreach = Pick<CostLimitReachedPayload, "limit_type" | "limit_scope" | "current_spend" | "limit_value">;

/**
 * Compose the human prose for a `cost.limit_reached` breach — the single source for the "$X of $Y"
 * money-prose so the daemon's owner alert and the dashboard error list never drift. A provider breach
 * carries a `limit_scope` (the provider id) and its numbers are daily request counts, not dollars; a
 * per-task/daily/monthly breach has no scope and its numbers are USD. Surfaces add only their own wrapper
 * text (e.g. the daemon's "Global ..." prefix and "Terminating N" suffix). Takes just the message-relevant
 * fields so a caller reading a stored payload need not reconstruct the whole event to format it.
 */
export function formatCostBreach(breach: CostBreach): string {
  if (breach.limit_scope) {
    return `${breach.limit_scope} daily request cap reached: ${breach.current_spend} of ${breach.limit_value}`;
  }
  return `${breach.limit_type} cost limit reached: $${breach.current_spend} of $${breach.limit_value}`;
}
