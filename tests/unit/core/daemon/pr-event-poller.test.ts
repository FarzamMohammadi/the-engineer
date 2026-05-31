import { describe, expect, it, vi } from "vitest";

import type { NotificationRouter } from "../../../../src/core/daemon/notification-router.js";
import { createPrEventPoller } from "../../../../src/core/daemon/pr-event-poller.js";
import type { PrEventPollerContext } from "../../../../src/core/daemon/types.js";
import type { PRComment } from "../../../../src/schemas/adapters.js";
import { type PrEvent, PrEventTypes } from "../../../../src/schemas/git-hosting-events.js";
import { type ReviewState, TaskStates } from "../../../../src/schemas/task.js";
import { createMockTask } from "../../../helpers/mock-factories.js";
import { createTestPeopleDirectory } from "../../../helpers/test-people-directory.js";

const comment = (id: string, author: string, body: string): PRComment => ({
  id,
  author,
  body,
  created_at: "2026-05-31T00:00:00Z",
});

const review = (over: Partial<ReviewState> = {}): ReviewState => ({
  pr_number: 7,
  pr_state: "ready",
  demo_artifacts: [],
  feedback_rounds: [],
  accommodated_comment_ids: [],
  accommodated_review_state: null,
  ...over,
});

interface SetupOptions {
  readonly events?: PrEvent[];
  readonly detectThrows?: boolean;
  readonly review?: ReviewState;
  readonly people?: ReturnType<typeof createTestPeopleDirectory>;
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
  const requestTransition = vi.fn().mockReturnValue({ success: true });
  const updateTaskField = vi.fn();
  const notify = vi.fn();
  const getBlockedTasksByReason = vi.fn().mockReturnValue([task]);

  const ctx = {
    registry: { getPrimaryPlugin: (type: string) => (type === "git_hosting" ? { detectPrEvents } : null) },
    taskEngine: { getBlockedTasksByReason, updateTaskField, requestTransition },
    peopleDirectory: options.people ?? createTestPeopleDirectory([]),
    observer: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
    clock: { now: () => 1000 },
    config: { review_polling: { failure_window_ms: 60_000, max_failures_before_pause: 3 } },
  } as unknown as PrEventPollerContext;
  const notifications = { notify } as unknown as NotificationRouter;

  return {
    poller: createPrEventPoller(ctx, notifications),
    detectPrEvents,
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

    it("re-queues a CI failure to execution with no feedback round", async () => {
      const { poller, requestTransition, updateTaskField } = setup({ events: [{ type: PrEventTypes.pr_ci_failure }] });

      await poller.poll();

      expect(updateTaskField).toHaveBeenCalledWith("t1", "pending_pr_event", "pr_ci_failure");
      expect(requestTransition).toHaveBeenCalledWith(...queuedFor("pr_ci_failure"));
      expect(updateTaskField).not.toHaveBeenCalledWith("t1", "review", expect.anything());
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

  describe("merge-class events are left for the auto-merge path", () => {
    it("does not re-queue on ready-to-merge", async () => {
      const { poller, requestTransition } = setup({ events: [{ type: PrEventTypes.pr_ready_to_merge }] });
      await poller.poll();
      expect(requestTransition).not.toHaveBeenCalled();
    });

    it("does not re-queue on an externally merged PR", async () => {
      const { poller, requestTransition } = setup({ events: [{ type: PrEventTypes.pr_merged }] });
      await poller.poll();
      expect(requestTransition).not.toHaveBeenCalled();
    });
  });

  describe("nothing actionable", () => {
    it("does not rework on a bare changes-requested with no comment text", async () => {
      const { poller, requestTransition } = setup({ events: [{ type: PrEventTypes.pr_comments, comments: [] }] });
      await poller.poll();
      expect(requestTransition).not.toHaveBeenCalled();
    });

    it("does not rework on an authorized /approve — that is an approval, not feedback", async () => {
      const { poller, requestTransition } = setup({
        events: [{ type: PrEventTypes.pr_comments, comments: [comment("c1", "solo-dev", "/approve")] }],
      });
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
