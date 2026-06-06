import type { DataLifecycleConfig } from "../../schemas/config.js";

// ── Data Lifecycle Inspection ─────────────────────────────────────────────────
// Pure config health checks over the configured retention policy, surfaced at
// daemon startup. Daemon config is restart-only (see docs/configuration/daemon.md),
// so a startup warn is the whole story — there is no hot-reload path to re-validate.

/**
 * Longest cost-replay horizon, in days. The cost tracker is the only component that full-replays the
 * `events` table to rebuild its accumulators after a snapshot loss, and the longest window it folds is
 * the monthly one — every `cost.incurred` event back to the first of the current calendar month
 * (`getMonthlyWindowStart`). On the last day of a 31-day month that span is just under 31 days, so an
 * `events` retention below 31 days can prune events the replay still needs. 31 is the exact worst case;
 * we do not pad it (a real, named bound beats a vague margin).
 */
export const MONTHLY_REPLAY_FLOOR_DAYS = 31;

/** Distinguishes the data-lifecycle config health problems The Engineer warns about. */
export type RetentionWarningKind = "events_below_monthly_replay_floor";

/** A single retention-config health warning: a kind, a plain-language message, and structured data. */
export interface RetentionWarning {
  readonly kind: RetentionWarningKind;
  readonly message: string;
  readonly data: Record<string, unknown>;
}

/**
 * Inspect the configured retention policy against the cost tracker's replay horizon. Returns warnings
 * only — never throws, never fails, never blocks startup. An empty array means the policy is safe.
 *
 * The one invariant checked: `events.max_age_days` must be at least {@link MONTHLY_REPLAY_FLOOR_DAYS}.
 * Below it, a snapshot-loss replay walks an `events` table that has already pruned this month's earlier
 * cost events, so the rebuilt monthly total is short and cost limits can under-enforce.
 */
export function inspectRetentionConfig(config: DataLifecycleConfig): RetentionWarning[] {
  const eventsMaxAgeDays = config.retention.events.max_age_days;
  if (eventsMaxAgeDays >= MONTHLY_REPLAY_FLOOR_DAYS) {
    return [];
  }

  const consequence = "a snapshot-loss replay will undercount monthly spend; cost limits may under-enforce";
  const message = `Event retention is ${String(eventsMaxAgeDays)} days, below the ${String(MONTHLY_REPLAY_FLOOR_DAYS)}-day monthly cost-replay window — ${consequence}`;

  return [
    {
      kind: "events_below_monthly_replay_floor",
      message,
      data: { eventsMaxAgeDays, floorDays: MONTHLY_REPLAY_FLOOR_DAYS },
    },
  ];
}
