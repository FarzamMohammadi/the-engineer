import { existsSync, rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import type { TestWorkspaceManagerHandle } from "../../../test/helpers/test-workspace-manager.js";
import { createTestWorkspaceManager } from "../../../test/helpers/test-workspace-manager.js";
import { branchName, slugify } from "./index.js";

const TRAILING_HYPHEN = /-$/;
const SHA_40 = /^[\da-f]{40}$/;

let handle: TestWorkspaceManagerHandle;

afterEach(() => {
  handle?.cleanup();
});

function setup(): TestWorkspaceManagerHandle {
  handle = createTestWorkspaceManager();
  return handle;
}

// ── Pure Functions ───────────────────────────────────────────────────────────

describe("slugify", () => {
  it("converts normal strings to kebab-case", () => {
    expect(slugify("Dark Mode Toggle", 30)).toBe("dark-mode-toggle");
  });

  it("handles special characters", () => {
    expect(slugify("Fix bug #42: auth!", 30)).toBe("fix-bug-42-auth");
  });

  it("collapses consecutive hyphens", () => {
    expect(slugify("foo---bar", 30)).toBe("foo-bar");
  });

  it("trims to maxLength", () => {
    const result = slugify("this is a very long title that should be truncated", 10);
    expect(result.length).toBeLessThanOrEqual(10);
    expect(result).not.toMatch(TRAILING_HYPHEN);
  });

  it("trims trailing hyphens after truncation", () => {
    // "a-b-c-d-e-f" truncated to 3 = "a-b" (no trailing hyphen)
    const result = slugify("a b c d e f", 3);
    expect(result).toBe("a-b");
  });

  it('returns "task" for empty input', () => {
    expect(slugify("", 30)).toBe("task");
  });

  it('returns "task" for all-special-character input', () => {
    expect(slugify("!!!@@@###", 30)).toBe("task");
  });
});

describe("branchName", () => {
  it("produces correct format", () => {
    expect(branchName("engineer/", "47", "dark-mode")).toBe("engineer/47-dark-mode");
  });

  it("works with empty prefix", () => {
    expect(branchName("", "47", "dark-mode")).toBe("47-dark-mode");
  });
});

// ── Workspace Lifecycle ──────────────────────────────────────────────────────

describe("createWorkspace", () => {
  it("creates a worktree directory on disk", () => {
    const { workspaceManager, repoName } = setup();

    const record = workspaceManager.createWorkspace("task-1", repoName, "Dark Mode");

    expect(existsSync(record.worktreePath)).toBe(true);
  });

  it("creates the correct branch name", () => {
    const { workspaceManager, repoName } = setup();

    const record = workspaceManager.createWorkspace("task-1", repoName, "Dark Mode");

    expect(record.branch).toBe("engineer/task-1-dark-mode");
  });

  it("populates all record fields", () => {
    const { workspaceManager, repoName } = setup();

    const record = workspaceManager.createWorkspace("task-1", repoName, "Dark Mode");

    expect(record.taskId).toBe("task-1");
    expect(record.repo).toBe(repoName);
    expect(record.baseBranch).toBe("main");
    expect(record.baseCommit).toMatch(SHA_40);
  });

  it("emits workspace.created event", () => {
    const h = setup();

    h.workspaceManager.createWorkspace("task-1", h.repoName, "Dark Mode");

    h.assertEventEmitted("workspace.created", (p) => p["task_id"] === "task-1");
    const events = h.getEmittedEvents("workspace.created");
    expect(events[0].payload["branch"]).toBe("engineer/task-1-dark-mode");
  });

  it("uses taskId as slug when no title provided", () => {
    const { workspaceManager, repoName } = setup();

    const record = workspaceManager.createWorkspace("task-1", repoName);

    expect(record.branch).toBe("engineer/task-1-task-1");
  });

  it("throws when repo clone directory does not exist", () => {
    const { workspaceManager } = setup();

    expect(() => {
      workspaceManager.createWorkspace("task-1", "nonexistent-repo", "Title");
    }).toThrow("repo clone directory does not exist");
  });
});

// ── Verification ─────────────────────────────────────────────────────────────

describe("verifyWorkspace", () => {
  it('returns "valid" for existing healthy worktree', () => {
    const { workspaceManager, repoName } = setup();
    workspaceManager.createWorkspace("task-1", repoName, "Test");

    const result = workspaceManager.verifyWorkspace("task-1");

    expect(result.status).toBe("valid");
    expect(result.currentCommit).toMatch(SHA_40);
    expect(result.recoveryAction).toBeNull();
  });

  it('returns "recoverable" when worktree directory is removed but branch exists', () => {
    const h = setup();
    const record = h.workspaceManager.createWorkspace("task-1", h.repoName, "Test");

    // Manually remove the worktree directory (simulate crash)
    rmSync(record.worktreePath, { recursive: true, force: true });
    // Also need to prune git's worktree list
    const { execSync } = require("node:child_process");
    execSync("git worktree prune", {
      cwd: h.cloneDir,
      stdio: "pipe",
    });

    const result = h.workspaceManager.verifyWorkspace("task-1");

    expect(result.status).toBe("recoverable");
    expect(result.currentCommit).toMatch(SHA_40);
    expect(result.recoveryAction).toBeTruthy();
  });

  it('returns "lost" for unknown taskId', () => {
    const { workspaceManager } = setup();

    const result = workspaceManager.verifyWorkspace("nonexistent");

    expect(result.status).toBe("lost");
    expect(result.currentCommit).toBeNull();
  });

  it("emits workspace.verified event", () => {
    const h = setup();
    h.workspaceManager.createWorkspace("task-1", h.repoName, "Test");

    h.workspaceManager.verifyWorkspace("task-1");

    h.assertEventEmitted(
      "workspace.verified",
      (p) => p["task_id"] === "task-1" && p["status"] === "valid",
    );
  });
});

// ── Cleanup ──────────────────────────────────────────────────────────────────

describe("cleanupWorkspace", () => {
  it("removes worktree directory", () => {
    const h = setup();
    const record = h.workspaceManager.createWorkspace("task-1", h.repoName, "Test");

    h.workspaceManager.cleanupWorkspace("task-1", false);

    expect(existsSync(record.worktreePath)).toBe(false);
  });

  it("deletes branch when preserveBranch is false", () => {
    const h = setup();
    h.workspaceManager.createWorkspace("task-1", h.repoName, "Test");

    h.workspaceManager.cleanupWorkspace("task-1", false);

    // Verify branch is deleted
    const { execSync } = require("node:child_process");
    const branches = execSync("git branch --list", {
      cwd: h.cloneDir,
      encoding: "utf-8",
    });
    expect(branches).not.toContain("engineer/task-1-test");
  });

  it("preserves branch when preserveBranch is true", () => {
    const h = setup();
    h.workspaceManager.createWorkspace("task-1", h.repoName, "Test");

    h.workspaceManager.cleanupWorkspace("task-1", true);

    // Verify branch still exists
    const { execSync } = require("node:child_process");
    const branches = execSync("git branch --list", {
      cwd: h.cloneDir,
      encoding: "utf-8",
    });
    expect(branches).toContain("engineer/task-1-test");
  });

  it("emits workspace.cleaned event", () => {
    const h = setup();
    h.workspaceManager.createWorkspace("task-1", h.repoName, "Test");

    h.workspaceManager.cleanupWorkspace("task-1", true);

    h.assertEventEmitted(
      "workspace.cleaned",
      (p) => p["task_id"] === "task-1" && p["branch_preserved"] === true,
    );
  });

  it("is idempotent for unknown taskId", () => {
    const { workspaceManager } = setup();

    // Should not throw
    workspaceManager.cleanupWorkspace("nonexistent", false);
  });
});

// ── Queries ──────────────────────────────────────────────────────────────────

describe("getWorktreePath", () => {
  it("returns correct path for known task", () => {
    const h = setup();
    const record = h.workspaceManager.createWorkspace("task-1", h.repoName, "Test");

    expect(h.workspaceManager.getWorktreePath("task-1")).toBe(record.worktreePath);
  });

  it("returns null for unknown task", () => {
    const { workspaceManager } = setup();

    expect(workspaceManager.getWorktreePath("nonexistent")).toBeNull();
  });
});
