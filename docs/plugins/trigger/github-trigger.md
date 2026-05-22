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
- Configurable work selection: filter by label, assignee, or both (defaults to the `engineer` label)
- Per-repo watermark tracking -- only returns issues updated since the last poll
- ETag caching for conditional requests (304 Not Modified skips processing)
- Rate limit reporting via `retry_after_ms` -- the Daemon honors the delay (Core-owned backoff)
- Watermark persistence via the Core StateStore -- survives restarts without re-processing old issues
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
| `labels` | `string[]` | `["engineer"]` | No | Only trigger on issues with these labels. Defaults to the `engineer` label when omitted. |
| `assignee` | `string` | -- | No | GitHub username to filter by assignee. |

**Work selection:** By default the plugin triggers on issues carrying the `engineer` label, so it works out of the box with no extra configuration. Set `labels` to your own list to change which labels match, set `assignee` to filter by who an issue is assigned to, or set both (the GitHub API then returns issues matching **both** criteria — an AND). To select **only** by assignee, set `labels: []` alongside `assignee`. The one configuration the plugin rejects is an explicit `labels: []` with no assignee — that would match every open issue, which is almost never intended, so it fails loud at startup.

**Poll interval:** Declared on the plugin manifest (`poll_interval_ms: 30000`) and honored by the Daemon. The Daemon's global `trigger_poll_interval_ms` config serves as the fallback for plugins that do not declare one. Plugin config does not include a poll interval field.

### Minimal config (uses the default `engineer` label)

```yaml
repos:
  - owner: your-github-username
    name: your-repo-name

github_token: "${GITHUB_TOKEN}"
```

### Assignee-based selection

```yaml
repos:
  - owner: your-github-username
    name: your-repo-name

github_token: "${GITHUB_TOKEN}"
labels: []                       # clear the default label...
assignee: "your-github-username" # ...and select by assignee only
```

### Full config (label + assignee)

```yaml
repos:
  - owner: FarzamMohammadi
    name: my-project

github_token: "${GITHUB_TOKEN}"
labels: ["engineer"]
assignee: "the-engineer-bot"
```

## How It Works

On each poll cycle, the plugin iterates through configured repos and calls the GitHub Issues API (`GET /repos/{owner}/{repo}/issues`) with `state=open`, `sort=updated`, `direction=asc`, and `per_page=30`.

**Watermarks**: After processing issues from a repo, the plugin records the latest `updated_at` timestamp. On subsequent polls, it passes this as the `since` parameter so the API only returns issues updated after that point. Watermarks are persisted through the Core [StateStore](../plugin-context.md#statestore) on shutdown and restored on startup — Core owns where and how state is stored, so the plugin holds no file paths of its own.

**ETag caching**: Each request includes an `If-None-Match` header with the ETag from the previous response. If the API returns 304 (no changes), the plugin skips processing entirely. This saves API quota on quiet repos.

**Rate limiting**: If the API returns 429, the plugin throws an `AdapterMethodError` with `retry_after_ms` set (parsed from the `Retry-After` header, defaulting to 60 seconds). The Daemon honors this delay before the next poll -- the plugin does not self-throttle. Rate-limit responses do not count toward the consecutive-failure threshold.

**Interactive setup**: The first `engineer start` invocation prompts for the repo in `owner/name` format and generates the config file.

## Limitations

- Polling only -- no webhook support. There is an inherent delay between issue creation and task pickup (up to the poll interval).
- Fetches at most 30 issues per repo per poll cycle. Repos with many simultaneous new issues may need multiple cycles.
- Issues only -- pull requests are filtered out (`pollIssues` skips anything with a `pull_request` field). There is no PR-review trigger.
- Label filtering is applied at the API level (comma-joined), so an issue must have all listed labels to match. Assignee filtering is likewise applied at the API level.
- Watermark loss (corrupt state, first run) causes re-fetching from the beginning. The Daemon's idempotency key deduplication prevents duplicate tasks.

## Related Plugins

| Plugin | Relationship |
|---|---|
| **github-comm** | Posts comments and manages labels on the GitHub issues that triggered tasks. |
| **github-hosting** | Creates and manages PRs for completed work on the same repos. |

These three plugins share the same `GITHUB_TOKEN` and form the complete GitHub workflow: trigger from issues, communicate via comments, deliver via PRs.
