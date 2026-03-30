# GitHub Trigger

The GitHub Trigger plugin polls the GitHub Issues API for open issues across configured repositories. When it finds issues, it generates `TriggerEvent` objects with stable idempotency keys (`github:issue:{owner}/{repo}:{number}`), which the Daemon uses to create tasks.

Use this plugin when you want The Engineer to pick up work from GitHub Issues. It is the standard entry point for the GitHub workflow -- assign an issue, and The Engineer starts working on it.

## Requirements

| Requirement | Details |
|---|---|
| **`GITHUB_TOKEN`** | A GitHub personal access token with `repo` scope. Generate one at https://github.com/settings/tokens. Set as an environment variable before running `engineer start`. |
| **Network** | Outbound HTTPS access to `api.github.com`. |

The plugin is marked `critical: true` -- if it fails to initialize, the Daemon will not start.

## Capabilities

- Polls open issues from one or more repositories
- Filters by label (optional)
- Per-repo watermark tracking -- only returns issues updated since the last poll
- ETag caching for conditional requests (304 Not Modified skips processing)
- Rate limit handling with Retry-After backoff (429 responses pause polling)
- Watermark persistence to disk -- survives restarts without re-processing old issues
- Idempotency keys prevent duplicate task creation for the same issue
- Filters out pull requests (only issues are returned)

## Configuration

Config file: `~/.engineer/config/plugins/github-trigger.yaml`

| Field | Type | Default | Required | Description |
|---|---|---|---|---|
| `github_token` | `string` | -- | Yes | GitHub personal access token. Use `${GITHUB_TOKEN}` to read from env. |
| `repos` | `array` | -- | Yes | At least one repository to watch. Each entry needs `owner` and `name`. |
| `repos[].owner` | `string` | -- | Yes | GitHub username or organization. |
| `repos[].name` | `string` | -- | Yes | Repository name. |
| `labels` | `string[]` | `[]` | No | Only trigger on issues with these labels. Empty means all issues. |
| `poll_interval_ms` | `number` | `30000` | No | Polling interval in milliseconds. |

### Minimal config

```yaml
repos:
  - owner: your-github-username
    name: your-repo-name

github_token: "${GITHUB_TOKEN}"
```

### Full config

```yaml
repos:
  - owner: FarzamMohammadi
    name: my-project

github_token: "${GITHUB_TOKEN}"
labels: ["engineer"]
poll_interval_ms: 30000
```

## How It Works

On each poll cycle, the plugin iterates through configured repos and calls the GitHub Issues API (`GET /repos/{owner}/{repo}/issues`) with `state=open`, `sort=updated`, `direction=asc`, and `per_page=30`.

**Watermarks**: After processing issues from a repo, the plugin records the latest `updated_at` timestamp. On subsequent polls, it passes this as the `since` parameter so the API only returns issues updated after that point. Watermarks are persisted to `~/.engineer/state/github-trigger/watermarks.json` on shutdown (atomic write via temp file + rename) and loaded on startup.

**ETag caching**: Each request includes an `If-None-Match` header with the ETag from the previous response. If the API returns 304 (no changes), the plugin skips processing entirely. This saves API quota on quiet repos.

**Rate limiting**: If the API returns 429, the plugin records the `Retry-After` duration and skips all polling until that time passes.

**Interactive setup**: Running `engineer init` prompts for the repo in `owner/name` format and generates the config file.

## Limitations

- Polling only -- no webhook support. There is an inherent delay between issue creation and task pickup (up to `poll_interval_ms`).
- Fetches at most 30 issues per repo per poll cycle. Repos with many simultaneous new issues may need multiple cycles.
- No PR review trigger events in the current implementation (idempotency key format exists for reviews but `pollIssues` filters out PRs).
- Label filtering is applied at the API level (comma-joined), so an issue must have all listed labels to match.
- Watermark loss (corrupt file, first run) causes re-fetching from the beginning. The Daemon's idempotency key deduplication prevents duplicate tasks.

## Related Plugins

| Plugin | Relationship |
|---|---|
| **github-comm** | Posts comments and manages labels on the GitHub issues that triggered tasks. |
| **github-hosting** | Creates and manages PRs for completed work on the same repos. |

These three plugins share the same `GITHUB_TOKEN` and form the complete GitHub workflow: trigger from issues, communicate via comments, deliver via PRs.
