import { realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ToolAdapter } from "../../adapters/tool.js";
import type { ActionResult, AgentAction } from "../../schemas/orchestrator.js";
import { ActionClasses } from "../../schemas/task.js";
import { extractErrorMessage } from "../../utils/errors.js";
import type { IActionPipeline } from "../interfaces/action-pipeline.interface.js";
import { WorkspaceEscapeError } from "./errors.js";

/**
 * Executes agent actions within a worktree.
 *
 * Maps AgentAction discriminated union to real operations: file I/O, search,
 * and command execution. All paths are resolved relative to the worktree root
 * and must not escape it (security boundary).
 */
export interface ActionExecutorDeps {
  actionPipeline: IActionPipeline;
  toolAdapter: ToolAdapter | null;
  taskId: string;
}

/**
 * Escape a string for safe inclusion in a shell command.
 * Wraps in single quotes, escaping internal single quotes with the
 * standard POSIX pattern: end quote, escaped literal quote, start quote.
 */
export function shellEscape(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Resolve a user-provided path against the worktree root.
 * Rejects paths that escape the worktree (e.g., `../../etc/passwd`).
 */
export function resolveWorktreePath(worktreePath: string, filePath: string): string {
  const resolved = resolve(worktreePath, filePath);
  if (!resolved.startsWith(worktreePath)) {
    throw new WorkspaceEscapeError(filePath);
  }
  return resolved;
}

/**
 * Resolve a path with symlink resolution for read operations on existing files.
 * Catches symlink-based worktree escapes that `resolveWorktreePath` misses.
 */
export function resolveWorktreePathCanonical(worktreePath: string, filePath: string): string {
  const resolved = resolve(worktreePath, filePath);
  if (!resolved.startsWith(worktreePath)) {
    throw new WorkspaceEscapeError(filePath);
  }
  // Resolve symlinks to catch symlink-based escape
  let real: string;
  try {
    real = realpathSync(resolved);
  } catch {
    // File doesn't exist — no symlink to follow, use the logical path
    return resolved;
  }
  const realWorktree = realpathSync(worktreePath);
  if (!real.startsWith(realWorktree)) {
    throw new WorkspaceEscapeError(filePath);
  }
  return real;
}

/**
 * Execute a single agent action. Returns an ActionResult.
 *
 * - File operations use Node fs directly (within worktree bounds).
 * - Commands go through the ToolAdapter via ActionPipeline (Gate 1 + Gate 2).
 * - `done` actions are not executed here (handled by the agent loop).
 */
export function executeAction(
  action: AgentAction,
  worktreePath: string,
  deps: ActionExecutorDeps,
): Promise<ActionResult> {
  switch (action.action) {
    case "read_file":
      return executeReadFile(action.params.path, worktreePath);
    case "write_file":
      return executeWriteFile(action.params.path, action.params.content, worktreePath, deps);
    case "edit_file":
      return executeEditFile(
        action.params.path,
        action.params.old_string,
        action.params.new_string,
        worktreePath,
        deps,
      );
    case "search_files":
      return executeSearchFiles(action.params.pattern, action.params.path, worktreePath, deps);
    case "search_content":
      return executeSearchContent(
        action.params.pattern,
        action.params.path,
        action.params.glob,
        worktreePath,
        deps,
      );
    case "run_command":
      return executeRunCommand(action.params.command, worktreePath, deps);
    case "done":
      return Promise.resolve({ success: true, output: "done" });
    default: {
      // Exhaustiveness check — TypeScript will error here if a new action type
      // is added to AgentAction without updating this switch.
      const _exhaustive: never = action;
      return Promise.resolve({
        success: false,
        output: "",
        error: `Unknown action: ${(_exhaustive as AgentAction).action}`,
      });
    }
  }
}

// ── Action Implementations ──────────────────────────────────────────────────────

async function executeReadFile(path: string, worktreePath: string): Promise<ActionResult> {
  try {
    const resolved = resolveWorktreePathCanonical(worktreePath, path);
    const content = await readFile(resolved, "utf-8");
    return { success: true, output: content };
  } catch (err) {
    return { success: false, output: "", error: extractErrorMessage(err) };
  }
}

async function executeWriteFile(
  path: string,
  content: string,
  worktreePath: string,
  deps: ActionExecutorDeps,
): Promise<ActionResult> {
  try {
    const resolved = resolveWorktreePath(worktreePath, path);

    const pipelineResult = await deps.actionPipeline.execute<void>({
      taskId: deps.taskId,
      actionClass: ActionClasses.write,
      details: { operation: "write_file", path },
      requestedBy: "orchestrator",
      executeFn: async () => {
        await mkdir(dirname(resolved), { recursive: true });
        await writeFile(resolved, content, "utf-8");
      },
    });

    if (pipelineResult.outcome !== "executed") {
      const reason = "reason" in pipelineResult ? pipelineResult.reason : "rejected";
      return { success: false, output: "", error: `Write rejected: ${reason}` };
    }

    return { success: true, output: `Wrote ${path}` };
  } catch (err) {
    return { success: false, output: "", error: extractErrorMessage(err) };
  }
}

async function executeEditFile(
  path: string,
  oldString: string,
  newString: string,
  worktreePath: string,
  deps: ActionExecutorDeps,
): Promise<ActionResult> {
  try {
    const resolved = resolveWorktreePathCanonical(worktreePath, path);
    const content = await readFile(resolved, "utf-8");

    if (!content.includes(oldString)) {
      return { success: false, output: "", error: `old_string not found in ${path}` };
    }

    const count = content.split(oldString).length - 1;
    if (count > 1) {
      return {
        success: false,
        output: "",
        error: `old_string matches ${String(count)} times in ${path} (must be unique)`,
      };
    }

    const updated = content.replace(oldString, newString);

    const pipelineResult = await deps.actionPipeline.execute<void>({
      taskId: deps.taskId,
      actionClass: ActionClasses.write,
      details: { operation: "edit_file", path },
      requestedBy: "orchestrator",
      executeFn: async () => {
        await writeFile(resolved, updated, "utf-8");
      },
    });

    if (pipelineResult.outcome !== "executed") {
      const reason = "reason" in pipelineResult ? pipelineResult.reason : "rejected";
      return { success: false, output: "", error: `Edit rejected: ${reason}` };
    }

    return { success: true, output: `Edited ${path}` };
  } catch (err) {
    return { success: false, output: "", error: extractErrorMessage(err) };
  }
}

function executeSearchFiles(
  pattern: string,
  searchPath: string | undefined,
  worktreePath: string,
  deps: ActionExecutorDeps,
): Promise<ActionResult> {
  const dir = searchPath ? resolveWorktreePath(worktreePath, searchPath) : worktreePath;
  return runToolCommand(
    `find ${shellEscape(dir)} -name ${shellEscape(pattern)} -type f 2>/dev/null | head -50`,
    worktreePath,
    deps,
  );
}

function executeSearchContent(
  pattern: string,
  searchPath: string | undefined,
  globPattern: string | undefined,
  worktreePath: string,
  deps: ActionExecutorDeps,
): Promise<ActionResult> {
  const dir = searchPath ? resolveWorktreePath(worktreePath, searchPath) : worktreePath;
  const globFlag = globPattern ? `--include=${shellEscape(globPattern)}` : "";
  return runToolCommand(
    `grep -rn ${globFlag} -- ${shellEscape(pattern)} ${shellEscape(dir)} 2>/dev/null | head -100`,
    worktreePath,
    deps,
  );
}

function executeRunCommand(
  command: string,
  worktreePath: string,
  deps: ActionExecutorDeps,
): Promise<ActionResult> {
  return runToolCommand(command, worktreePath, deps);
}

// ── Shared Helpers ──────────────────────────────────────────────────────────────

async function runToolCommand(
  command: string,
  worktreePath: string,
  deps: ActionExecutorDeps,
): Promise<ActionResult> {
  if (!deps.toolAdapter) {
    return { success: false, output: "", error: "No tool adapter available" };
  }

  const tool = deps.toolAdapter;
  try {
    const pipelineResult = await deps.actionPipeline.execute({
      taskId: deps.taskId,
      actionClass: ActionClasses.write,
      details: { operation: "run_command", command },
      requestedBy: "orchestrator",
      executeFn: () =>
        tool.execute("run", { command }, { workspace_path: worktreePath, task_id: deps.taskId }),
    });

    if (pipelineResult.outcome !== "executed") {
      const reason = "reason" in pipelineResult ? pipelineResult.reason : "rejected";
      return { success: false, output: "", error: `Command rejected: ${reason}` };
    }

    const result = pipelineResult.result;
    return {
      success: result.success,
      output: result.output,
      error: result.error ? result.error.message : undefined,
    };
  } catch (err) {
    return { success: false, output: "", error: extractErrorMessage(err) };
  }
}
