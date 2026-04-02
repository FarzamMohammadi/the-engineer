# People Configuration

Defines the people The Engineer works with — their roles, contact information, and notification preferences. This is the directory The Engineer uses to know who to notify, who can approve, and how to reach them.

**File:** `~/.engineer/config/people.yaml`
**Hot-reload:** **Yes** — changes take effect without restarting the daemon.

## Structure

The file contains a single `people` array. Each entry is a person:

```yaml
people:
  - id: farzam
    name: Farzam Mohammadi
    roles: [owner]
    contacts:
      - channel: telegram
        handle: "farzammoh"
      - channel: github
        handle: "FarzamMohammadi"
    preferences:
      notification_level: milestones
      quiet_hours: null
```

## Person Schema

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Unique identifier. Used internally for lookups. |
| `name` | string | Yes | Display name (used in notifications and logs). |
| `roles` | string[] | Yes | Role tags. Common values: `"owner"`, `"reviewer"`, `"contributor"`. |
| `contacts` | Contact[] | Yes | At least one contact method (see below). |
| `preferences` | object | No | Notification and availability preferences (see below). |

### Roles

Roles determine authorization and notification routing:

| Role | Effect |
|------|--------|
| `owner` | Receives all notifications. Can `/approve` PRs (when comment approval is enabled). |
| `reviewer` | Can `/approve` PRs (when comment approval is enabled). |
| `contributor` | No special privileges (standard notifications). |

Roles are free-form strings — you can define custom roles. The roles above are the ones The Engineer recognizes for authorization decisions.

## Contacts

Each contact maps a person to a communication channel.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `channel` | string | Yes | Communication channel: `"telegram"`, `"github"`, `"email"`, etc. |
| `handle` | string | Yes | User identifier on that channel. |

The `channel` value must match a loaded communication plugin's channel. For example:
- `telegram` — matched by `telegram-comm` plugin. Handle is the Telegram username (without `@`).
- `github` — matched by `github-comm` plugin. Handle is the GitHub username (case-insensitive).

**GitHub handles are also used for `/approve` authorization** — when `enable_comment_approval` is enabled in safety config, the PR comment author is matched against `github` contact handles.

## Preferences

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `notification_level` | `"all"` \| `"milestones"` \| `"critical"` | `"milestones"` | Notification filtering level. `all` = every update, `milestones` = key events only, `critical` = errors and alerts only. |
| `quiet_hours` | object \| null | `null` | Personal quiet hours override. When set, notifications are suppressed during this window. |
| `quiet_hours.start` | string | — | Quiet period start (HH:MM format). |
| `quiet_hours.end` | string | — | Quiet period end (HH:MM format). |

## Multiple People

For teams, add multiple entries. Each person gets independent notification routing:

```yaml
people:
  - id: farzam
    name: Farzam Mohammadi
    roles: [owner, reviewer]
    contacts:
      - channel: telegram
        handle: "farzammoh"
      - channel: github
        handle: "FarzamMohammadi"
    preferences:
      notification_level: milestones

  - id: alice
    name: Alice Chen
    roles: [reviewer]
    contacts:
      - channel: github
        handle: "alicechen"
    preferences:
      notification_level: critical
      quiet_hours:
        start: "22:00"
        end: "08:00"
```

## Empty People Directory

If `people.yaml` is missing or has an empty `people` array, The Engineer still operates but:
- No personal notifications are sent (only ticket comments on GitHub issues).
- When `enable_comment_approval` is enabled, **any** PR commenter can `/approve` (no authorization check). This is the default solo-dev fallback.
