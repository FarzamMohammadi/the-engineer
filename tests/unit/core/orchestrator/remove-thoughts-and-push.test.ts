import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { removeThoughtsAndPush } from "../../../../src/core/orchestrator/pr-manager.js";
import { createTestObserverFacade } from "../../../helpers/test-observer-facade.js";
import type { TestWorkspaceManagerHandle } from "../../../helpers/test-workspace-manager.js";
import { createTestWorkspaceManager } from "../../../helpers/test-workspace-manager.js";

let handle: TestWorkspaceManagerHandle;

afterEach(() => {
  handle?.cleanup();
});

function setup(): TestWorkspaceManagerHandle {
  handle = createTestWorkspaceManager();
  return handle;
}

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

    const result = removeThoughtsAndPush(
      { workspaceManager: h.workspaceManager, observer: createTestObserverFacade("pr-manager") },
      "task-1",
    );

    expect(result).toBe(true);
    expect(existsSync(thoughtsDir)).toBe(false);
  });

  it("returns false when branch has no thoughts files added", () => {
    const h = setup();
    h.workspaceManager.createWorkspace("task-1", h.repoName, { title: "No Thoughts" });

    // No thoughtsId → no thoughts directory, nothing added to branch
    const result = removeThoughtsAndPush(
      { workspaceManager: h.workspaceManager, observer: createTestObserverFacade("pr-manager") },
      "task-1",
    );

    expect(result).toBe(false);
  });

  it("throws when no workspace record exists for the task", () => {
    const h = setup();
    expect(() =>
      removeThoughtsAndPush(
        { workspaceManager: h.workspaceManager, observer: createTestObserverFacade("pr-manager") },
        "unknown-task",
      ),
    ).toThrow();
  });
});
