# Phase R8: Security Hardening

## Identity

You are an implementation agent for **The Engineer** -- an autonomous software engineering agent built in TypeScript/Node.js. You are executing Phase R8 of Layer 7 (Structural Restructuring). You operate with zero prior context. Everything you need is in this prompt.

Read `docs/persona.md` and `docs/philosophy.md` before starting -- they define who The Engineer is and how it thinks. Your work must embody those principles.

**Security context:** The Engineer is an autonomous agent that receives instructions from external sources (GitHub issues), executes shell commands in workspaces, and sends data to LLMs. Every input/output boundary is a potential attack surface. This phase hardens those boundaries.

---

## Architecture Catchup

The Engineer is a three-tier system:

- **Core** (invariant brain): EventBus, TaskEngine, Orchestrator, Daemon, Registry, SafetyLayer, ActionPipeline, SessionMemory, WorkspaceManager, PeopleDirectory
- **Adapters** (stable contracts): TriggerAdapter, CommunicationAdapter, LLMAdapter, ToolAdapter, GitHostingAdapter
- **Plugins** (swappable implementations): GitHubTrigger, GitHubComm, GitHubHosting, TelegramComm, ClaudeCodeLLM, BashTool

Tech stack: TypeScript (strict), Node.js 22 LTS, pnpm, ESM, SQLite (better-sqlite3), Zod, Vitest, Biome.

### Key Files to Read First

Read these files to understand the current state before making changes:

1. `src/plugins/tool/bash-tool/bash-tool.ts` -- BashToolPlugin: `spawn("bash", ["-c", cmd])`, env allowlist, workspace confinement, output limits, command timeout. **Note the GIT_* wildcard passthrough on lines 199-203.**
2. `src/plugins/tool/bash-tool/config.ts` -- BashToolConfig schema (command_timeout_ms, max_output_bytes, env_passthrough)
3. `src/utils/sanitize.ts` -- `sanitizeSecrets()`: redacts GITHUB_TOKEN, TELEGRAM_BOT_TOKEN from output. Currently applied to LLM output and journal entries but NOT to LLM input.
4. `src/core/orchestrator/agent-loop.ts` -- Agent loop: builds prompts, calls LLM, parses responses. Uses `sanitizeSecrets()` on LLM response content (line 9 import, find usage).
5. `src/core/orchestrator/prompts/context.ts` -- Builds repo context for LLM prompts (file contents, git log, etc.)
6. `src/core/orchestrator/prompts/system.ts` -- System prompt builder
7. `src/core/workspace-manager/index.ts` -- WorkspaceManager: creates git worktrees, workspace paths derived from task IDs. **No symlink/realpath validation.**
8. `src/core/orchestrator/action-executor.ts` -- ActionExecutor: maps agent actions to tool calls, passes workspace_path to tools
9. `src/core/safety-layer/index.ts` -- SafetyLayer: evaluateAction with action_class and scope parameters. **No input validation on scope fields.**
10. `src/core/session-memory/index.ts` -- SessionMemory: stores journal entries (sanitized), checkpoint data
11. `src/schemas/task.ts` -- ActionClassSchema and related types
12. `implementation-docs/7-restructure/assessment.md` -- Security Gaps section (5 items)
13. `implementation-docs/7-restructure/decisions.md` -- Decision log (D166+)

### Related Layer 7 Context

This phase runs in **Wave 3** (parallel with R5, R6, R7). It depends on Wave 1 (R0) and Wave 2 being complete. This phase has no dependencies on other Wave 3 phases. Security hardening touches multiple components but does not change their public APIs.

---

## Problem Statement

From the assessment:

> **Security Gaps:**
> - Command injection surface in BashTool (no pattern blocking)
> - Secret leakage to LLM context (output sanitized, input not)
> - Workspace escape via symlinks (no realpath canonicalization)
> - GIT_* env wildcard passthrough
> - No input validation on safety scope parameters

These are real attack surfaces. An adversary who can create a GitHub issue assigned to The Engineer could potentially:
1. Craft issue text that tricks the LLM into running destructive commands
2. Exfiltrate secrets via LLM context that contains unsanitized env vars
3. Escape the workspace via symlinks to read/write files outside the worktree
4. Abuse GIT_* env passthrough to inject arbitrary git configuration
5. Bypass safety checks via malformed scope parameters

