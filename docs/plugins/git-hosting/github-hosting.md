# GitHub Hosting

Manages the full pull request lifecycle on GitHub via the Octokit REST API. Creates PRs, updates metadata, merges, closes, checks review status, dismisses stale approvals, reads comments, and queries branch protection. Every `GitHostingAdapter` method is implemented.

Use this plugin whenever the Engineer needs to open PRs, respond to review feedback, or merge completed work.

## Requirements

| Type | Name | Notes |
|------|------|-------|
| env  | `GITHUB_TOKEN` | Personal access token with `repo` scope. Set in `~/.engineer/.env`. |

The token needs sufficient permissions for the target repositories: create/update/merge PRs, read branch protection rules, manage labels, and request reviewers.

## Capabilities

Every adapter method is implemented:

| Method | Description |
|--------|-------------|
| `createPR` | Opens a pull request with title, body, base/head branches, draft mode, labels, and reviewers |
| `updatePR` | Modifies title, body, draft status, and labels (add/remove) on an existing PR |
| `mergePR` | Merges a PR using the configured strategy. Never force-merges. |
| `closePR` | Closes a PR without merging |
| `getPRStatus` | Returns PR state (open/closed/merged), draft flag, mergeability, CI check status, and URL |
| `getReviewStatus` | Aggregates review state per reviewer (approved/changes_requested/commented/pending) |
| `dismissApprovals` | Dismisses all current approvals on a PR with a message explaining why |
| `commentOnPR` | Posts a conversation comment or replies to an inline review comment |
| `getPRComments` | Fetches both conversation-level and inline review comments (filters out bot comments) |
| `detectPrEvents` | Aggregates live PR state into the typed events Core reacts to (comments, CI failure, conflict, ready-to-merge, merged) |
| `getBranchProtection` | Returns protection rules: required reviews, required checks, push restrictions |
| `getDefaultBranch` | Returns the repository's default branch name |

## Configuration

Config file: `~/.engineer/config/plugins/github-hosting.yaml`

```yaml
github_token: "${GITHUB_TOKEN}"          # REQUIRED -- GitHub personal access token (env var ref)
default_merge_strategy: squash           # squash | merge | rebase (default: squash)
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `github_token` | `string` | -- (required) | GitHub PAT. Use `${GITHUB_TOKEN}` to reference the env var. |
| `default_merge_strategy` | `"squash"` \| `"merge"` \| `"rebase"` | `"squash"` | Merge method used when merging PRs. |

## How It Works

**PR creation.** Calls `pulls.create` via Octokit. After creation, adds labels and requests reviewers in separate API calls if provided. Returns the PR number and URL.

**PR updates.** Only sends API calls for fields that are non-null. Label additions and removals are handled separately. Label removal logs a `warn` and treats failure as non-fatal — the label may already be gone (concurrent removal, never set).

**Merging.** Calls `pulls.merge` with the configured merge strategy (`squash`, `merge`, or `rebase`). The plugin never force-merges. If branch protection requirements are not satisfied (required reviews, status checks), the merge returns an error with `pr_not_mergeable` or `merge_conflict` -- it does not bypass protections.

**PR status.** Fetches the PR and the combined commit status for the head SHA. Maps GitHub's state to a simplified `open | closed | merged` enum. CI check status is determined by the combined status API (`repos.getCombinedStatusForRef`).

**Review aggregation.** Fetches all reviews chronologically and tracks the latest meaningful state per reviewer (`APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`). A PR is considered approved only when at least one reviewer approved AND no reviewer has `changes_requested` as their latest state. Review body text is collected as feedback comments.

**Approval dismissal.** `dismissApprovals` lists all reviews on the PR via `pulls.listReviews`, filters for those with state `APPROVED`, and calls `pulls.dismissReview` for each one with the provided message. No-ops when no approvals exist. Called by the PR manager after rework pushes new code — the old approval was for different code and must not authorize the changed PR.

**Comments.** `commentOnPR` handles two cases: if `replyTo` is provided, it creates a reply to an inline review comment; otherwise, it posts a regular issue comment (PRs are issues in the GitHub API). `getPRComments` fetches both conversation-level (`issues.listComments`) and inline review comments (`pulls.listReviewComments`) in parallel, filtering out `github-actions[bot]`.

**Event detection.** `detectPrEvents` fetches PR status, review status, and comments in parallel, then aggregates them statelessly into the typed `PrEvent` vocabulary. `pr_merged` short-circuits (terminal); otherwise it emits `pr_ci_failure` on red checks, `pr_merge_conflict` when not mergeable, `pr_comments` when changes are requested or an unapproved PR has comments (a formal approval suppresses non-blocking comments), and `pr_ready_to_merge` only when approval, green CI, and mergeability hold together. Readiness is recomputed every poll, so an "approved but CI still running" PR emits nothing and simply stays blocked — there is no in-memory wait state to lose on restart. The plugin reports facts only: `/approve` comments are surfaced raw inside `pr_comments` for Core to recognize and authorize against the people directory, and self-authored daemon comments are filtered by Core, not here.

**Branch protection.** Queries branch protection rules. Returns required review count, required status check contexts, and push restrictions (users/teams). A 404 response means no protection is configured (returns safe defaults with `protected: false`).

**Health checks.** Same as other GitHub plugins -- calls the rate limit API, reports unhealthy below 100 remaining requests.

**Error classification for merges:**
- 405 --> `pr_not_mergeable` (branch protection not satisfied)
- 409 --> `merge_conflict`
- Other --> `network_error`

## Limitations

- No force-merge capability. If branch protection blocks a merge, the plugin returns an error. This is intentional -- the Engineer respects repository rules.
- No webhook support. The plugin is API-driven, not event-driven. PR status changes are detected by polling.
- Review aggregation uses the latest state per reviewer. If a reviewer approves, then comments, their state shows as `commented` (not `approved`). This matches GitHub's own review summary behavior.
- Bot comments from `github-actions[bot]` are filtered from `getPRComments`. Other bot accounts are not filtered.
- The `default_merge_strategy` applies globally. Per-repo merge strategies are not configurable at the plugin level (the Orchestrator can override per-call).

## Related Plugins

| Plugin | Relationship |
|--------|-------------|
| `github-trigger` | Watches repos for open issues filtered by label and/or assignee. Shares `GITHUB_TOKEN`. |
| `github-comm` | Posts comments and manages labels on the same issues/PRs. Shares `GITHUB_TOKEN`. |
