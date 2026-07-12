import { describe, expect, it, vi } from "vitest";

import type { NotificationRouter } from "../../../src/core/daemon/notification-router.js";
import { createPrEventPoller } from "../../../src/core/daemon/pr-event-poller.js";
import type { PrEventPollerContext } from "../../../src/core/daemon/types.js";
import { toBlockReason } from "../../../src/core/orchestrator/index.js";
import { autoMerge, autoMergeNext } from "../../../src/core/orchestrator/pipeline/delivery/auto-merge.js";
import {
  HOST_BLOCKED_MERGE_CATEGORY,
  hostBlockedMergeNeeded,
} from "../../../src/core/orchestrator/pipeline/host-blocked-merge.js";
import { type Ctx, Phases, type RoutableResult } from "../../../src/core/orchestrator/pipeline/types.js";
import type { MergeResult, PRStatus } from "../../../src/schemas/adapters.js";
import { PrEventTypes } from "../../../src/schemas/git-hosting-events.js";
import { BlockCategories, BlockReasons, type ReviewState, TaskStates } from "../../../src/schemas/task.js";
import { createMockTask } from "../../helpers/mock-factories.js";
import { createRecordingObserver } from "../../helpers/test-mock-pipeline.js";
import { createTestObserverFacade } from "../../helpers/test-observer-facade.js";
import { createTestPeopleDirectory } from "../../helpers/test-people-directory.js";

vi.mock("../../../src/core/orchestrator/pr-manager.js", () => ({ removeThoughtsAndPush: vi.fn(() => false) }));

// ── The Host-Blocked Merge Contract ──────────────────────────────────────────
//
// A host can report a PR as protection-`blocked`: mergeable in shape, green, but gated by a rule such as a
// required review. That verdict is about the host's rules — NOT about whether the merge can happen. A token
// with admin rights on a repo that permits a bypass merges such a PR normally, and for a lone owner that
// bypass is the only automated route there is: the PR is authored under the owner's own account, and a host
// will not let an author approve their own pull request, so the required review can never be satisfied by
// anyone. The `/approve` comment is the owner's approval precisely because the formal one is unreachable.
//
// So `blocked` is not refused up front. Both the poller (on an authorized `/approve`) and delivery's
// auto-merge carry a blocked PR forward to an actual merge attempt, and let the host decide.
//
// This file guards the other half: what happens when the host DOES refuse. A refused merge means the code is
// sound and only the merge is gated, so it must never route to execution rework, and must never be dressed
// up as a completed task on an unmerged PR. It hands off to the owner on one contract — one lifecycle state,
// one honest message. That hand-off is also what bounds the merge path: it leaves the review-poll set, so a
// promote → refuse cycle cannot repeat.
//
// It fails if anyone pre-refuses a blocked merge instead of attempting it, terminalizes the hand-off into a
// false "completed", lets the message over-promise, or routes a refused merge back into execution.

const PR_NUMBER = 7;

const reviewState: ReviewState = {
  pr_number: PR_NUMBER,
  merged_at: null,
  feedback_rounds: [],
  accommodated_comment_ids: [],
  accommodated_review_state: null,
  consecutive_blocker_reentries: 0,
};

/** The host condition under test: mergeable in shape, green, but the host's protection gates the merge. */
const hostBlockedStatus: PRStatus = {
  number: PR_NUMBER,
  state: "open",
  draft: false,
  merge_state: "blocked",
  checks_state: "passing",
  url: "https://x/7",
};

/** The host refusing the merge outright — no bypass available to this token. */
const REFUSED: MergeResult = { success: false, reason: "not_mergeable", message: "Pull Request is not mergeable" };

/** Drive delivery's auto-merge on the blocked PR with a given merge outcome, and return the route it produces. */
async function autoMergePath(mergeResult: MergeResult = REFUSED) {
  const notify = vi.fn();
  const mergePR = vi.fn().mockResolvedValue(mergeResult);
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

/** Drive the PR-event poller on the same blocked PR carrying an authorized /approve. */
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

  return {
    blockWrite: updateTaskField.mock.calls.find((call) => call[1] === "blocked")?.[2],
    promoted: updateTaskField.mock.calls.some(
      (call) => call[1] === "pending_pr_event" && call[2] === PrEventTypes.pr_ready_to_merge,
    ),
    requestTransition,
  };
}

