import { describe, expect, it, vi } from "vitest";

import type { NotificationRouter } from "../../../src/core/daemon/notification-router.js";
import { createPrEventPoller } from "../../../src/core/daemon/pr-event-poller.js";
import type { PrEventPollerContext } from "../../../src/core/daemon/types.js";
import { autoMerge, autoMergeNext } from "../../../src/core/orchestrator/pipeline/delivery/auto-merge.js";
import {
  HOST_BLOCKED_MERGE_CATEGORY,
  hostBlockedMergeNeeded,
} from "../../../src/core/orchestrator/pipeline/host-blocked-merge.js";
import { type Ctx, Phases, type RoutableResult } from "../../../src/core/orchestrator/pipeline/types.js";
import type { PRStatus } from "../../../src/schemas/adapters.js";
import { PrEventTypes } from "../../../src/schemas/git-hosting-events.js";
import { BlockCategories, BlockReasons, type ReviewState, TaskStates } from "../../../src/schemas/task.js";
import { createMockTask } from "../../helpers/mock-factories.js";
import { createRecordingObserver } from "../../helpers/test-mock-pipeline.js";
import { createTestObserverFacade } from "../../helpers/test-observer-facade.js";
import { createTestPeopleDirectory } from "../../helpers/test-people-directory.js";

vi.mock("../../../src/core/orchestrator/pr-manager.js", () => ({ removeThoughtsAndPush: vi.fn(() => false) }));

// ── The Host-Blocked Merge Contract ──────────────────────────────────────────
//
// Issue #47 (criteria 9–12). ONE host condition — the host reports `merge_state: "blocked"`: the PR is
// mergeable in shape, but branch protection will not let the Engineer complete the merge — is detected by
// TWO independent paths: the PR-event poller (an authorized `/approve` on a blocked PR) and delivery's
// auto-merge (readiness, before any merge call).
//
// The bug this file guards against is not a crash — it is INCOHERENCE. The two paths originally resolved
// the same condition to opposite task lifecycle states (blocked-and-resumable vs. completed-and-terminal)
// and made opposite promises to the owner ("I'll merge it" vs. "you merge it"). This test drives both paths
// on the SAME status and asserts they land on the SAME contract, in the same words.
//
// It fails if anyone re-splits the contract, re-terminalizes the hand-off into a false "completed", lets
// the two messages drift apart, or routes a blocked merge back into execution rework.

const PR_NUMBER = 7;

const reviewState: ReviewState = {
  pr_number: PR_NUMBER,
  merged_at: null,
  feedback_rounds: [],
  accommodated_comment_ids: [],
  accommodated_review_state: null,
  consecutive_blocker_reentries: 0,
};

/** The one host condition both paths resolve: mergeable in shape, green, but the host will not merge it. */
const hostBlockedStatus: PRStatus = {
  number: PR_NUMBER,
  state: "open",
  draft: false,
  merge_state: "blocked",
  checks_state: "passing",
  url: "https://x/7",
};

/** Drive delivery's auto-merge on the host-blocked PR and return the route its pure `next` produces. */
async function autoMergePath() {
  const notify = vi.fn();
  const mergePR = vi.fn();
  const ctx = {
    registry: {
      getPrimaryPlugin: (type: string) =>
        type === "git_hosting"
          ? {
              getPRStatus: vi.fn().mockResolvedValue(hostBlockedStatus),
              mergePR,
              getReviewStatus: vi.fn().mockResolvedValue({ approved: false }),
            }
          : null,
    },
    workspaceManager: { getWorkspaceRecord: () => ({ repo: "acme/app", baseBranch: "main" }) },
    safetyLayer: { checkAutoMergeAllowed: () => true, shouldExcludeThoughtsOnMerge: () => false },
    workspaceConfig: { pr: { default_merge_strategy: "squash" } },
    eventBus: { publish: vi.fn() },
    taskEngine: { updateTaskField: vi.fn() },
    notifications: { notify },
    observer: createRecordingObserver(),
    task: { id: "t1", repo: "acme/app", review: reviewState },
  } as unknown as Ctx;

  const result = await autoMerge.run(ctx);
  return { route: autoMergeNext(result as RoutableResult), result, mergePR, notify };
}

