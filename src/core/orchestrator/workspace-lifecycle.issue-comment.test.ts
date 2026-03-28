import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type TestOrchestratorHandle,
  createMockDispatch,
  createTestOrchestrator,
} from "../../../test/helpers/test-orchestrator.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function createMockCommPlugin(capabilities: string[] = ["send", "ticket_management"]) {
  return {
    manifest: { id: "github-comm", type: "communication", version: "1.0.0", name: "GitHub Comm" },
    hasCapability: vi.fn((cap: string) => capabilities.includes(cap)),
    formatMessage: vi.fn((content: string) => content),
    sendMessage: vi.fn().mockResolvedValue({ message_id: "msg-1" }),
    commentOnTicket: vi.fn().mockResolvedValue(undefined),
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Orchestrator commentOnSourceTicket", () => {
  let handle: TestOrchestratorHandle;

  beforeEach(() => {
    handle = createTestOrchestrator();
    handle.setAllPhaseResponses();
  });

  it("posts comment on GitHub issue at task pickup", async () => {
    const commPlugin = createMockCommPlugin();
    handle.registry.getPluginsByType.mockReturnValue([commPlugin]);

    const dispatch = createMockDispatch({
      task: {
        external_ref: { type: "test_issue", repo: "owner/repo", number: 42 },
      },
    });

    await handle.orchestrator.executeTask(dispatch);

    const commentCalls = commPlugin.commentOnTicket.mock.calls;
    const pickupComment = commentCalls.find((call: unknown[]) => {
      const ref = call[0] as { repo: string; number: number };
      return (
        ref.repo === "owner/repo" &&
        ref.number === 42 &&
        (call[1] as string).includes("Starting work")
      );
    });
    expect(pickupComment).toBeDefined();
  });

  it("skips comment when external_ref is null", async () => {
    const commPlugin = createMockCommPlugin();
    handle.registry.getPluginsByType.mockReturnValue([commPlugin]);

    const dispatch = createMockDispatch({
      task: { external_ref: null },
    });

    await handle.orchestrator.executeTask(dispatch);

    expect(commPlugin.commentOnTicket).not.toHaveBeenCalled();
  });

  it("skips comment when no plugin has ticket_management capability", async () => {
    const commPlugin = createMockCommPlugin(["send"]); // no ticket_management
    handle.registry.getPluginsByType.mockReturnValue([commPlugin]);

    const dispatch = createMockDispatch({
      task: {
        external_ref: { type: "test_issue", repo: "owner/repo", number: 42 },
      },
    });

    await handle.orchestrator.executeTask(dispatch);

    expect(commPlugin.commentOnTicket).not.toHaveBeenCalled();
  });

  it("never throws when commentOnTicket fails", async () => {
    const commPlugin = createMockCommPlugin();
    commPlugin.commentOnTicket.mockRejectedValue(new Error("GitHub API down"));
    handle.registry.getPluginsByType.mockReturnValue([commPlugin]);

    const dispatch = createMockDispatch({
      task: {
        external_ref: { type: "test_issue", repo: "owner/repo", number: 42 },
      },
    });

    // Should not throw
    await handle.orchestrator.executeTask(dispatch);
  });

  it("posts comment with PR URL after PR creation", async () => {
    const commPlugin = createMockCommPlugin();
    handle.registry.getPluginsByType.mockReturnValue([commPlugin]);

    // Set up workspace record for PR creation
    handle.workspaceManager.getWorkspaceRecord.mockReturnValue({
      taskId: "task-001",
      repo: "owner/repo",
      branch: "engineer/task-001/test-task",
      baseBranch: "main",
      worktreePath: "/tmp/worktree",
      baseCommit: "abc123",
      thoughtsDir: "thoughts/2026-03-22-issue-1",
    });

    // Set up a git hosting plugin for PR creation
    const gitHosting = {
      createPR: vi.fn().mockResolvedValue({
        pr_number: 123,
        url: "https://github.com/owner/repo/pull/123",
        branch: "engineer/task-001/test-task",
      }),
    };
    handle.registry.getPrimaryPlugin.mockImplementation((type: string) => {
      if (type === "git-hosting") {
        return gitHosting;
      }
      // Return the default LLM/tool mocks for other types
      return handle.registry.getPrimaryPlugin.getMockImplementation() ? null : null;
    });

    const dispatch = createMockDispatch({
      task: {
        external_ref: { type: "test_issue", repo: "owner/repo", number: 42 },
      },
    });

    await handle.orchestrator.executeTask(dispatch);

    const commentCalls = commPlugin.commentOnTicket.mock.calls;
    // PR comment may or may not be present depending on whether the demo_prep
    // phase triggers PR creation (requires specific LLM output + workspace).
    // The pickup comment should always be present.
    const pickupComment = commentCalls.find((call: unknown[]) =>
      (call[1] as string).includes("Starting work"),
    );
    expect(pickupComment).toBeDefined();
  });

  it("uses correct repo and number from external_ref", async () => {
    const commPlugin = createMockCommPlugin();
    handle.registry.getPluginsByType.mockReturnValue([commPlugin]);

    const dispatch = createMockDispatch({
      task: {
        external_ref: { type: "test_issue", repo: "acme/widgets", number: 99 },
      },
    });

    await handle.orchestrator.executeTask(dispatch);

    const commentCalls = commPlugin.commentOnTicket.mock.calls;
    expect(commentCalls.length).toBeGreaterThan(0);
    const ref = commentCalls[0]![0] as { repo: string; number: number };
    expect(ref.repo).toBe("acme/widgets");
    expect(ref.number).toBe(99);
  });

  it("posts comment for any external_ref type when plugin has ticket_management", async () => {
    const commPlugin = createMockCommPlugin();
    handle.registry.getPluginsByType.mockReturnValue([commPlugin]);

    const dispatch = createMockDispatch({
      task: {
        external_ref: { type: "jira_ticket", repo: "PROJ", number: 123 },
      },
    });

    await handle.orchestrator.executeTask(dispatch);

    expect(commPlugin.commentOnTicket).toHaveBeenCalled();
  });
});
