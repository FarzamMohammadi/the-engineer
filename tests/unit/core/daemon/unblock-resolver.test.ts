import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type UnblockResolverContext,
  createUnblockResolver,
  externalRefsMatch,
} from "../../../../src/core/daemon/unblock-resolver.js";
import { BlockReasons, TaskStates } from "../../../../src/schemas/task.js";
import { createTestObserverFacade } from "../../../helpers/test-observer-facade.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function createMockContext(): UnblockResolverContext {
  return {
    taskEngine: {
      getTask: vi.fn().mockReturnValue(null),
      getTasksByState: vi.fn().mockReturnValue([]),
      requestTransition: vi.fn().mockReturnValue({ success: true }),
      updateTaskField: vi.fn(),
    },
    observer: createTestObserverFacade("daemon"),
  } as unknown as UnblockResolverContext;
}

function makeBlockedTask(id: string, repo: string, externalId: string, thoughtsId: string | null = null) {
  return {
    id,
    title: "Blocked task",
    state: TaskStates.blocked,
    external_ref: { type: "test_issue", repo, id: externalId },
    thoughts_id: thoughtsId,
  };
}

function makeReviewPendingTask(id: string, repo: string, externalId: string) {
  return {
    ...makeBlockedTask(id, repo, externalId),
    blocked: {
      reason: BlockReasons.pr_review_pending,
      category: "awaiting_pr_review",
      sub_phase: "await-review",
      needed: "waiting on the PR",
    },
  };
}

// ── externalRefsMatch ────────────────────────────────────────────────────────

describe("externalRefsMatch", () => {
  it("returns true for matching repo + id", () => {
    const a = { type: "test_issue", repo: "owner/repo", id: "42" };
    const b = { type: "test_issue", repo: "owner/repo", id: "42" };
    expect(externalRefsMatch(a, b)).toBe(true);
  });

  it("returns true when types differ (matches on repo + id only)", () => {
    const a = { type: "test_issue", repo: "owner/repo", id: "42" };
    const b = { type: "test_pr", repo: "owner/repo", id: "42" };
    expect(externalRefsMatch(a, b)).toBe(true);
  });

  it("returns false when repos differ", () => {
    const a = { type: "test_issue", repo: "owner/repo-a", id: "42" };
    const b = { type: "test_issue", repo: "owner/repo-b", id: "42" };
    expect(externalRefsMatch(a, b)).toBe(false);
  });

  it("returns false when ids differ", () => {
    const a = { type: "test_issue", repo: "owner/repo", id: "1" };
    const b = { type: "test_issue", repo: "owner/repo", id: "2" };
    expect(externalRefsMatch(a, b)).toBe(false);
  });
});

// ── UnblockResolver ──────────────────────────────────────────────────────────

