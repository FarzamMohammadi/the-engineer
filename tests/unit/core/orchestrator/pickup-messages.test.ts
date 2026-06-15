import { describe, expect, it } from "vitest";

import { pickupMessages } from "../../../../src/core/orchestrator/index.js";

// The owner sees a pickup notice on their chat channel and the source ticket every time the engine takes a
// task. On a fresh task it reads "Starting"; on a resume — an answered block, a PR rework, a crash-resume,
// each of which re-dispatches with a `resume_from` checkpoint — it reads "Continuing", so a re-run never
// looks like a brand-new start.

describe("pickupMessages", () => {
  it("says 'Starting' for a task's first run", () => {
    expect(pickupMessages("Fix the login bug", false)).toEqual({
      milestone: "Starting work on: Fix the login bug",
      ticket: "Starting work on this ticket.",
    });
  });

  it("says 'Continuing' when resuming a prior run", () => {
    expect(pickupMessages("Fix the login bug", true)).toEqual({
      milestone: "Continuing work on: Fix the login bug",
      ticket: "Continuing work on this ticket.",
    });
  });
});