---

## Exact Specifications

### 1. Command Validation in BashTool

Add a command validation layer to `BashToolPlugin` that blocks dangerous patterns before execution.

#### Modify `src/plugins/tool/bash-tool/config.ts`

Add a `blocked_patterns` field to the config schema:

```typescript
export const BashToolConfigSchema = z.object({
  command_timeout_ms: z.number().int().positive().default(120_000),
  max_output_bytes: z.number().int().positive().default(1_048_576),
  env_passthrough: z.array(z.string()).default([]),
  // NEW: Patterns that are blocked from execution
  blocked_patterns: z.array(z.string()).default([
    // Credential/secret exfiltration
    "curl.*env",
    "wget.*env",
    "cat.*/etc/shadow",
    "cat.*/etc/passwd",
    // Destructive operations outside workspace
    "rm\\s+-rf\\s+/",
    "rm\\s+-rf\\s+~",
    "mkfs\\.",
    "dd\\s+if=",
    // Process/system manipulation
    "kill\\s+-9",
    "killall",
    "shutdown",
    "reboot",
    // Network exfiltration
    "nc\\s+-l",
    "ncat",
    "socat",
    // Env dumping (secrets)
    "\\benv\\b",
    "printenv",
    "set\\s*$",
    "export\\s*$",
  ]),
  // NEW: Whether to audit all commands (log to event bus)
  audit_commands: z.boolean().default(true),
});
```

#### Modify `src/plugins/tool/bash-tool/bash-tool.ts`

Add a `validateCommand()` method that runs before `spawnAndCollect()`:

```typescript
/**
 * Validate a command against blocked patterns.
 * Returns null if the command is safe, or a rejection reason if blocked.
 */
function validateCommand(command: string, blockedPatterns: string[]): string | null {
  for (const pattern of blockedPatterns) {
    const regex = new RegExp(pattern, "i");
    if (regex.test(command)) {
      return `Command blocked: matches pattern "${pattern}"`;
    }
  }
  return null;
}
```

In `doExecute()`, call `validateCommand()` before `spawnAndCollect()`. If blocked:
- Return a `ToolResult` with `success: false` and a clear error message
- If `audit_commands` is true, the command should still be logged (the caller -- ActionPipeline -- handles event emission)

Add audit logging: when `audit_commands` is true, include the full command in the `side_effects` array regardless of success/failure. This is already partially done via the `command_run` side effect -- ensure it always includes the full command string.

### 2. LLM Context Sanitization (Input Side)

Currently `sanitizeSecrets()` is only applied to LLM **output** (response content). It must also be applied to all **input** going to the LLM.

#### Modify `src/core/orchestrator/agent-loop.ts`

Find where the prompt is assembled and sent to the LLM. Apply `sanitizeSecrets()` to:
1. The `initialPrompt` before it enters the LLM context
2. Any tool execution results that are fed back into the conversation
3. The `systemPrompt` before it enters the LLM context

The key chokepoints are:
- The initial prompt sent in the first LLM call
- Action results that are appended to the conversation history
- Any file contents or git output included in context

Look for where `CompletionRequest` is constructed and wrap the prompt field:

```typescript
const request: CompletionRequest = {
  prompt: sanitizeSecrets(assembledPrompt),
  system_prompt: sanitizeSecrets(systemPrompt),
  options: { ... },
};
```

Also sanitize action results before they are added to conversation history:

```typescript
// When feeding tool results back to LLM
const sanitizedOutput = sanitizeSecrets(actionResult.output);
```

#### Modify `src/utils/sanitize.ts`

Expand the secret detection:

```typescript
const SECRET_ENV_VARS = [
  "GITHUB_TOKEN",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "CLAUDE_API_KEY",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "NPM_TOKEN",
  "DOCKER_PASSWORD",
  "DATABASE_URL",
];
```

Add a pattern-based detection for common secret formats:

