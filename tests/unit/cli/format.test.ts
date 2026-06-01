import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { timeAgo } from "../../../src/cli/format.js";

describe("timeAgo", () => {
  beforeEach(() => {
    // Pin "now" so relative ages are deterministic.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("formats ages under an hour in minutes", () => {
    expect(timeAgo("2026-01-15T11:57:00Z")).toBe("3m ago");
  });

  it("formats ages under a day in hours", () => {
    expect(timeAgo("2026-01-15T10:00:00Z")).toBe("2h ago");
  });

  it("formats ages of a day or more in days", () => {
    expect(timeAgo("2026-01-10T12:00:00Z")).toBe("5d ago");
  });

  it("returns 'unknown' for a malformed timestamp instead of 'NaNm ago'", () => {
    const result = timeAgo("not-a-date");
    expect(result).toBe("unknown");
    expect(result).not.toContain("NaN");
  });

  it("returns 'unknown' for an empty string", () => {
    expect(timeAgo("")).toBe("unknown");
  });
});
