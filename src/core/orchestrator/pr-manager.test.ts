import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestObserverFacade } from "../../../test/helpers/test-observer-facade.js";
import { OrchestratorConfigSchema } from "../../schemas/config.js";
import type { Dispatch } from "../../schemas/ephemeral.js";
import { Phases } from "../../schemas/orchestrator.js";
import type { PhaseOutput } from "../../schemas/orchestrator.js";
import type { Task } from "../../schemas/task.js";
import type { NotificationRouter } from "../daemon/notification-router.js";
import { composePrBody, createPrManager, formatTriggerReference } from "./pr-manager.js";
import type { OrchestratorContext } from "./types.js";

// Mock child_process — must be before imports that use it
vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

// Mock fs for deliverable file reading
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn().mockReturnValue(""),
    statSync: vi.fn().mockReturnValue({ isDirectory: () => false }),
  };
});

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";

const mockedExecFileSync = vi.mocked(execFileSync);

// ── Helpers ─────────────────────────────────────────────────────────────────

function createMockContext(): OrchestratorContext {
  return {
    config: OrchestratorConfigSchema.parse({}),
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
        taskId: "task-001",
        repo: "owner/repo",
        branch: "engineer/task-001",
        baseBranch: "main",
        worktreePath: "/tmp/worktree",
        baseCommit: "abc123",
        thoughtsDir: "thoughts/2026-03-22-issue-1",
      }),
      pushBranch: vi.fn(),
    } as unknown as OrchestratorContext["workspaceManager"],
    peopleDirectory: {
      getOwner: vi.fn().mockReturnValue(null),
    } as unknown as OrchestratorContext["peopleDirectory"],
    observationStore: null,
    observer: createTestObserverFacade("orchestrator"),
    notifications: { notify: vi.fn(), syncStateToCommPlugin: vi.fn() },
    tracesDir: null,
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

function createMockNotifier(): NotificationRouter {
  return {
    notify: vi.fn(),
    syncStateToCommPlugin: vi.fn(),
  };
}

function makeDemoPrepOutput(data?: Record<string, unknown>): PhaseOutput {
  return {
    phase: Phases.demo_prep,
    task_id: "task-001",
    timestamp: new Date().toISOString(),
    data: data ?? {},
    confidence: "high" as const,
    open_questions: [],
  };
}

