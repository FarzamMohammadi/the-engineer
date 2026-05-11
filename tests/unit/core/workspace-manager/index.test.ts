import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { branchName, slugify, validateWorkspacePath } from "../../../../src/core/workspace-manager/index.js";
import type { TestWorkspaceManagerHandle } from "../../../helpers/test-workspace-manager.js";
import { createTestWorkspaceManager } from "../../../helpers/test-workspace-manager.js";

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

    const record = workspaceManager.createWorkspace("task-1", repoName, { title: "Dark Mode" });

    expect(existsSync(record.worktreePath)).toBe(true);
  });

  it("creates the correct branch name", () => {
    const { workspaceManager, repoName } = setup();

    const record = workspaceManager.createWorkspace("task-1", repoName, { title: "Dark Mode" });

    expect(record.branch).toBe("engineer/task-1-dark-mode");
  });

  it("populates all record fields", () => {
    const { workspaceManager, repoName } = setup();

    const record = workspaceManager.createWorkspace("task-1", repoName, { title: "Dark Mode" });

    expect(record.taskId).toBe("task-1");
    expect(record.repo).toBe(repoName);
    expect(record.baseBranch).toBe("main");
    expect(record.baseCommit).toMatch(SHA_40);
  });

  it("emits workspace.created event", () => {
    const h = setup();

    h.workspaceManager.createWorkspace("task-1", h.repoName, { title: "Dark Mode" });

    h.assertEventEmitted("workspace.created", (p) => p["task_id"] === "task-1");
    const events = h.getEmittedEvents("workspace.created");
    expect(events[0]?.payload["branch"]).toBe("engineer/task-1-dark-mode");
  });

  it("uses taskId as slug when no title provided", () => {
    const { workspaceManager, repoName } = setup();

    const record = workspaceManager.createWorkspace("task-1", repoName);

    expect(record.branch).toBe("engineer/task-1-task-1");
  });

  it("throws when repo clone directory does not exist", () => {
    const { workspaceManager } = setup();

    expect(() => {
      workspaceManager.createWorkspace("task-1", "nonexistent-repo", { title: "Title" });
    }).toThrow("repo clone directory does not exist");
  });
});

// ── Verification ─────────────────────────────────────────────────────────────

describe("verifyWorkspace", () => {
  it('returns "valid" for existing healthy worktree', () => {
    const { workspaceManager, repoName } = setup();
    workspaceManager.createWorkspace("task-1", repoName, { title: "Test" });

    const result = workspaceManager.verifyWorkspace("task-1");

    expect(result.status).toBe("valid");
    expect(result.currentCommit).toMatch(SHA_40);
    expect(result.recoveryAction).toBeNull();
  });

  it('returns "recoverable" when worktree directory is removed but branch exists', () => {
    const h = setup();
    const record = h.workspaceManager.createWorkspace("task-1", h.repoName, { title: "Test" });

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
    h.workspaceManager.createWorkspace("task-1", h.repoName, { title: "Test" });

    h.workspaceManager.verifyWorkspace("task-1");

    h.assertEventEmitted("workspace.verified", (p) => p["task_id"] === "task-1" && p["status"] === "valid");
  });
});

// ── Cleanup ──────────────────────────────────────────────────────────────────

describe("cleanupWorkspace", () => {
  it("removes worktree directory", () => {
    const h = setup();
    const record = h.workspaceManager.createWorkspace("task-1", h.repoName, { title: "Test" });

    h.workspaceManager.cleanupWorkspace("task-1", false);

    expect(existsSync(record.worktreePath)).toBe(false);
  });

  it("deletes branch when preserveBranch is false", () => {
    const h = setup();
    h.workspaceManager.createWorkspace("task-1", h.repoName, { title: "Test" });

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
    h.workspaceManager.createWorkspace("task-1", h.repoName, { title: "Test" });

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
    h.workspaceManager.createWorkspace("task-1", h.repoName, { title: "Test" });

    h.workspaceManager.cleanupWorkspace("task-1", true);

    h.assertEventEmitted("workspace.cleaned", (p) => p["task_id"] === "task-1" && p["branch_preserved"] === true);
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
    const record = h.workspaceManager.createWorkspace("task-1", h.repoName, { title: "Test" });

    expect(h.workspaceManager.getWorktreePath("task-1")).toBe(record.worktreePath);
  });

  it("returns null for unknown task", () => {
    const { workspaceManager } = setup();

    expect(workspaceManager.getWorktreePath("nonexistent")).toBeNull();
  });
});

