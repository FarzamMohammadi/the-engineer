/**
 * Tests for commitPushAndCreatePR (D149, D150, D151).
 *
 * Isolated in a separate file to scope the vi.mock("node:child_process") —
 * the main index.test.ts does not mock execFileSync.
 */
import { type Mock, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: vi.fn() };
});

import { execFileSync } from "node:child_process";

import type { WorkspaceRecord } from "../../../../src/core/interfaces/workspace-manager.interface.js";
import { Phases } from "../../../../src/schemas/orchestrator.js";
import { SessionEndReasons } from "../../../../src/schemas/session-memory.js";
import {
  type TestOrchestratorHandle,
  createMockDispatch,
  createTestOrchestrator,
} from "../../../helpers/test-orchestrator.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const WORKTREE_PATH = "/tmp/worktree/task-001";

const WORKSPACE_RECORD: WorkspaceRecord = {
  taskId: "task-001",
  repo: "org/repo",
  branch: "engineer/task-001-test-task",
  worktreePath: WORKTREE_PATH,
  baseBranch: "main",
  baseCommit: "abc123",
  thoughtsDir: "thoughts/2026-03-22-issue-1",
};

/** Configure execFileSync to handle standard git commands for the happy path. */
function setupGitMocks(options: {
  hasStagedChanges: boolean;
  aheadCount?: string;
  commitFails?: boolean;
  revListFails?: boolean;
}): void {
  const mock = vi.mocked(execFileSync);
  mock.mockImplementation((_file, args) => {
    const argsArray = args as string[];
    const command = argsArray[0] ?? "";
    return routeGitCommand(command, options);
  });
}

/** Route a mocked git command to the appropriate behavior. */
function routeGitCommand(
  command: string,
  options: {
    hasStagedChanges: boolean;
    aheadCount?: string;
    commitFails?: boolean;
    revListFails?: boolean;
  },
): string {
  if (command === "add") {
    return "";
  }
  if (command === "diff") {
    if (options.hasStagedChanges) {
      throw new Error("exit code 1");
    }
    return "";
  }
  if (command === "commit") {
    if (options.commitFails) {
      throw new Error("commit failed");
    }
    return "";
  }
  if (command === "rev-list") {
    if (options.revListFails) {
      throw new Error("rev-list failed");
    }
    return `${options.aheadCount ?? "0"}\n`;
  }
  return "";
}