/** Mock git so staged changes exist (git diff --cached --quiet throws). */
function mockStagedChanges(): void {
  mockedExecFileSync.mockImplementation((_cmd: unknown, args: unknown) => {
    if (Array.isArray(args) && args[0] === "diff" && args[1] === "--cached") {
      throw new Error("has changes");
    }
    return "";
  });
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("commitAndPush", () => {
  beforeEach(() => {
    mockedExecFileSync.mockReset();
  });

  it("returns nothing_to_push when no workspace path", () => {
    const ctx = createMockContext();
    (ctx.workspaceManager.getWorktreePath as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const pm = createPrManager(ctx, createMockNotifier());

    const result = pm.commitAndPush("session-001", "task-001", createDispatch());

    expect(result).toEqual({ outcome: "nothing_to_push" });
  });

  it("returns nothing_to_push when no workspace record", () => {
    const ctx = createMockContext();
    (ctx.workspaceManager.getWorkspaceRecord as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const pm = createPrManager(ctx, createMockNotifier());

    const result = pm.commitAndPush("session-001", "task-001", createDispatch());

    expect(result).toEqual({ outcome: "nothing_to_push" });
  });

  it("returns error with step and reason when commit fails", () => {
    const ctx = createMockContext();
    mockedExecFileSync.mockImplementation(() => {
      throw new Error("git error");
    });
    const pm = createPrManager(ctx, createMockNotifier());

    const result = pm.commitAndPush("session-001", "task-001", createDispatch());

    expect(result).toEqual({
      outcome: "error",
      step: "commit",
      reason: expect.stringContaining("git error"),
    });
  });

  it("logs journal entry when commit fails", () => {
    const ctx = createMockContext();
    mockedExecFileSync.mockImplementation(() => {
      throw new Error("git error");
    });
    const pm = createPrManager(ctx, createMockNotifier());

    pm.commitAndPush("session-001", "task-001", createDispatch());

    expect(ctx.sessionMemory.addJournalEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: expect.stringContaining("PR workflow failed at commit"),
        tags: ["pr_workflow", "commit"],
      }),
    );
  });

  it("returns nothing_to_push when no commits ahead of base and no staged changes", () => {
    const ctx = createMockContext();
    mockedExecFileSync.mockImplementation((_cmd: unknown, args: unknown) => {
      if (Array.isArray(args) && args[0] === "rev-list") {
        return "0\n";
      }
      return "";
    });
    const pm = createPrManager(ctx, createMockNotifier());

    const result = pm.commitAndPush("session-001", "task-001", createDispatch());

    expect(result).toEqual({ outcome: "nothing_to_push" });
  });

  it("returns pushed with committed=true when staged changes exist", () => {
    const ctx = createMockContext();
    mockStagedChanges();
    const pm = createPrManager(ctx, createMockNotifier());

    const result = pm.commitAndPush("session-001", "task-001", createDispatch());

    expect(result).toEqual({ outcome: "pushed", committed: true });
    expect(ctx.workspaceManager.pushBranch).toHaveBeenCalledWith("task-001");
  });

  it("returns error when push fails", () => {
    const ctx = createMockContext();
    mockStagedChanges();
    (ctx.workspaceManager.pushBranch as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("401 Unauthorized");
    });
    const pm = createPrManager(ctx, createMockNotifier());

    const result = pm.commitAndPush("session-001", "task-001", createDispatch());

    expect(result).toEqual({
      outcome: "error",
      step: "push",
      reason: expect.stringContaining("401 Unauthorized"),
    });
  });

  it("sanitizes task title in commit message", () => {
    const ctx = createMockContext();
    mockStagedChanges();
    const pm = createPrManager(ctx, createMockNotifier());
    const poisonedTitle = "Fix ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA leak";
    const dispatch = createDispatch({ title: poisonedTitle } as unknown as Partial<Task>);

    pm.commitAndPush("session-001", "task-001", dispatch);

    const commitCall = mockedExecFileSync.mock.calls.find(
      (c: unknown[]) => Array.isArray(c[1]) && (c[1] as string[]).includes("-m"),
    );
    expect(commitCall).toBeDefined();
    const commitMsg = (commitCall![1] as string[])[2]!;
    expect(commitMsg).not.toContain("ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    expect(commitMsg).toContain("[REDACTED:token]");
    expect(commitMsg).toContain("Crafted by The Engineer");
  });
});

describe("createPullRequest", () => {
  beforeEach(() => {
    mockedExecFileSync.mockReset();
  });

  // ── Rework Path ─────────────────────────────────────────────────────────

  it("returns rework_pushed and marks feedback as applied on rework path", async () => {
    const ctx = createMockContext();
    const task = {
      id: "task-001",
      review: {
        pr_number: 42,
        feedback_rounds: [{ round: 1, applied: false, comments: [] }],
      },
    };
    (ctx.taskEngine.getTask as ReturnType<typeof vi.fn>).mockReturnValue(task);
    const pm = createPrManager(ctx, createMockNotifier());
    const dispatch = createDispatch({
      review: {
        pr_number: 42,
        pr_state: "ready",
        demo_artifacts: [],
        feedback_rounds: [{ round: 1, applied: false, comments: [] }],
      },
    } as unknown as Partial<Task>);

    const result = await pm.createPullRequest(
      "session-001",
      "task-001",
      makeDemoPrepOutput(),
      dispatch,
    );

    expect(result).toEqual({ outcome: "rework_pushed" });
    expect(ctx.taskEngine.updateTaskField).toHaveBeenCalledWith(
      "task-001",
      "review",
      expect.objectContaining({
        feedback_rounds: [expect.objectContaining({ applied: true })],
      }),
    );
  });

  it("dismisses stale approvals after rework push", async () => {
    const ctx = createMockContext();
    const task = {
      id: "task-001",
      review: {
        pr_number: 42,
        feedback_rounds: [{ round: 1, applied: false, comments: [] }],
      },
    };
    (ctx.taskEngine.getTask as ReturnType<typeof vi.fn>).mockReturnValue(task);
    const fakeHosting = { dismissApprovals: vi.fn().mockResolvedValue(undefined) };
    (ctx.registry.getPrimaryPlugin as ReturnType<typeof vi.fn>).mockReturnValue(fakeHosting);
    const pm = createPrManager(ctx, createMockNotifier());
    const dispatch = createDispatch({
      review: {
        pr_number: 42,
        pr_state: "ready",
        demo_artifacts: [],
        feedback_rounds: [{ round: 1, applied: false, comments: [] }],
      },
    } as unknown as Partial<Task>);

    const result = await pm.createPullRequest(
      "session-001",
      "task-001",
      makeDemoPrepOutput(),
      dispatch,
    );

    expect(result).toEqual({ outcome: "rework_pushed" });
    expect(fakeHosting.dismissApprovals).toHaveBeenCalledWith(
      "owner/repo",
      42,
      expect.stringContaining("Re-review required"),
    );
  });

  it("rework succeeds even if dismissApprovals fails", async () => {
    const ctx = createMockContext();
    const task = {
      id: "task-001",
      review: {
        pr_number: 42,
        feedback_rounds: [{ round: 1, applied: false, comments: [] }],
      },
    };
    (ctx.taskEngine.getTask as ReturnType<typeof vi.fn>).mockReturnValue(task);
    const fakeHosting = {
      dismissApprovals: vi.fn().mockRejectedValue(new Error("403 Forbidden")),
    };
    (ctx.registry.getPrimaryPlugin as ReturnType<typeof vi.fn>).mockReturnValue(fakeHosting);
    const pm = createPrManager(ctx, createMockNotifier());
    const dispatch = createDispatch({
      review: {
        pr_number: 42,
        pr_state: "ready",
        demo_artifacts: [],
        feedback_rounds: [{ round: 1, applied: false, comments: [] }],
      },
    } as unknown as Partial<Task>);

    const result = await pm.createPullRequest(
      "session-001",
      "task-001",
      makeDemoPrepOutput(),
      dispatch,
    );

    expect(result).toEqual({ outcome: "rework_pushed" });
  });

  // ── New PR Path ─────────────────────────────────────────────────────────

  it("returns no_hosting_plugin when git hosting adapter is absent", async () => {
    const ctx = createMockContext();
    const pm = createPrManager(ctx, createMockNotifier());

    const result = await pm.createPullRequest(
      "session-001",
      "task-001",
      makeDemoPrepOutput(),
      createDispatch(),
    );

    expect(result).toEqual({ outcome: "no_hosting_plugin" });
  });

  it("creates PR and returns created with pr_number and url", async () => {
    const ctx = createMockContext();
    const fakeGitHosting = {
      createPR: vi.fn().mockResolvedValue({ pr_number: 99, url: "https://github.com/pr/99" }),
    };
    (ctx.registry.getPrimaryPlugin as ReturnType<typeof vi.fn>).mockImplementation(
      (type: string) => (type === "git_hosting" ? fakeGitHosting : null),
    );
    const pm = createPrManager(ctx, createMockNotifier());

    const result = await pm.createPullRequest(
      "session-001",
      "task-001",
      makeDemoPrepOutput({ pr_description: "Clean description" }),
      createDispatch(),
    );

    expect(result).toEqual({ outcome: "created", pr_number: 99, url: "https://github.com/pr/99" });
    expect(ctx.taskEngine.updateTaskField).toHaveBeenCalledWith(
      "task-001",
      "review",
      expect.objectContaining({ pr_number: 99, pr_state: "ready" }),
    );
  });

  it("returns error when PR creation fails", async () => {
    const ctx = createMockContext();
    const fakeGitHosting = {
      createPR: vi.fn().mockRejectedValue(new Error("401 Unauthorized")),
    };
    (ctx.registry.getPrimaryPlugin as ReturnType<typeof vi.fn>).mockImplementation(
      (type: string) => (type === "git_hosting" ? fakeGitHosting : null),
    );
    const pm = createPrManager(ctx, createMockNotifier());

    const result = await pm.createPullRequest(
      "session-001",
      "task-001",
      makeDemoPrepOutput({ pr_description: "Some PR" }),
      createDispatch(),
    );

    expect(result).toEqual({
      outcome: "error",
      step: "pr_creation",
      reason: expect.stringContaining("401 Unauthorized"),
    });
  });

  it("sanitizes PR title before sending to API", async () => {
    const ctx = createMockContext();
    const fakeGitHosting = {
      createPR: vi.fn().mockResolvedValue({ pr_number: 99, url: "https://github.com/pr/99" }),
    };
    (ctx.registry.getPrimaryPlugin as ReturnType<typeof vi.fn>).mockImplementation(
      (type: string) => (type === "git_hosting" ? fakeGitHosting : null),
    );
    const pm = createPrManager(ctx, createMockNotifier());
    const poisonedTitle = "Fix ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA leak";
    const dispatch = createDispatch({ title: poisonedTitle } as unknown as Partial<Task>);

    await pm.createPullRequest(
      "session-001",
      "task-001",
      makeDemoPrepOutput({ pr_description: "Clean" }),
      dispatch,
    );

    expect(fakeGitHosting.createPR).toHaveBeenCalledWith(
      expect.objectContaining({
        title: expect.not.stringContaining("ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
      }),
    );
  });

  it("sanitizes PR description before creating PR", async () => {
    const ctx = createMockContext();
    const fakeGitHosting = {
      createPR: vi.fn().mockResolvedValue({ pr_number: 99, url: "https://github.com/pr/99" }),
    };
    (ctx.registry.getPrimaryPlugin as ReturnType<typeof vi.fn>).mockImplementation(
      (type: string) => (type === "git_hosting" ? fakeGitHosting : null),
    );
    const pm = createPrManager(ctx, createMockNotifier());

    await pm.createPullRequest(
      "session-001",
      "task-001",
      makeDemoPrepOutput({ pr_description: "PR with token ghp_secret123abc in description" }),
      createDispatch(),
    );

    if (fakeGitHosting.createPR.mock.calls.length > 0) {
      const prArgs = fakeGitHosting.createPR.mock.calls[0]![0];
      expect(prArgs.body).toBeDefined();
    }
  });

  it("reads PR description from deliverable file when not in PhaseOutput.data", async () => {
    const ctx = createMockContext();
    const fakeGitHosting = {
      createPR: vi.fn().mockResolvedValue({ pr_number: 42, url: "https://github.com/pr/42" }),
    };
    (ctx.registry.getPrimaryPlugin as ReturnType<typeof vi.fn>).mockImplementation(
      (type: string) => (type === "git_hosting" ? fakeGitHosting : null),
    );
    vi.mocked(existsSync).mockImplementation((p: unknown) =>
      String(p).endsWith("pr-description.md"),
    );
    vi.mocked(readFileSync).mockImplementation((p: unknown) => {
      if (String(p).endsWith("pr-description.md")) {
        return "# PR from file\n\nDescription read from deliverable file." as any;
      }
      return "" as any;
    });
    const pm = createPrManager(ctx, createMockNotifier());

    await pm.createPullRequest(
      "session-001",
      "task-001",
      makeDemoPrepOutput({
        deliverable_path: "thoughts/2026-03-22-issue-1/demo-prep/pr-description.md",
      }),
      createDispatch(),
    );

    expect(fakeGitHosting.createPR).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining("Description read from deliverable file"),
      }),
    );
    const prArgs = fakeGitHosting.createPR.mock.calls[0]![0];
    expect(prArgs.body).toContain("Crafted by The Engineer");
  });

  it("resolves pr-description.md when deliverable_path is a directory", async () => {
    const ctx = createMockContext();
    const fakeGitHosting = {
      createPR: vi.fn().mockResolvedValue({ pr_number: 43, url: "https://github.com/pr/43" }),
    };
    (ctx.registry.getPrimaryPlugin as ReturnType<typeof vi.fn>).mockImplementation(
      (type: string) => (type === "git_hosting" ? fakeGitHosting : null),
    );
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(statSync).mockImplementation((p: unknown) => {
      const s = String(p);
      return { isDirectory: () => !s.endsWith(".md") } as ReturnType<typeof statSync>;
    });
    vi.mocked(readFileSync).mockImplementation((p: unknown) => {
      if (String(p).endsWith("pr-description.md")) {
        return "# PR from directory fallback" as any;
      }
      return "" as any;
    });
    const pm = createPrManager(ctx, createMockNotifier());

    await pm.createPullRequest(
      "session-001",
      "task-001",
      makeDemoPrepOutput({ deliverable_path: "thoughts/2026-03-22-issue-1/demo-prep" }),
      createDispatch(),
    );

    expect(fakeGitHosting.createPR).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining("PR from directory fallback"),
      }),
    );
    const prArgs = fakeGitHosting.createPR.mock.calls[0]![0];
    expect(prArgs.body).toContain("Crafted by The Engineer");
  });

  it("includes trigger reference when external_ref has URL", async () => {
    const ctx = createMockContext();
    const fakeGitHosting = {
      createPR: vi.fn().mockResolvedValue({ pr_number: 55, url: "https://github.com/pr/55" }),
    };
    (ctx.registry.getPrimaryPlugin as ReturnType<typeof vi.fn>).mockImplementation(
      (type: string) => (type === "git_hosting" ? fakeGitHosting : null),
    );
    const pm = createPrManager(ctx, createMockNotifier());
    const dispatch = createDispatch({
      external_ref: {
        type: "github_issue",
        repo: "owner/repo",
        id: "42",
        url: "https://github.com/owner/repo/issues/42",
      },
    } as unknown as Partial<Task>);

    await pm.createPullRequest(
      "session-001",
      "task-001",
      makeDemoPrepOutput({ pr_description: "Added feature X" }),
      dispatch,
    );

    const prArgs = fakeGitHosting.createPR.mock.calls[0]![0];
    expect(prArgs.body).toContain(
      "> Triggered by [owner/repo#42](https://github.com/owner/repo/issues/42)",
    );
    expect(prArgs.body).toContain("Added feature X");
    expect(prArgs.body).toContain("Crafted by The Engineer");
  });

  // ── PR Title Decorations ──────────────────────────────────────────────

  it("applies title_prefix from pr_decorations", async () => {
    const ctx = createMockContext();
    const fakeGitHosting = {
      createPR: vi.fn().mockResolvedValue({ pr_number: 60, url: "https://github.com/pr/60" }),
    };
    (ctx.registry.getPrimaryPlugin as ReturnType<typeof vi.fn>).mockImplementation(
      (type: string) => (type === "git_hosting" ? fakeGitHosting : null),
    );
    const pm = createPrManager(ctx, createMockNotifier());
    const dispatch = createDispatch({
      title: "Fix authentication bug",
      external_ref: {
        type: "github_issue",
        repo: "owner/repo",
        id: "42",
        url: "https://github.com/owner/repo/issues/42",
        pr_decorations: { title_prefix: "#42:" },
      },
    } as unknown as Partial<Task>);

    await pm.createPullRequest(
      "session-001",
      "task-001",
      makeDemoPrepOutput({ pr_description: "Added feature X" }),
      dispatch,
    );

    expect(fakeGitHosting.createPR).toHaveBeenCalledWith(
      expect.objectContaining({ title: "#42: Fix authentication bug" }),
    );
  });

  it("applies title_suffix from pr_decorations", async () => {
    const ctx = createMockContext();
    const fakeGitHosting = {
      createPR: vi.fn().mockResolvedValue({ pr_number: 63, url: "https://github.com/pr/63" }),
    };
    (ctx.registry.getPrimaryPlugin as ReturnType<typeof vi.fn>).mockImplementation(
      (type: string) => (type === "git_hosting" ? fakeGitHosting : null),
    );
    const pm = createPrManager(ctx, createMockNotifier());
    const dispatch = createDispatch({
      title: "Fix bug",
      external_ref: {
        type: "github_issue",
        repo: "owner/repo",
        id: "42",
        pr_decorations: { title_suffix: "[urgent]" },
      },
    } as unknown as Partial<Task>);

    await pm.createPullRequest(
      "session-001",
      "task-001",
      makeDemoPrepOutput({ pr_description: "Added feature X" }),
      dispatch,
    );

    expect(fakeGitHosting.createPR).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Fix bug [urgent]" }),
    );
  });

  it("applies both title_prefix and title_suffix", async () => {
    const ctx = createMockContext();
    const fakeGitHosting = {
      createPR: vi.fn().mockResolvedValue({ pr_number: 64, url: "https://github.com/pr/64" }),
    };
    (ctx.registry.getPrimaryPlugin as ReturnType<typeof vi.fn>).mockImplementation(
      (type: string) => (type === "git_hosting" ? fakeGitHosting : null),
    );
    const pm = createPrManager(ctx, createMockNotifier());
    const dispatch = createDispatch({
      title: "Fix bug",
      external_ref: {
        type: "github_issue",
        repo: "owner/repo",
        id: "42",
        pr_decorations: { title_prefix: "#42:", title_suffix: "[urgent]" },
      },
    } as unknown as Partial<Task>);

    await pm.createPullRequest(
      "session-001",
      "task-001",
      makeDemoPrepOutput({ pr_description: "Added feature X" }),
      dispatch,
    );

    expect(fakeGitHosting.createPR).toHaveBeenCalledWith(
      expect.objectContaining({ title: "#42: Fix bug [urgent]" }),
    );
  });

  it("does not decorate PR title when pr_decorations is absent", async () => {
    const ctx = createMockContext();
    const fakeGitHosting = {
      createPR: vi.fn().mockResolvedValue({ pr_number: 61, url: "https://github.com/pr/61" }),
    };
    (ctx.registry.getPrimaryPlugin as ReturnType<typeof vi.fn>).mockImplementation(
      (type: string) => (type === "git_hosting" ? fakeGitHosting : null),
    );
    const pm = createPrManager(ctx, createMockNotifier());
    const dispatch = createDispatch({
      title: "Fix authentication bug",
      external_ref: { type: "github_issue", repo: "owner/repo", id: "42" },
    } as unknown as Partial<Task>);

    await pm.createPullRequest(
      "session-001",
      "task-001",
      makeDemoPrepOutput({ pr_description: "Clean" }),
      dispatch,
    );

    expect(fakeGitHosting.createPR).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Fix authentication bug" }),
    );
  });

  it("does not decorate PR title when external_ref is null", async () => {
    const ctx = createMockContext();
    const fakeGitHosting = {
      createPR: vi.fn().mockResolvedValue({ pr_number: 62, url: "https://github.com/pr/62" }),
    };
    (ctx.registry.getPrimaryPlugin as ReturnType<typeof vi.fn>).mockImplementation(
      (type: string) => (type === "git_hosting" ? fakeGitHosting : null),
    );
    const pm = createPrManager(ctx, createMockNotifier());

    await pm.createPullRequest(
      "session-001",
      "task-001",
      makeDemoPrepOutput({ pr_description: "Clean" }),
      createDispatch(),
    );

    expect(fakeGitHosting.createPR).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Test task" }),
    );
  });
});

