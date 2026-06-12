# People Configuration

Defines the people The Engineer works with — their roles and contact information. This is the
directory The Engineer uses to know who to reach, who can approve, and how
to contact them.

**File:** `~/.engineer/config/people.yaml`
**When changes apply:** on the next `engineer start`. Edit the file, then restart the daemon.

## Single-User in v1

The Engineer assumes the human side is exactly one person — the **owner**. The owner assigns the
work, answers the questions, and reviews the output. Every message to a human targets the owner.

This is a deliberate, scoped constraint — see [`../constraints.md`](../constraints.md) for the full
rationale and the two things it does *not* relax (one user is still many tasks; one user is still
many plugins).

What this means for this file:

- **Configure one person, with role `owner`.** That is the whole directory in v1.
- **The owner is assumed, not required.** The Engineer still starts with no owner configured — but
  it warns, because without a contact it cannot reach you when a task is **blocked**, needs
  **additional context**, or needs a **decision during requirements gathering**.
- **Extra people are not contacted.** You may list more entries (the schema allows it), but v1
  reaches only the owner. The Engineer warns when more than one person is configured.

These checks surface at daemon startup (logged) and on demand through the **People Directory**
category of [`engineer doctor`](../cli.md#doctor).

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
```

## Person Schema

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Unique identifier. Used internally for lookups. |
| `name` | string | Yes | Display name (used in notifications and logs). |
| `roles` | string[] | Yes | Role tags. In v1, the meaningful role is `"owner"`. |
| `contacts` | Contact[] | Yes | At least one contact method (see below). |

### Roles

Roles are free-form strings. Two are recognized:

| Role | Effect |
|------|--------|
| `owner` | The single human The Engineer reaches. Receives all outreach; can `/approve` PRs (when comment approval is enabled). |
| `reviewer` | Can `/approve` PRs (when comment approval is enabled), but is **not** contacted for outreach in v1. |

The `reviewer` role is a remnant of the multi-person model the directory once supported. Under the
single-user constraint, outreach goes to the owner only; reviewer affects PR-approval authorization,
not who gets messaged.

## Contacts

Each contact maps a person to a communication channel.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `channel` | string | Yes | Communication channel: `"telegram"`, `"github"`, `"email"`, etc. |
| `handle` | string | Yes | User identifier on that channel. |

The `channel` value must match an installed communication plugin's channel. For example:

- `telegram` — matched by the `telegram-comm` plugin. Handle is the Telegram username (without `@`).
- `github` — matched by the `github-comm` plugin. Handle is the GitHub username (case-insensitive).

If the owner has a contact on a channel that no installed communication plugin handles, The Engineer
**warns** — at startup and in `engineer doctor` — because messages on that channel cannot be
delivered. The warning names the channel and points here.

**GitHub handles are also used for `/approve` authorization** — when `enable_comment_approval` is
enabled in safety config, the PR comment author is matched against `github` contact handles.

## No Owner Configured

If `people.yaml` is missing, has an empty `people` array, or has no person with role `owner`, The
Engineer still operates but:

- It logs a warning at startup (and `engineer doctor` reports it) explaining that it cannot reach you
  when blocked, needs context, or needs a decision.
- No personal notifications are sent. On GitHub, it can still post ticket comments on the issue.
- When `enable_comment_approval` is enabled, **any** PR commenter can `/approve` (no authorization
  check). This is the solo-dev fallback.

The owner is assumed, not required — The Engineer never refuses to start over a missing contact. It
makes the trade-off visible instead of letting it surprise you at the first blocker.
