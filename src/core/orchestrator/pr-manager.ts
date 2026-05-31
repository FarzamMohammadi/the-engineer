import { execFileSync } from "node:child_process";
import { ObservationTypes } from "../../schemas/observer.js";
import type { IWorkspaceManager } from "../interfaces/workspace-manager.interface.js";
import type { IObserver } from "../observer/index.js";
import { WorkspaceNotFoundError } from "../workspace-manager/errors.js";

// ── removeThoughtsAndPush ─────────────────────────────────────────────────────

/** Narrow dependency shape for `removeThoughtsAndPush`. */
export interface RemoveThoughtsDeps {
  workspaceManager: IWorkspaceManager;
  observer: IObserver;
}

/**
 * Remove thoughts files **introduced by this branch** from the worktree, commit, and push.
 *
 * PR-prep work called immediately before merge. Only removes files added relative to the
 * base branch — pre-existing `thoughts/` content in the repo is never touched. The files
 * remain in PR history for reviewer context but stay out of the target branch on merge.
 * Returns true if a cleanup commit was made, false if there was nothing to remove.
 */
export function removeThoughtsAndPush(deps: RemoveThoughtsDeps, taskId: string): boolean {
  const { workspaceManager, observer } = deps;
  const record = workspaceManager.getWorkspaceRecord(taskId);
  if (!record) {
    throw new WorkspaceNotFoundError(taskId);
  }

  const span = observer.startSpan(
    ObservationTypes.plugin_call,
    "remove_thoughts_and_push",
    { taskId, branch: record.branch, base: record.baseBranch },
    { task_id: taskId },
  );

  try {
    const baseRef = `origin/${record.baseBranch}`;
    const addedFilesRaw = execFileSync(
      "git",
      ["-c", "credential.helper=", "diff", "--name-only", "--diff-filter=A", baseRef, "--", "thoughts/"],
      { cwd: record.worktreePath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    ).trim();

    if (!addedFilesRaw) {
      observer.recordDecision(
        "remove_thoughts_and_push",
        `No branch-introduced thoughts files for task "${taskId}"`,
        [
          { id: "skip", description: "No files to remove — skip commit + push" },
          { id: "proceed", description: "Files present — rm, commit, push" },
        ],
        "skip",
        "Diff against base branch returned no added thoughts/ files.",
        1,
        { task_id: taskId },
      );
      span.end({ skipped: true, fileCount: 0 });
      return false;
    }

    const files = addedFilesRaw.split("\n");
    observer.info("Removing branch-introduced thoughts files before merge", { taskId, fileCount: files.length });

    execFileSync("git", ["-c", "credential.helper=", "rm", "-f", ...files], {
      cwd: record.worktreePath,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    execFileSync(
      "git",
      ["-c", "credential.helper=", "commit", "-m", "chore: remove engineering thoughts before merge"],
      { cwd: record.worktreePath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    workspaceManager.pushBranch(taskId);

    observer.info("Thoughts files removed and pushed", { taskId, fileCount: files.length });
    span.end({ skipped: false, fileCount: files.length });
    return true;
  } catch (error) {
    span.setError(error);
    span.end({ skipped: false });
    throw error;
  }
}
