import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A bare git repository on disk that workspace-manager can `clone` from via a `file://` URL.
 * Has a `main` branch with one commit so `origin/main` resolves.
 */
export interface TestRepo {
  /** Absolute path to the bare repo on disk. */
  path: string;
  /** `file://`-prefixed URL suitable for `clone_url`. */
  cloneUrl: string;
  /** Remove the repo from disk. */
  cleanup(): void;
}

/**
 * Create a bare git repo with a single commit on `main`.
 * The workspace manager clones from this and creates worktrees off `origin/main`.
 */
export function createTestRepo(): TestRepo {
  const root = join(tmpdir(), `engineer-testrepo-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`);
  const seedDir = join(root, "seed");
  const bareDir = join(root, "bare.git");

  mkdirSync(seedDir, { recursive: true });

  // Seed repo with one commit on `main`.
  const git = (args: string[], cwd: string): void => {
    execFileSync("git", args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
  };
  git(["init", "-b", "main"], seedDir);
  git(["config", "user.email", "test@example.com"], seedDir);
  git(["config", "user.name", "Test"], seedDir);
  writeFileSync(join(seedDir, "README.md"), "# test\n", "utf-8");
  git(["add", "README.md"], seedDir);
  git(["-c", "commit.gpgsign=false", "commit", "-m", "init"], seedDir);

  // Convert to a bare repo (what `git clone` against a file:// URL expects).
  git(["clone", "--bare", seedDir, bareDir], root);

  return {
    path: bareDir,
    cloneUrl: `file://${bareDir}`,
    cleanup() {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    },
  };
}
