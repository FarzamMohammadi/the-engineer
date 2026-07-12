import { describe, expect, it, vi } from "vitest";

import type { NotificationRouter } from "../../../../src/core/daemon/notification-router.js";
import { createPrEventPoller } from "../../../../src/core/daemon/pr-event-poller.js";
import type { PrEventPollerContext } from "../../../../src/core/daemon/types.js";
import {
  HOST_BLOCKED_MERGE_CATEGORY,
  hostBlockedMergeNeeded,
} from "../../../../src/core/orchestrator/pipeline/host-blocked-merge.js";
import type { PRComment, PRStatus } from "../../../../src/schemas/adapters.js";
import { type PrEvent, PrEventTypes } from "../../../../src/schemas/git-hosting-events.js";
import { NotificationKinds } from "../../../../src/schemas/notifications.js";
import { BlockCategories, BlockReasons, type ReviewState, TaskStates } from "../../../../src/schemas/task.js";
import { createMockTask } from "../../../helpers/mock-factories.js";
import { createTestObserverFacade } from "../../../helpers/test-observer-facade.js";
import { createTestPeopleDirectory } from "../../../helpers/test-people-directory.js";

const comment = (id: string, author: string, body: string): PRComment => ({
  id,
  author,
  body,
  created_at: "2026-05-31T00:00:00Z",
});

const review = (over: Partial<ReviewState> = {}): ReviewState => ({
  pr_number: 7,
  merged_at: null,
  feedback_rounds: [],
  accommodated_comment_ids: [],
  accommodated_review_state: null,
  consecutive_blocker_reentries: 0,
  ...over,
});

interface SetupOptions {
  readonly events?: PrEvent[];
  readonly detectThrows?: boolean;
  readonly review?: ReviewState;
  readonly people?: ReturnType<typeof createTestPeopleDirectory>;
  readonly prStatus?: Partial<PRStatus>;
  readonly commentApproval?: boolean;
}

function setup(options: SetupOptions = {}) {
  const task = createMockTask({
    id: "t1",
    repo: "acme/app",
    state: TaskStates.blocked,
    review: options.review ?? review(),
  });
  const detectPrEvents = options.detectThrows
    ? vi.fn().mockRejectedValue(new Error("host down"))
    : vi.fn().mockResolvedValue(options.events ?? []);
  const prStatus: PRStatus = {
    number: 7,
    state: "open",
    draft: false,
    merge_state: "mergeable",
    checks_state: "passing",
    url: "https://x/7",
    ...options.prStatus,
  };
  const getPRStatus = vi.fn().mockResolvedValue(prStatus);
  const requestTransition = vi.fn().mockReturnValue({ success: true });
  const updateTaskField = vi.fn();
  const notify = vi.fn();
  const getBlockedTasksByReason = vi.fn().mockReturnValue([task]);

  const ctx = {
    registry: {
      getPrimaryPlugin: (type: string) => (type === "git_hosting" ? { detectPrEvents, getPRStatus } : null),
      // The hosting plugin declares its channel; the poller derives the /approve authorization namespace from it.
      getPluginsByType: (type: string) =>
        type === "git_hosting" ? [{ manifest: { adapter_meta: { channel: "github" } } }] : [],
    },
    taskEngine: { getBlockedTasksByReason, updateTaskField, requestTransition },
    peopleDirectory: options.people ?? createTestPeopleDirectory([]),
    safetyLayer: { isCommentApprovalEnabled: () => options.commentApproval ?? true },
    observer: createTestObserverFacade("daemon"),
    clock: { now: () => 1000 },
    config: { review_polling: { failure_window_ms: 60_000, max_failures_before_pause: 3, max_blocker_reentries: 3 } },
  } as unknown as PrEventPollerContext;
  const notifications = { notify } as unknown as NotificationRouter;

  return {
    poller: createPrEventPoller(ctx, notifications),
    detectPrEvents,
    getPRStatus,
    requestTransition,
    updateTaskField,
    notify,
    getBlockedTasksByReason,
  };
}

const queuedFor = (type: string) => ["t1", TaskStates.queued, null, `pr_event:${type}`, "daemon"];

