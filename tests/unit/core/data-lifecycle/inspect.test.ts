import { describe, expect, it } from "vitest";

import { MONTHLY_REPLAY_FLOOR_DAYS, inspectRetentionConfig } from "../../../../src/core/data-lifecycle/inspect.js";
import { DataLifecycleConfigSchema } from "../../../../src/schemas/config.js";
import type { DataLifecycleConfig } from "../../../../src/schemas/config.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

function configWithEventsRetention(maxAgeDays: number): DataLifecycleConfig {
  return DataLifecycleConfigSchema.parse({ retention: { events: { max_age_days: maxAgeDays } } });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("inspectRetentionConfig", () => {
  it("returns no warning at the default 90-day retention", () => {
    expect(inspectRetentionConfig(DataLifecycleConfigSchema.parse({}))).toEqual([]);
  });

  it("returns no warning exactly at the monthly replay floor", () => {
    expect(inspectRetentionConfig(configWithEventsRetention(MONTHLY_REPLAY_FLOOR_DAYS))).toEqual([]);
  });

  it("warns when events retention is one day below the floor", () => {
    const warnings = inspectRetentionConfig(configWithEventsRetention(MONTHLY_REPLAY_FLOOR_DAYS - 1));

    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.kind).toBe("events_below_monthly_replay_floor");
    // The message must name the consequence the owner needs to weigh, not just "too low".
    expect(warnings[0]?.message).toContain("undercount monthly spend");
    expect(warnings[0]?.message).toContain("cost limits may under-enforce");
    expect(warnings[0]?.data).toMatchObject({
      eventsMaxAgeDays: MONTHLY_REPLAY_FLOOR_DAYS - 1,
      floorDays: MONTHLY_REPLAY_FLOOR_DAYS,
    });
  });

  it("warns at the minimum positive retention of 1 day", () => {
    const warnings = inspectRetentionConfig(configWithEventsRetention(1));

    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.kind).toBe("events_below_monthly_replay_floor");
  });
});
