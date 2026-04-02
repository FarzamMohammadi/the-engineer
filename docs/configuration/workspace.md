# Workspace Configuration

Controls git operations: where worktrees are created, how branches are named, PR merge strategy, and cleanup behavior. These settings define how The Engineer interacts with git.

**File:** `~/.engineer/config/workspace.yaml`
**Hot-reload:** No — requires daemon restart.

## Root Settings

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `workspace_root` | string | `"~/.engineer/workspaces/"` | Directory where git worktrees are created. Supports `~` expansion. |
| `branch_prefix` | string | `"engineer/"` | Prefix for all branches (e.g., `engineer/task-47-dark-mode`). |
| `slug_max_length` | integer | `30` | Maximum character length for the task slug portion of branch names. |
| `fetch_before_create` | boolean | `true` | Fetch from remote before creating a worktree, ensuring the base branch is up to date. |
| `default_base_branch` | string | `"main"` | Default base branch for PRs when not specified by the task. |
| `git_token_env` | string | `"GIT_TOKEN"` | Name of the environment variable holding the git authentication token. Set to `GITHUB_TOKEN` if using GitHub. Token is read at operation time and never persisted. |

## PR Settings

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `pr.default_merge_strategy` | `"squash"` \| `"merge"` \| `"rebase"` | `"squash"` | How PRs are merged. Squash creates a single commit, merge creates a merge commit, rebase replays commits. |
| `pr.delete_branch_after_merge` | boolean | `true` | Delete the task branch after its PR is merged. |
| `pr.branch_retention_days` | integer \| null | `null` | Days to retain merged branches before cleanup. `null` = no automatic deletion. |

## Cleanup

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `cleanup.preserve_branch_on_failure` | boolean | `true` | Keep the task branch when a task fails, for post-mortem debugging. |
| `cleanup.preserve_branch_on_cancel` | boolean | `false` | Keep the task branch when a task is cancelled. |

## Child Task Strategy

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `child_pr_strategy` | `"merge_into_parent"` \| `"individual_prs"` | `"merge_into_parent"` | How child task branches integrate. `merge_into_parent` merges all children into the parent branch for a single PR. `individual_prs` creates one PR per child task. |

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
git_token_env: GITHUB_TOKEN

pr:
  default_merge_strategy: squash
  delete_branch_after_merge: true

cleanup:
  preserve_branch_on_failure: true
  preserve_branch_on_cancel: false
```
