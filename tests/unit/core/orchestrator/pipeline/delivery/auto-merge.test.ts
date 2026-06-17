import { describe, expect, it, vi } from "vitest";

import { autoMerge, autoMergeNext } from "../../../../../../src/core/orchestrator/pipeline/delivery/auto-merge.js";
import {
  BlockCategories,
  type Ctx,
  Phases,
  type RoutableResult,
} from "../../../../../../src/core/orchestrator/pipeline/types.js";
import { removeThoughtsAndPush } from "../../../../../../src/core/orchestrator/pr-manager.js";
import type { MergeResult, PRStatus } from "../../../../../../src/schemas/adapters.js";
import type { ReviewState } from "../../../../../../src/schemas/task.js";
import { createRecordingObserver } from "../../../../../helpers/test-mock-pipeline.js";

// The real thoughts cleanup shells out to git; mock it so tests control whether a strip commit was pushed.
vi.mock("../../../../../../src/core/orchestrator/pr-manager.js", () => ({
  removeThoughtsAndPush: vi.fn(() => false),
}));

const okResult = (disposition: string): RoutableResult => ({ outcome: "ok", summary: "", data: { disposition } });

const readyReview: ReviewState = {
  pr_number: 7,
  merged_at: null,
  feedback_rounds: [],
  accommodated_comment_ids: [],
  accommodated_review_state: null,
  consecutive_blocker_reentries: 0,
};

interface MockOptions {
  readonly status?: Partial<PRStatus>;
  readonly mergeResult?: MergeResult;
  readonly hosting?: boolean;
  readonly autoMergeAllowed?: boolean;
  readonly excludeThoughts?: boolean;
  readonly review?: ReviewState | null;
  readonly reviewApproved?: boolean;
}

function mockCtx(options: MockOptions = {}) {
  const status: PRStatus = {
    number: 7,
    state: "open",
    draft: false,
    merge_state: "mergeable",
    checks_state: "passing",
    url: "https://x/7",
    ...options.status,
  };
  const getPRStatus = vi.fn().mockResolvedValue(status);
  const mergePR = vi
    .fn()
    .mockResolvedValue(options.mergeResult ?? { merge_sha: "sha-merged", success: true, error: null });
  const getReviewStatus = vi.fn().mockResolvedValue({
    approved: options.reviewApproved ?? false,
    approvals: options.reviewApproved ? 1 : 0,
    changes_requested: false,
    reviewers: [],
    comments: [],
  });
  const deleteRemoteBranch = vi.fn();
  const updateTaskField = vi.fn();
  const notify = vi.fn();
  const published: string[] = [];
  const observer = createRecordingObserver();

  const hosting = options.hosting === false ? null : { getPRStatus, mergePR, getReviewStatus };
  const ctx = {
    registry: { getPrimaryPlugin: (type: string) => (type === "git_hosting" ? hosting : null) },
    workspaceManager: {
      getWorkspaceRecord: () => ({ repo: "acme/app", branch: "feat/x", baseBranch: "main", thoughtsDir: "thoughts/x" }),
      deleteRemoteBranch,
    },
    safetyLayer: {
      checkAutoMergeAllowed: () => options.autoMergeAllowed ?? true,
      shouldExcludeThoughtsOnMerge: () => options.excludeThoughts ?? false,
    },
    workspaceConfig: {
      pr: { default_merge_strategy: "squash" },
    },
    eventBus: { publish: vi.fn((event: { type: string }) => published.push(event.type)) },
    taskEngine: { updateTaskField },
    notifications: { notify },
    observer,
    task: { id: "t1", repo: "acme/app", review: options.review === undefined ? readyReview : options.review },
  } as unknown as Ctx;

  return { ctx, getPRStatus, mergePR, deleteRemoteBranch, updateTaskField, notify, published, observer };
}

describe("auto-merge next", () => {
  it("completes the task on a merged disposition", () => {
    expect(autoMergeNext(okResult("merged"))).toEqual({ go: "done" });
  });

  it("completes the task when auto-merge is disabled — the human merges the ready PR", () => {
    expect(autoMergeNext(okResult("auto_merge_disabled"))).toEqual({ go: "done" });
  });

  it("completes the task on a host-blocked merge — the host needs a human to merge", () => {
    expect(autoMergeNext(okResult("needs_human_merge"))).toEqual({ go: "done" });
  });

  it("jumps to execution to fix a failing CI", () => {
    const route = autoMergeNext(okResult("ci_failure"));
    expect(route.go).toBe("jump");
    expect(route).toMatchObject({ to: Phases.execution });
  });

  it("jumps to execution to resolve a merge conflict", () => {
    const route = autoMergeNext(okResult("merge_conflict"));
    expect(route.go).toBe("jump");
    expect(route).toMatchObject({ to: Phases.execution });
  });

  it("returns to the review wait on a transient miss", () => {
    expect(autoMergeNext(okResult("retry_wait"))).toMatchObject({
      go: "block",
      category: BlockCategories.awaiting_pr_review,
    });
  });

  it("blocks for a human on the unreachable needs_human outcome", () => {
    expect(autoMergeNext({ outcome: "needs_human", summary: "" })).toMatchObject({
      go: "block",
      category: BlockCategories.awaiting_human,
    });
  });
});