/** Create a dispatch with repo and clone_url so workspace gets created. */
function dispatchWithWorkspace() {
  return createMockDispatch({
    task: {
      repo: "org/repo",
      clone_url: "https://github.com/org/repo.git",
    },
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("commitPushAndCreatePR", () => {
  let h: TestOrchestratorHandle;
  let fakeGitHosting: { createPR: Mock };

  beforeEach(() => {
    vi.clearAllMocks();
    h = createTestOrchestrator();
    h.setAllPhaseResponses();

    // Wire workspace manager to return a valid workspace
    h.workspaceManager.createWorkspace.mockReturnValue(WORKSPACE_RECORD);
    h.workspaceManager.getWorktreePath.mockReturnValue(WORKTREE_PATH);
    h.workspaceManager.getWorkspaceRecord.mockReturnValue(WORKSPACE_RECORD);

    // Wire git hosting plugin
    fakeGitHosting = {
      createPR: vi.fn().mockResolvedValue({
        pr_number: 42,
        url: "https://github.com/org/repo/pull/42",
      }),
    };
    h.registry.getPrimaryPlugin.mockImplementation((type: string) => {
      if (type === "llm") {
        // Need the original LLM mock — call the original
        return h.registry.getPrimaryPlugin.getMockImplementation() ? undefined : null;
      }
      if (type === "git_hosting") {
        return fakeGitHosting;
      }
      return null;
    });

    // Re-wire to keep original getPrimaryPlugin for "llm" and "tool"
    const originalImpl = createTestOrchestrator();
    const originalGetPrimary = originalImpl.registry.getPrimaryPlugin;
    h.registry.getPrimaryPlugin.mockImplementation((type: string) => {
      if (type === "git_hosting") {
        return fakeGitHosting;
      }
      // Delegate llm/tool to the original mock's return values
      return originalGetPrimary(type);
    });
  });

  it("returns early when no workspace exists", async () => {
    h.workspaceManager.getWorktreePath.mockReturnValue(null);
    setupGitMocks({ hasStagedChanges: false });

    const dispatch = dispatchWithWorkspace();
    await h.orchestrator.executeTask(dispatch);

    expect(h.workspaceManager.pushBranch).not.toHaveBeenCalled();
    expect(fakeGitHosting.createPR).not.toHaveBeenCalled();
  });

  it("returns early when no workspace record exists at PR creation time", async () => {
    // Return workspace record for initial thoughtsDir read, then null for PR creation
    h.workspaceManager.getWorkspaceRecord.mockReturnValueOnce(WORKSPACE_RECORD).mockReturnValue(null);
    setupGitMocks({ hasStagedChanges: false });

    const dispatch = dispatchWithWorkspace();
    await h.orchestrator.executeTask(dispatch);

    expect(h.workspaceManager.pushBranch).not.toHaveBeenCalled();
    expect(fakeGitHosting.createPR).not.toHaveBeenCalled();
  });

  it("commits, pushes, and creates ready PR when staged changes exist", async () => {
    setupGitMocks({ hasStagedChanges: true });

    const dispatch = dispatchWithWorkspace();
    await h.orchestrator.executeTask(dispatch);

    // Verify git commit was called
    const commitCalls = vi.mocked(execFileSync).mock.calls.filter((call) => (call[1] as string[])[0] === "commit");
    expect(commitCalls.length).toBe(1);

    // Verify push and PR creation
    expect(h.workspaceManager.pushBranch).toHaveBeenCalledWith("task-001");
    expect(fakeGitHosting.createPR).toHaveBeenCalledWith(
      expect.objectContaining({
        repo: "org/repo",
        branch: "engineer/task-001-test-task",
        base: "main",
        draft: false,
      }),
    );
  });

  it("skips commit but pushes and creates PR when ahead of base", async () => {
    setupGitMocks({ hasStagedChanges: false, aheadCount: "3" });

    const dispatch = dispatchWithWorkspace();
    await h.orchestrator.executeTask(dispatch);

    // Verify git commit was NOT called (no staged changes)
    const commitCalls = vi.mocked(execFileSync).mock.calls.filter((call) => (call[1] as string[])[0] === "commit");
    expect(commitCalls.length).toBe(0);

    // But push and PR should still happen (ahead of base)
    expect(h.workspaceManager.pushBranch).toHaveBeenCalledWith("task-001");
    expect(fakeGitHosting.createPR).toHaveBeenCalled();
  });

  it("returns early when not ahead of base and no staged changes", async () => {
    setupGitMocks({ hasStagedChanges: false, aheadCount: "0" });

    const dispatch = dispatchWithWorkspace();
    await h.orchestrator.executeTask(dispatch);

    expect(h.workspaceManager.pushBranch).not.toHaveBeenCalled();
    expect(fakeGitHosting.createPR).not.toHaveBeenCalled();
  });

  it("returns early safely when rev-list fails", async () => {
    setupGitMocks({ hasStagedChanges: false, revListFails: true });

    const dispatch = dispatchWithWorkspace();
    await h.orchestrator.executeTask(dispatch);

    expect(h.workspaceManager.pushBranch).not.toHaveBeenCalled();
    expect(fakeGitHosting.createPR).not.toHaveBeenCalled();
  });

  it("logs journal error and skips PR when push fails", async () => {
    setupGitMocks({ hasStagedChanges: true });
    h.workspaceManager.pushBranch.mockImplementation(() => {
      throw new Error("push permission denied");
    });

    const dispatch = dispatchWithWorkspace();
    await h.orchestrator.executeTask(dispatch);

    // Push was attempted
    expect(h.workspaceManager.pushBranch).toHaveBeenCalled();

    // Journal error should be recorded
    const journalCalls = h.sessionMemory.addJournalEntry.mock.calls;
    const pushErrorEntry = journalCalls.find(
      (call) =>
        (call[0] as { summary: string }).summary.includes("push") &&
        (call[0] as { tags?: string[] }).tags?.includes("pr_workflow"),
    );
    expect(pushErrorEntry).toBeTruthy();

    // PR should NOT be created
    expect(fakeGitHosting.createPR).not.toHaveBeenCalled();
  });

  it("logs journal error when PR creation fails", async () => {
    setupGitMocks({ hasStagedChanges: true });
    fakeGitHosting.createPR.mockRejectedValue(new Error("API rate limited"));

    const dispatch = dispatchWithWorkspace();
    await h.orchestrator.executeTask(dispatch);

    // PR creation was attempted
    expect(fakeGitHosting.createPR).toHaveBeenCalled();

    // Journal error should be recorded
    const journalCalls = h.sessionMemory.addJournalEntry.mock.calls;
    const prErrorEntry = journalCalls.find(
      (call) =>
        (call[0] as { summary: string }).summary.includes("pr_creation") &&
        (call[0] as { tags?: string[] }).tags?.includes("pr_workflow"),
    );
    expect(prErrorEntry).toBeTruthy();
  });

  it("pushes but skips PR creation when no git hosting plugin", async () => {
    setupGitMocks({ hasStagedChanges: true });
    h.registry.getPrimaryPlugin.mockImplementation((type: string) => {
      if (type === "git_hosting") {
        return null; // No hosting plugin
      }
      // Keep llm/tool working
      const orig = createTestOrchestrator();
      return orig.registry.getPrimaryPlugin(type);
    });

    const dispatch = dispatchWithWorkspace();
    await h.orchestrator.executeTask(dispatch);

    // Push should still happen
    expect(h.workspaceManager.pushBranch).toHaveBeenCalled();

    // But no PR creation
    expect(fakeGitHosting.createPR).not.toHaveBeenCalled();
  });

  it("updates task review field after successful PR creation", async () => {
    setupGitMocks({ hasStagedChanges: true });

    const dispatch = dispatchWithWorkspace();
    await h.orchestrator.executeTask(dispatch);

    // Task review should be updated with PR number
    const reviewUpdateCalls = h.taskEngine.updateTaskField.mock.calls.filter((call) => call[1] === "review");
    expect(reviewUpdateCalls.length).toBeGreaterThanOrEqual(1);
    const lastReviewUpdate = reviewUpdateCalls[reviewUpdateCalls.length - 1];
    expect(lastReviewUpdate?.[2]).toEqual(
      expect.objectContaining({
        pr_number: 42,
        pr_state: "ready",
      }),
    );
  });

  // ── Review Pending Outcome ────────────────────────────────────────────

  it("returns review_pending outcome when PR is successfully created", async () => {
    setupGitMocks({ hasStagedChanges: true });

    const dispatch = dispatchWithWorkspace();
    const result = await h.orchestrator.executeTask(dispatch);

    expect(result.outcome).toBe("review_pending");
    if (result.outcome === "review_pending") {
      expect(result.phase).toBe(Phases.demo_prep);
      // Should include phases up to demo_prep (6 of 7)
      expect(result.phaseOutputs.size).toBe(6);
      expect(result.phaseOutputs.has(Phases.integration)).toBe(false);
    }
  });

  it("ends session with review_pending when PR is created", async () => {
    setupGitMocks({ hasStagedChanges: true });

    const dispatch = dispatchWithWorkspace();
    await h.orchestrator.executeTask(dispatch);

    expect(h.sessionMemory.endSession).toHaveBeenCalledWith(expect.any(String), SessionEndReasons.review_pending);
  });

  it("blocks task when PR creation fails", async () => {
    setupGitMocks({ hasStagedChanges: true });
    fakeGitHosting.createPR.mockRejectedValue(new Error("API rate limited"));

    const dispatch = dispatchWithWorkspace();
    const result = await h.orchestrator.executeTask(dispatch);

    // PR creation failed — task blocks for owner attention
    expect(result.outcome).toBe("blocked");
  });

  it("returns completed when no workspace record at PR creation time (no PR to create)", async () => {
    // Return workspace record for initial thoughtsDir read, then null for PR creation
    h.workspaceManager.getWorkspaceRecord.mockReturnValueOnce(WORKSPACE_RECORD).mockReturnValue(null);
    setupGitMocks({ hasStagedChanges: false });

    const dispatch = dispatchWithWorkspace();
    const result = await h.orchestrator.executeTask(dispatch);

    expect(result.outcome).toBe("completed");
  });
});