```typescript
/** Patterns that look like API keys/tokens regardless of env var. */
const SECRET_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // GitHub tokens (ghp_, gho_, ghs_, ghr_, github_pat_)
  { pattern: /\b(ghp_[a-zA-Z0-9]{36,})\b/g, replacement: "[REDACTED:github_token]" },
  { pattern: /\b(gho_[a-zA-Z0-9]{36,})\b/g, replacement: "[REDACTED:github_token]" },
  { pattern: /\b(ghs_[a-zA-Z0-9]{36,})\b/g, replacement: "[REDACTED:github_token]" },
  { pattern: /\b(ghr_[a-zA-Z0-9]{36,})\b/g, replacement: "[REDACTED:github_token]" },
  { pattern: /\b(github_pat_[a-zA-Z0-9_]{36,})\b/g, replacement: "[REDACTED:github_pat]" },
  // AWS keys
  { pattern: /\b(AKIA[A-Z0-9]{16})\b/g, replacement: "[REDACTED:aws_key]" },
  // Generic long hex/base64 strings that look like secrets (40+ chars)
  // Be conservative -- only match in contexts that look like assignments
  { pattern: /(?:token|secret|password|key|api_key|apikey)["']?\s*[:=]\s*["']?([a-zA-Z0-9_\-/.]{40,})["']?/gi, replacement: "[REDACTED:secret_value]" },
];
```

Apply these patterns in `sanitizeSecrets()` after the env var replacement phase.

### 3. Workspace Escape Prevention

Add `realpathSync` canonicalization to prevent symlink-based workspace escapes.

#### Modify `src/core/workspace-manager/index.ts`

Add a workspace path validation function:

```typescript
import { realpathSync } from "node:fs";

/**
 * Validate that a path is within the expected workspace root.
 * Uses realpathSync to resolve symlinks before comparison.
 * Throws if the resolved path is outside the workspace root.
 */
export function validateWorkspacePath(path: string, workspaceRoot: string): string {
  const resolvedPath = realpathSync(path);
  const resolvedRoot = realpathSync(workspaceRoot);

  if (!resolvedPath.startsWith(resolvedRoot + "/") && resolvedPath !== resolvedRoot) {
    throw new Error(
      `Workspace escape detected: "${path}" resolves to "${resolvedPath}" which is outside workspace root "${resolvedRoot}"`
    );
  }

  return resolvedPath;
}
```

Apply this validation in:
1. `createWorkspace()` -- after the worktree path is determined, validate it resolves within the workspace root
2. `verifyWorkspace()` -- validate the stored path still resolves correctly

#### Modify `src/core/orchestrator/action-executor.ts`

Before passing `workspace_path` to any tool execution, validate the path:

```typescript
import { validateWorkspacePath } from "../workspace-manager/index.js";

// In the action execution path:
const validatedPath = validateWorkspacePath(worktreePath, workspaceRoot);
```

#### Modify `src/plugins/tool/bash-tool/bash-tool.ts`

Add workspace path validation in `doExecute()`:

```typescript
import { realpathSync } from "node:fs";

// In doExecute(), before spawnAndCollect():
try {
  const resolvedCwd = realpathSync(context.workspace_path);
  // Verify the resolved path still looks like a workspace (contains .git or is within a git worktree)
  // This prevents symlink escapes where the workspace_path itself is a symlink to /etc or /
} catch {
  return {
    success: false,
    output: "",
    side_effects: [],
    error: createAdapterError("workspace_invalid", "Workspace path could not be resolved"),
  };
}
```

### 4. Git Env Explicit Allowlist

Replace the GIT_* wildcard passthrough with an explicit allowlist.

#### Modify `src/plugins/tool/bash-tool/bash-tool.ts`

Current code (lines 199-203):
```typescript
for (const [key, value] of Object.entries(process.env)) {
  if (key.startsWith("GIT_") && value !== undefined) {
    env[key] = value;
  }
}
```

Replace with an explicit allowlist:

```typescript
/** Git environment variables that are safe to pass through. */
const GIT_ENV_ALLOWLIST = [
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "GIT_SSH_COMMAND",
  "GIT_TERMINAL_PROMPT",  // Should be "0" to prevent interactive prompts
];
```

Remove the wildcard loop. The `GIT_AUTHOR_NAME`, `GIT_COMMITTER_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_EMAIL` entries are already in `ENV_ALLOWLIST` so they will be covered. Add `GIT_SSH_COMMAND` and `GIT_TERMINAL_PROMPT` to `ENV_ALLOWLIST`.

