import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestObserverFacade } from "../../../test/helpers/test-observer-facade.js";
import { TaskStates } from "../../schemas/task.js";
import {
  type UnblockResolverContext,
  createUnblockResolver,
  externalRefsMatch,
} from "./unblock-resolver.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function createMockContext(): UnblockResolverContext {
  return {
    taskEngine: {
      getTask: vi.fn().mockReturnValue(null),
      getTasksByState: vi.fn().mockReturnValue([]),
      requestTransition: vi.fn().mockReturnValue({ success: true }),
      updateTaskField: vi.fn(),
    },
    workspaceManager: {
      getWorktreePath: vi.fn().mockReturnValue(null),
      getWorkspaceRecord: vi.fn().mockReturnValue(null),
    },
    observer: createTestObserverFacade("unblock-resolver"),
  } as unknown as UnblockResolverContext;
}

function makeBlockedTask(
  id: string,
  repo: string,
  externalId: string,
  thoughtsId: string | null = null,
) {
  return {
    id,
    title: "Blocked task",
    state: TaskStates.blocked,
    external_ref: { type: "test_issue", repo, id: externalId },
    thoughts_id: thoughtsId,
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

      const transitionOrder = (mockCtx.taskEngine.requestTransition as ReturnType<typeof vi.fn>)
        .mock.invocationCallOrder[0];
      const updateOrder = (mockCtx.taskEngine.updateTaskField as ReturnType<typeof vi.fn>).mock
        .invocationCallOrder[0];
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
      expect(mockCtx.taskEngine.updateTaskField).not.toHaveBeenCalled();
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
    let tempDir: string;

    beforeEach(() => {
      tempDir = mkdtempSync(path.join(tmpdir(), "unblock-test-"));
    });

    afterEach(() => {
      rmSync(tempDir, { recursive: true, force: true });
    });

    it("writes response content to worktree when provided", () => {
      const task = makeBlockedTask("task-1", "test/repo", "42", "issue-42");
      (mockCtx.taskEngine.getTask as ReturnType<typeof vi.fn>).mockReturnValue(task);
      (mockCtx.taskEngine.getTasksByState as ReturnType<typeof vi.fn>).mockReturnValue([task]);
      (mockCtx.workspaceManager.getWorktreePath as ReturnType<typeof vi.fn>).mockReturnValue(
        tempDir,
      );
      (mockCtx.workspaceManager.getWorkspaceRecord as ReturnType<typeof vi.fn>).mockReturnValue({
        thoughtsDir: "thoughts/2026-03-23-issue-42",
      });

      const resolver = createUnblockResolver(mockCtx);
      resolver.tryUnblock({
        by: "external_ref",
        ref: { type: "test_issue", repo: "test/repo", id: "42" },
        source: "github",
        content: "The answer is 42",
      });

      const responsesDir = path.join(
        tempDir,
        "thoughts",
        "2026-03-23-issue-42",
        "requirements",
        "responses",
      );
      expect(existsSync(responsesDir)).toBe(true);
      const files = readdirSync(responsesDir);
      const responseFile = files.find((f) => f.includes("-github.txt"));
      expect(responseFile).toBeDefined();
      expect(responseFile).toMatch(/^response-\d+-github\.txt$/);
      expect(readFileSync(path.join(responsesDir, responseFile!), "utf-8")).toBe(
        "The answer is 42",
      );
    });

    it("skips file write when no worktree exists", () => {
      const task = makeBlockedTask("task-1", "test/repo", "42", "issue-42");
      (mockCtx.taskEngine.getTask as ReturnType<typeof vi.fn>).mockReturnValue(task);
      (mockCtx.taskEngine.getTasksByState as ReturnType<typeof vi.fn>).mockReturnValue([task]);
      // getWorktreePath returns null

      const resolver = createUnblockResolver(mockCtx);
      const result = resolver.tryUnblock({
        by: "external_ref",
        ref: { type: "test_issue", repo: "test/repo", id: "42" },
        source: "github",
        content: "Some content",
      });

      // Still unblocks — file write is best-effort
      expect(result.unblocked).toBe(true);
    });
  });
});
