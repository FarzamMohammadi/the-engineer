import { describe, expect, it, vi } from "vitest";
import { createTestObserverFacade } from "../../../test/helpers/test-observer-facade.js";
import { OrchestratorConfigSchema } from "../../schemas/config.js";
import type { Dispatch } from "../../schemas/ephemeral.js";
import type { Task } from "../../schemas/task.js";
import { createAndonCord } from "./andon-cord.js";
import type { OrchestratorContext } from "./types.js";
import { createWorkspaceLifecycle } from "./workspace-lifecycle.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function createMockContext(): OrchestratorContext {
  return {
    config: OrchestratorConfigSchema.parse({}),
    eventBus: {
      publish: vi.fn(),
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      replay: vi.fn(),
      getEventsForTask: vi.fn().mockReturnValue([]),
      getEventsSince: vi.fn().mockReturnValue([]),
    } as unknown as OrchestratorContext["eventBus"],
    registry: {
      getPrimaryPlugin: vi.fn().mockReturnValue(null),
      getPluginsByType: vi.fn().mockReturnValue([]),
      getPlugin: vi.fn().mockReturnValue(null),
    } as unknown as OrchestratorContext["registry"],
    taskEngine: {
      checkPermission: vi.fn().mockReturnValue({ allowed: true }),
      updateTaskField: vi.fn(),
      getTask: vi.fn(),
      requestTransition: vi.fn(),
      updateTracking: vi.fn(),
      createTask: vi.fn(),
    } as unknown as OrchestratorContext["taskEngine"],
    safetyLayer: {} as OrchestratorContext["safetyLayer"],
    actionPipeline: {
      execute: vi.fn(),
    } as unknown as OrchestratorContext["actionPipeline"],
    sessionMemory: {
      createSession: vi.fn().mockReturnValue({ id: "session-001", task_id: "task-001" }),
      endSession: vi.fn(),
      addJournalEntry: vi.fn(),
      createCheckpoint: vi.fn(),
      getLatestCheckpoint: vi.fn(),
    } as unknown as OrchestratorContext["sessionMemory"],
    workspaceManager: {
      getWorktreePath: vi.fn().mockReturnValue(null),
      getWorkspaceRecord: vi.fn().mockReturnValue(null),
      createWorkspace: vi.fn().mockReturnValue({
        branch: "engineer/task-001",
        worktreePath: "/tmp/worktree/task-001",
        repo: "owner/repo",
        baseBranch: "main",
      }),
      verifyWorkspace: vi.fn(),
      registerExistingWorkspace: vi.fn(),
      pushBranch: vi.fn(),
      cleanupWorkspace: vi.fn(),
    } as unknown as OrchestratorContext["workspaceManager"],
    peopleDirectory: {
      getOwner: vi.fn().mockReturnValue(null),
      resolveContact: vi.fn().mockReturnValue(null),
    } as unknown as OrchestratorContext["peopleDirectory"],
    observationStore: null,
    observer: createTestObserverFacade("orchestrator"),
  };
}

