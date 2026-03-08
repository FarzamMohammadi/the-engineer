# Workspace Manager -- Layer 2 Design

The Workspace Manager handles per-task git isolation -- branches, worktrees, commits, PRs. It keeps tasks from stepping on each other. It is a pure git operations service: no LLM, no intelligence, no autonomous behavior. Other components tell it what to do; it executes mechanically.

Part of **Layer 2** -- see [`layers.md`](layers.md). Resolves gap: #11.

---

## Proven Systems

The Workspace Manager derives from three proven patterns:

| Proven system | What we take | Applied as |
|---------------|-------------|------------|
| **OS process address spaces** | Each process gets isolated virtual memory. Processes share the kernel but cannot see each other's memory. Fork creates a new address space cheaply from the parent. | Git worktrees as isolated address spaces. Shared `.git` directory is the "kernel." Child tasks fork their workspace from the parent's branch, like `fork()` creating a child process from parent memory. |
| **Git's worktree model** | `git worktree add` creates a lightweight checkout sharing the same `.git` directory. Multiple worktrees exist simultaneously, each on a different branch. Cheap to create and remove. | One worktree per task. Worktrees are ephemeral (tied to task lifecycle); branches are the persistent artifacts. The `.git` dir is never duplicated. |
| **Container runtimes (Docker/OCI)** | Layered filesystems. Containers share a base image but have their own writable layer. Containers are cheap to create and destroy. The image (base) persists; the container (instance) is ephemeral. | The repo clone is the "image." Each worktree is a "container" -- an ephemeral writable layer over the shared base. Parent branches are base layers; child branches are overlay layers on top. |

**Key insight from proven systems:** Isolation should be cheap, structural, and disposable. Expensive isolation (full clones) is unnecessary when the underlying system provides lightweight mechanisms (worktrees). The persistent artifact is the branch (like the container image), not the worktree (like the running container).

---

## What the Workspace Manager Owns (and Doesn't)

| Concern | Owner | Why |
|---------|-------|-----|
| **Worktree lifecycle** (create, verify, remove) | Workspace Manager | Pure git operation, per-task isolation |
| **Branch lifecycle** (create, push, delete) | Workspace Manager | Branch naming, creation from correct base |
| **Commit operations** (stage, commit, push) | Workspace Manager | Mechanical git operations |
| **PR lifecycle** (create draft, update, mark ready, merge) | Workspace Manager | Git hosting operations (GitHub API) |
| **Parent-child branch relationships** | Workspace Manager | Structural -- children branch from parent |
| **Multi-repo workspace coordination** (interface) | Workspace Manager | Workspace-level concern, cross-repo branching |
| **Workspace verification** (branch exists, commit exists) | Workspace Manager | Called during checkpoint resume |
| What to commit (content decisions) | Orchestrator | The Orchestrator decides what changes to make |
| When to commit (timing decisions) | Orchestrator | Phase-driven judgment |
| PR description content | Orchestrator | Reasoning and narrative |
| When to open/update PR | Orchestrator | Phase transitions drive PR actions |
| Branch/file scope policy enforcement | Safety Layer | Policy, not mechanics |
| Workspace field on Task object | Task Engine | Task Engine updates workspace field after Workspace Manager creates it |

**The boundary:** The Orchestrator decides *what* and *when*. The Workspace Manager executes *how*. The Safety Layer checks *if it's allowed*. The Task Engine records the result.

---

## Workspace Lifecycle

Workspace creation is tied to task scheduling, not task creation. A workspace involves filesystem operations, so it should not be created speculatively.

### Lifecycle Table

