import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { Observer, createSilentLogger } from "../../../../src/core/observer/index.js";
import { branchName, slugify, validateWorkspacePath } from "../../../../src/core/workspace-manager/index.js";
import { ObservationTypes } from "../../../../src/schemas/observer.js";
import { createTestObserver } from "../../../helpers/test-observer.js";
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
    const h = setup();
    h.setupTask("task-1");

    const record = h.workspaceManager.createWorkspace("task-1", h.repoName, { title: "Dark Mode" });

    expect(existsSync(record.worktreePath)).toBe(true);
  });

  it("creates the correct branch name", () => {
    const h = setup();
    h.setupTask("task-1");

    const record = h.workspaceManager.createWorkspace("task-1", h.repoName, { title: "Dark Mode" });

    expect(record.branch).toBe("engineer/task-1-dark-mode");
  });

  it("populates record fields", () => {
    const h = setup();
    h.setupTask("task-1");

    const record = h.workspaceManager.createWorkspace("task-1", h.repoName, { title: "Dark Mode" });

    expect(record.taskId).toBe("task-1");
    expect(record.repo).toBe(h.repoName);
    expect(record.baseBranch).toBe("main");
  });

  it("persists base_branch to task.workspace", () => {
    const h = setup();
    h.setupTask("task-1");

    h.workspaceManager.createWorkspace("task-1", h.repoName, { title: "Dark Mode" });

    expect(h.taskEngine.getTask("task-1")?.workspace?.base_branch).toBe("main");
  });

  it("emits workspace.created event with base_commit in payload", () => {
    const h = setup();
    h.setupTask("task-1");

    h.workspaceManager.createWorkspace("task-1", h.repoName, { title: "Dark Mode" });

    h.assertEventEmitted("workspace.created", (p) => p["task_id"] === "task-1");
    const events = h.getEmittedEvents("workspace.created");
    expect(events[0]?.payload["branch"]).toBe("engineer/task-1-dark-mode");
    expect(events[0]?.payload["base_commit"]).toMatch(SHA_40);
  });

  it("uses taskId as slug when no title provided", () => {
    const h = setup();
    h.setupTask("task-1");

    const record = h.workspaceManager.createWorkspace("task-1", h.repoName);

    expect(record.branch).toBe("engineer/task-1-task-1");
  });

  it("throws when repo clone directory does not exist", () => {
    const h = setup();
    h.setupTask("task-1");

    expect(() => {
      h.workspaceManager.createWorkspace("task-1", "nonexistent-repo", { title: "Title" });
    }).toThrow("Repo clone directory does not exist");
  });
});

// ── Verification ─────────────────────────────────────────────────────────────

describe("verifyWorkspace", () => {
  it('returns "valid" for existing healthy worktree', () => {
    const h = setup();
    h.setupTask("task-1");
    h.workspaceManager.createWorkspace("task-1", h.repoName, { title: "Test" });

    const result = h.workspaceManager.verifyWorkspace("task-1");

    expect(result.status).toBe("valid");
    expect(result.currentCommit).toMatch(SHA_40);
    expect(result.recoveryAction).toBeNull();
  });

  it('returns "recoverable" when worktree directory is removed but branch exists', () => {
    const h = setup();
    h.setupTask("task-1");
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
    h.setupTask("task-1");
    h.workspaceManager.createWorkspace("task-1", h.repoName, { title: "Test" });

    h.workspaceManager.verifyWorkspace("task-1");

    h.assertEventEmitted("workspace.verified", (p) => p["task_id"] === "task-1" && p["status"] === "valid");
  });
});

// ── Cleanup ──────────────────────────────────────────────────────────────────

describe("cleanupWorkspace", () => {
  it("removes worktree directory", () => {
    const h = setup();
    h.setupTask("task-1");
    const record = h.workspaceManager.createWorkspace("task-1", h.repoName, { title: "Test" });

    h.workspaceManager.cleanupWorkspace("task-1", false);

    expect(existsSync(record.worktreePath)).toBe(false);
  });

  it("deletes branch when preserveBranch is false", () => {
    const h = setup();
    h.setupTask("task-1");
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
    h.setupTask("task-1");
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
    h.setupTask("task-1");
    h.workspaceManager.createWorkspace("task-1", h.repoName, { title: "Test" });

    h.workspaceManager.cleanupWorkspace("task-1", true);

    h.assertEventEmitted("workspace.cleaned", (p) => p["task_id"] === "task-1" && p["branch_preserved"] === true);
  });

  it("leaves task.workspace persisted as audit after cleanup", () => {
    const h = setup();
    h.setupTask("task-1");
    h.workspaceManager.createWorkspace("task-1", h.repoName, { title: "Test" });

    h.workspaceManager.cleanupWorkspace("task-1", true);

    // task.workspace is not nulled — the workspace.cleaned event is the audit trail.
    expect(h.taskEngine.getTask("task-1")?.workspace).not.toBeNull();
  });

  it("is idempotent for unknown taskId", () => {
    const { workspaceManager } = setup();

    // Should not throw
    workspaceManager.cleanupWorkspace("nonexistent", false);
  });
});

