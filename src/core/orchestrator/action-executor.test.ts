import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentAction } from "../../schemas/orchestrator.js";
import { type ActionExecutorDeps, executeAction, resolveWorktreePath } from "./action-executor.js";

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