| Task state transition | Workspace action | Rationale |
|----------------------|-----------------|-----------|
| Intake -> Queued | Nothing | Task may never run (failed validation, deprioritized) |
| Queued -> Active.Working | **Create workspace** | Task is about to be worked on. Worktree needed. |
| Active.Working -> Queued (preemption) | **Worktree persists** | Branch and worktree stay in place. Context is checkpointed. When resumed, worktree is still there. |
| Active.Working -> Blocked | **Worktree persists** | Task will resume when unblocked. |
| Active.Working -> Review_Pending | **Worktree persists** | May need to apply feedback. |
| Review_Pending -> Active.Working (feedback) | **Verify worktree** | Confirm worktree still exists. If not (crash recovery), recreate from branch. |
| Active.Supervising -> Active.Integrating | **Verify/reactivate parent worktree** | Parent's worktree may have been idle. Verify or recreate. |
| -> Completed | **Cleanup** | Remove worktree. Branch deleted after merge (configurable). |
| -> Failed | **Cleanup with evidence** | Remove worktree. Branch kept (evidence preservation). |

### Preemption Handling

When a task is preempted (Active.Working -> Queued), its worktree is NOT removed. The worktree sits idle on disk. In single-core mode, only one task is Active.Working at a time, but a preempted task's worktree coexists with the new task's worktree (git supports multiple worktrees simultaneously). This avoids the cost of teardown/recreation on resume.

### Crash Recovery

If the Daemon detects a crash and the Orchestrator restarts, the Workspace Manager verifies the workspace: does the worktree directory exist? Is it on the correct branch? Is the expected commit present? If the worktree was corrupted or lost, it recreates from the branch (the branch is the persistent artifact).

### Cleanup Policy

| Task outcome | Worktree | Branch | PR |
|-------------|----------|--------|-----|
| Completed (PR merged) | Remove | Deleted after merge (configurable: keep for N days) | Closed (merged) |
| Completed (no PR) | Remove | Deleted | N/A |
| Failed | Remove | **Kept** (evidence) | Closed (not merged), labeled |
Branch deletion after merge is configurable. Default: delete after merge (standard GitHub flow). Can be configured to retain for N days for audit purposes.

**Note:** There is no "Cancelled" state in the Task Engine state machine. Cancellation is handled as Failed with reason "cancelled by user." The Failed cleanup policy applies: worktree removed, branch kept for evidence.

---

## Worktree Model

### Filesystem Layout

```
{workspace_root}/
  {repo-name}/                         # The primary clone
    .git/                               # Shared git data
  worktrees/
    {repo-name}/
      {task-id}-{slug}/                 # One worktree per task
        <full repo checkout>
```

**Path convention:**
- `workspace_root`: Configurable base path (default: `~/.engineer/workspaces/`)
- Worktree path: `{workspace_root}/worktrees/{repo-name}/{task-id}-{slug}/`
- Example: `~/.engineer/workspaces/worktrees/my-app/47-dark-mode/`

### Worktree Creation

When a task transitions Queued -> Active.Working:

1. Workspace Manager receives `createWorkspace(task)` call
2. Ensure primary clone exists (clone if first task for this repo)
3. Fetch latest from remote: `git fetch origin` (on the primary clone)
4. Create branch from the appropriate base:
   - Top-level task: branch from `origin/{default_base_branch}` (usually `main`)
   - Child task: branch from parent's branch (which may already have completed siblings' work)
5. Create worktree: `git worktree add {worktree_path} {branch_name}`
6. Return workspace reference to Task Engine for storage on Task object

### Worktree Verification

Called during checkpoint resume (Session/Memory resume flow, step 7):

```
WorkspaceVerification {
  worktree_exists:    boolean    (directory exists and is valid git worktree)
  branch_exists:      boolean    (branch ref exists locally and/or remotely)
  commit_exists:      boolean    (the expected commit SHA is reachable)
  current_commit:     string     (actual HEAD of the branch)
  diverged:           boolean    (remote has new commits not in local)
  status:             "valid" | "recoverable" | "lost"
}
```

Recovery actions by status:
- **valid**: Worktree is intact, branch is at expected commit. Resume.
- **recoverable**: Worktree missing but branch exists. Recreate worktree from branch.
- **lost**: Branch deleted or force-pushed over. Cannot resume workspace. Task should be flagged for human attention.

---

## Branch Naming Convention

### Top-Level Tasks

```
engineer/{task-id}-{slug}
```

