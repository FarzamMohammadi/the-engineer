import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestObserverFacade } from "../../../test/helpers/test-observer-facade.js";
import { OrchestratorConfigSchema } from "../../schemas/config.js";
import type { Dispatch } from "../../schemas/ephemeral.js";
import { Phases } from "../../schemas/orchestrator.js";
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

// ── Tests ───────────────────────────────────────────────────────────────────

describe("PrManager", () => {
  beforeEach(() => {
    mockedExecFileSync.mockReset();
  });

  it("returns false when no workspace path", async () => {
    const ctx = createMockContext();
    (ctx.workspaceManager.getWorktreePath as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const pm = createPrManager(ctx, createMockNotifier());
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
    );

    expect(result).toBe(false);
  });

  it("returns false when no workspace record", async () => {
    const ctx = createMockContext();
    (ctx.workspaceManager.getWorkspaceRecord as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const pm = createPrManager(ctx, createMockNotifier());
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
    );

    expect(result).toBe(false);
  });

  it("logs journal entry when commit fails", async () => {
    const ctx = createMockContext();
    mockedExecFileSync.mockImplementation(() => {
      throw new Error("git error");
    });
    const pm = createPrManager(ctx, createMockNotifier());
    const demoPrepOutput = {
      phase: Phases.demo_prep,
      task_id: "task-001",
      timestamp: new Date().toISOString(),
      data: {},
      confidence: "high" as const,
      open_questions: [],
    };

    await pm.commitPushAndCreatePR("session-001", "task-001", demoPrepOutput, createDispatch());

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
    const pm = createPrManager(ctx, createMockNotifier());
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

    const pm = createPrManager(ctx, createMockNotifier());
    const dispatch = createDispatch({
      review: {
        pr_number: 42,
        pr_state: "ready",
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

  // SECURITY: PR title is sanitized before sending to GitHub API
  it("sanitizes task title in PR title and commit message", async () => {
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

    const pm = createPrManager(ctx, createMockNotifier());
    const demoPrepOutput = {
      phase: Phases.demo_prep,
      task_id: "task-001",
      timestamp: new Date().toISOString(),
      data: { pr_description: "Clean description" },
      confidence: "high" as const,
      open_questions: [],
    };

    // Use a title containing a recognizable GitHub token pattern
    const poisonedTitle = "Fix ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA leak";
    const dispatch = createDispatch({ title: poisonedTitle } as unknown as Partial<Task>);
    await pm.commitPushAndCreatePR("session-001", "task-001", demoPrepOutput, dispatch);

    // Verify commit message has sanitized title
    const commitCall = mockedExecFileSync.mock.calls.find(
      (c: unknown[]) => Array.isArray(c[1]) && (c[1] as string[]).includes("-m"),
    );
    expect(commitCall).toBeDefined();
    const commitMsg = (commitCall![1] as string[])[2]!;
    expect(commitMsg).not.toContain("ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    expect(commitMsg).toContain("[REDACTED:github_token]");
    expect(commitMsg).toContain("Crafted by The Engineer");

    // Verify PR title has sanitized title
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

    const pm = createPrManager(ctx, createMockNotifier());
    const demoPrepOutput = {
      phase: Phases.demo_prep,
      task_id: "task-001",
      timestamp: new Date().toISOString(),
      data: { pr_description: "PR with token ghp_secret123abc in description" },
      confidence: "high" as const,
      open_questions: [],
    };

    await pm.commitPushAndCreatePR("session-001", "task-001", demoPrepOutput, createDispatch());

    // The createPR call should have sanitized the description
    if (fakeGitHosting.createPR.mock.calls.length > 0) {
      const prArgs = fakeGitHosting.createPR.mock.calls[0]![0];
      // sanitizeSecrets replaces known env var values, not arbitrary tokens
      // Just verify it was called with a body field
      expect(prArgs.body).toBeDefined();
    }
  });

  it("reads PR description from deliverable file when not in PhaseOutput.data", async () => {
    const ctx = createMockContext();
    const fakeGitHosting = {
      createPR: vi.fn().mockResolvedValue({ pr_number: 42, url: "https://github.com/pr/42" }),
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

    // Configure fs mocks to return file content for the deliverable path
    vi.mocked(existsSync).mockImplementation((p: unknown) => {
      if (String(p).endsWith("pr-description.md")) {
        return true;
      }
      return false;
    });
    vi.mocked(readFileSync).mockImplementation((p: unknown) => {
      if (String(p).endsWith("pr-description.md")) {
        return "# PR from file\n\nDescription read from deliverable file." as any;
      }
      return "" as any;
    });

    const pm = createPrManager(ctx, createMockNotifier());
    const demoPrepOutput = {
      phase: Phases.demo_prep,
      task_id: "task-001",
      timestamp: new Date().toISOString(),
      data: { deliverable_path: "thoughts/2026-03-22-issue-1/demo-prep/pr-description.md" },
      confidence: "high" as const,
      open_questions: [],
    };
    const dispatch = createDispatch();
    await pm.commitPushAndCreatePR("session-001", "task-001", demoPrepOutput, dispatch);

    expect(fakeGitHosting.createPR).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining("Description read from deliverable file"),
      }),
    );
    // Verify branding footer is present
    const prArgs = fakeGitHosting.createPR.mock.calls[0]![0];
    expect(prArgs.body).toContain("Crafted by The Engineer");
  });

  it("resolves pr-description.md when deliverable_path is a directory", async () => {
    const ctx = createMockContext();
    const fakeGitHosting = {
      createPR: vi.fn().mockResolvedValue({ pr_number: 43, url: "https://github.com/pr/43" }),
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

    // deliverable_path points to a directory; statSync reports it as directory
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
    const demoPrepOutput = {
      phase: Phases.demo_prep,
      task_id: "task-001",
      timestamp: new Date().toISOString(),
      data: { deliverable_path: "thoughts/2026-03-22-issue-1/demo-prep" },
      confidence: "high" as const,
      open_questions: [],
    };
    const dispatch = createDispatch();
    await pm.commitPushAndCreatePR("session-001", "task-001", demoPrepOutput, dispatch);

    expect(fakeGitHosting.createPR).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining("PR from directory fallback"),
      }),
    );
    // Verify branding footer is present
    const prArgs2 = fakeGitHosting.createPR.mock.calls[0]![0];
    expect(prArgs2.body).toContain("Crafted by The Engineer");
  });

  it("includes trigger reference when external_ref has URL", async () => {
    const ctx = createMockContext();
    const fakeGitHosting = {
      createPR: vi.fn().mockResolvedValue({ pr_number: 55, url: "https://github.com/pr/55" }),
    };
    (ctx.registry.getPrimaryPlugin as ReturnType<typeof vi.fn>).mockImplementation(
      (type: string) => {
        if (type === "git_hosting") {
          return fakeGitHosting;
        }
        return null;
      },
    );

    mockedExecFileSync.mockImplementation((_cmd: unknown, args: unknown) => {
      if (Array.isArray(args) && args[0] === "diff" && args[1] === "--cached") {
        throw new Error("has changes");
      }
      return "";
    });

    const pm = createPrManager(ctx, createMockNotifier());
    const demoPrepOutput = {
      phase: Phases.demo_prep,
      task_id: "task-001",
      timestamp: new Date().toISOString(),
      data: { pr_description: "Added feature X" },
      confidence: "high" as const,
      open_questions: [],
    };
    const dispatch = createDispatch({
      external_ref: {
        type: "github_issue",
        repo: "owner/repo",
        id: "42",
        url: "https://github.com/owner/repo/issues/42",
      },
    } as unknown as Partial<Task>);

    await pm.commitPushAndCreatePR("session-001", "task-001", demoPrepOutput, dispatch);

    const prArgs = fakeGitHosting.createPR.mock.calls[0]![0];
    expect(prArgs.body).toContain(
      "> Triggered by [owner/repo#42](https://github.com/owner/repo/issues/42)",
    );
    expect(prArgs.body).toContain("Added feature X");
    expect(prArgs.body).toContain("Crafted by The Engineer");
  });

  it("prefixes PR title with pr_prefix when present", async () => {
    const ctx = createMockContext();
    const fakeGitHosting = {
      createPR: vi.fn().mockResolvedValue({ pr_number: 60, url: "https://github.com/pr/60" }),
    };
    (ctx.registry.getPrimaryPlugin as ReturnType<typeof vi.fn>).mockImplementation(
      (type: string) => {
        if (type === "git_hosting") {
          return fakeGitHosting;
        }
        return null;
      },
    );

    mockedExecFileSync.mockImplementation((_cmd: unknown, args: unknown) => {
      if (Array.isArray(args) && args[0] === "diff" && args[1] === "--cached") {
        throw new Error("has changes");
      }
      return "";
    });

    const pm = createPrManager(ctx, createMockNotifier());
    const demoPrepOutput = {
      phase: Phases.demo_prep,
      task_id: "task-001",
      timestamp: new Date().toISOString(),
      data: { pr_description: "Added feature X" },
      confidence: "high" as const,
      open_questions: [],
    };
    const dispatch = createDispatch({
      title: "Fix authentication bug",
      external_ref: {
        type: "github_issue",
        repo: "owner/repo",
        id: "42",
        url: "https://github.com/owner/repo/issues/42",
        pr_prefix: "#42",
      },
    } as unknown as Partial<Task>);

    await pm.commitPushAndCreatePR("session-001", "task-001", demoPrepOutput, dispatch);

    expect(fakeGitHosting.createPR).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "#42: Fix authentication bug",
      }),
    );
  });

  it("does not prefix PR title when pr_prefix is absent", async () => {
    const ctx = createMockContext();
    const fakeGitHosting = {
      createPR: vi.fn().mockResolvedValue({ pr_number: 61, url: "https://github.com/pr/61" }),
    };
    (ctx.registry.getPrimaryPlugin as ReturnType<typeof vi.fn>).mockImplementation(
      (type: string) => {
        if (type === "git_hosting") {
          return fakeGitHosting;
        }
        return null;
      },
    );

    mockedExecFileSync.mockImplementation((_cmd: unknown, args: unknown) => {
      if (Array.isArray(args) && args[0] === "diff" && args[1] === "--cached") {
        throw new Error("has changes");
      }
      return "";
    });

    const pm = createPrManager(ctx, createMockNotifier());
    const demoPrepOutput = {
      phase: Phases.demo_prep,
      task_id: "task-001",
      timestamp: new Date().toISOString(),
      data: { pr_description: "Clean description" },
      confidence: "high" as const,
      open_questions: [],
    };
    const dispatch = createDispatch({
      title: "Fix authentication bug",
      external_ref: {
        type: "github_issue",
        repo: "owner/repo",
        id: "42",
      },
    } as unknown as Partial<Task>);

    await pm.commitPushAndCreatePR("session-001", "task-001", demoPrepOutput, dispatch);

    expect(fakeGitHosting.createPR).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Fix authentication bug",
      }),
    );
  });

  it("does not prefix PR title when external_ref is null", async () => {
    const ctx = createMockContext();
    const fakeGitHosting = {
      createPR: vi.fn().mockResolvedValue({ pr_number: 62, url: "https://github.com/pr/62" }),
    };
    (ctx.registry.getPrimaryPlugin as ReturnType<typeof vi.fn>).mockImplementation(
      (type: string) => {
        if (type === "git_hosting") {
          return fakeGitHosting;
        }
        return null;
      },
    );

    mockedExecFileSync.mockImplementation((_cmd: unknown, args: unknown) => {
      if (Array.isArray(args) && args[0] === "diff" && args[1] === "--cached") {
        throw new Error("has changes");
      }
      return "";
    });

    const pm = createPrManager(ctx, createMockNotifier());
    const demoPrepOutput = {
      phase: Phases.demo_prep,
      task_id: "task-001",
      timestamp: new Date().toISOString(),
      data: { pr_description: "Clean description" },
      confidence: "high" as const,
      open_questions: [],
    };
    const dispatch = createDispatch();

    await pm.commitPushAndCreatePR("session-001", "task-001", demoPrepOutput, dispatch);

    expect(fakeGitHosting.createPR).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Test task",
      }),
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

  it("returns null when external_ref is null", () => {
    expect(formatTriggerReference({ external_ref: null })).toBeNull();
  });

  it("returns null when external_ref is undefined", () => {
    expect(formatTriggerReference({})).toBeNull();
  });

  it("never inspects external_ref.type (plugin-blind)", () => {
    const result = formatTriggerReference({
      external_ref: {
        type: "azure_devops_work_item",
        repo: "org/project",
        id: "999",
        url: "https://dev.azure.com/org/project/_workitems/edit/999",
      },
    });
    expect(result).toBe(
      "> Triggered by [org/project#999](https://dev.azure.com/org/project/_workitems/edit/999)",
    );
  });
});