describe("PrEventPoller", () => {
  describe("rework events re-enter the pipeline", () => {
    it("re-queues a comments event and records the feedback for the re-entered phase", async () => {
      const { poller, requestTransition, updateTaskField, notify } = setup({
        events: [{ type: PrEventTypes.pr_comments, comments: [comment("c1", "alice", "tighten the naming")] }],
      });

      await poller.poll();

      expect(updateTaskField).toHaveBeenCalledWith("t1", "pending_pr_event", "pr_comments");
      expect(updateTaskField).toHaveBeenCalledWith(
        "t1",
        "review",
        expect.objectContaining({
          accommodated_comment_ids: ["c1"],
          feedback_rounds: [expect.objectContaining({ applied: false, comments: ["@alice: tighten the naming"] })],
        }),
      );
      expect(requestTransition).toHaveBeenCalledWith(...queuedFor("pr_comments"));
      expect(notify).toHaveBeenCalled();
    });

    it("re-queues a CI failure to execution, advancing the streak and adding no feedback round", async () => {
      const { poller, requestTransition, updateTaskField } = setup({ events: [{ type: PrEventTypes.pr_ci_failure }] });

      await poller.poll();

      expect(updateTaskField).toHaveBeenCalledWith("t1", "pending_pr_event", "pr_ci_failure");
      expect(requestTransition).toHaveBeenCalledWith(...queuedFor("pr_ci_failure"));
      // The blocker streak advances, but no reviewer feedback is recorded — that is the comments path.
      expect(updateTaskField).toHaveBeenCalledWith(
        "t1",
        "review",
        expect.objectContaining({ consecutive_blocker_reentries: 1, feedback_rounds: [] }),
      );
    });

    it("re-queues a merge conflict to execution", async () => {
      const { poller, requestTransition } = setup({ events: [{ type: PrEventTypes.pr_merge_conflict }] });
      await poller.poll();
      expect(requestTransition).toHaveBeenCalledWith(...queuedFor("pr_merge_conflict"));
    });

    it("addresses reviewer feedback before a simultaneous approval", async () => {
      const { poller, requestTransition } = setup({
        events: [
          { type: PrEventTypes.pr_ready_to_merge },
          { type: PrEventTypes.pr_comments, comments: [comment("c1", "alice", "one more thing")] },
        ],
      });
      await poller.poll();
      expect(requestTransition).toHaveBeenCalledWith(...queuedFor("pr_comments"));
    });
  });

  describe("the automated-blocker re-entry bound", () => {
    it("increments the blocker streak and re-enters while under the cap", async () => {
      const { poller, requestTransition, updateTaskField } = setup({
        review: review({ consecutive_blocker_reentries: 1 }),
        events: [{ type: PrEventTypes.pr_merge_conflict }],
      });

      await poller.poll();

      expect(updateTaskField).toHaveBeenCalledWith(
        "t1",
        "review",
        expect.objectContaining({ consecutive_blocker_reentries: 2 }),
      );
      expect(requestTransition).toHaveBeenCalledWith(...queuedFor("pr_merge_conflict"));
    });

    it("escalates to the owner instead of re-entering once the cap is exceeded", async () => {
      // The cap is 3 (config). A streak already at 3 means the next blocker is the 4th — over the cap.
      const { poller, requestTransition, updateTaskField, notify } = setup({
        review: review({ consecutive_blocker_reentries: 3 }),
        events: [{ type: PrEventTypes.pr_merge_conflict }],
      });

      await poller.poll();

      // Re-blocked under pr_rework_cap_hit (a pipeline_failed reason) so it leaves the PR-review poll set.
      expect(updateTaskField).toHaveBeenCalledWith(
        "t1",
        "blocked",
        expect.objectContaining({
          reason: "pipeline_failed",
          category: "pr_rework_cap_hit",
          sub_phase: "await-review",
        }),
      );
      // The pending event is cleared so the next dispatch cannot walk straight back into the loop.
      expect(updateTaskField).toHaveBeenCalledWith("t1", "pending_pr_event", null);
      // The owner is alerted, and the task is NOT re-queued.
      expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: NotificationKinds.alert }));
      expect(requestTransition).not.toHaveBeenCalled();
    });

    it("resets the blocker streak when reviewer feedback arrives — human engagement is progress", async () => {
      const { poller, updateTaskField } = setup({
        review: review({ consecutive_blocker_reentries: 2 }),
        events: [{ type: PrEventTypes.pr_comments, comments: [comment("c1", "alice", "one more change")] }],
      });

      await poller.poll();

      expect(updateTaskField).toHaveBeenCalledWith(
        "t1",
        "review",
        expect.objectContaining({ consecutive_blocker_reentries: 0 }),
      );
    });

    it("resets the blocker streak when a poll finds no actionable blocker — the loop has cleared", async () => {
      const { poller, updateTaskField, requestTransition } = setup({
        review: review({ consecutive_blocker_reentries: 2 }),
        events: [],
      });

      await poller.poll();

      expect(updateTaskField).toHaveBeenCalledWith(
        "t1",
        "review",
        expect.objectContaining({ consecutive_blocker_reentries: 0 }),
      );
      expect(requestTransition).not.toHaveBeenCalled();
    });
  });

  describe("merge events re-enter at auto-merge", () => {
    it("re-queues to auto-merge on ready-to-merge", async () => {
      const { poller, requestTransition, updateTaskField } = setup({
        events: [{ type: PrEventTypes.pr_ready_to_merge }],
      });

      await poller.poll();

      expect(updateTaskField).toHaveBeenCalledWith("t1", "pending_pr_event", "pr_ready_to_merge");
      expect(requestTransition).toHaveBeenCalledWith(...queuedFor("pr_ready_to_merge"));
    });

    it("re-queues to auto-merge on an externally merged PR", async () => {
      const { poller, requestTransition } = setup({ events: [{ type: PrEventTypes.pr_merged }] });
      await poller.poll();
      expect(requestTransition).toHaveBeenCalledWith(...queuedFor("pr_merged"));
    });
  });

  describe("the /approve merge promotion", () => {
    const approve = (): PrEvent => ({
      type: PrEventTypes.pr_comments,
      comments: [comment("c1", "solo-dev", "/approve")],
    });

    it("promotes an authorized /approve on a green, mergeable PR to a merge", async () => {
      const { poller, requestTransition, updateTaskField, getPRStatus } = setup({ events: [approve()] });

      await poller.poll();

      expect(getPRStatus).toHaveBeenCalledWith("acme/app", 7);
      expect(updateTaskField).toHaveBeenCalledWith("t1", "pending_pr_event", "pr_ready_to_merge");
      expect(requestTransition).toHaveBeenCalledWith(...queuedFor("pr_ready_to_merge"));
      // an approval is not feedback — no rework round recorded
      expect(updateTaskField).not.toHaveBeenCalledWith("t1", "review", expect.anything());
    });

    it("does not promote — the task waits — when the PR is not yet green", async () => {
      const { poller, requestTransition } = setup({ events: [approve()], prStatus: { checks_state: "pending" } });
      await poller.poll();
      expect(requestTransition).not.toHaveBeenCalled();
    });

    it("does not promote on an /approve when the CI status could not be determined (unknown)", async () => {
      // Regression (issue #29): the /approve re-check can hit a transient lookup error, yielding
      // checks_state `unknown`. `unknown` is not `passing`, so the promotion is withheld — the task keeps
      // waiting and re-checks next poll, never merging on an unverified CI status.
      const { poller, requestTransition } = setup({ events: [approve()], prStatus: { checks_state: "unknown" } });
      await poller.poll();
      expect(requestTransition).not.toHaveBeenCalled();
    });

    it("does not promote when comment approval is disabled", async () => {
      const { poller, requestTransition, getPRStatus } = setup({ events: [approve()], commentApproval: false });
      await poller.poll();
      expect(getPRStatus).not.toHaveBeenCalled();
      expect(requestTransition).not.toHaveBeenCalled();
    });

    it("reworks the real problem when an /approve lands alongside a CI failure", async () => {
      const { poller, requestTransition } = setup({
        events: [approve(), { type: PrEventTypes.pr_ci_failure }],
        prStatus: { checks_state: "failing" },
      });

      await poller.poll();

      // not green → no promotion; the CI failure routes the rework instead
      expect(requestTransition).toHaveBeenCalledWith(...queuedFor("pr_ci_failure"));
    });

    it("escalates to the owner instead of promoting when the host's branch protection blocks the merge", async () => {
      // Issue #47: a green PR whose merge_state is `blocked` (branch protection needs a formal review a
      // /approve comment cannot satisfy). Promoting would attempt a doomed merge that re-pushes the branch
      // and loops. Instead the poller escalates: no promotion, and the task is re-blocked under
      // `need_more_info` (which takes it off the pr_review_pending poll set — the structural loop bound).
      const { poller, requestTransition, updateTaskField, notify } = setup({
        events: [approve()],
        prStatus: { merge_state: "blocked" },
      });

      await poller.poll();

      // No promotion: no pr_ready_to_merge event, no re-queue transition.
      expect(updateTaskField).not.toHaveBeenCalledWith("t1", "pending_pr_event", "pr_ready_to_merge");
      expect(requestTransition).not.toHaveBeenCalled();
      // Re-blocked under need_more_info / awaiting_human — off the pr_review_pending poll set. This is the
      // SAME contract delivery's auto-merge resolves the same condition to (see host-blocked-merge-contract).
      expect(updateTaskField).toHaveBeenCalledWith(
        "t1",
        "blocked",
        expect.objectContaining({
          reason: BlockReasons.need_more_info,
          category: HOST_BLOCKED_MERGE_CATEGORY,
          needed: hostBlockedMergeNeeded(7, false),
        }),
      );
      expect(BlockCategories.awaiting_human).toBe(HOST_BLOCKED_MERGE_CATEGORY);
      // Pending event cleared defensively so no stale event re-dispatches the task into the loop.
      expect(updateTaskField).toHaveBeenCalledWith("t1", "pending_pr_event", null);
      // The owner is told, actionably — and with the one honest message, not a promise the Engineer may not
      // be able to keep (it never says an unconditional "I'll merge it").
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({ kind: NotificationKinds.alert, message: hostBlockedMergeNeeded(7, false) }),
      );
    });

    it("does not escalate a blocked PR that carries no authorized /approve — it is just awaiting its review", async () => {
      // The dangerous false positive: a PR with required reviews and no approval yet ALSO reports
      // merge_state `blocked` — that is the normal waiting state, the highest-traffic path in the system.
      // The escalation is gated on an authorized /approve, so this poll must do nothing at all.
      const { poller, requestTransition, updateTaskField, notify } = setup({
        events: [{ type: PrEventTypes.pr_comments, comments: [comment("c1", "alice", "looks good so far")] }],
        prStatus: { merge_state: "blocked" },
      });

      await poller.poll();

      expect(updateTaskField).not.toHaveBeenCalledWith("t1", "blocked", expect.anything());
      expect(notify).not.toHaveBeenCalledWith(expect.objectContaining({ kind: NotificationKinds.alert }));
      // The comment is ordinary reviewer feedback — it still reworks as it always did.
      expect(requestTransition).toHaveBeenCalledWith(...queuedFor("pr_comments"));
    });

    it("cannot re-form the loop — once escalated, the task leaves the poll set and a later poll does nothing", async () => {
      // The escalation moves the task off the pr_review_pending set (reason need_more_info). Model that the
      // daemon's re-query no longer returns it: the second poll has nothing to act on, so it never re-escalates
      // or re-promotes. This is what bounds the previously-unbounded pr_ready_to_merge re-entry path.
      const { poller, requestTransition, notify, getBlockedTasksByReason } = setup({
        events: [approve()],
        prStatus: { merge_state: "blocked" },
      });
      getBlockedTasksByReason.mockReturnValueOnce([]);

      await poller.poll();

      expect(requestTransition).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
    });
  });

  describe("nothing actionable", () => {
    it("does not rework on a bare changes-requested with no comment text", async () => {
      const { poller, requestTransition } = setup({ events: [{ type: PrEventTypes.pr_comments, comments: [] }] });
      await poller.poll();
      expect(requestTransition).not.toHaveBeenCalled();
    });

    it("skips feedback whose comments are all already accommodated", async () => {
      const { poller, requestTransition } = setup({
        review: review({ accommodated_comment_ids: ["c1"] }),
        events: [{ type: PrEventTypes.pr_comments, comments: [comment("c1", "alice", "already handled")] }],
      });
      await poller.poll();
      expect(requestTransition).not.toHaveBeenCalled();
    });
  });

  describe("resilience", () => {
    it("survives a detect failure without re-queuing or throwing", async () => {
      const { poller, requestTransition } = setup({ detectThrows: true });
      await expect(poller.poll()).resolves.toBeUndefined();
      expect(requestTransition).not.toHaveBeenCalled();
    });
  });
});