- `task-id`: The internal task ID (or external ref number for GitHub issues)
- `slug`: A short kebab-case slug derived from the task title (max 30 chars, sanitized)
- Example: `engineer/47-dark-mode-toggle`

### Child Tasks

```
engineer/{parent-task-id}/{child-task-id}-{slug}
```

- Children branch from the parent's branch, and their names are namespaced under the parent
- Example: `engineer/50-jwt-migration/51-jwt-utils`
- Nested children (grandchildren): `engineer/50-jwt-migration/51-jwt-utils/60-token-validation`

### Multi-Repo Convention

When a task spans multiple repos, branches use the same name across all repos for traceability:

```
engineer/{task-id}-{slug}        # Same branch name in all repos
```

### Branch Name Validation

Before creating a branch, the Workspace Manager validates the name against the Safety Layer's `scope.branches.create_pattern` (default: `engineer/.*`). This is a passive Safety Layer check (the Workspace Manager calls the Safety Layer, not the other way around). If the name doesn't match, the operation fails with an error.

---

## Parent-Child Workspace Relationships

### Branch Hierarchy

```
main
  └── engineer/50-jwt-migration                    (parent branch)
        ├── engineer/50-jwt-migration/51-jwt-utils  (child branch)
        ├── engineer/50-jwt-migration/52-middleware  (child branch)
        ├── engineer/50-jwt-migration/53-endpoints   (child branch)
        ├── engineer/50-jwt-migration/54-routes       (child branch)
        └── engineer/50-jwt-migration/55-cleanup      (child branch)
```

### Progressive Merge

When a child task completes, its branch is merged into the parent branch **immediately** -- not deferred to Active.Integrating. This ensures dependent siblings get prior siblings' actual code, not just knowledge summaries.

**Flow:**

```
1. Parent #50 enters Active.Working
   → Workspace Manager creates branch engineer/50-jwt-migration from origin/main
   → Orchestrator researches, decides to decompose
   → Parent transitions to Active.Supervising (slot freed)

2. Child #51 enters Active.Working
   → Workspace Manager creates branch engineer/50-jwt-migration/51-jwt-utils from engineer/50-jwt-migration
   → Child #51 works in its own worktree
   → Child #51 completes

3. Progressive merge: #51's branch merged into parent
   → Workspace Manager merges engineer/50-jwt-migration/51-jwt-utils into engineer/50-jwt-migration
   → Parent branch now has #51's work

4. Child #52 enters Active.Working (depends on #51)
   → Workspace Manager creates branch engineer/50-jwt-migration/52-middleware from engineer/50-jwt-migration
   → Child #52's worktree has #51's code (via parent branch)

5. Parallel children #53, #54 branch from parent at their start time
   → Both get all previously merged siblings' work

6. All children complete
   → Parent #50 transitions Supervising -> Integrating
   → Active.Integrating is lightweight: any remaining unmerged work is merged, final verification runs
```

**Why progressive merge:** The JWT migration example makes this clear. Child #52 (middleware) depends on #51 (JWT utils). If #52 can't access #51's actual code -- only a knowledge summary -- it can't import the JWT utility functions. Progressive merge solves this naturally: completed work flows into the integration branch (parent), and subsequent children start from there.

### Progressive Merge Trigger

**Who calls `mergeBranch`?** The **Task Engine**, not the Orchestrator. When a child task transitions to Completed, the Task Engine:

1. Receives child completion event
2. Checks if the child has a `parent_workspace`
3. If yes: calls `Workspace Manager.mergeBranch(child_branch, parent_branch)`
4. If merge succeeds: attaches child completion summary to parent context (existing behavior)
5. If merge conflict: emits `workspace.merge_conflict` event — the Orchestrator (in Supervising) decides how to resolve

This is infrastructure work — like an OS cleaning up process resources after exit. The parent Orchestrator in Active.Supervising doesn't need git permissions for this. The Task Engine handles it as part of the child completion lifecycle, just as it already handles workspace creation (Queued→Active) and cleanup (→Completed/Failed).