// ── Queries ──────────────────────────────────────────────────────────────────

describe("deleteRemoteBranch", () => {
  it("deletes a pushed branch and tolerates a repeat delete (idempotent — already-gone is success)", () => {
    const h = setup();
    h.setupTask("task-1");
    const record = h.workspaceManager.createWorkspace("task-1", h.repoName, { title: "Feature" });
    h.workspaceManager.pushBranch("task-1");

    const onRemote = () =>
      execSync(`git ls-remote --heads ${h.bareRepoDir} ${record.branch}`, { encoding: "utf-8" }).trim();
    expect(onRemote()).not.toBe(""); // the branch is on the remote

    h.workspaceManager.deleteRemoteBranch("task-1");
    expect(onRemote()).toBe(""); // the first delete actually removed it

    // The remote ref is now gone — a repeat delete is the desired end-state, so it must not throw.
    expect(() => h.workspaceManager.deleteRemoteBranch("task-1")).not.toThrow();
  });

  it("throws when the task has no workspace on record", () => {
    const h = setup();
    h.setupTask("task-1");
    expect(() => h.workspaceManager.deleteRemoteBranch("task-1")).toThrow();
  });
});

describe("getWorktreePath", () => {
  it("returns correct path for known task (DB-backed)", () => {
    const h = setup();
    h.setupTask("task-1");
    const record = h.workspaceManager.createWorkspace("task-1", h.repoName, { title: "Test" });

    expect(h.workspaceManager.getWorktreePath("task-1")).toBe(record.worktreePath);
  });

  it("returns null for unknown task", () => {
    const { workspaceManager } = setup();

    expect(workspaceManager.getWorktreePath("nonexistent")).toBeNull();
  });

  it("returns null when task has no workspace persisted", () => {
    const h = setup();
    h.setupTask("task-1");

    expect(h.workspaceManager.getWorktreePath("task-1")).toBeNull();
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
  it("continues cleanup (event emission) even when worktree removal fails", () => {
    const h = setup();
    h.setupTask("task-1");
    const record = h.workspaceManager.createWorkspace("task-1", h.repoName, { title: "Test" });

    // Corrupt the worktree's .git file so `git worktree remove` will fail,
    // but the directory still exists (existsSync returns true).
    writeFileSync(join(record.worktreePath, ".git"), "corrupted");

    // Should not throw — the try/catch around worktree removal continues cleanup
    expect(() => h.workspaceManager.cleanupWorkspace("task-1", true)).not.toThrow();

    // workspace.cleaned event still emitted
    h.assertEventEmitted("workspace.cleaned", (p) => p["task_id"] === "task-1");
  });
});

// ── F9: verifyWorkspace on corrupted worktree ─────────────────────────────────

describe("verifyWorkspace with corrupted worktree (F9)", () => {
  it('returns "recoverable" when worktree directory exists but HEAD is unreadable', () => {
    const h = setup();
    h.setupTask("task-1");
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

// ── Resume flow: DB-backed reads survive a fresh WorkspaceManager ────────────

describe("resume flow (DB-backed reads)", () => {
  it("base_branch persists on createWorkspace and survives a fresh WorkspaceManager instance", () => {
    const h = setup();
    h.setupTask("task-1");
    const record = h.workspaceManager.createWorkspace("task-1", h.repoName, { title: "Resume" });

    // task.workspace carries the persisted shape immediately — proves the silent
    // wrong-base bug on restart is gone (base_branch was hardcoded post-restart before).
    const workspace = h.taskEngine.getTask("task-1")?.workspace;
    expect(workspace?.base_branch).toBe("main");
    expect(workspace?.branch).toBe(record.branch);
    expect(workspace?.worktree_path).toBe(record.worktreePath);

    // A fresh WorkspaceManager pointed at the same DB — the analogue of a daemon
    // restart. Reads must work without any registerExistingWorkspace call.
    const fresh = h.createWorkspaceManager();

    const recovered = fresh.getWorkspaceRecord("task-1");
    expect(recovered).not.toBeNull();
    expect(recovered?.baseBranch).toBe("main");
    expect(recovered?.worktreePath).toBe(record.worktreePath);
    expect(fresh.getWorktreePath("task-1")).toBe(record.worktreePath);
  });
});

// ── F13: createWorkspace branch rollback ──────────────────────────────────────

describe("createWorkspace branch rollback on worktree failure (F13)", () => {
  it("deletes branch when worktree creation fails (invalid base ref)", () => {
    const { execSync } = require("node:child_process");
    const h = setup();
    h.setupTask("task-fail");

    // Attempt to create a workspace with a non-existent base ref so creation throws.
    // Verify no branch was left behind.
    expect(() => {
      h.workspaceManager.createWorkspace("task-fail", h.repoName, {
        title: "Fail",
        baseBranch: "nonexistent-ref-that-does-not-exist",
      });
    }).toThrow();

    const branches: string = execSync("git branch --list", {
      cwd: h.cloneDir,
      encoding: "utf-8",
    });
    expect(branches).not.toContain("task-fail");
  });
});

// ── workspace_op observations ─────────────────────────────────────────────────
// The dashboard ships an empty "Workspace" filter; these assert the worktree git ops now feed it.

describe("workspace_op observations", () => {
  let store: ReturnType<typeof createTestObserver> | undefined;

  afterEach(() => {
    store?.cleanup();
    store = undefined;
  });

  /** A workspace manager whose observer writes to a queryable observation store. */
  function setupWithStore(): TestWorkspaceManagerHandle {
    const observerStore = createTestObserver();
    store = observerStore;
    const observer = new Observer({ rootPino: createSilentLogger().logger, store: null }, "workspace-manager");
    observer.upgrade(observerStore.observer);
    handle = createTestWorkspaceManager({ observer });
    return handle;
  }

  it("emits a worktree_created workspace_op carrying the branch and a duration", () => {
    const h = setupWithStore();
    h.setupTask("task-1");

    h.workspaceManager.createWorkspace("task-1", h.repoName, { title: "Dark Mode" });

    const ops = store?.observer.query({ type: ObservationTypes.workspace_op, task_id: "task-1" }) ?? [];
    const created = ops.find((op) => op.name === "worktree_created");
    expect(created?.input).toMatchObject({ branch: "engineer/task-1-dark-mode", repo: h.repoName });
    expect(typeof created?.input?.["durationMs"]).toBe("number");
  });

  it("nests worktree_created under the task's execution trace when trace context is threaded", () => {
    const h = setupWithStore();
    h.setupTask("task-1");

    // The orchestrator passes the dispatch's trace_id + root span id so this setup
    // observation joins the task trace instead of surfacing as a lone 1-span trace.
    h.workspaceManager.createWorkspace("task-1", h.repoName, {
      title: "Dark Mode",
      traceId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      parentObservationId: "01ARZ3NDEKTSV4RRFFQ69G5FB0",
    });

    const ops = store?.observer.query({ type: ObservationTypes.workspace_op, task_id: "task-1" }) ?? [];
    const created = ops.find((op) => op.name === "worktree_created");
    expect(created?.trace_id).toBe("01ARZ3NDEKTSV4RRFFQ69G5FAV");
    expect(created?.parent_observation_id).toBe("01ARZ3NDEKTSV4RRFFQ69G5FB0");
  });

  it("leaves worktree_created untraced (dashboard-only) when no trace context is given", () => {
    const h = setupWithStore();
    h.setupTask("task-1");

    h.workspaceManager.createWorkspace("task-1", h.repoName, { title: "Dark Mode" });

    const ops = store?.observer.query({ type: ObservationTypes.workspace_op, task_id: "task-1" }) ?? [];
    const created = ops.find((op) => op.name === "worktree_created");
    expect(created?.trace_id).toBeNull();
    expect(created?.parent_observation_id).toBeNull();
  });

  it("emits a worktree_cleaned workspace_op when a workspace is cleaned up", () => {
    const h = setupWithStore();
    h.setupTask("task-1");
    h.workspaceManager.createWorkspace("task-1", h.repoName, { title: "Dark Mode" });

    h.workspaceManager.cleanupWorkspace("task-1");

    const ops = store?.observer.query({ type: ObservationTypes.workspace_op, task_id: "task-1" }) ?? [];
    const cleaned = ops.find((op) => op.name === "worktree_cleaned");
    expect(cleaned?.input).toMatchObject({ branch: "engineer/task-1-dark-mode", branchPreserved: false });
  });

  it("emits a branch_deleted workspace_op when the remote branch is deleted", () => {
    const h = setupWithStore();
    h.setupTask("task-1");
    h.workspaceManager.createWorkspace("task-1", h.repoName, { title: "Dark Mode" });
    h.workspaceManager.pushBranch("task-1");

    h.workspaceManager.deleteRemoteBranch("task-1");

    const ops = store?.observer.query({ type: ObservationTypes.workspace_op, task_id: "task-1" }) ?? [];
    const deleted = ops.find((op) => op.name === "branch_deleted");
    expect(deleted?.input).toMatchObject({ branch: "engineer/task-1-dark-mode", alreadyGone: false });
  });
});
