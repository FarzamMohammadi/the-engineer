import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sanitizeSecrets } from "../../../utils/sanitize.js";
import type { IObserver } from "../../observer/index.js";

// ── Types ────────────────────────────────────────────────────────────────────

/** Repository context gathered before the agent loop starts. */
export interface RepoContext {
  /** Current git branch name. */
  gitBranch: string;
  /** Package name, description, and scripts from package.json, or null. */
  packageInfo: string | null;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Gather repository context from a worktree path.
 *
 * Uses sync I/O (matching WorkspaceManager pattern). Every operation is
 * wrapped in try/catch — partial context is better than no context.
 */
export function gatherRepoContext(worktreePath: string, observer?: IObserver): RepoContext {
  const gitBranch = readGitBranch(worktreePath);
  const packageInfo = readPackageInfo(worktreePath);

  const context: RepoContext = {
    gitBranch,
    packageInfo: packageInfo ? sanitizeSecrets(packageInfo) : null,
  };

  if (observer) {
    observer.debug("Repo context gathered", {
      worktreePath,
      hasBranch: gitBranch !== "(branch unavailable)",
      hasPackageInfo: packageInfo !== null,
    });
  }

  return context;
}

/**
 * Safe wrapper: returns null if worktreePath is null (no workspace).
 */
export function gatherRepoContextSafe(
  worktreePath: string | null,
  observer?: IObserver,
): RepoContext | null {
  if (!worktreePath) {
    return null;
  }
  return gatherRepoContext(worktreePath, observer);
}

// ── Internal Helpers ─────────────────────────────────────────────────────────

function readGitBranch(worktreePath: string): string {
  try {
    return execFileSync("git", ["branch", "--show-current"], {
      cwd: worktreePath,
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
  } catch {
    return "(branch unavailable)";
  }
}

function readPackageInfo(worktreePath: string): string | null {
  try {
    const content = readFileSync(join(worktreePath, "package.json"), "utf-8");
    const pkg = JSON.parse(content) as {
      name?: string;
      description?: string;
      scripts?: Record<string, string>;
    };

    const lines: string[] = [];
    if (pkg.name) {
      lines.push(`Name: ${pkg.name}`);
    }
    if (pkg.description) {
      lines.push(`Description: ${pkg.description}`);
    }
    if (pkg.scripts) {
      const scriptNames = Object.keys(pkg.scripts).slice(0, 20);
      lines.push(`Scripts: ${scriptNames.join(", ")}`);
    }
    return lines.length > 0 ? lines.join("\n") : null;
  } catch {
    return null;
  }
}