The final `ENV_ALLOWLIST` should be:

```typescript
const ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "NODE_ENV",
  "LANG",
  "TERM",
  "GIT_AUTHOR_NAME",
  "GIT_COMMITTER_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_EMAIL",
  "GIT_SSH_COMMAND",
  "GIT_TERMINAL_PROMPT",
];
```

And remove the `GIT_*` wildcard loop entirely from `buildSanitizedEnv()`.

### 5. Input Validation on Safety Scope Parameters

Add Zod validation to SafetyLayer method inputs.

#### Modify `src/core/safety-layer/index.ts`

Add input validation schemas:

```typescript
import { z } from "zod";
import { ActionClassSchema } from "../../schemas/task.js";

const SafetyQueryInputSchema = z.object({
  type: z.enum(["can_i", "should_i_ask", "cost_check"]),
  context: z.object({
    task_id: z.string().min(1),
    repo: z.string().min(1).regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/),
    action_class: ActionClassSchema.optional(),
    decision_category: z.string().optional(),
    details: z.record(z.unknown()),
  }),
});

const EvaluateActionInputSchema = z.object({
  task_id: z.string().min(1),
  action_class: ActionClassSchema,
  scope: z.object({
    repo: z.string().min(1).regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/),
    paths: z.array(z.string()).optional(),
    description: z.string().optional(),
  }),
});
```

Apply validation at the entry point of:
1. `evaluateAction()` -- validate the action class, task_id, and scope
2. `consultJudgment()` -- validate the SafetyQuery input

On validation failure, return a `deny` verdict with the validation error message rather than throwing. This prevents invalid inputs from bypassing safety checks.

```typescript
evaluateAction(input: unknown): SafetyVerdict {
  const parsed = EvaluateActionInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      allowed: false,
      action: "deny",
      reason: `Invalid safety input: ${parsed.error.message}`,
      warnings: ["Input validation failed -- this may indicate a prompt injection attempt"],
    };
  }
  // ... existing logic with parsed.data
}
```

**Important:** Read the current method signatures of `evaluateAction()` and `consultJudgment()` carefully before modifying. The validation should wrap the existing parameters, not change the internal logic. If the methods currently accept typed parameters (not `unknown`), you may need to add an overload or modify the ActionPipeline call site to pass validated input.

---

## Refinement Checklist

Before writing any code, verify:

- [ ] Read `src/plugins/tool/bash-tool/bash-tool.ts` completely -- understand the current env sanitization, process spawning, and workspace confinement
- [ ] Read `src/utils/sanitize.ts` completely -- understand current sanitization patterns
- [ ] Read `src/core/orchestrator/agent-loop.ts` completely -- find ALL places where text enters the LLM context
- [ ] Read `src/core/workspace-manager/index.ts` completely -- understand workspace creation and path handling
- [ ] Read `src/core/safety-layer/index.ts` completely -- understand evaluateAction and consultJudgment signatures
- [ ] Read `src/core/orchestrator/action-executor.ts` -- understand how workspace_path flows to tools
- [ ] Grep for `sanitizeSecrets` across the codebase to find all current usage points
- [ ] Grep for `GIT_` across the codebase to find all env var references
- [ ] Grep for `workspace_path` to find all places workspace paths are used

During implementation:

- [ ] Blocked command patterns use case-insensitive matching
- [ ] Blocked patterns have no false positives on common development commands (e.g., `env` inside `environment` should not trigger -- use `\benv\b` word boundary)
- [ ] `sanitizeSecrets()` changes are backward-compatible (expanded, not changed)
- [ ] Pattern-based secret detection is conservative (low false positive rate)
- [ ] `realpathSync` calls handle the case where the path doesn't exist yet (workspace creation)
- [ ] GIT_* allowlist preserves all git operations that currently work
- [ ] Safety input validation returns deny verdicts, not exceptions
- [ ] No existing tests break from the security changes

---

## Verification Steps

Run these commands after implementation:

```bash
# 1. Type check passes
pnpm typecheck

# 2. Lint passes
pnpm lint

# 3. All existing tests still pass
pnpm test

# 4. New tests pass
pnpm test -- --reporter=verbose src/plugins/tool/bash-tool/bash-tool.test.ts
pnpm test -- --reporter=verbose src/utils/sanitize.test.ts
pnpm test -- --reporter=verbose src/core/workspace-manager/index.test.ts
pnpm test -- --reporter=verbose src/core/safety-layer/index.test.ts

# 5. Verify GIT_* wildcard is gone
grep -n "startsWith.*GIT_" src/plugins/tool/bash-tool/bash-tool.ts  # should return 0 lines

# 6. Verify sanitizeSecrets is used in agent-loop input path
grep -n "sanitizeSecrets" src/core/orchestrator/agent-loop.ts  # should show input + output usage

# 7. Verify workspace validation exists
grep -n "realpathSync\|validateWorkspacePath" src/core/workspace-manager/index.ts

# 8. Verify blocked_patterns in config
grep -n "blocked_patterns" src/plugins/tool/bash-tool/config.ts

# 9. Build succeeds
pnpm build
```

---

## Test Requirements

### New tests in `src/plugins/tool/bash-tool/bash-tool.test.ts` (add to existing file)

1. **Blocked patterns**: Commands matching blocked patterns return failure with clear message
2. **Pattern specificity**: Common dev commands (e.g., `echo $HOME`, `ls -la`, `git status`) are NOT blocked
3. **Case insensitivity**: `Curl` and `CURL` are blocked same as `curl`
4. **Word boundaries**: `environment` is not blocked by `\benv\b` pattern
5. **Custom patterns**: User-configured blocked_patterns are applied
6. **Audit logging**: Commands include full command string in side_effects when audit_commands=true

### New tests in `src/utils/sanitize.test.ts` (add to existing file)

1. **GitHub token patterns**: `ghp_`, `gho_`, `ghs_`, `ghr_`, `github_pat_` are redacted
2. **AWS key pattern**: `AKIA...` strings are redacted
3. **Assignment pattern**: `token=abc...xyz` style assignments are redacted
4. **No false positives**: Normal code/text is not redacted
5. **Expanded env vars**: New env vars in the list are redacted when present
6. **Composition**: Multiple patterns in one string are all caught

### New tests in `src/core/workspace-manager/index.test.ts` (add to existing file)

1. **Valid path**: Path within workspace root passes validation
2. **Symlink escape**: Symlink pointing outside workspace root is caught
3. **Exact root**: Path equal to workspace root passes
4. **Missing path**: Non-existent path throws appropriate error
5. **Parent traversal**: Path with `../` that resolves outside root is caught

### New tests in `src/core/safety-layer/index.test.ts` (add to existing file)

1. **Valid input**: Well-formed input passes validation and proceeds normally
2. **Invalid task_id**: Empty string task_id returns deny verdict
3. **Invalid repo format**: Malformed repo string returns deny verdict
4. **Invalid action_class**: Unknown action class returns deny verdict
5. **Missing required fields**: Missing context fields return deny verdict

---

## Commit Instructions

When complete, create a single commit:

```
Add security hardening: command validation, input sanitization, workspace escapes, env allowlist (R8)

- BashTool blocked_patterns with audit logging
- sanitizeSecrets on ALL LLM input (not just output)
- Expanded secret detection (GitHub PATs, AWS keys, pattern-based)
- Workspace escape prevention via realpathSync canonicalization
- Explicit GIT_* env allowlist (replaces wildcard passthrough)
- Zod validation on SafetyLayer scope parameters
```

Do NOT push. The commit stays local.

---

## Constraints

- Do not add external dependencies -- all security hardening uses Node.js builtins and Zod (already present)
- Blocked patterns must have reasonable defaults but be configurable via `bash-tool.yaml`
- Secret pattern detection must be conservative -- false negatives are acceptable, false positives are not
- `realpathSync` must handle the case where workspace is being created (path may not exist yet -- use try/catch)
- Safety validation must return deny verdicts, never throw (deny-by-default on invalid input)
- All changes must be backward-compatible -- no public API changes
- Biome lint must pass (`pnpm lint`)
- TypeScript strict mode must pass (`pnpm typecheck`)
- All existing tests must continue to pass
