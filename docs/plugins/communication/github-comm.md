# GitHub Communication

Posts comments on GitHub issues and PRs, manages state labels (`engineer:*` prefix), and creates/updates issues. This is the primary public-facing communication channel -- everything the Engineer says on GitHub goes through this plugin.

Use this plugin when you want task status updates, milestone announcements, and questions to appear directly on the source GitHub issue.

## Requirements

| Type | Name | Notes |
|------|------|-------|
| env  | `GITHUB_TOKEN` | Personal access token with `repo` scope. Set in `~/.engineer/.env`. |

The token must have permission to comment on issues/PRs and manage labels in the target repositories.

## Capabilities

| Capability | Supported | Description |
|------------|-----------|-------------|
| `send` | Yes | Posts formatted comments on issues and PRs |
| `sync` | Yes | Manages `engineer:*` state labels on issues (adds new state label, removes old ones) |
| `ticket_management` | Yes | Creates issues, updates issue state/body/labels, comments on tickets via `ExternalRef` |
| `receive` | No | Deferred -- see future-considerations.md |

## Configuration

Config file: `~/.engineer/config/plugins/github-comm.yaml`

```yaml
github_token: "${GITHUB_TOKEN}"    # REQUIRED -- GitHub personal access token (env var ref)
label_prefix: "engineer:"          # Prefix for state labels (default: "engineer:")
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `github_token` | `string` | -- (required) | GitHub PAT. Use `${GITHUB_TOKEN}` to reference the env var. |
| `label_prefix` | `string` | `"engineer:"` | Prefix prepended to task state names when managing labels. For example, state `executing` becomes label `engineer:executing`. |

## How It Works

**Message formatting.** Each message type gets a GitHub-flavored markdown prefix:
- `notification` --> `> **Info**`
- `question` --> `> **Question**`
- `alert` --> `> **Alert**`
- `milestone` --> `> **Milestone**`
- `status_response` --> `> **Status**`

**Sending.** Target channels use the format `owner/repo#number`. The plugin calls `issues.createComment` via Octokit. Returns the comment ID on success.

**State sync.** When a task transitions states, the plugin:
1. Fetches current labels on the issue
2. Computes a diff (which `engineer:*` label to add, which to remove)
3. Adds the new state label, removes stale ones
4. Silently ignores 404s when removing labels that are already gone

**Reconciliation.** `reconcileState` batch-checks multiple tasks, ensuring each issue's labels match the expected state. Returns a count of reconciled tasks and any errors.

**Ticket management.** `createTicket` creates new GitHub issues with optional labels and assignees. `updateTicket` modifies state, body, labels (add/remove). `commentOnTicket` posts a comment using an `ExternalRef` (repo + issue number).

**Health checks.** Calls the GitHub rate limit API. Reports unhealthy when remaining requests drop below 100.

**Error classification.** HTTP status codes map to adapter error types:
- 401/403 --> `auth_failed`
- 404 --> `not_found`
- 429 --> `rate_limited`
- 5xx --> `network_error` (retryable)

## Limitations

- No `receive` capability. The plugin cannot listen for incoming messages or webhook events. Polling for inbound communication is deferred.
- Label management is best-effort. If a label removal fails (e.g., concurrent modification), the error is swallowed. Reconciliation can fix drift.
- Rate limit awareness is passive. The plugin checks remaining quota during health checks but does not throttle requests proactively. If you hit the rate limit, individual API calls will fail with `rate_limited` errors.
- The `label_prefix` applies globally. All repos managed by this plugin share the same prefix.

## Related Plugins

| Plugin | Relationship |
|--------|-------------|
| `github-trigger` | Watches the same repos for new issues/PR reviews. Shares `GITHUB_TOKEN`. |
| `github-hosting` | Manages PR lifecycle (create, merge, review). Shares `GITHUB_TOKEN`. |
| `telegram-comm` | Alternative communication channel for personal notifications. |
