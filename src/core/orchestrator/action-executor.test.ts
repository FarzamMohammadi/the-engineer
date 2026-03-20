import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentAction } from "../../schemas/orchestrator.js";
import { ActionClasses } from "../../schemas/task.js";
import {
  type ActionExecutorDeps,
  executeAction,
  resolveWorktreePath,
  resolveWorktreePathCanonical,
  shellEscape,
} from "./action-executor.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

let worktree: string;

beforeEach(() => {
  worktree = mkdtempSync(join(tmpdir(), "action-exec-test-"));
});

function makeDeps(overrides?: Partial<ActionExecutorDeps>): ActionExecutorDeps {
  return {
    actionPipeline: {
      execute: vi.fn(async (input: { executeFn: () => Promise<unknown> }) => {
        const result = await input.executeFn();
        return { outcome: "executed", result };
      }),
    } as unknown as ActionExecutorDeps["actionPipeline"],
    toolAdapter: overrides?.toolAdapter ?? null,
    taskId: "task-001",
    ...overrides,
  };
}

// ── resolveWorktreePath ──────────────────────────────────────────────────────

describe("resolveWorktreePath", () => {
  it("resolves relative path within worktree", () => {
    const result = resolveWorktreePath("/tmp/worktree", "src/index.ts");
    expect(result).toBe("/tmp/worktree/src/index.ts");
  });

  it("rejects path traversal attempts", () => {
    expect(() => resolveWorktreePath("/tmp/worktree", "../../etc/passwd")).toThrow(
      "Path escapes worktree",
    );
  });

  it("allows absolute paths within worktree", () => {
    const result = resolveWorktreePath("/tmp/worktree", "/tmp/worktree/src/a.ts");
    expect(result).toBe("/tmp/worktree/src/a.ts");
  });
});

// ── executeAction: read_file ─────────────────────────────────────────────────

