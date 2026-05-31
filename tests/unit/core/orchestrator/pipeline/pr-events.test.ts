import { describe, expect, it } from "vitest";

import {
  arbitrate,
  dedupePrEvents,
  entryFor,
  findAuthorizedApproval,
} from "../../../../../src/core/orchestrator/pipeline/pr-events.js";
import type { PRComment } from "../../../../../src/schemas/adapters.js";
import { type PrEvent, PrEventTypes } from "../../../../../src/schemas/git-hosting-events.js";
import { createTestPeopleDirectory } from "../../../../helpers/test-people-directory.js";

const comment = (id: string, author: string, body: string): PRComment => ({
  id,
  author,
  body,
  created_at: "2026-05-31T00:00:00Z",
});

const ev = {
  comments: (comments: PRComment[] = []): PrEvent => ({ type: PrEventTypes.pr_comments, comments }),
  ciFailure: (): PrEvent => ({ type: PrEventTypes.pr_ci_failure }),
  conflict: (): PrEvent => ({ type: PrEventTypes.pr_merge_conflict }),
  ready: (): PrEvent => ({ type: PrEventTypes.pr_ready_to_merge }),
  merged: (): PrEvent => ({ type: PrEventTypes.pr_merged }),
};

describe("PR-event policy", () => {
  describe("entryFor", () => {
    it("re-enters comments at requirements, where new scope is caught", () => {
      expect(entryFor(ev.comments())).toEqual({ phase: "requirements" });
    });

    it("re-enters CI failures and merge conflicts at execution to fix", () => {
      expect(entryFor(ev.ciFailure())).toEqual({ phase: "execution", sub: "implement" });
      expect(entryFor(ev.conflict())).toEqual({ phase: "execution", sub: "implement" });
    });

    it("re-enters ready-to-merge and already-merged at delivery's auto-merge", () => {
      expect(entryFor(ev.ready())).toEqual({ phase: "delivery", sub: "auto-merge" });
      expect(entryFor(ev.merged())).toEqual({ phase: "delivery", sub: "auto-merge" });
    });
  });

  describe("arbitrate", () => {
    it("returns null when no events arrived", () => {
      expect(arbitrate([])).toBeNull();
    });

    it("returns the only event when one arrived", () => {
      expect(arbitrate([ev.ciFailure()])).toEqual(ev.ciFailure());
    });

    it("lets reviewer feedback win over a simultaneous approval, so feedback is never skipped", () => {
      expect(arbitrate([ev.ready(), ev.comments()])).toEqual(ev.comments());
    });

    it("lets a merge win outright — it is terminal", () => {
      expect(arbitrate([ev.comments(), ev.merged()])).toEqual(ev.merged());
    });

    it("orders the blockers conflict over CI over ready-to-merge", () => {
      expect(arbitrate([ev.ready(), ev.ciFailure(), ev.conflict()])).toEqual(ev.conflict());
    });
  });

  describe("dedupePrEvents", () => {
    it("leaves non-comment events untouched", () => {
      const events = [ev.ciFailure(), ev.ready()];
      expect(dedupePrEvents(events, ["c1"])).toEqual(events);
    });

    it("drops a comments event whose comments are all already accommodated", () => {
      const events = [ev.comments([comment("c1", "alice", "fix this")])];
      expect(dedupePrEvents(events, ["c1"])).toEqual([]);
    });

    it("keeps a comments event that carries an unseen comment", () => {
      const fresh = ev.comments([comment("c1", "alice", "old"), comment("c2", "bob", "new")]);
      expect(dedupePrEvents([fresh], ["c1"])).toEqual([fresh]);
    });

    it("keeps a comments event with no comment payload — a state signal the consumer owns", () => {
      const signal = ev.comments([]);
      expect(dedupePrEvents([signal], ["c1"])).toEqual([signal]);
    });
  });

  describe("findAuthorizedApproval", () => {
    const people = createTestPeopleDirectory(); // owner github handle "test-owner", reviewer "test-reviewer"

    it("counts an /approve from a configured owner", () => {
      expect(findAuthorizedApproval([comment("c1", "test-owner", "/approve")], people)).toEqual({
        author: "test-owner",
      });
    });

    it("matches /approved too and is case-insensitive on the command", () => {
      expect(findAuthorizedApproval([comment("c1", "test-reviewer", "/APPROVED")], people)).toEqual({
        author: "test-reviewer",
      });
    });

    it("ignores an /approve from someone not in the directory — no drive-by merges", () => {
      expect(findAuthorizedApproval([comment("c1", "random-drive-by", "/approve")], people)).toBeNull();
    });

    it("ignores a comment that merely mentions the command", () => {
      expect(findAuthorizedApproval([comment("c1", "test-owner", "please /approve when ready")], people)).toBeNull();
    });

    it("is permissive when no one is configured — the sole-contributor case", () => {
      const empty = createTestPeopleDirectory([]);
      expect(findAuthorizedApproval([comment("c1", "anyone", "/approve")], empty)).toEqual({ author: "anyone" });
    });

    it("returns null when there is no approval command at all", () => {
      expect(findAuthorizedApproval([comment("c1", "test-owner", "what about the edge case?")], people)).toBeNull();
    });
  });
});
