import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ── Constants ────────────────────────────────────────────────────────────────

const README_MAX_LINES = 200;
const README_MAX_CHARS = 4000;
const TREE_MAX_ENTRIES = 150;
const COMMITS_COUNT = 15;

const TREE_EXCLUDE_DIRS = [
  "node_modules",
  ".git",
  "dist",
  "coverage",
  ".next",
  ".turbo",
  "__pycache__",
  ".mypy_cache",
];

// ── Types ────────────────────────────────────────────────────────────────────

/** Repository context gathered before the agent loop starts. */
export interface RepoContext {
  /** First ~200 lines of README.md, or null if not found. */
  readme: string | null;
  /** Directory tree (top 3 levels, excluding common noise). */
  directoryTree: string;
  /** Recent git commits (one-line format). */
  recentCommits: string;
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
export function gatherRepoContext(worktreePath: string): RepoContext {
  return {
    readme: readReadme(worktreePath),
    directoryTree: readDirectoryTree(worktreePath),
    recentCommits: readRecentCommits(worktreePath),
    gitBranch: readGitBranch(worktreePath),
    packageInfo: readPackageInfo(worktreePath),
  };
}

/**
 * Safe wrapper: returns null if worktreePath is null (no workspace).
 */
export function gatherRepoContextSafe(worktreePath: string | null): RepoContext | null {
  if (!worktreePath) {
    return null;
  }
  return gatherRepoContext(worktreePath);
}

// ── Internal Helpers ─────────────────────────────────────────────────────────

function readReadme(worktreePath: string): string | null {
  try {
    const content = readFileSync(join(worktreePath, "README.md"), "utf-8");
    const lines = content.split("\n").slice(0, README_MAX_LINES);
    const truncated = lines.join("\n");
    if (truncated.length > README_MAX_CHARS) {
      return `${truncated.slice(0, README_MAX_CHARS)}\n[... truncated]`;
    }
    return truncated;
  } catch {
    return null;
  }
}

function readDirectoryTree(worktreePath: string): string {
  try {
    const excludeArgs: string[] = [];
    for (const dir of TREE_EXCLUDE_DIRS) {
      excludeArgs.push("-not", "-path", `*/${dir}/*`);
    }

    const output = execFileSync("find", [".", "-maxdepth", "3", "-type", "f", ...excludeArgs], {
      cwd: worktreePath,
      encoding: "utf-8",
      timeout: 5000,
    });

    const entries = output
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .sort();

    if (entries.length > TREE_MAX_ENTRIES) {
      return [
        ...entries.slice(0, TREE_MAX_ENTRIES),
        `[... ${String(entries.length - TREE_MAX_ENTRIES)} more files]`,
      ].join("\n");
    }

    return entries.join("\n");
  } catch {
    return "(directory tree unavailable)";
  }
}

function readRecentCommits(worktreePath: string): string {
  try {
    return execFileSync("git", ["log", "--oneline", `-${String(COMMITS_COUNT)}`], {
      cwd: worktreePath,
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
  } catch {
    return "(git log unavailable)";
  }
}

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