describe("the host-blocked merge contract — attempt first, then hand off", () => {
  it("carries a blocked PR to an actual merge attempt rather than refusing it up front", async () => {
    // The host's "blocked" is about its rules, not about our ability to merge — a bypass may well be
    // available. Both entry paths must therefore reach the merge, not pre-empt it: the poller by promoting
    // the /approve, and auto-merge by calling the host. Refusing here is what would strand a lone owner's
    // PRs forever, since no one is permitted to give them the formal approval the host is asking for.
    const [merge, poll] = await Promise.all([autoMergePath(), pollerPath()]);

    expect(merge.mergePR).toHaveBeenCalled();
    expect(poll.promoted).toBe(true);
    expect(poll.blockWrite).toBeUndefined();
  });

  it("merges a blocked PR when the host allows the bypass", async () => {
    // The whole point of attempting: with an admin token on a repo that permits bypass, the host takes it.
    const { route, result } = await autoMergePath({ success: true, merge_sha: "sha-merged" });

    expect(result).toMatchObject({ outcome: "ok", data: { disposition: "merged" } });
    expect(route).toEqual({ go: "done" });
  });

  it("hands a refused merge off to the owner on the one contract — same state, same words", async () => {
    const { route } = await autoMergePath();

    // The category decides the poll set, the escalation ladder, and resumability.
    expect(route).toMatchObject({ go: "block", category: HOST_BLOCKED_MERGE_CATEGORY });
    // The message is the shared one, verbatim — no drift into a second, contradictory hand-off.
    expect((route as { needed: string }).needed).toBe(hostBlockedMergeNeeded(PR_NUMBER, false));
  });

  it("never falsely completes the task — the PR is unmerged and undelivered", async () => {
    const { route, notify } = await autoMergePath();

    // `done` would transition the task to `completed`, post a success notice on an UNMERGED PR, destroy the
    // worktree, and make the task non-retryable — so the retry the hand-off message asks for would be
    // impossible to perform.
    expect(route.go).not.toBe("done");
    expect(route.go).toBe("block");
    // One event, one message: the block's own delivery tells the owner — `run` must not notify as well.
    expect(notify).not.toHaveBeenCalled();
  });

  it("never drives execution rework — the code is sound, only the merge is gated", async () => {
    const { route } = await autoMergePath();

    // Routing a refused merge into execution is what would re-push the branch and let the poller re-promote
    // the same /approve, over and over. The hand-off is what breaks that cycle.
    expect(route).not.toMatchObject({ go: "jump", to: Phases.execution });
  });

  it("promises only what the Engineer can actually do — never an unconditional 'I'll merge it'", () => {
    // A `blocked` verdict is a catch-all: it cannot distinguish a required review the owner CAN add (so the
    // merge succeeds on retry) from a restriction this token can never satisfy. The message must hold in both.
    for (const needed of [hostBlockedMergeNeeded(PR_NUMBER, false), hostBlockedMergeNeeded(PR_NUMBER, true)]) {
      expect(needed).toMatch(/if the host lets me/i);
      expect(needed).toMatch(/merge it yourself/i);
      expect(needed).not.toMatch(/resume and I'll merge it\b/i);
    }
  });

  it("the contract category is the one that leaves the review-poll set and stays resumable", () => {
    // This is the bound on the merge path. The hand-off returns only a CATEGORY; the block *reason* — which
    // decides the daemon poll set the task lands on — is derived from it by `toBlockReason`. If
    // `awaiting_human` ever mapped back to `pr_review_pending`, the task would rejoin the PR-event poll set,
    // the /approve would be re-promoted, and the refused merge would be retried forever.
    expect(toBlockReason(HOST_BLOCKED_MERGE_CATEGORY)).toBe(BlockReasons.need_more_info);
    expect(toBlockReason(HOST_BLOCKED_MERGE_CATEGORY)).not.toBe(BlockReasons.pr_review_pending);
    // And `blocked` on that reason is retryable, so the owner can unblock the merge on the host and resume.
    expect(HOST_BLOCKED_MERGE_CATEGORY).not.toBe(BlockCategories.awaiting_pr_review);
  });
});