### Conflict Resolution Between Siblings

Siblings work on separate branches, so conflicts only surface during merge. Two scenarios:

**Sequential children (dependency chain):** Child #52 depends on #51. When #52 starts, it branches from the parent which already has #51's work merged. No conflict (by design -- the dependency ordering ensures this).

**Parallel children (no dependency):** Children #53 and #54 both branch from parent at similar points. They modify different parts of the codebase (by design -- the Orchestrator's decomposition should minimize overlap). During progressive merge, if both modified the same file, the merge reveals the conflict.

**Conflict handling:** The Workspace Manager emits `workspace.merge_conflict`. The parent task transitions Active.Supervising → Active.Working (consumes a working slot) so the Orchestrator has write/git permissions to resolve the conflict. After resolution, the parent transitions Active.Working → Active.Supervising (frees the slot). The Workspace Manager applies the resolution mechanically. See `task-engine.md` § Progressive Merge on Child Completion.

### Child PR Strategy

Two models, configurable per parent task:

| Model | How it works | When to use |
|-------|-------------|-------------|
| **merge_into_parent** (default) | Children merge into parent branch. One PR from parent to main. | Most cases. Clean integration, single review point. |
| **individual_prs** | Each child opens its own PR to main. Parent verifies all merged. | When children are independently valuable and reviewable. |

Default: merge into parent. The parent PR is the single deliverable. Child branches are implementation details.

---

## Multi-Repo Interface (Gap #11 -- Resolved)

### How a Task Can Span Multiple Repos

A task can touch multiple repositories when the work requires coordinated changes (e.g., API change in backend repo + client update in frontend repo, or extracting a module from a monolith into a new service repo).

### Primary vs Secondary Repos

- **Primary**: The repo where the main work happens. The PR lives here. The task's external_ref (GitHub issue) is in this repo.
- **Secondary**: Supporting repos that need coordinated changes. Each gets its own branch and worktree.

The Orchestrator designates the primary repo during intake-analysis based on where the issue originated and where the bulk of the work is.

### Workspace Extension for Multi-Repo

The Task object's `workspace` field extends for multi-repo:

```
workspace: {
  -- Single-repo (existing fields) --
  repo:          string
  branch:        string
  worktree_path: string?

  -- Multi-repo extension --
  multi_repo: [{
    repo:          string
    branch:        string
    worktree_path: string?
    role:          "primary" | "secondary"
    base_branch:   string
    pr: {
      number:      number?
      state:       string
      url:         string?
    }
  }]?
}
```

When `multi_repo` is null, it's a single-repo task (the common case). When populated, `repo` and `branch` refer to the primary repo, and `multi_repo` contains all repos including the primary.

### Safety Layer Scope Interaction

From Safety Layer design: "When a task touches multiple repos, most restrictive scope across all repos applies."

The Workspace Manager enforces this by checking scope for each repo independently before any operation:

1. Before creating a branch in repo X: check `scope.repos.allowed` includes X, check `scope.branches.create_pattern` for X
2. Before modifying a file in repo X: check `scope.files.exclude_patterns` for X
3. If any repo's scope denies the operation: the operation fails for that repo

### Coordination Model

**Branch consistency:** Same branch name across all repos for traceability.

**Independent operations:** Branches and worktrees are created independently per repo. Commits are independent per repo -- no cross-repo atomic commits (this is a git limitation). The Orchestrator ensures logical consistency by working on repos in a sensible order.

**Deferred to Layer 3:**
- Cross-repo commit ordering guarantees
- Coordinated PR strategy (linked PRs, merge ordering)
- Cross-repo conflict detection
- Rollback mechanics if one repo's PR fails review
- Cross-repo integration testing strategy

---

## PR Management

### PR Creation (Draft -- Demo Stage)

Called by Orchestrator during demo-prep phase:

```
createPR(task_id, options: PROptions) -> PRResult

PROptions {
  repo:          string
  branch:        string        (source branch)
  base:          string        (target branch, usually "main")
  title:         string        (provided by Orchestrator)
  body:          string        (provided by Orchestrator -- contains demo artifacts)
  draft:         boolean       (true for demo stage)
  labels:        string[]?
  reviewers:     string[]?     (from task.team where role = "reviewer")
}
```

The Workspace Manager creates the PR on the git hosting platform (GitHub). The Orchestrator provides all content (title, body, reviewers). The Workspace Manager handles the API call.

### PR Update (Feedback Response)

When the Orchestrator pushes new commits in response to feedback:

1. Orchestrator makes code changes, calls Workspace Manager to commit and push
2. Workspace Manager commits with provided message, pushes to branch
3. The PR updates automatically (GitHub detects new commits)
4. Orchestrator comments on the PR via Workspace Manager (responding to specific review comments)

### Draft -> Ready Transition

When Demo is approved:

1. Orchestrator cleans up demo artifacts (removes temporary files)
2. Orchestrator calls Workspace Manager to commit the cleanup
3. Workspace Manager marks PR as Ready (removes draft status via GitHub API)

### PR Merge

When Code review is approved and merge is authorized:

1. Workspace Manager merges the PR via GitHub API
2. Merge strategy: configurable (squash, merge commit, rebase). Default: squash.
3. After merge: Workspace Manager deletes the source branch (configurable)
4. Workspace Manager reports merge result to Task Engine via event

### Multi-Repo PR Coordination (Interface Only)

For multi-repo tasks, each repo gets its own PR. The PRs reference each other in their descriptions (cross-links). Merge ordering and coordination are deferred to Layer 3.

---

## Workspace Object Schema

```
Workspace {
  -- Identity --
  task_id:         string

  -- Primary repo --
  repo:            string          (e.g., "owner/repo")
  branch:          string          (e.g., "engineer/47-dark-mode-toggle")
  worktree_path:   string?         (filesystem path, null when worktree is removed)

  -- Git state --
  base_branch:     string          (what this branch was created from: "main", or parent branch)
  base_commit:     string          (SHA of the commit this branch was created from)
  last_commit:     string?         (SHA of the latest commit on this branch)

  -- PR state --
  pr: {
    number:        number?
    state:         "none" | "draft" | "ready" | "merged" | "closed"
    url:           string?
    merge_strategy: "squash" | "merge" | "rebase"
  }

  -- Hierarchy --
  parent_workspace: {
    task_id:       string
    branch:        string
  }?                               (null for top-level tasks)

  child_branches:  string[]        (branches of child tasks, populated during Supervising)

  -- Multi-repo (Gap #11) --
  multi_repo: [{
    repo:          string
    branch:        string
    worktree_path: string?
    role:          "primary" | "secondary"
    base_branch:   string
    base_commit:   string
    last_commit:   string?
    pr: {
      number:      number?
      state:       string
      url:         string?
    }
  }]?                              (null for single-repo tasks)

  -- Lifecycle --
  created_at:      datetime
  last_activity:   datetime
  status:          "active" | "idle" | "cleaning_up" | "cleaned"
}
```

### Design Principles

- **Branch is the persistent artifact.** The worktree is ephemeral. If the worktree is lost, it can be recreated from the branch.
- **`base_commit` enables drift detection.** If `origin/main` moves forward, the Workspace Manager can detect how far the branch has drifted and whether a rebase is needed.
- **PR state mirrors the Task Engine's `review.pr_state`.** Both track the same thing from different perspectives -- Task Engine for workflow, Workspace Manager for git operations. They stay in sync via events.
- **`status` tracks worktree lifecycle**, not task lifecycle. A task can be Active while its workspace status is "idle" (preempted, workspace still on disk).

---

## Operations

The Workspace Manager provides these operations:

**Workspace lifecycle:**
- `createWorkspace(task_id, repo, base_branch, parent_branch?) -> Workspace`
- `verifyWorkspace(workspace_ref) -> WorkspaceVerification`
- `cleanupWorkspace(task_id, preserve_branch: boolean)`

