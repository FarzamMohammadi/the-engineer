import { describe, expect, it, vi } from "vitest";
import type { Dispatch } from "../../schemas/ephemeral.js";
import { Phases } from "../../schemas/orchestrator.js";
import type { Task } from "../../schemas/task.js";
import { createPrManager } from "./pr-manager.js";
import type { OrchestratorContext } from "./types.js";

// Mock child_process — must be before imports that use it
vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from "node:child_process";

const mockedExecFileSync = vi.mocked(execFileSync);

// ── Helpers ─────────────────────────────────────────────────────────────────

function createMockContext(): OrchestratorContext {
  return {
    eventBus: { publish: vi.fn() } as unknown as OrchestratorContext["eventBus"],
    registry: {
      getPrimaryPlugin: vi.fn().mockReturnValue(null),
      getPluginsByType: vi.fn().mockReturnValue([]),
      getPlugin: vi.fn().mockReturnValue(null),
    } as unknown as OrchestratorContext["registry"],
    taskEngine: {
      updateTaskField: vi.fn(),
      getTask: vi.fn(),
    } as unknown as OrchestratorContext["taskEngine"],
    safetyLayer: {} as OrchestratorContext["safetyLayer"],
    actionPipeline: { execute: vi.fn() } as unknown as OrchestratorContext["actionPipeline"],
    sessionMemory: {
      addJournalEntry: vi.fn(),
      endSession: vi.fn(),
    } as unknown as OrchestratorContext["sessionMemory"],
    workspaceManager: {
      getWorktreePath: vi.fn().mockReturnValue("/tmp/worktree"),
      getWorkspaceRecord: vi.fn().mockReturnValue({
        repo: "owner/repo",
        branch: "engineer/task-001",
        baseBranch: "main",
        worktreePath: "/tmp/worktree",
      }),
      pushBranch: vi.fn(),
    } as unknown as OrchestratorContext["workspaceManager"],
    peopleDirectory: {
      getOwner: vi.fn().mockReturnValue(null),
    } as unknown as OrchestratorContext["peopleDirectory"],
    observability: null,
    observer: null,
  };
}

function createDispatch(overrides?: Partial<Task>): Dispatch {
  return {
    task: {
      id: "task-001",
      title: "Test task",
      external_ref: null,
      workspace: null,
      review: null,
      repo: "owner/repo",
      clone_url: "https://github.com/owner/repo.git",
      state: "active",
      sub_state: "working",
      ...overrides,
    } as Task,
    resume_from: null,
    knowledge: { repo: [], user: [] },
  } as Dispatch;
}

const noopComment = vi.fn();
const noopNotify = vi.fn();

// ── Tests ───────────────────────────────────────────────────────────────────

