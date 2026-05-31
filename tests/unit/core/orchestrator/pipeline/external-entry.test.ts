import { describe, expect, it } from "vitest";

import { arbitrate, entryFor } from "../../../../../src/core/orchestrator/pipeline/pipeline.js";
import { type PrEvent, PrEventTypes } from "../../../../../src/schemas/git-hosting-events.js";

const event = (type: PrEvent["type"]): PrEvent => ({ type });

describe("external re-entry", () => {
  describe("entryFor", () => {
    it("re-enters comments at requirements, where new scope is caught", () => {
      expect(entryFor(event(PrEventTypes.pr_comments))).toEqual({ phase: "requirements" });
    });

    it("re-enters CI failures and merge conflicts at execution to fix", () => {
      expect(entryFor(event(PrEventTypes.pr_ci_failure))).toEqual({ phase: "execution", sub: "implement" });
      expect(entryFor(event(PrEventTypes.pr_merge_conflict))).toEqual({ phase: "execution", sub: "implement" });
    });

    it("re-enters ready-to-merge and already-merged at delivery's auto-merge", () => {
      expect(entryFor(event(PrEventTypes.pr_ready_to_merge))).toEqual({ phase: "delivery", sub: "auto-merge" });
      expect(entryFor(event(PrEventTypes.pr_merged))).toEqual({ phase: "delivery", sub: "auto-merge" });
    });
  });

  describe("arbitrate", () => {
    it("returns null when no events arrived", () => {
      expect(arbitrate([])).toBeNull();
    });

    it("returns the only event when one arrived", () => {
      expect(arbitrate([event(PrEventTypes.pr_ci_failure)])).toEqual(event(PrEventTypes.pr_ci_failure));
    });

    it("lets reviewer feedback win over a simultaneous approval, so feedback is never skipped", () => {
      const events = [event(PrEventTypes.pr_ready_to_merge), event(PrEventTypes.pr_comments)];
      expect(arbitrate(events)).toEqual(event(PrEventTypes.pr_comments));
    });

    it("lets a merge win outright — it is terminal", () => {
      const events = [event(PrEventTypes.pr_comments), event(PrEventTypes.pr_merged)];
      expect(arbitrate(events)).toEqual(event(PrEventTypes.pr_merged));
    });

    it("orders the blockers conflict over CI over ready-to-merge", () => {
      const events = [
        event(PrEventTypes.pr_ready_to_merge),
        event(PrEventTypes.pr_ci_failure),
        event(PrEventTypes.pr_merge_conflict),
      ];
      expect(arbitrate(events)).toEqual(event(PrEventTypes.pr_merge_conflict));
    });
  });
});