**Branch operations:**
- `createBranch(repo, branch_name, from_ref) -> { branch, commit_sha }`
- `deleteBranch(repo, branch_name)`
- `mergeBranch(repo, source_branch, target_branch) -> MergeResult`
- `rebaseBranch(repo, branch, onto) -> RebaseResult`

**Commit operations:**
- `commit(task_id, message, files?) -> { commit_sha }`
- `push(task_id) -> { pushed_ref, commit_sha }`

**PR operations:**
- `createPR(task_id, options: PROptions) -> PRResult`
- `updatePR(task_id, updates: PRUpdates)`
- `markPRReady(task_id)`
- `mergePR(task_id, strategy?) -> MergeResult`
- `closePR(task_id, reason?)`
- `commentOnPR(task_id, comment, in_reply_to?)`

**Query operations:**
- `getWorkspace(task_id) -> Workspace`
- `getWorktreePath(task_id) -> string`
- `getBranchStatus(task_id) -> { ahead, behind, conflicts? }`

**Multi-repo operations:**
- `createMultiRepoWorkspace(task_id, repos: RepoSpec[]) -> Workspace`
- `getRepoWorktreePath(task_id, repo) -> string`

---

## Interaction with Other Components

| Component | Interaction | Direction |
|-----------|-------------|-----------|
| **Task Engine** | Calls `createWorkspace` on Queued->Active transition. Calls `mergeBranch` for progressive merge on child completion. Calls `cleanupWorkspace` on Completed/Failed. Stores workspace reference on Task object (`task.workspace`). | Task Engine -> Workspace Manager |
| **Orchestrator** | All git operations go through Workspace Manager. Orchestrator calls `commit`, `push`, `createPR`, `mergeBranch`, etc. Orchestrator provides content (messages, PR descriptions); Workspace Manager executes. During resume: Orchestrator calls `verifyWorkspace` via Session/Memory's resume flow. | Orchestrator -> Workspace Manager |
| **Session/Memory** | Checkpoint's `workspace_ref` (branch + last_commit) is verified via `verifyWorkspace` during resume. Session/Memory doesn't call Workspace Manager directly -- the Orchestrator does during the resume flow. | Indirect (via Orchestrator) |
| **Safety Layer** | Workspace Manager checks scope before branch operations (passive consultation). Safety Layer's active interceptor can veto `git.push` and `git.merge` events on the Event Bus. | Workspace Manager -> Safety Layer (consultation), Safety Layer -> Event Bus (interception) |
| **Daemon** | Daemon includes workspace info in Dispatch package (from Task object). Daemon doesn't call Workspace Manager directly. | Indirect (via Task Engine) |
| **Event Bus** | Workspace Manager emits events: `workspace.created`, `workspace.verified`, `workspace.cleaned`, `workspace.merge_conflict`, `git.branch_created`, `git.committed`, `git.pushed`, `git.pr_opened`, `git.pr_updated`, `git.pr_merged`, `git.merge_completed`. These feed the audit trail and can be intercepted by Safety Layer. Task Engine subscribes to workspace/git events to keep Task object in sync (see `task-engine.md` § Event Subscriptions). | Workspace Manager -> Event Bus |

### Event Flow Example: Task #47 Dark Mode

