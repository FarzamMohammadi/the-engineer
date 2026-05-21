# Phase 6: Workspace & Session Setup

---

## Flow

```
orchestrator.executeTask(dispatch)
    │
    ├─ 1. Generate trace ID (ULID)
    ├─ 2. Create session
    │      ├─ Resume: link to previous session + checkpoint
    │      └─ Fresh: standalone session
    ├─ 3. Update task.session_id
    ├─ 4. Setup workspace
    │      ├─ New task: clone repo → create branch → create worktree
    │      ├─ Rework: registerExistingWorkspace() (worktree preserved)
    │      └─ Child task: branch from parent's branch
    ├─ 5. Update task.workspace { repo, branch, worktree_path }
    ├─ 6. Notify milestone (Telegram + GitHub)
    ├─ 7. Comment on source issue: "Starting work on this issue."
    └─ 8. Build PipelineState { traceId, sessionId, loopbackCount: 0 }
           │
           ▼
         Phase 7: runPhasePipeline()
```

---

## Production Files

| # | File | Role |
|---|------|------|
| 1 | `src/core/orchestrator/index.ts` | `executeTask()` — session + workspace + pipeline entry |
| 2 | `src/core/orchestrator/workspace-lifecycle.ts` | Workspace setup helpers, notification routing |
| 3 | `src/core/workspace-manager/index.ts` | Git operations: clone, branch, worktree, push |

---

## Session Creation

**Fresh dispatch:**
```
sessionMemory.createSession({ taskId })
```

**Resume from checkpoint:**
```
sessionMemory.createSession({
  taskId,
  previousSessionId: checkpoint.session_id,
  resumedFromCheckpoint: checkpoint.id
})
```

Sessions form a chain per task — each rework or resume creates a new session linked to the previous one.

---

## Workspace Creation: 3 Cases

### Case 1: New Task
```
workspaceManager.createWorkspace(taskId, repo, title, baseBranch, null, cloneUrl)
```

Steps:
1. **Determine base ref**: `parentBranch ?? baseBranch ?? config.default_base_branch`
2. **Slug + branch**: `slugify(title)` → `engineer/{taskId}-{slug}`
3. **Ensure repo cloned**: `git clone` with transient token injection (D147)
4. **Fetch latest** (if configured): `git fetch origin`
5. **Create branch**: `git branch {branch} origin/{base}`
6. **Create worktree**: `git worktree add {path} {branch}`
7. **Emit**: `workspace.created` event

### Case 2: Rework (Existing Workspace)
```
workspaceManager.registerExistingWorkspace(taskId, task.workspace)
```

Worktree was preserved during `review_pending` — no git operations needed.

### Case 3: Child Task
```
workspaceManager.createWorkspace(taskId, repo, title, baseBranch, parentBranch, cloneUrl)
```

Uses `parentBranch` as the base — child branches off parent's work.

---

## Authentication (D145, D148, D151)

- Token read from `process.env[config.git_token_env]` at operation time
- **Clone**: inject into URL → `https://{token}@github.com/...` → then reset remote to unauthenticated URL
- **Push**: inject into explicit URL → `git push -u {authUrl} {branch}`
- Token **never** persisted on disk or in `.git/config`

---

## Milestone Notifications

**Personal channel** (Telegram):
1. `peopleDirectory.getOwner()` → owner contacts
2. Find matching comm plugin by channel
3. `plugin.sendMessage(target, formatted)` — fire-and-forget

**Public channel** (GitHub issue):
1. Extract `task.external_ref` (github_issue or github_pr)
2. Find comm plugin with `issue_management` capability
3. `plugin.commentOnIssue(repo, number, message)` — fire-and-forget

All notifications are `.catch(err => logger.error(err))` — never block the pipeline.

---

## Workspace Verification (on resume)

```
workspaceManager.verifyWorkspace(taskId)
```

| Status | Meaning | Recovery |
|--------|---------|----------|
| `valid` | Worktree exists, branch intact | None needed |
| `recoverable` | Worktree gone, branch exists | Recreate worktree from branch |
| `lost` | Both gone | Task must restart from scratch |

---

## Test Files

| File | Type |
|------|------|
| `src/core/workspace-manager/index.test.ts` | Unit — clone, branch, worktree |
| `src/core/orchestrator/workspace-lifecycle.test.ts` | Unit — setup helpers |
| `test/integration/` | Integration tests cover full dispatch→workspace flow |