describe("UnblockResolver", () => {
  let mockCtx: UnblockResolverContext;

  beforeEach(() => {
    mockCtx = createMockContext();
  });

  describe("by external_ref", () => {
    it("unblocks a matching blocked task", () => {
      const task = makeBlockedTask("task-1", "test/repo", "42");
      (mockCtx.taskEngine.getTasksByState as ReturnType<typeof vi.fn>).mockReturnValue([task]);

      const resolver = createUnblockResolver(mockCtx);
      const result = resolver.tryUnblock({
        by: "external_ref",
        ref: { type: "test_issue", repo: "test/repo", id: "42" },
        source: "github",
      });

      expect(result).toEqual({ unblocked: true, taskId: "task-1", reason: null });
      expect(mockCtx.taskEngine.requestTransition).toHaveBeenCalledWith(
        "task-1",
        TaskStates.queued,
        null,
        "github_response_received",
        "daemon",
      );
      expect(mockCtx.taskEngine.updateTaskField).toHaveBeenCalledWith("task-1", "blocked", null);
    });

    it("does not unblock a PR-review-pending task — it resumes through PR events, not a comment", () => {
      const task = makeReviewPendingTask("task-1", "test/repo", "42");
      (mockCtx.taskEngine.getTasksByState as ReturnType<typeof vi.fn>).mockReturnValue([task]);

      const resolver = createUnblockResolver(mockCtx);
      const result = resolver.tryUnblock({
        by: "external_ref",
        ref: { type: "test_issue", repo: "test/repo", id: "42" },
        source: "github",
        content: "looks good",
      });

      expect(result).toEqual({ unblocked: false, taskId: "task-1", reason: "pr_review_pending" });
      expect(mockCtx.taskEngine.requestTransition).not.toHaveBeenCalled();
      expect(mockCtx.taskEngine.updateTaskField).not.toHaveBeenCalled();
    });

    it("returns no_match when no blocked task matches", () => {
      (mockCtx.taskEngine.getTasksByState as ReturnType<typeof vi.fn>).mockReturnValue([]);

      const resolver = createUnblockResolver(mockCtx);
      const result = resolver.tryUnblock({
        by: "external_ref",
        ref: { type: "test_issue", repo: "test/repo", id: "42" },
        source: "github",
      });

      expect(result).toEqual({ unblocked: false, taskId: null, reason: "no_match" });
      expect(mockCtx.taskEngine.requestTransition).not.toHaveBeenCalled();
    });

    it("clears blocked field only after successful transition", () => {
      const task = makeBlockedTask("task-1", "test/repo", "42");
      (mockCtx.taskEngine.getTasksByState as ReturnType<typeof vi.fn>).mockReturnValue([task]);

      const resolver = createUnblockResolver(mockCtx);
      resolver.tryUnblock({
        by: "external_ref",
        ref: { type: "test_issue", repo: "test/repo", id: "42" },
        source: "github",
      });

      const transitionOrder = (mockCtx.taskEngine.requestTransition as ReturnType<typeof vi.fn>).mock
        .invocationCallOrder[0];
      const updateOrder = (mockCtx.taskEngine.updateTaskField as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
      expect(transitionOrder).toBeLessThan(updateOrder!);
    });

    it("returns failure when transition fails (blocked details preserved)", () => {
      const task = makeBlockedTask("task-1", "test/repo", "42");
      (mockCtx.taskEngine.getTasksByState as ReturnType<typeof vi.fn>).mockReturnValue([task]);
      (mockCtx.taskEngine.requestTransition as ReturnType<typeof vi.fn>).mockReturnValue({
        success: false,
        reason: "invalid_transition",
      });

      const resolver = createUnblockResolver(mockCtx);
      const result = resolver.tryUnblock({
        by: "external_ref",
        ref: { type: "test_issue", repo: "test/repo", id: "42" },
        source: "github",
      });

      expect(result).toEqual({
        unblocked: false,
        taskId: "task-1",
        reason: "invalid_transition",
      });
      // blocked field NOT cleared on failure
      expect(mockCtx.taskEngine.updateTaskField).not.toHaveBeenCalledWith("task-1", "blocked", null);
    });
  });

  describe("by task_id", () => {
    it("unblocks a blocked task by direct ID", () => {
      const task = makeBlockedTask("task-1", "test/repo", "42");
      (mockCtx.taskEngine.getTask as ReturnType<typeof vi.fn>).mockReturnValue(task);

      const resolver = createUnblockResolver(mockCtx);
      const result = resolver.tryUnblock({
        by: "task_id",
        taskId: "task-1",
        source: "dashboard",
      });

      expect(result).toEqual({ unblocked: true, taskId: "task-1", reason: null });
      expect(mockCtx.taskEngine.requestTransition).toHaveBeenCalledWith(
        "task-1",
        TaskStates.queued,
        null,
        "dashboard_response_received",
        "daemon",
      );
    });

    it("does not unblock a PR-review-pending task by direct id", () => {
      const task = makeReviewPendingTask("task-1", "test/repo", "42");
      (mockCtx.taskEngine.getTask as ReturnType<typeof vi.fn>).mockReturnValue(task);

      const resolver = createUnblockResolver(mockCtx);
      const result = resolver.tryUnblock({ by: "task_id", taskId: "task-1", source: "dashboard" });

      expect(result).toEqual({ unblocked: false, taskId: "task-1", reason: "pr_review_pending" });
      expect(mockCtx.taskEngine.requestTransition).not.toHaveBeenCalled();
    });

    it("returns not_blocked when task is not in blocked state", () => {
      (mockCtx.taskEngine.getTask as ReturnType<typeof vi.fn>).mockReturnValue({
        id: "task-1",
        state: TaskStates.active,
      });

      const resolver = createUnblockResolver(mockCtx);
      const result = resolver.tryUnblock({
        by: "task_id",
        taskId: "task-1",
        source: "dashboard",
      });

      expect(result).toEqual({ unblocked: false, taskId: "task-1", reason: "not_blocked" });
      expect(mockCtx.taskEngine.requestTransition).not.toHaveBeenCalled();
    });

    it("returns not_blocked when task does not exist", () => {
      const resolver = createUnblockResolver(mockCtx);
      const result = resolver.tryUnblock({
        by: "task_id",
        taskId: "nonexistent",
        source: "dashboard",
      });

      expect(result).toEqual({ unblocked: false, taskId: "nonexistent", reason: "not_blocked" });
    });
  });

  describe("response content", () => {
    it("captures the owner's answer on the task before the transition, so the re-run can read it", () => {
      const task = makeBlockedTask("task-1", "test/repo", "42", "issue-42");
      (mockCtx.taskEngine.getTasksByState as ReturnType<typeof vi.fn>).mockReturnValue([task]);

      const resolver = createUnblockResolver(mockCtx);
      resolver.tryUnblock({
        by: "external_ref",
        ref: { type: "test_issue", repo: "test/repo", id: "42" },
        source: "github",
        content: "The answer is 42",
      });

      expect(mockCtx.taskEngine.updateTaskField).toHaveBeenCalledWith("task-1", "pending_response", "The answer is 42");
      // Answer captured BEFORE the queued transition, so it is in place when the daemon dispatches.
      const responseOrder = (mockCtx.taskEngine.updateTaskField as ReturnType<typeof vi.fn>).mock.calls.findIndex(
        (call) => call[1] === "pending_response",
      );
      const responseInvocation = (mockCtx.taskEngine.updateTaskField as ReturnType<typeof vi.fn>).mock
        .invocationCallOrder[responseOrder];
      const transitionInvocation = (mockCtx.taskEngine.requestTransition as ReturnType<typeof vi.fn>).mock
        .invocationCallOrder[0];
      expect(responseInvocation).toBeLessThan(transitionInvocation!);
    });

    it("does not set pending_response when no answer content is provided", () => {
      const task = makeBlockedTask("task-1", "test/repo", "42", "issue-42");
      (mockCtx.taskEngine.getTasksByState as ReturnType<typeof vi.fn>).mockReturnValue([task]);

      const resolver = createUnblockResolver(mockCtx);
      const result = resolver.tryUnblock({
        by: "external_ref",
        ref: { type: "test_issue", repo: "test/repo", id: "42" },
        source: "github",
      });

      expect(result.unblocked).toBe(true);
      expect(mockCtx.taskEngine.updateTaskField).not.toHaveBeenCalledWith(
        "task-1",
        "pending_response",
        expect.anything(),
      );
    });
  });
});
