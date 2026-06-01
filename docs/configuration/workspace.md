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
| `default_base_branch` | string | `"main"` | Default base branch for PRs when not specified by the task. |

## PR Settings

The Engineer delivers one of two ways. By default it opens a **pull request** and drives it to merge. With `skip_pr_creation` enabled (globally or per repo) it runs in **push-only mode**: it pushes the branch and the task completes — no pull request, no review, no merge.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `pr.default_merge_strategy` | `"squash"` \| `"merge"` \| `"rebase"` | `"squash"` | How PRs are merged. Squash creates a single commit, merge creates a merge commit, rebase replays commits. |
| `pr.delete_branch_after_merge` | boolean | `true` | Delete the task branch after its PR is merged. |
| `pr.branch_retention_days` | integer \| null | `null` | Days to retain merged branches before cleanup. `null` = no automatic deletion. |
| `pr.skip_pr_creation.default` | boolean | `false` | **Push-only mode.** Skip PR creation after pushing — code lands on the remote branch with no pull request and no review gate, and the task completes once the branch is pushed. |
| `pr.skip_pr_creation.repos` | Record<string, boolean> | `{}` | Per-repo overrides for push-only mode (e.g., `"owner/repo": true`). A repo entry takes precedence over `default`. |

## Cleanup

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `cleanup.preserve_branch_on_failure` | boolean | `true` | Keep the task branch when a task fails, for post-mortem debugging. |
| `cleanup.preserve_branch_on_cancel` | boolean | `false` | Keep the task branch when a task is cancelled. |

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
  delete_branch_after_merge: true
  skip_pr_creation:
    default: false        # set true for push-only delivery (no PR)

cleanup:
  preserve_branch_on_failure: true
  preserve_branch_on_cancel: false
```