```
1. Task Engine: Queued -> Active.Working
2. Task Engine -> Workspace Manager: createWorkspace(task_id=47, repo="owner/app", base="main")
3. Workspace Manager:
   a. git fetch origin
   b. git branch engineer/47-dark-mode-toggle origin/main
   c. git worktree add ~/.engineer/workspaces/worktrees/app/47-dark-mode/ engineer/47-dark-mode-toggle
   d. Emit: workspace.created { task_id: 47, branch: "engineer/47-dark-mode-toggle", ... }
   e. Return workspace reference
4. Task Engine: stores workspace on Task object

... Orchestrator works ...

5. Orchestrator -> Workspace Manager: commit(47, "Add CSS variable refactoring")
   a. Emit: git.committed { task_id: 47, sha: "abc123" }
6. Orchestrator -> Workspace Manager: push(47)
   a. Emit: git.pushed { task_id: 47, branch: "engineer/47-dark-mode-toggle" }
   b. Safety Layer intercepts git.pushed -- checks scope -- allows
7. Orchestrator -> Workspace Manager: createPR(47, { title: "...", body: "...", draft: true })
   a. Emit: git.pr_opened { task_id: 47, pr_number: 52, draft: true }

... review feedback ...

8. Orchestrator -> Workspace Manager: commit(47, "Extract useThemeToggle hook")
9. Orchestrator -> Workspace Manager: push(47)
10. Orchestrator -> Workspace Manager: markPRReady(47)
    a. Emit: git.pr_updated { task_id: 47, pr_number: 52, draft: false }

... code review approved ...

11. Orchestrator -> Workspace Manager: mergePR(47, "squash")
    a. Emit: git.pr_merged { task_id: 47, pr_number: 52 }
12. Task Engine -> Workspace Manager: cleanupWorkspace(47, preserve_branch: false)
    a. Remove worktree
    b. Delete branch (already merged)
    c. Emit: workspace.cleaned { task_id: 47 }
```

---

## Configuration Schema

```
WorkspaceConfig {
  -- Paths --
  workspace_root:        string       (default: "~/.engineer/workspaces/")

  -- Branch naming --
  branch_prefix:         string       (default: "engineer/")
  slug_max_length:       number       (default: 30)

  -- Git behavior --
  fetch_before_create:   boolean      (default: true)
  default_base_branch:   string       (default: "main")

  -- PR defaults --
  pr: {
    default_merge_strategy: "squash" | "merge" | "rebase"  (default: "squash")
    delete_branch_after_merge: boolean                      (default: true)
    branch_retention_days:     number?                      (default: null -- delete immediately)
  }

  -- Cleanup --
  cleanup: {
    preserve_branch_on_failure: boolean  (default: true)
    preserve_branch_on_cancel:  boolean  (default: false)
  }

  -- Child task PR strategy --
  child_pr_strategy:     "merge_into_parent" | "individual_prs"  (default: "merge_into_parent")

  -- Multi-repo --
  multi_repo: {
    enabled:             boolean       (default: true)
    max_repos_per_task:  number        (default: 5)
  }
}
```

---

## Gap Resolved

| # | Gap | Resolution |
|---|-----|-----------|
| 11 | Multi-repo workspace management | Primary/secondary repo model. Same branch name across repos for traceability. Task.workspace extended with `multi_repo` array. Safety scope checked per-repo, most restrictive applies. Coordination model defined at interface level. Detailed mechanics (cross-repo commit ordering, coordinated PRs, rollback) deferred to Layer 3. |

---

## Open Questions for Layer 3

- **Git hosting abstraction**: The PR operations assume GitHub. How does the git hosting plugin interface work for GitLab, Bitbucket, etc.? (Layer 3: Plugin interfaces)
- **Rebase vs merge for child integration**: When progressively merging children into parent, should the Workspace Manager rebase for clean history or merge for traceability? Configurable? (Layer 3)
- **Worktree disk management**: How much disk space do multiple idle worktrees consume? Should there be a limit on concurrent worktrees? Eviction policy for long-idle worktrees? (Layer 3 or 4)
- **Base branch drift**: If `main` moves forward while a task is in progress, when and how does the Workspace Manager rebase? Automatic? On-demand? Before PR? (Layer 3)
- **Cross-repo commit ordering**: For multi-repo tasks, what order should commits/PRs be made? Dependency-based? (Layer 3)
- **Multi-repo coordinated merge**: If a multi-repo task has PRs in 3 repos, what happens if repo A's PR is approved but repo B gets feedback? Merge ordering guarantees. (Layer 3)
- **Commit message conventions**: Should the Workspace Manager enforce commit message templates? Or is this an Orchestrator judgment call? (Layer 3)
- **Worktree recovery from corruption**: Beyond "recreate from branch," what if uncommitted work was lost? Integration with checkpoint system for work-in-progress recovery. (Layer 3)