/** Drive the PR-event poller on the same host-blocked PR (with an authorized /approve) and capture what it writes. */
async function pollerPath() {
  const task = createMockTask({ id: "t1", repo: "acme/app", state: TaskStates.blocked, review: reviewState });
  const updateTaskField = vi.fn();
  const requestTransition = vi.fn().mockReturnValue({ success: true });
  const notify = vi.fn();

  const ctx = {
    registry: {
      getPrimaryPlugin: (type: string) =>
        type === "git_hosting"
          ? {
              detectPrEvents: vi.fn().mockResolvedValue([
                {
                  type: PrEventTypes.pr_comments,
                  comments: [{ id: "c1", author: "solo-dev", body: "/approve", created_at: "2026-05-31T00:00:00Z" }],
                },
              ]),
              getPRStatus: vi.fn().mockResolvedValue(hostBlockedStatus),
            }
          : null,
      getPluginsByType: (type: string) =>
        type === "git_hosting" ? [{ manifest: { adapter_meta: { channel: "github" } } }] : [],
    },
    taskEngine: {
      getBlockedTasksByReason: vi.fn().mockReturnValue([task]),
      updateTaskField,
      requestTransition,
    },
    peopleDirectory: createTestPeopleDirectory([]),
    safetyLayer: { isCommentApprovalEnabled: () => true },
    observer: createTestObserverFacade("daemon"),
    clock: { now: () => 1000 },
    config: { review_polling: { failure_window_ms: 60_000, max_failures_before_pause: 3, max_blocker_reentries: 3 } },
  } as unknown as PrEventPollerContext;

  await createPrEventPoller(ctx, { notify } as unknown as NotificationRouter).poll();

  const blockWrite = updateTaskField.mock.calls.find((call) => call[1] === "blocked");
  return {
    blocked: blockWrite?.[2] as { reason: string; category: string; needed: string } | undefined,
    requestTransition,
  };
}

describe("the host-blocked merge contract — both paths, one resolution", () => {
  it("resolves the same host-blocked condition to the same lifecycle state and the same message", async () => {
    const [merge, poll] = await Promise.all([autoMergePath(), pollerPath()]);

    // Same category ⇒ same block reason ⇒ same poll set, same escalation ladder, same resumability.
    expect(merge.route).toMatchObject({ go: "block", category: HOST_BLOCKED_MERGE_CATEGORY });
    expect(poll.blocked).toMatchObject({ category: HOST_BLOCKED_MERGE_CATEGORY, reason: BlockReasons.need_more_info });

    // The IDENTICAL message — not merely similar. This is what stops the two hand-offs from drifting into
    // contradictory promises ("I'll merge it" vs "you merge it") on the same condition.
    const message = hostBlockedMergeNeeded(PR_NUMBER, false);
    expect((merge.route as { needed: string }).needed).toBe(message);
    expect(poll.blocked?.needed).toBe(message);
  });

  it("neither path falsely completes the task — the PR is unmerged and undelivered", async () => {
    const { route, mergePR, notify } = await autoMergePath();

    // `done` would transition the task to `completed`, post "Task completed successfully." on an UNMERGED
    // PR, destroy the worktree, and make the task non-retryable — so the retry the hand-off message asks
    // for would be impossible. The poller never completes a task at all, so only this path can regress.
    expect(route.go).not.toBe("done");
    expect(route.go).toBe("block");
    // And no merge was attempted: the doomed call is what pushed a cleanup commit and re-pushed the branch.
    expect(mergePR).not.toHaveBeenCalled();
    // One event, one message: the block's own delivery tells the owner — `run` must not notify as well.
    expect(notify).not.toHaveBeenCalled();
  });

  it("neither path drives execution rework — the code is fine, only the merge is gated", async () => {
    const [merge, poll] = await Promise.all([autoMergePath(), pollerPath()]);

    // The original infinite loop (criterion 1): a blocked merge fell into execution/implement, re-pushed the
    // branch, and the poller re-promoted the same /approve — forever.
    expect(merge.route).not.toMatchObject({ go: "jump", to: Phases.execution });
    expect(poll.requestTransition).not.toHaveBeenCalled();
  });

  it("promises only what the Engineer can actually do — never an unconditional 'I'll merge it'", () => {
    // `mergeable_state: "blocked"` is a catch-all: it cannot distinguish a required review the owner CAN add
    // (the Engineer merges on retry) from a merge restriction the Engineer can NEVER satisfy. So the message
    // must hold in both worlds.
    for (const needed of [hostBlockedMergeNeeded(PR_NUMBER, false), hostBlockedMergeNeeded(PR_NUMBER, true)]) {
      expect(needed).toMatch(/if the host lets me/i);
      expect(needed).toMatch(/merge it yourself/i);
      expect(needed).not.toMatch(/resume and I'll merge it\b/i);
    }
  });

  it("the contract category is the one that leaves the review-poll set and stays resumable", () => {
    // awaiting_human ⇒ need_more_info (not pr_review_pending) ⇒ the task is off the PR-event poll set, so the
    // promote → doomed-merge → rework loop is structurally impossible; and `blocked` is retryable, so the
    // owner can unblock the merge on the host and resume.
    expect(HOST_BLOCKED_MERGE_CATEGORY).toBe(BlockCategories.awaiting_human);
    expect(HOST_BLOCKED_MERGE_CATEGORY).not.toBe(BlockCategories.awaiting_pr_review);
  });
});