describe("auto-merge run", () => {
  it("merges a green PR, records the merge, notifies the milestone, and never deletes the branch", async () => {
    const { ctx, mergePR, deleteRemoteBranch, updateTaskField, notify, published } = mockCtx();

    const result = await autoMerge.run(ctx);

    expect(result).toMatchObject({ outcome: "ok", data: { disposition: "merged" } });
    expect(mergePR).toHaveBeenCalledWith("acme/app", 7, "squash");
    // Records the merge time so the reaper can reap the branch — but the reaper, not auto-merge, deletes it.
    expect(updateTaskField).toHaveBeenCalledWith(
      "t1",
      "review",
      expect.objectContaining({ pr_number: 7, merged_at: expect.any(String) }),
    );
    expect(deleteRemoteBranch).not.toHaveBeenCalled();
    expect(published).toEqual(["git.pr_merged"]);
    // A self-merge notifies the milestone.
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: "milestone" }));
  });

  it("backfills an already-merged PR — records the merge with no milestone, no re-merge, no branch delete", async () => {
    const { ctx, mergePR, deleteRemoteBranch, updateTaskField, notify, published } = mockCtx({
      status: { state: "merged" },
    });

    const result = await autoMerge.run(ctx);

    expect(result).toMatchObject({ outcome: "ok", data: { disposition: "merged" } });
    expect(mergePR).not.toHaveBeenCalled();
    expect(updateTaskField).toHaveBeenCalledWith(
      "t1",
      "review",
      expect.objectContaining({ pr_number: 7, merged_at: expect.any(String) }),
    );
    expect(published).toEqual(["git.pr_merged"]);
    expect(deleteRemoteBranch).not.toHaveBeenCalled();
    // The user merged it themselves — no milestone notification for their own action.
    expect(notify).not.toHaveBeenCalled();
  });

  it("completes without merging or recording when auto-merge is disabled for the repo", async () => {
    const { ctx, mergePR, updateTaskField, notify, published } = mockCtx({ autoMergeAllowed: false });

    const result = await autoMerge.run(ctx);

    expect(result).toMatchObject({ outcome: "ok", data: { disposition: "auto_merge_disabled" } });
    expect(mergePR).not.toHaveBeenCalled();
    expect(updateTaskField).not.toHaveBeenCalled();
    expect(published).toEqual([]);
    expect(notify).toHaveBeenCalled();
  });

  it("reworks instead of merging when CI is failing", async () => {
    const { ctx, mergePR, published } = mockCtx({ status: { checks_state: "failing" } });

    const result = await autoMerge.run(ctx);

    expect(result).toMatchObject({ outcome: "ok", data: { disposition: "ci_failure" } });
    expect(mergePR).not.toHaveBeenCalled();
    expect(published).toEqual([]);
  });

  it("reworks instead of merging when the PR is definitively conflicting", async () => {
    const { ctx, mergePR } = mockCtx({ status: { merge_state: "conflicting" } });

    const result = await autoMerge.run(ctx);

    expect(result).toMatchObject({ outcome: "ok", data: { disposition: "merge_conflict" } });
    expect(mergePR).not.toHaveBeenCalled();
  });

  it("waits rather than reworking when mergeability is not yet computed (unknown)", async () => {
    const { ctx, mergePR } = mockCtx({ status: { merge_state: "unknown" } });

    const result = await autoMerge.run(ctx);

    expect(result).toMatchObject({ outcome: "ok", data: { disposition: "retry_wait" } });
    expect(mergePR).not.toHaveBeenCalled();
  });

  it("waits rather than reworking when checks are still pending", async () => {
    const { ctx, mergePR } = mockCtx({ status: { checks_state: "pending" } });

    const result = await autoMerge.run(ctx);

    expect(result).toMatchObject({ outcome: "ok", data: { disposition: "retry_wait" } });
    expect(mergePR).not.toHaveBeenCalled();
  });

  it("reworks when the merge call is rejected as a conflict", async () => {
    const { ctx, published } = mockCtx({
      mergeResult: {
        merge_sha: "",
        success: false,
        error: {
          code: "merge_conflict",
          message: "conflict",
          retryable: false,
          retry_after_ms: null,
          severity: "error",
        },
      },
    });

    const result = await autoMerge.run(ctx);

    expect(result).toMatchObject({ outcome: "ok", data: { disposition: "merge_conflict" } });
    expect(published).toEqual([]);
  });

  it("waits to retry when the merge call fails transiently", async () => {
    const { ctx, published } = mockCtx({
      mergeResult: {
        merge_sha: "",
        success: false,
        error: { code: "network_error", message: "timeout", retryable: true, retry_after_ms: null, severity: "error" },
      },
    });

    const result = await autoMerge.run(ctx);

    expect(result).toMatchObject({ outcome: "ok", data: { disposition: "retry_wait" } });
    expect(published).toEqual([]);
  });

  it("hands the merge off to the owner when the host blocks the Engineer (pr_not_mergeable) — terminal, notified, no record", async () => {
    const { ctx, updateTaskField, notify, published, observer } = mockCtx({
      mergeResult: {
        merge_sha: "",
        success: false,
        error: {
          code: "pr_not_mergeable",
          message: "At least 1 approving review is required",
          retryable: false,
          retry_after_ms: null,
          severity: "error",
        },
      },
    });

    const result = await autoMerge.run(ctx);

    // Terminal hand-off: needs_human_merge routes to done — no rework, no retry-wait, so the task leaves the
    // review-poll set and the PR #28 re-trigger loop cannot form.
    expect(result).toMatchObject({ outcome: "ok", data: { disposition: "needs_human_merge" } });
    expect(autoMergeNext(okResult("needs_human_merge"))).toEqual({ go: "done" });
    // The owner is told once; nothing is recorded as merged.
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: "ticket_comment" }));
    expect(updateTaskField).not.toHaveBeenCalled();
    expect(published).toEqual([]);
    // The route is observable as a recorded decision.
    const decision = observer.decisions.find((entry) => entry.name === "merge_outcome");
    expect(decision?.chosen).toBe("needs_human_merge");
  });

  const hostBlocked = {
    merge_sha: "",
    success: false,
    error: {
      code: "pr_not_mergeable",
      message: "At least 1 approving review is required",
      retryable: false,
      retry_after_ms: null,
      severity: "error",
    },
  } as const;

  it("tells the owner to re-approve when the thoughts-cleanup push dismissed their formal approval", async () => {
    vi.mocked(removeThoughtsAndPush).mockReturnValue(true);
    const { ctx, notify } = mockCtx({ excludeThoughts: true, reviewApproved: true, mergeResult: hostBlocked });

    await autoMerge.run(ctx);

    expect(notify).toHaveBeenLastCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/dismissed your earlier approval/i) }),
    );
  });

  it("keeps the plain hand-off when only a /approve comment was used (no formal approval to dismiss)", async () => {
    vi.mocked(removeThoughtsAndPush).mockReturnValue(true);
    const { ctx, notify } = mockCtx({ excludeThoughts: true, reviewApproved: false, mergeResult: hostBlocked });

    await autoMerge.run(ctx);

    expect(notify).toHaveBeenLastCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/merge it when you're ready/i) }),
    );
  });

  it("regression (PR #28): a host-blocked merge resolves terminally — the /approve loop cannot form", async () => {
    const { ctx, notify, updateTaskField, published } = mockCtx({ mergeResult: hostBlocked });

    const result = await autoMerge.run(ctx);

    // The host block resolves to needs_human_merge, which routes to a terminal completion — NOT back to
    // awaiting_pr_review, the re-block that re-queued the task and let the poller re-promote the same
    // /approve into a doomed merge, forever.
    expect(result).toMatchObject({ outcome: "ok", data: { disposition: "needs_human_merge" } });
    const route = autoMergeNext(okResult("needs_human_merge"));
    expect(route).toEqual({ go: "done" });
    expect(route).not.toMatchObject({ category: BlockCategories.awaiting_pr_review });
    // The owner is notified exactly once; nothing is recorded as merged.
    expect(notify).toHaveBeenCalledTimes(1);
    expect(updateTaskField).not.toHaveBeenCalled();
    expect(published).toEqual([]);
  });

  it("throws so the runner blocks when no git hosting plugin is registered", async () => {
    const { ctx } = mockCtx({ hosting: false });
    await expect(autoMerge.run(ctx)).rejects.toThrow("no git hosting plugin");
  });

  it("throws so the runner blocks when the task has no PR on record", async () => {
    const { ctx } = mockCtx({ review: null });
    await expect(autoMerge.run(ctx)).rejects.toThrow("no PR number or repo");
  });

  it("records the merge-readiness decision with the chosen disposition and its alternatives", async () => {
    const { ctx, observer } = mockCtx({ status: { checks_state: "failing" } });

    await autoMerge.run(ctx);

    const decision = observer.decisions.find((entry) => entry.name === "merge_readiness");
    expect(decision?.chosen).toBe("ci_failure");
  });
});
