import { describe, expect, it, vi } from "vitest";

import type { NotificationRouter } from "../../../../src/core/daemon/notification-router.js";
import { createPrEventPoller } from "../../../../src/core/daemon/pr-event-poller.js";
import type { PrEventPollerContext } from "../../../../src/core/daemon/types.js";
import type { PRComment, PRStatus } from "../../../../src/schemas/adapters.js";
import { type PrEvent, PrEventTypes } from "../../../../src/schemas/git-hosting-events.js";
import { NotificationKinds } from "../../../../src/schemas/notifications.js";
import { type ReviewState, TaskStates } from "../../../../src/schemas/task.js";
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