describe("executeAction: read_file", () => {
  it("reads existing file", async () => {
    writeFileSync(join(worktree, "hello.txt"), "Hello world");
    const action: AgentAction = { action: "read_file", params: { path: "hello.txt" } };
    const result = await executeAction(action, worktree, makeDeps());
    expect(result.success).toBe(true);
    expect(result.output).toBe("Hello world");
  });

  it("returns error for non-existent file", async () => {
    const action: AgentAction = { action: "read_file", params: { path: "missing.txt" } };
    const result = await executeAction(action, worktree, makeDeps());
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});

// ── executeAction: write_file ────────────────────────────────────────────────

describe("executeAction: write_file", () => {
  it("writes file and creates parent directories", async () => {
    const action: AgentAction = {
      action: "write_file",
      params: { path: "sub/dir/new.txt", content: "New content" },
    };
    const result = await executeAction(action, worktree, makeDeps());
    expect(result.success).toBe(true);
    expect(readFileSync(join(worktree, "sub/dir/new.txt"), "utf-8")).toBe("New content");
  });

  it("returns error when pipeline rejects", async () => {
    const deps = makeDeps();
    (deps.actionPipeline.execute as ReturnType<typeof vi.fn>).mockResolvedValue({
      outcome: "rejected",
      reason: "safety_policy",
    });
    const action: AgentAction = {
      action: "write_file",
      params: { path: "bad.txt", content: "x" },
    };
    const result = await executeAction(action, worktree, deps);
    expect(result.success).toBe(false);
    expect(result.error).toContain("rejected");
  });
});

// ── executeAction: edit_file ─────────────────────────────────────────────────

describe("executeAction: edit_file", () => {
  it("edits file with unique old_string match", async () => {
    writeFileSync(join(worktree, "edit.ts"), "const x = 1;\nconst y = 2;\n");
    const action: AgentAction = {
      action: "edit_file",
      params: { path: "edit.ts", old_string: "const x = 1;", new_string: "const x = 42;" },
    };
    const result = await executeAction(action, worktree, makeDeps());
    expect(result.success).toBe(true);
    expect(readFileSync(join(worktree, "edit.ts"), "utf-8")).toBe("const x = 42;\nconst y = 2;\n");
  });

  it("returns error when old_string not found", async () => {
    writeFileSync(join(worktree, "edit.ts"), "const x = 1;");
    const action: AgentAction = {
      action: "edit_file",
      params: { path: "edit.ts", old_string: "NOT HERE", new_string: "new" },
    };
    const result = await executeAction(action, worktree, makeDeps());
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });

  it("returns error when old_string matches multiple times", async () => {
    writeFileSync(join(worktree, "edit.ts"), "foo\nfoo\n");
    const action: AgentAction = {
      action: "edit_file",
      params: { path: "edit.ts", old_string: "foo", new_string: "bar" },
    };
    const result = await executeAction(action, worktree, makeDeps());
    expect(result.success).toBe(false);
    expect(result.error).toContain("2 times");
  });
});

// ── executeAction: search/command ────────────────────────────────────────────

describe("executeAction: search and commands", () => {
  it("search_files returns error when no tool adapter", async () => {
    const action: AgentAction = {
      action: "search_files",
      params: { pattern: "*.ts" },
    };
    const result = await executeAction(action, worktree, makeDeps());
    expect(result.success).toBe(false);
    expect(result.error).toContain("No tool adapter");
  });

  it("run_command returns error when no tool adapter", async () => {
    const action: AgentAction = {
      action: "run_command",
      params: { command: "echo hello" },
    };
    const result = await executeAction(action, worktree, makeDeps());
    expect(result.success).toBe(false);
    expect(result.error).toContain("No tool adapter");
  });

  it("run_command passes ActionClasses.write to pipeline (Gate 2 enforcement)", async () => {
    const executeSpy = vi.fn(async () => ({
      outcome: "executed" as const,
      result: { success: true, output: "ok", error: null },
    }));
    const fakeToolAdapter = {
      execute: vi.fn(async () => ({ success: true, output: "ok", error: null })),
    };
    const deps = makeDeps({
      actionPipeline: { execute: executeSpy } as unknown as ActionExecutorDeps["actionPipeline"],
      toolAdapter: fakeToolAdapter as unknown as ActionExecutorDeps["toolAdapter"],
    });
    const action: AgentAction = {
      action: "run_command",
      params: { command: "echo hello" },
    };
    await executeAction(action, worktree, deps);
    expect(executeSpy).toHaveBeenCalledWith(
      expect.objectContaining({ actionClass: ActionClasses.write }),
    );
  });

  it("done action returns success immediately", async () => {
    const action: AgentAction = {
      action: "done",
      result: { status: "ok" },
    };
    const result = await executeAction(action, worktree, makeDeps());
    expect(result.success).toBe(true);
    expect(result.output).toBe("done");
  });
});

// ── executeAction: path security ─────────────────────────────────────────────

describe("executeAction: path security", () => {
  it("read_file rejects path traversal", async () => {
    const action: AgentAction = {
      action: "read_file",
      params: { path: "../../etc/passwd" },
    };
    const result = await executeAction(action, worktree, makeDeps());
    expect(result.success).toBe(false);
    expect(result.error).toContain("escapes worktree");
  });

  it("write_file rejects path traversal", async () => {
    const action: AgentAction = {
      action: "write_file",
      params: { path: "../../../tmp/evil.txt", content: "bad" },
    };
    const result = await executeAction(action, worktree, makeDeps());
    expect(result.success).toBe(false);
    expect(result.error).toContain("escapes worktree");
  });
});

// ── shellEscape ──────────────────────────────────────────────────────────────

describe("shellEscape", () => {
  it("wraps simple string in single quotes", () => {
    expect(shellEscape("simple")).toBe("'simple'");
  });

  it("escapes internal single quotes", () => {
    expect(shellEscape("it's")).toBe("'it'\\''s'");
  });

  it("neutralizes injection attempts", () => {
    const escaped = shellEscape("'; rm -rf / #");
    // The single quote is escaped: end-quote, backslash-quote, start-quote
    expect(escaped).toBe("''\\''; rm -rf / #'");
  });

  it("handles empty string", () => {
    expect(shellEscape("")).toBe("''");
  });

  it("handles string with multiple single quotes", () => {
    const escaped = shellEscape("a'b'c");
    expect(escaped).toBe("'a'\\''b'\\''c'");
  });
});

// ── resolveWorktreePathCanonical ──────────────────────────────────────────────────

describe("resolveWorktreePathCanonical", () => {
  it("resolves normal files within worktree", () => {
    writeFileSync(join(worktree, "normal.txt"), "ok");
    const result = resolveWorktreePathCanonical(worktree, "normal.txt");
    expect(result).toContain("normal.txt");
  });

  it("gracefully handles non-existent files (returns logical path)", () => {
    const result = resolveWorktreePathCanonical(worktree, "does-not-exist.txt");
    expect(result).toBe(join(worktree, "does-not-exist.txt"));
  });

  it("rejects path traversal", () => {
    expect(() => resolveWorktreePathCanonical(worktree, "../../etc/passwd")).toThrow(
      "escapes worktree",
    );
  });

  it("rejects symlinks pointing outside the worktree", () => {
    const outsideFile = join(tmpdir(), "outside-secret.txt");
    writeFileSync(outsideFile, "secret data");
    symlinkSync(outsideFile, join(worktree, "sneaky-link"));

    expect(() => resolveWorktreePathCanonical(worktree, "sneaky-link")).toThrow("escapes worktree");
  });

  it("read_file rejects symlink escape via executeAction", async () => {
    const outsideFile = join(tmpdir(), "outside-read-test.txt");
    writeFileSync(outsideFile, "should not be readable");
    symlinkSync(outsideFile, join(worktree, "escape-link"));

    const action: AgentAction = {
      action: "read_file",
      params: { path: "escape-link" },
    };
    const result = await executeAction(action, worktree, makeDeps());
    expect(result.success).toBe(false);
    expect(result.error).toContain("escapes worktree");
  });
});
