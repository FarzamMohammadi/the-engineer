import { execFileSync } from "node:child_process";

import { sanitizeSecrets } from "../../../../utils/sanitize.js";
import type { Ctx, Route, SubPhase, SubPhaseResult } from "../types.js";

// ── The Sub-Phase ────────────────────────────────────────────────────────────
//
// An orchestrator sub-phase: it commits anything the agent left behind and pushes
// the branch through the workspace manager, which owns the authenticated push.
// push runs in both modes — it is the entire deliverable in push-only mode and the
// safety net before the PR in PR mode. A push that cannot run (commit or push fails)
// throws, so the runner blocks it loud and recoverable; nothing to push is a clean
// advance.

/** Per-git-command wall-clock ceiling. A hung git invocation is killed and surfaces as a failure. */
const GIT_TIMEOUT_MS = 120_000;

/** Delivery: commit any stragglers and push the branch. Runs in both modes. */
export const push: SubPhase = {
  name: "push",
  run: (ctx) => Promise.resolve(runPush(ctx)),
  next: pushNext,
};

/** push always advances; the PR-vs-push-only difference is expressed by the downstream skip-gates. */
export function pushNext(): Route {
  return { go: "advance" };
}

// ── Running the Push ───────────────────────────────────────────────────────────

function runPush(ctx: Ctx): SubPhaseResult {
  const worktreePath = ctx.worktreePath;
  const record = ctx.workspaceManager.getWorkspaceRecord(ctx.task.id);
  if (!(worktreePath && record)) {
    ctx.observer.warn("No workspace to push — delivery has nothing to ship", { taskId: ctx.task.id });
    return { outcome: "ok", summary: "No workspace — nothing to push" };
  }

  const committed = commitStragglers(ctx, worktreePath);
  if (!(committed || hasCommitsAheadOfBase(ctx, worktreePath, record.baseBranch))) {
    ctx.observer.info("Nothing ahead of base — nothing to push", { taskId: ctx.task.id, branch: record.branch });
    return { outcome: "ok", summary: "No commits ahead of base — nothing to push" };
  }

  ctx.observer.info("Pushing branch", { taskId: ctx.task.id, branch: record.branch });
  try {
    ctx.workspaceManager.pushBranch(ctx.task.id);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot push branch "${record.branch}": ${detail}`);
  }
  return { outcome: "ok", summary: `Pushed ${record.branch}` };
}

/**
 * Commit anything the agent left uncommitted. Execution commits as it goes, so this is the
 * safety net that catches stragglers. Returns whether a new commit was made.
 */
function commitStragglers(ctx: Ctx, cwd: string): boolean {
  git(["add", "-A"], cwd, ctx.signal);
  if (!hasStagedChanges(cwd, ctx.signal)) {
    return false;
  }
  const isRework = ctx.task.review?.pr_number != null;
  const message = isRework
    ? "fix: address review feedback\n\nCrafted by The Engineer"
    : `feat: ${sanitizeSecrets(ctx.task.title)}\n\nCrafted by The Engineer`;
  git(["commit", "--no-verify", "-m", message], cwd, ctx.signal);
  return true;
}

/** Whether the index holds staged changes — `git diff --cached --quiet` exits non-zero when it does. */
function hasStagedChanges(cwd: string, signal?: AbortSignal): boolean {
  try {
    git(["diff", "--cached", "--quiet"], cwd, signal);
    return false;
  } catch {
    return true;
  }
}

/** Whether the branch has commits the base does not — guards against pushing an empty delta. */
function hasCommitsAheadOfBase(ctx: Ctx, cwd: string, baseBranch: string): boolean {
  try {
    const ahead = git(["rev-list", "--count", `origin/${baseBranch}..HEAD`], cwd, ctx.signal);
    return ahead.trim() !== "0";
  } catch (error) {
    ctx.observer.warn("Cannot determine commits ahead of base — treating as nothing to push", {
      taskId: ctx.task.id,
      error: error instanceof Error ? error.message.slice(0, 200) : String(error),
    });
    return false;
  }
}

/** Run a git command, throwing on a non-zero exit so a failed push blocks loud. */
function git(args: readonly string[], cwd: string, signal?: AbortSignal): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    timeout: GIT_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
    ...(signal ? { signal } : {}),
  });
}
