# Workspace Configuration

Controls git operations: where worktrees are created, how branches are named, PR merge strategy, and how long merged branches are retained. These settings define how The Engineer interacts with git.

**File:** `~/.engineer/config/workspace.yaml`
**Hot-reload:** No — requires daemon restart.

## Root Settings

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `workspace_root` | string | `"~/.engineer/workspaces/"` | Directory where git worktrees are created. Supports `~` expansion. |
| `branch_prefix` | string | `"engineer/"` | Prefix for all branches (e.g., `engineer/task-47-dark-mode`). |
| `slug_max_length` | integer | `30` | Maximum character length for the task slug portion of branch names. |
| `default_base_branch` | string | `"main"` | Default base branch for PRs when not specified by the task. |

## PR Settings

The Engineer delivers one of two ways. By default it opens a **pull request** and drives it to merge. With `skip_pr_creation` enabled (globally or per repo) it runs in **push-only mode**: it pushes the branch and the task completes — no pull request, no review, no merge.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `pr.default_merge_strategy` | `"squash"` \| `"merge"` \| `"rebase"` | `"squash"` | How PRs are merged. Squash creates a single commit, merge creates a merge commit, rebase replays commits. |
| `pr.branch_retention_days` | integer \| null | `0` | How long to keep a **merged** branch before the reaper deletes it: `null` = keep forever, `0` = delete on the next reaper sweep, `N` = delete `N` days after the merge. Push-only branches are the deliverable and are never deleted. |
| `pr.skip_pr_creation.default` | boolean | `false` | **Push-only mode.** Skip PR creation after pushing — code lands on the remote branch with no pull request and no review gate, and the task completes once the branch is pushed. |
| `pr.skip_pr_creation.repos` | Record<string, boolean> | `{}` | Per-repo overrides for push-only mode (e.g., `"owner/repo": true`). A repo entry takes precedence over `default`. |

Branch deletion is performed by the daemon's **workspace reaper**, not at merge time — auto-merge only records the merge, and the reaper deletes the branch once `branch_retention_days` has elapsed (so deletion can lag up to one sweep interval). See `workspace_reaper` in [daemon.yaml](daemon.md). Failed-task branches are always preserved (debug evidence + retry source).

## Multi-Repo

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `multi_repo.enabled` | boolean | `true` | Allow tasks to span multiple repositories. Safe to leave enabled for single-repo setups. |
| `multi_repo.max_repos_per_task` | integer | `5` | Maximum number of repositories a single task can span. |

## Complete Example

```yaml
workspace_root: "~/.engineer/workspaces/"
branch_prefix: "engineer/"
default_base_branch: main

pr:
  default_merge_strategy: squash
  branch_retention_days: 0   # null = keep forever, 0 = next reaper sweep, N = N days after merge
  skip_pr_creation:
    default: false           # set true for push-only delivery (no PR)
```