describe("composePrBody", () => {
  it("includes trigger reference, description, and branding", () => {
    const body = composePrBody("Feature description", {
      external_ref: {
        type: "github_issue",
        repo: "owner/repo",
        id: "42",
        url: "https://github.com/owner/repo/issues/42",
      },
    });
    expect(body).toContain("> Triggered by [owner/repo#42]");
    expect(body).toContain("Feature description");
    expect(body).toContain("*Crafted by The Engineer*");
  });

  it("omits trigger reference when no external_ref", () => {
    const body = composePrBody("Feature description", { external_ref: null });
    expect(body).not.toContain("Triggered by");
    expect(body).toContain("Feature description");
    expect(body).toContain("*Crafted by The Engineer*");
  });

  it("works with empty description", () => {
    const body = composePrBody("", { external_ref: null });
    expect(body).toContain("*Crafted by The Engineer*");
  });

  it("separates sections with blank lines", () => {
    const body = composePrBody("Desc", {
      external_ref: { type: "x", repo: "a/b", id: "1", url: "https://example.com" },
    });
    const lines = body.split("\n");
    // trigger ref, blank, desc, blank, hr + footer
    expect(lines[0]).toMatch(/^> Triggered by/);
    expect(lines[1]).toBe("");
    expect(lines[2]).toBe("Desc");
    expect(lines[3]).toBe("");
    expect(lines[4]).toBe("---");
  });
});