// ── Helper Function Tests ──────────────────────────────────────────────────

describe("formatTriggerReference", () => {
  it("returns markdown link when URL is available", () => {
    const result = formatTriggerReference({
      external_ref: {
        type: "github_issue",
        repo: "owner/repo",
        id: "42",
        url: "https://github.com/owner/repo/issues/42",
      },
    });
    expect(result).toBe("> Triggered by [owner/repo#42](https://github.com/owner/repo/issues/42)");
  });

  it("returns plain text when no URL", () => {
    const result = formatTriggerReference({
      external_ref: { type: "gitlab_issue", repo: "group/project", id: "7" },
    });
    expect(result).toBe("> Triggered by group/project#7");
  });

  it("returns null when no external_ref", () => {
    expect(formatTriggerReference({})).toBeNull();
    expect(formatTriggerReference({ external_ref: null })).toBeNull();
  });
});

describe("composePrBody", () => {
  it("includes trigger reference, description, and branding", () => {
    const result = composePrBody("Feature description", {
      external_ref: {
        type: "github_issue",
        repo: "owner/repo",
        id: "1",
        url: "https://github.com/owner/repo/issues/1",
      },
    });
    expect(result).toContain("> Triggered by [owner/repo#1]");
    expect(result).toContain("Feature description");
    expect(result).toContain("Crafted by The Engineer");
  });

  it("omits trigger reference when no external_ref", () => {
    const result = composePrBody("Just a fix", {});
    expect(result).not.toContain("Triggered by");
    expect(result).toContain("Just a fix");
    expect(result).toContain("Crafted by The Engineer");
  });

  it("includes description_prefix and description_suffix from decorations", () => {
    const result = composePrBody("Feature X", {
      external_ref: {
        type: "github_issue",
        repo: "o/r",
        id: "1",
        pr_decorations: {
          description_prefix: "<!-- prefix -->",
          description_suffix: "<!-- suffix -->",
        },
      },
    });
    expect(result).toContain("<!-- prefix -->");
    expect(result).toContain("Feature X");
    expect(result).toContain("<!-- suffix -->");
  });
});