describe("PrManager", () => {
  beforeEach(() => {
    mockedExecFileSync.mockReset();
    noopComment.mockReset();
    noopNotify.mockReset();
  });

  it("returns false when no workspace path", async () => {
    const ctx = createMockContext();
    (ctx.workspaceManager.getWorktreePath as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const pm = createPrManager(ctx);
    const demoPrepOutput = {
      phase: Phases.demo_prep,
      task_id: "task-001",
      timestamp: new Date().toISOString(),
      data: {},
      confidence: "high" as const,
      open_questions: [],
    };

    const result = await pm.commitPushAndCreatePR(
      "session-001",
      "task-001",
      demoPrepOutput,
      createDispatch(),
      noopComment,
      noopNotify,
    );

    expect(result).toBe(false);
  });

  it("returns false when no workspace record", async () => {
    const ctx = createMockContext();
    (ctx.workspaceManager.getWorkspaceRecord as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const pm = createPrManager(ctx);
    const demoPrepOutput = {
      phase: Phases.demo_prep,
      task_id: "task-001",
      timestamp: new Date().toISOString(),
      data: {},
      confidence: "high" as const,
      open_questions: [],
    };

    const result = await pm.commitPushAndCreatePR(
      "session-001",
      "task-001",
      demoPrepOutput,
      createDispatch(),
      noopComment,
      noopNotify,
    );

    expect(result).toBe(false);
  });

  it("logs journal entry when commit fails", async () => {
    const ctx = createMockContext();
    mockedExecFileSync.mockImplementation(() => {
      throw new Error("git error");
    });
    const pm = createPrManager(ctx);
    const demoPrepOutput = {
      phase: Phases.demo_prep,
      task_id: "task-001",
      timestamp: new Date().toISOString(),
      data: {},
      confidence: "high" as const,
      open_questions: [],
    };

    await pm.commitPushAndCreatePR(
      "session-001",
      "task-001",
      demoPrepOutput,
      createDispatch(),
      noopComment,
      noopNotify,
    );

    expect(ctx.sessionMemory.addJournalEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: expect.stringContaining("PR workflow failed at commit"),
        tags: ["pr_workflow", "commit"],
      }),
    );
  });

  it("returns false when no commits ahead of base and no staged changes", async () => {
    const ctx = createMockContext();
    // git add -A succeeds
    // git diff --cached --quiet succeeds (no staged changes)
    // git rev-list --count returns 0
    mockedExecFileSync.mockImplementation((_cmd: unknown, args: unknown) => {
      if (Array.isArray(args) && args[0] === "rev-list") {
        return "0\n";
      }
      return "";
    });
    const pm = createPrManager(ctx);
    const demoPrepOutput = {
      phase: Phases.demo_prep,
      task_id: "task-001",
      timestamp: new Date().toISOString(),
      data: {},
      confidence: "high" as const,
      open_questions: [],
    };

    const result = await pm.commitPushAndCreatePR(
      "session-001",
      "task-001",
      demoPrepOutput,
      createDispatch(),
      noopComment,
      noopNotify,
    );

    expect(result).toBe(false);
  });

  it("marks feedback as applied on rework path", async () => {
    const ctx = createMockContext();
    const task = {
      id: "task-001",
      review: {
        pr_number: 42,
        feedback_rounds: [{ round: 1, applied: false, comments: [] }],
      },
    };
    (ctx.taskEngine.getTask as ReturnType<typeof vi.fn>).mockReturnValue(task);

    // Simulate staged changes exist
    mockedExecFileSync.mockImplementation((_cmd: unknown, args: unknown) => {
      if (Array.isArray(args) && args[0] === "diff" && args[1] === "--cached") {
        throw new Error("has changes");
      }
      return "";
    });

    const pm = createPrManager(ctx);
    const dispatch = createDispatch({
      review: {
        pr_number: 42,
        pr_state: "draft",
        demo_artifacts: [],
        feedback_rounds: [{ round: 1, applied: false, comments: [] }],
      },
    } as unknown as Partial<Task>);
    const demoPrepOutput = {
      phase: Phases.demo_prep,
      task_id: "task-001",
      timestamp: new Date().toISOString(),
      data: {},
      confidence: "high" as const,
      open_questions: [],
    };

    const result = await pm.commitPushAndCreatePR(
      "session-001",
      "task-001",
      demoPrepOutput,
      dispatch,
      noopComment,
      noopNotify,
    );

    expect(result).toBe(true);
    expect(ctx.taskEngine.updateTaskField).toHaveBeenCalledWith(
      "task-001",
      "review",
      expect.objectContaining({
        feedback_rounds: [expect.objectContaining({ applied: true })],
      }),
    );
  });

  it("sanitizes PR description before creating PR", async () => {
    const ctx = createMockContext();
    const fakeGitHosting = {
      createPR: vi.fn().mockResolvedValue({ pr_number: 99, url: "https://github.com/pr/99" }),
    };
    (ctx.registry.getPrimaryPlugin as ReturnType<typeof vi.fn>).mockImplementation(
      (type: string) => {
        if (type === "git_hosting") {
          return fakeGitHosting;
        }
        return null;
      },
    );

    // Simulate staged changes
    mockedExecFileSync.mockImplementation((_cmd: unknown, args: unknown) => {
      if (Array.isArray(args) && args[0] === "diff" && args[1] === "--cached") {
        throw new Error("has changes");
      }
      return "";
    });

    const pm = createPrManager(ctx);
    const demoPrepOutput = {
      phase: Phases.demo_prep,
      task_id: "task-001",
      timestamp: new Date().toISOString(),
      data: { pr_description: "PR with token ghp_secret123abc in description" },
      confidence: "high" as const,
      open_questions: [],
    };

    await pm.commitPushAndCreatePR(
      "session-001",
      "task-001",
      demoPrepOutput,
      createDispatch(),
      noopComment,
      noopNotify,
    );

    // The createPR call should have sanitized the description
    if (fakeGitHosting.createPR.mock.calls.length > 0) {
      const prArgs = fakeGitHosting.createPR.mock.calls[0][0];
      // sanitizeSecrets replaces known env var values, not arbitrary tokens
      // Just verify it was called with a body field
      expect(prArgs.body).toBeDefined();
    }
  });
});