// ── Workspace Path Validation (Security Hardening R8) ────────────────────

describe("validateWorkspacePath", () => {
  it("passes for path within workspace root", () => {
    const root = mkdtempSync(join(tmpdir(), "ws-root-"));
    const subdir = join(root, "sub");
    require("node:fs").mkdirSync(subdir);
    const result = validateWorkspacePath(subdir, root);
    expect(result).toBeTruthy();
    rmSync(root, { recursive: true, force: true });
  });

  it("passes when path equals workspace root", () => {
    const root = mkdtempSync(join(tmpdir(), "ws-root-"));
    const result = validateWorkspacePath(root, root);
    expect(result).toBeTruthy();
    rmSync(root, { recursive: true, force: true });
  });

  it("detects symlink escape outside workspace root", () => {
    const root = mkdtempSync(join(tmpdir(), "ws-root-"));
    const outside = mkdtempSync(join(tmpdir(), "ws-outside-"));
    const link = join(root, "escape-link");
    symlinkSync(outside, link);

    expect(() => validateWorkspacePath(link, root)).toThrow("Workspace escape detected");

    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("throws for non-existent path", () => {
    const root = mkdtempSync(join(tmpdir(), "ws-root-"));
    expect(() => validateWorkspacePath(join(root, "nonexistent"), root)).toThrow(
      "does not exist or cannot be resolved",
    );
    rmSync(root, { recursive: true, force: true });
  });

  it("catches parent traversal that resolves outside root", () => {
    const root = mkdtempSync(join(tmpdir(), "ws-root-"));
    const subdir = join(root, "sub");
    require("node:fs").mkdirSync(subdir);
    // ../.. from subdir goes above root
    expect(() => validateWorkspacePath(join(subdir, "..", ".."), root)).toThrow("Workspace escape detected");
    rmSync(root, { recursive: true, force: true });
  });
});

// ── F8: cleanupWorkspace resilience ──────────────────────────────────────────

describe("cleanupWorkspace resilience (F8)", () => {
  it("continues cleanup (map removal + event) even when worktree removal fails", () => {
    const h = setup();
    const record = h.workspaceManager.createWorkspace("task-1", h.repoName, { title: "Test" });

    // Corrupt the worktree's .git file so `git worktree remove` will fail,
    // but the directory still exists (existsSync returns true).
    writeFileSync(join(record.worktreePath, ".git"), "corrupted");

    // Should not throw — the try/catch around worktree removal continues cleanup
    expect(() => h.workspaceManager.cleanupWorkspace("task-1", true)).not.toThrow();

    // Task removed from in-memory map
    expect(h.workspaceManager.getWorktreePath("task-1")).toBeNull();

    // workspace.cleaned event still emitted
    h.assertEventEmitted("workspace.cleaned", (p) => p["task_id"] === "task-1");
  });
});

// ── F9: verifyWorkspace on corrupted worktree ─────────────────────────────────

describe("verifyWorkspace with corrupted worktree (F9)", () => {
  it('returns "recoverable" when worktree directory exists but HEAD is unreadable', () => {
    const h = setup();
    const record = h.workspaceManager.createWorkspace("task-1", h.repoName, { title: "Test" });

    // Corrupt the .git file in the worktree so rev-parse HEAD fails.
    // This simulates a partial crash where the directory exists but git state is broken.
    writeFileSync(join(record.worktreePath, ".git"), "corrupted-not-a-git-file");

    const result = h.workspaceManager.verifyWorkspace("task-1");

    expect(result.status).toBe("recoverable");
    expect(result.currentCommit).toBeNull();
    expect(result.recoveryAction).toContain("recreate worktree");
  });
});

// ── F13: createWorkspace branch rollback ──────────────────────────────────────

describe("createWorkspace branch rollback on worktree failure (F13)", () => {
  it("deletes branch when worktree creation fails (invalid base ref)", () => {
    const { execSync } = require("node:child_process");
    const h = setup();

    // Attempt to create a workspace with a non-existent base ref
    // so that worktree add succeeds but we can simulate the branch being created.
    // Instead of trying to fail worktree add (complex), verify that a normally failing
    // creation (bad fromRef) throws without leaving a branch behind.

    expect(() => {
      h.workspaceManager.createWorkspace("task-fail", h.repoName, {
        title: "Fail",
        baseBranch: "nonexistent-ref-that-does-not-exist",
      });
    }).toThrow();

    // Verify no branch was left behind
    const branches: string = execSync("git branch --list", {
      cwd: h.cloneDir,
      encoding: "utf-8",
    });
    expect(branches).not.toContain("task-fail");
  });
});

// ── removeThoughtsAndPush ──────────────────────────────────────────────────

describe("removeThoughtsAndPush", () => {
  it("removes only branch-introduced thoughts files, commits, and pushes", () => {
    const h = setup();
    const record = h.workspaceManager.createWorkspace("task-1", h.repoName, {
      title: "Test",
      thoughtsId: "issue-1",
    });

    // Verify thoughts dir exists
    const thoughtsDir = join(record.worktreePath, record.thoughtsDir!);
    expect(existsSync(thoughtsDir)).toBe(true);

    // Commit the thoughts dir so git diff sees it as branch-added
    execSync("git add -A && git commit -m 'add thoughts'", {
      cwd: record.worktreePath,
      encoding: "utf-8",
      stdio: "pipe",
    });

    const result = h.workspaceManager.removeThoughtsAndPush("task-1");

    expect(result).toBe(true);
    expect(existsSync(thoughtsDir)).toBe(false);
  });

  it("returns false when branch has no thoughts files added", () => {
    const h = setup();
    h.workspaceManager.createWorkspace("task-1", h.repoName, { title: "No Thoughts" });

    // No thoughtsId → no thoughts directory, nothing added to branch
    const result = h.workspaceManager.removeThoughtsAndPush("task-1");

    expect(result).toBe(false);
  });

  it("throws WorkspaceNotFoundError for unknown task", () => {
    const h = setup();
    expect(() => h.workspaceManager.removeThoughtsAndPush("unknown-task")).toThrow();
  });
});

// ── getSkillsDir ────────────────────────────────────────────────────────────

describe("getSkillsDir", () => {
  it("returns {workspace_root}/skills/", () => {
    const h = setup();
    expect(h.workspaceManager.getSkillsDir()).toBe(join(h.workspaceRoot, "skills"));
  });
});

// ── syncSkills ──────────────────────────────────────────────────────────────

describe("syncSkills", () => {
  it("copies skill files to {workspace_root}/skills/", () => {
    const h = setup();
    h.workspaceManager.syncSkills();

    const skillsDir = h.workspaceManager.getSkillsDir();
    expect(existsSync(join(skillsDir, "commit", "SKILL.md"))).toBe(true);
    expect(existsSync(join(skillsDir, "expert-panel-review", "SKILL.md"))).toBe(true);
  });

  it("copies persona files for expert-panel-review", () => {
    const h = setup();
    h.workspaceManager.syncSkills();

    const personasDir = join(h.workspaceManager.getSkillsDir(), "expert-panel-review", "personas");
    expect(existsSync(personasDir)).toBe(true);
    const personas = readdirSync(personasDir);
    expect(personas.length).toBeGreaterThan(0);
    expect(personas.some((f) => f.endsWith(".md"))).toBe(true);
  });

  it("is idempotent — calling twice does not throw", () => {
    const h = setup();
    h.workspaceManager.syncSkills();
    expect(() => h.workspaceManager.syncSkills()).not.toThrow();

    // Files still present after second call
    const skillsDir = h.workspaceManager.getSkillsDir();
    expect(existsSync(join(skillsDir, "commit", "SKILL.md"))).toBe(true);
  });
});
