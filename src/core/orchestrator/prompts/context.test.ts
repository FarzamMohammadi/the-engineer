import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gatherRepoContext, gatherRepoContextSafe } from "./context.js";

// ── Test Setup ───────────────────────────────────────────────────────────────

let tempDir: string;

function gitInit(dir: string): void {
  execFileSync("git", ["init"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
}

function gitCommit(dir: string, message: string): void {
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-m", message, "--allow-empty-message"], {
    cwd: dir,
  });
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "ctx-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("gatherRepoContextSafe", () => {
  it("returns null when worktreePath is null", () => {
    expect(gatherRepoContextSafe(null)).toBeNull();
  });

  it("returns RepoContext when worktreePath is provided", () => {
    gitInit(tempDir);
    writeFileSync(join(tempDir, "README.md"), "# Hello");
    gitCommit(tempDir, "init");

    const result = gatherRepoContextSafe(tempDir);
    expect(result).not.toBeNull();
    expect(result?.readme).toContain("Hello");
  });
});

describe("gatherRepoContext", () => {
  it("reads README.md content", () => {
    gitInit(tempDir);
    writeFileSync(join(tempDir, "README.md"), "# My Project\n\nA description.");
    gitCommit(tempDir, "init");

    const ctx = gatherRepoContext(tempDir);
    expect(ctx.readme).toContain("My Project");
    expect(ctx.readme).toContain("description");
  });

  it("returns null readme when no README.md exists", () => {
    gitInit(tempDir);
    writeFileSync(join(tempDir, "index.ts"), "export {}");
    gitCommit(tempDir, "init");

    const ctx = gatherRepoContext(tempDir);
    expect(ctx.readme).toBeNull();
  });

  it("truncates long READMEs", () => {
    gitInit(tempDir);
    const longContent = "line\n".repeat(300);
    writeFileSync(join(tempDir, "README.md"), longContent);
    gitCommit(tempDir, "init");

    const ctx = gatherRepoContext(tempDir);
    expect(ctx.readme).not.toBeNull();
    // Should be truncated — either by line count (200) or char count (4000)
    expect(ctx.readme!.length).toBeLessThanOrEqual(4020); // 4000 + [... truncated]
  });

  it("reads directory tree", () => {
    gitInit(tempDir);
    mkdirSync(join(tempDir, "src"));
    writeFileSync(join(tempDir, "src", "index.ts"), "export {}");
    writeFileSync(join(tempDir, "package.json"), "{}");
    gitCommit(tempDir, "init");

    const ctx = gatherRepoContext(tempDir);
    expect(ctx.directoryTree).toContain("src/index.ts");
  });

  it("excludes node_modules from directory tree", () => {
    gitInit(tempDir);
    mkdirSync(join(tempDir, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(tempDir, "node_modules", "pkg", "index.js"), "");
    writeFileSync(join(tempDir, "index.ts"), "export {}");
    gitCommit(tempDir, "init");

    const ctx = gatherRepoContext(tempDir);
    expect(ctx.directoryTree).not.toContain("node_modules");
  });

  it("reads recent commits", () => {
    gitInit(tempDir);
    writeFileSync(join(tempDir, "a.txt"), "a");
    gitCommit(tempDir, "first commit");
    writeFileSync(join(tempDir, "b.txt"), "b");
    gitCommit(tempDir, "second commit");

    const ctx = gatherRepoContext(tempDir);
    expect(ctx.recentCommits).toContain("first commit");
    expect(ctx.recentCommits).toContain("second commit");
  });

  it("reads current git branch", () => {
    gitInit(tempDir);
    writeFileSync(join(tempDir, "a.txt"), "a");
    gitCommit(tempDir, "init");

    const ctx = gatherRepoContext(tempDir);
    // Default branch name varies by git config, but should be non-empty
    expect(ctx.gitBranch.length).toBeGreaterThan(0);
  });

  it("reads package.json info", () => {
    gitInit(tempDir);
    writeFileSync(
      join(tempDir, "package.json"),
      JSON.stringify({
        name: "my-project",
        description: "A test project",
        scripts: { test: "vitest", build: "tsc" },
      }),
    );
    gitCommit(tempDir, "init");

    const ctx = gatherRepoContext(tempDir);
    expect(ctx.packageInfo).toContain("my-project");
    expect(ctx.packageInfo).toContain("test project");
    expect(ctx.packageInfo).toContain("test");
    expect(ctx.packageInfo).toContain("build");
  });

  it("returns null packageInfo when no package.json exists", () => {
    gitInit(tempDir);
    writeFileSync(join(tempDir, "main.py"), "print('hello')");
    gitCommit(tempDir, "init");

    const ctx = gatherRepoContext(tempDir);
    expect(ctx.packageInfo).toBeNull();
  });

  it("handles non-git directory gracefully", () => {
    writeFileSync(join(tempDir, "file.txt"), "hello");

    const ctx = gatherRepoContext(tempDir);
    // Should not throw — git operations return fallback strings
    expect(ctx.recentCommits).toContain("unavailable");
    expect(ctx.gitBranch).toContain("unavailable");
    // File tree should still work
    expect(ctx.directoryTree).toContain("file.txt");
  });
});
