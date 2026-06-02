import { describe, expect, it, vi } from "vitest";

import { autoMerge, autoMergeNext } from "../../../../../../src/core/orchestrator/pipeline/delivery/auto-merge.js";
import {
  BlockCategories,
  type Ctx,
  Phases,
  type RoutableResult,
} from "../../../../../../src/core/orchestrator/pipeline/types.js";
import type { MergeResult, PRStatus } from "../../../../../../src/schemas/adapters.js";
import type { ReviewState } from "../../../../../../src/schemas/task.js";
import { createRecordingObserver } from "../../../../../helpers/test-mock-pipeline.js";

const okResult = (disposition: string): RoutableResult => ({ outcome: "ok", summary: "", data: { disposition } });

const readyReview: ReviewState = {
  pr_number: 7,
  merged_at: null,
  feedback_rounds: [],
  accommodated_comment_ids: [],
  accommodated_review_state: null,
};

interface MockOptions {
  readonly status?: Partial<PRStatus>;
  readonly mergeResult?: MergeResult;
  readonly hosting?: boolean;
  readonly autoMergeAllowed?: boolean;
  readonly excludeThoughts?: boolean;
  readonly deleteBranch?: boolean;
  readonly review?: ReviewState | null;
}

function mockCtx(options: MockOptions = {}) {
  const status: PRStatus = {
    number: 7,
    state: "open",
    draft: false,
    mergeable: true,
    checks_state: "passing",
    url: "https://x/7",
    ...options.status,
  };
  const getPRStatus = vi.fn().mockResolvedValue(status);
  const mergePR = vi
    .fn()
    .mockResolvedValue(options.mergeResult ?? { merge_sha: "sha-merged", success: true, error: null });
  const deleteRemoteBranch = vi.fn();
  const updateTaskField = vi.fn();
  const notify = vi.fn();
  const published: string[] = [];
  const observer = createRecordingObserver();

  const hosting = options.hosting === false ? null : { getPRStatus, mergePR };
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
      pr: { default_merge_strategy: "squash", delete_branch_after_merge: options.deleteBranch ?? true },
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
  it("merges a green, mergeable PR and publishes the merge and branch-delete audit events", async () => {
    const { ctx, mergePR, deleteRemoteBranch, published } = mockCtx();

    const result = await autoMerge.run(ctx);

    expect(result).toMatchObject({ outcome: "ok", data: { disposition: "merged" } });
    expect(mergePR).toHaveBeenCalledWith("acme/app", 7, "squash");
    expect(deleteRemoteBranch).toHaveBeenCalledWith("t1");
    expect(published).toEqual(["git.pr_merged", "git.branch_deleted"]);
  });

  it("does not delete the remote branch when delete_branch_after_merge is off", async () => {
    const { ctx, deleteRemoteBranch, published } = mockCtx({ deleteBranch: false });

    await autoMerge.run(ctx);

    expect(deleteRemoteBranch).not.toHaveBeenCalled();
    expect(published).toEqual(["git.pr_merged"]);
  });

  it("short-circuits to done without merging when the PR is already merged", async () => {
    const { ctx, mergePR } = mockCtx({ status: { state: "merged" } });

    const result = await autoMerge.run(ctx);

    expect(result).toMatchObject({ outcome: "ok", data: { disposition: "merged" } });
    expect(mergePR).not.toHaveBeenCalled();
  });

  it("completes without merging when auto-merge is disabled for the repo", async () => {
    const { ctx, mergePR, notify } = mockCtx({ autoMergeAllowed: false });

    const result = await autoMerge.run(ctx);

    expect(result).toMatchObject({ outcome: "ok", data: { disposition: "auto_merge_disabled" } });
    expect(mergePR).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalled();
  });

  it("reworks instead of merging when CI is failing", async () => {
    const { ctx, mergePR } = mockCtx({ status: { checks_state: "failing" } });

    const result = await autoMerge.run(ctx);

    expect(result).toMatchObject({ outcome: "ok", data: { disposition: "ci_failure" } });
    expect(mergePR).not.toHaveBeenCalled();
  });

  it("reworks instead of merging when the PR is not mergeable", async () => {
    const { ctx, mergePR } = mockCtx({ status: { mergeable: false } });

    const result = await autoMerge.run(ctx);

    expect(result).toMatchObject({ outcome: "ok", data: { disposition: "merge_conflict" } });
    expect(mergePR).not.toHaveBeenCalled();
  });

  it("waits rather than reworking when checks are still pending", async () => {
    const { ctx, mergePR } = mockCtx({ status: { checks_state: "pending" } });

    const result = await autoMerge.run(ctx);

    expect(result).toMatchObject({ outcome: "ok", data: { disposition: "retry_wait" } });
    expect(mergePR).not.toHaveBeenCalled();
  });

  it("reworks when the merge call is rejected as a conflict", async () => {
    const { ctx } = mockCtx({
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