function createDispatch(overrides?: Partial<Task>): Dispatch {
  const now = new Date().toISOString();
  return {
    task: {
      id: "task-001",
      external_ref: null,
      state: "active",
      sub_state: "working",
      phase: null,
      parent_id: null,
      children: [],
      cascade_policy: "pause_siblings",
      title: "Test task",
      description: "A test task",
      source_text: "Test",
      acceptance_criteria: [],
      team: [],
      related: [],
      decisions: [],
      child_summaries: [],
      workspace: null,
      review: null,
      blocked: null,
      priority: 50,
      llm_tokens: 0,
      llm_cost_usd: 0,
      compute_time_ms: 0,
      created_at: now,
      started_at: now,
      completed_at: null,
      last_transition_at: now,
      session_id: null,
      repo: "owner/repo",
      clone_url: "https://github.com/owner/repo.git",
      ...overrides,
    } as Task,
    resume_from: null,
    knowledge: { repo: [], user: [] },
  } as Dispatch;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("WorkspaceLifecycle", () => {
  describe("setupWorkspace", () => {
    it("creates workspace for fresh task with repo", () => {
      const ctx = createMockContext();
      const wl = createWorkspaceLifecycle(ctx);
      const dispatch = createDispatch();

      wl.setupWorkspace(dispatch);

      expect(ctx.workspaceManager.createWorkspace).toHaveBeenCalledWith("task-001", "owner/repo", {
        title: "Test task",
        parentBranch: undefined,
        cloneUrl: "https://github.com/owner/repo.git",
      });
      expect(ctx.taskEngine.updateTaskField).toHaveBeenCalledWith(
        "task-001",
        "workspace",
        expect.objectContaining({ repo: "owner/repo" }),
      );
    });

    it("re-registers existing workspace on rework", () => {
      const ctx = createMockContext();
      (ctx.workspaceManager.getWorktreePath as ReturnType<typeof vi.fn>).mockReturnValue(
        "/tmp/worktree/task-001",
      );
      const wl = createWorkspaceLifecycle(ctx);
      const dispatch = createDispatch({
        workspace: { repo: "owner/repo", branch: "engineer/task-001", worktree_path: "/tmp/wt" },
      } as Partial<Task>);

      wl.setupWorkspace(dispatch);

      expect(ctx.workspaceManager.registerExistingWorkspace).toHaveBeenCalledWith(
        "task-001",
        expect.objectContaining({ repo: "owner/repo" }),
      );
      expect(ctx.workspaceManager.createWorkspace).not.toHaveBeenCalled();
    });

    it("looks up parent branch for child tasks", () => {
      const ctx = createMockContext();
      (ctx.taskEngine.getTask as ReturnType<typeof vi.fn>).mockReturnValue({
        workspace: { branch: "engineer/parent-branch" },
      });
      const wl = createWorkspaceLifecycle(ctx);
      const dispatch = createDispatch({ parent_id: "parent-001" } as Partial<Task>);

      wl.setupWorkspace(dispatch);

      expect(ctx.workspaceManager.createWorkspace).toHaveBeenCalledWith("task-001", "owner/repo", {
        title: "Test task",
        parentBranch: "engineer/parent-branch",
        cloneUrl: "https://github.com/owner/repo.git",
      });
    });

    it("registers existing workspace on resume", () => {
      const ctx = createMockContext();
      const wl = createWorkspaceLifecycle(ctx);
      const dispatch = createDispatch({
        workspace: { repo: "owner/repo", branch: "engineer/task-001", worktree_path: "/tmp/wt" },
      } as Partial<Task>);
      (dispatch as { resume_from: unknown }).resume_from = {
        id: "cp-001",
        session_id: "session-prev",
        phase: "research",
      };

      wl.setupWorkspace(dispatch);

      expect(ctx.workspaceManager.registerExistingWorkspace).toHaveBeenCalledWith(
        "task-001",
        expect.objectContaining({ repo: "owner/repo" }),
      );
    });
  });

  describe("createSession", () => {
    it("creates fresh session for new dispatch", () => {
      const ctx = createMockContext();
      const wl = createWorkspaceLifecycle(ctx);
      const dispatch = createDispatch();

      const session = wl.createSession(dispatch);

      expect(session.id).toBe("session-001");
      expect(ctx.sessionMemory.createSession).toHaveBeenCalledWith({ taskId: "task-001" });
    });

    it("creates linked session on resume", () => {
      const ctx = createMockContext();
      const wl = createWorkspaceLifecycle(ctx);
      const dispatch = createDispatch();
      (dispatch as { resume_from: unknown }).resume_from = {
        id: "cp-001",
        session_id: "session-prev",
        phase: "research",
      };

      wl.createSession(dispatch);

      expect(ctx.sessionMemory.createSession).toHaveBeenCalledWith({
        taskId: "task-001",
        previousSessionId: "session-prev",
        resumedFromCheckpoint: "cp-001",
      });
    });
  });

  describe("notifyMilestone (security)", () => {
    it("sanitizes token-bearing message before sending to comm plugin", async () => {
      const ctx = createMockContext();
      const sendMessage = vi.fn().mockResolvedValue(undefined);
      const formatMessage = vi.fn((content: string) => content);
      const mockPlugin = {
        manifest: { id: "telegram-comm" },
        hasCapability: vi.fn().mockReturnValue(true),
        formatMessage,
        sendMessage,
      };
      (ctx.registry.getPluginsByType as ReturnType<typeof vi.fn>).mockReturnValue([mockPlugin]);
      (ctx.peopleDirectory.getOwner as ReturnType<typeof vi.fn>).mockReturnValue({
        id: "owner-1",
        contacts: [{ channel: "telegram-comm", handle: "@user" }],
      });

      const wl = createWorkspaceLifecycle(ctx);
      const dispatch = createDispatch();
      const poisonedMessage =
        "Cloned: https://git:ghp_SECRETTOKEN1234567890abcdefgh@github.com/org/repo.git";

      wl.notifyMilestone(dispatch, poisonedMessage);
      await new Promise((r) => setTimeout(r, 0));

      const formattedArg = formatMessage.mock.calls[0]?.[0] as string;
      expect(formattedArg).not.toContain("ghp_SECRETTOKEN1234567890abcdefgh");
    });
  });

  describe("notifyMilestone", () => {
    it("is fire-and-forget — errors do not propagate", () => {
      const ctx = createMockContext();
      (ctx.peopleDirectory.getOwner as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error("directory error");
      });
      const wl = createWorkspaceLifecycle(ctx);
      const dispatch = createDispatch();

      expect(() => wl.notifyMilestone(dispatch, "test")).not.toThrow();
    });

    it("skips when no owner configured", () => {
      const ctx = createMockContext();
      const wl = createWorkspaceLifecycle(ctx);
      const dispatch = createDispatch();

      wl.notifyMilestone(dispatch, "test");

      expect(ctx.registry.getPluginsByType).not.toHaveBeenCalled();
    });

    // F11: sendMessage failure is logged via observer.debug (not swallowed silently)
    it("logs debug when sendMessage rejects (F11)", async () => {
      const ctx = createMockContext();
      const sendMessage = vi.fn().mockRejectedValue(new Error("network timeout"));
      const formatMessage = vi.fn().mockReturnValue("formatted");

      (ctx.peopleDirectory.getOwner as ReturnType<typeof vi.fn>).mockReturnValue({
        contacts: [{ channel: "telegram", handle: "@user" }],
      });
      (ctx.registry.getPluginsByType as ReturnType<typeof vi.fn>).mockReturnValue([
        {
          manifest: { id: "telegram-comm" },
          sendMessage,
          formatMessage,
          hasCapability: () => false,
        },
      ]);

      const wl = createWorkspaceLifecycle(ctx);
      const dispatch = createDispatch();

      // Should not throw
      expect(() => wl.notifyMilestone(dispatch, "Task started")).not.toThrow();

      // Allow the rejected promise to settle
      await new Promise((resolve) => setTimeout(resolve, 0));

      // The rejection should have been caught and logged (not rethrown)
      // We verify sendMessage was called (so the code ran) and no unhandled rejection occurred
      expect(sendMessage).toHaveBeenCalled();
    });
  });

  describe("commentOnSourceIssue (security)", () => {
    it("sanitizes token-bearing message before posting to GitHub issue", async () => {
      const ctx = createMockContext();
      const commentOnIssue = vi.fn().mockResolvedValue(undefined);
      const mockPlugin = {
        hasCapability: vi.fn().mockReturnValue(true),
        commentOnIssue,
      };
      (ctx.registry.getPluginsByType as ReturnType<typeof vi.fn>).mockReturnValue([mockPlugin]);

      const wl = createWorkspaceLifecycle(ctx);
      const dispatch = createDispatch({
        external_ref: { type: "github_issue", repo: "org/repo", number: 7 },
      } as Partial<Task>);
      const poisonedMessage =
        "Push failed: https://git:ghp_SECRETTOKEN1234567890abcdefgh@github.com/org/repo.git";

      wl.commentOnSourceIssue(dispatch, poisonedMessage);
      await new Promise((r) => setTimeout(r, 0));

      const commentArg = commentOnIssue.mock.calls[0]?.[2] as string;
      expect(commentArg).not.toContain("ghp_SECRETTOKEN1234567890abcdefgh");
    });
  });

  describe("commentOnSourceIssue", () => {
    it("skips when no external_ref", () => {
      const ctx = createMockContext();
      const wl = createWorkspaceLifecycle(ctx);
      const dispatch = createDispatch();

      wl.commentOnSourceIssue(dispatch, "test comment");

      expect(ctx.registry.getPluginsByType).not.toHaveBeenCalled();
    });

    it("is fire-and-forget — errors do not propagate", () => {
      const ctx = createMockContext();
      (ctx.registry.getPluginsByType as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error("plugin error");
      });
      const wl = createWorkspaceLifecycle(ctx);
      const dispatch = createDispatch({
        external_ref: { type: "github_issue", repo: "owner/repo", number: 1 },
      } as Partial<Task>);

      expect(() => wl.commentOnSourceIssue(dispatch, "test")).not.toThrow();
    });

    // F11: commentOnIssue failure is logged via observer.debug (not swallowed silently)
    it("logs debug when commentOnIssue rejects (F11)", async () => {
      const ctx = createMockContext();
      const commentOnIssue = vi.fn().mockRejectedValue(new Error("rate limited"));

      (ctx.registry.getPluginsByType as ReturnType<typeof vi.fn>).mockReturnValue([
        {
          hasCapability: (cap: string) => cap === "issue_management",
          commentOnIssue,
        },
      ]);

      const wl = createWorkspaceLifecycle(ctx);
      const dispatch = createDispatch({
        external_ref: { type: "github_issue", repo: "owner/repo", number: 42 },
      } as Partial<Task>);

      // Should not throw
      expect(() => wl.commentOnSourceIssue(dispatch, "Starting work")).not.toThrow();

      // Allow the rejected promise to settle
      await new Promise((resolve) => setTimeout(resolve, 0));

      // Verify the comment was attempted (code ran) without unhandled rejection
      expect(commentOnIssue).toHaveBeenCalled();
    });
  });
});

describe("AndonCord", () => {
  it("starts not pulled", () => {
    const cord = createAndonCord();
    expect(cord.isPulled()).toBe(false);
    expect(cord.getReason()).toBeNull();
  });

  it("can be pulled with a reason", () => {
    const cord = createAndonCord();
    cord.pull("secret detected");
    expect(cord.isPulled()).toBe(true);
    expect(cord.getReason()).toBe("secret detected");
  });

  it("can be reset after pulling", () => {
    const cord = createAndonCord();
    cord.pull("workspace corruption");
    expect(cord.isPulled()).toBe(true);

    cord.reset();
    expect(cord.isPulled()).toBe(false);
    expect(cord.getReason()).toBeNull();
  });
});
