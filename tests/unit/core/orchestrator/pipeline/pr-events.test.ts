import { describe, expect, it } from "vitest";

import {
  arbitrate,
  dedupePrEvents,
  entryFor,
  findAuthorizedApproval,
  reentryCarry,
} from "../../../../../src/core/orchestrator/pipeline/pr-events.js";
import type { PRComment } from "../../../../../src/schemas/adapters.js";
import { type PrEvent, PrEventTypes } from "../../../../../src/schemas/git-hosting-events.js";
import { createMockTask } from "../../../../helpers/mock-factories.js";
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
      expect(entryFor(PrEventTypes.pr_comments)).toEqual({ phase: "requirements" });
    });

    it("re-enters CI failures and merge conflicts at execution to fix", () => {
      expect(entryFor(PrEventTypes.pr_ci_failure)).toEqual({ phase: "execution", sub: "implement" });
      expect(entryFor(PrEventTypes.pr_merge_conflict)).toEqual({ phase: "execution", sub: "implement" });
    });

    it("re-enters ready-to-merge and already-merged at delivery's auto-merge", () => {
      expect(entryFor(PrEventTypes.pr_ready_to_merge)).toEqual({ phase: "delivery", sub: "auto-merge" });
      expect(entryFor(PrEventTypes.pr_merged)).toEqual({ phase: "delivery", sub: "auto-merge" });
    });
  });

  describe("reentryCarry", () => {
    it("lists the task's outstanding feedback for a comments re-entry", () => {
      const task = createMockTask({
        review: {
          pr_number: 7,
          merged_at: null,
          accommodated_comment_ids: [],
          accommodated_review_state: null,
          consecutive_blocker_reentries: 0,
          feedback_rounds: [{ applied: false, comments: ["Tighten the error message", "Add a test"] }],
        },
      });
      const carry = reentryCarry(PrEventTypes.pr_comments, task);
      expect(carry.summary).toContain("Tighten the error message");
      expect(carry.summary).toContain("Add a test");
    });

    it("falls back to a generic feedback prompt when no unapplied feedback is stored", () => {
      const task = createMockTask({ review: null });
      expect(reentryCarry(PrEventTypes.pr_comments, task).summary).toContain("New reviewer feedback");
    });

    it("tells the agent to reproduce the failing gates for a CI-failure re-entry", () => {
      expect(reentryCarry(PrEventTypes.pr_ci_failure, createMockTask()).summary).toContain("CI checks are failing");
    });

    it("tells the agent to resolve conflicts for a merge-conflict re-entry", () => {
      expect(reentryCarry(PrEventTypes.pr_merge_conflict, createMockTask()).summary).toContain(
        "no longer merges cleanly",
      );
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
    // The git-host channels the active hosting plugins declare — the poller derives this from the registry.
    const githubChannels = new Set(["github"]);

    it("counts an /approve from a configured owner", () => {
      expect(findAuthorizedApproval([comment("c1", "test-owner", "/approve")], people, githubChannels)).toEqual({
        author: "test-owner",
      });
    });

    it("matches /approved too and is case-insensitive on the command", () => {
      expect(findAuthorizedApproval([comment("c1", "test-reviewer", "/APPROVED")], people, githubChannels)).toEqual({
        author: "test-reviewer",
      });
    });

    it("ignores an /approve from someone not in the directory — no drive-by merges", () => {
      expect(findAuthorizedApproval([comment("c1", "random-drive-by", "/approve")], people, githubChannels)).toBeNull();
    });

    it("ignores a comment that merely mentions the command", () => {
      expect(
        findAuthorizedApproval([comment("c1", "test-owner", "please /approve when ready")], people, githubChannels),
      ).toBeNull();
    });

    it("is permissive when no one is configured — the sole-contributor case", () => {
      const empty = createTestPeopleDirectory([]);
      expect(findAuthorizedApproval([comment("c1", "anyone", "/approve")], empty, githubChannels)).toEqual({
        author: "anyone",
      });
    });

    it("returns null when there is no approval command at all", () => {
      expect(
        findAuthorizedApproval([comment("c1", "test-owner", "what about the edge case?")], people, githubChannels),
      ).toBeNull();
    });

    it("authorizes an /approve from a contact on a non-github git-host channel — no hardcoded platform", () => {
      const gitlabPeople = createTestPeopleDirectory([
        { id: "owner", name: "GL Owner", roles: ["owner"], contacts: [{ channel: "gitlab", handle: "gl-owner" }] },
      ]);
      expect(
        findAuthorizedApproval([comment("c1", "gl-owner", "/approve")], gitlabPeople, new Set(["gitlab"])),
      ).toEqual({ author: "gl-owner" });
    });

    it("never authorizes via a non-git-host (comms) contact, even when the handle matches", () => {
      const commsOnly = createTestPeopleDirectory([
        { id: "owner", name: "Owner", roles: ["owner"], contacts: [{ channel: "telegram", handle: "ghost" }] },
      ]);
      // "ghost" equals the telegram handle, but telegram is not a git-host channel — it carries no merge authority.
      expect(findAuthorizedApproval([comment("c1", "ghost", "/approve")], commsOnly, new Set(["gitlab"]))).toBeNull();
    });
  });
});
