# Comm Plugins -- Layer 2 Design

Comm plugins are the Engineer's voice -- how it communicates with humans through external platforms. They are **plugins** (not skeleton), registered in the Registry. Each comm plugin adapts a specific platform (Telegram, GitHub, email) to a shared contract.

Part of **Layer 2** -- see [`layers.md`](../layers.md). Resolves gaps: #20, #22.

---

## Proven Systems

| Proven system | What we take | Applied as |
|---------------|-------------|------------|
| **Chat bots / CLI parsers** | Command recognition, intent parsing, structured responses to natural language input | Status query interface: recognize human queries ("status", "progress on #47"), route to correct data source, compose response |
| **Webhook / event sync patterns** | Subscribe to internal state changes, push updates to external systems on each change | GitHub state sync: subscribe to task state events on Event Bus, sync labels/status/comments to GitHub |
| **Adapter pattern** | Common interface, platform-specific implementations. Consumers interact with the interface, never with the platform directly. | Comm plugin interface: common contract (`sendMessage`, `onMessage`, `syncTaskState`), platform adapters (Telegram, GitHub, email) |

---

## What Comm Plugins Own (and Don't)

| Concern | Owner | Why |
|---------|-------|-----|
| **Platform transport** (sending/receiving messages) | Comm Plugin | Platform-specific API calls |
| **Message formatting** (platform-specific rendering) | Comm Plugin | Telegram Markdown vs GitHub Markdown vs email HTML |
| **State sync to external platforms** (labels, comments) | Comm Plugin | Platform-specific representation of internal state |
| **Inbound message delivery** (routing raw messages into the system) | Comm Plugin | Emits events on Event Bus for other components to handle |
| Query interpretation (understanding "status" vs task response) | Daemon | Keyword matching, not LLM intelligence — see `daemon-scheduler.md` § Query Handler |
| Response composition (crafting human-readable answers) | Daemon | Structured data retrieval + template formatting — no LLM needed |
| Notification cadence (when to notify) | Orchestrator | Milestone-based judgment (already designed in Orchestrator Layer 2) |
| What to communicate (content decisions) | Orchestrator | Phase-driven reasoning |

**The boundary:** Comm plugins are dumb transport. The Orchestrator owns all intelligence -- what to say, when to say it, how to interpret incoming messages. Comm plugins handle the mechanical platform interaction. This means swapping Telegram for Slack doesn't require reimplementing query parsing or notification logic.

---

## Comm Plugin Interface (Shared Contract)

```
CommPlugin {
  id:           string              (e.g., "telegram", "github", "email")
  platform:     string              (platform identifier)
  capabilities: string[]            ("send", "receive", "query", "sync")

  -- Outbound --
  sendMessage(target: Target, message: FormattedMessage)
  commentOnIssue(repo: string, issue_number: number, comment: string)
  createIssue(repo: string, options: IssueOptions) -> IssueResult
  updateIssue(repo: string, issue_number: number, updates: IssueUpdates)

  -- Inbound --
  onMessage(handler: (InboundMessage) -> void)

  -- Sync (optional capability) --
  syncTaskState(task: Task, old_state: string, new_state: string)?
}

Target {
  user_id:      string              (maps to People Directory entry)
  channel:      string?             (specific channel/chat/thread, optional)
}

FormattedMessage {
  content:      string              (platform-specific formatted content)
  metadata: {
    task_id:    string?
    type:       "notification" | "question" | "status_response" | "milestone"
  }
}

InboundMessage {
  source:       string              (comm plugin ID)
  sender:       string              (user identifier on the platform)
  content:      string              (raw message text)
  timestamp:    datetime
  reply_to:     string?             (if replying to a previous message)
  platform_metadata: object         (platform-specific data: chat_id, thread_id, etc.)
}
```

```
IssueOptions {
  title:         string
  body:          string
  labels:        string[]?
  assignees:     string[]?
  parent_issue:  number?             (link to parent issue for cross-reference)
}

IssueResult {
  number:        number              (the created issue number)
  url:           string
}

IssueUpdates {
  state:         "open" | "closed"?
  labels_add:    string[]?
  labels_remove: string[]?
  body:          string?             (for updating checklists on parent issues)
}
```

**Note on PR comments:** PR lifecycle operations (including replying to code review comments) are Workspace Manager territory, not comm plugin territory. The comm plugin handles issue-level communication and state sync. See [`workspace-manager.md`](workspace-manager.md) for PR operations.

### Capabilities

| Capability | What it means | Example plugins |
|-----------|---------------|-----------------|
| `send` | Can send outbound messages | All plugins |
| `receive` | Can receive inbound messages from humans | Telegram, Slack, GitHub (PR/issue comments) |
| `query` | Can handle status queries (has a persistent connection for real-time interaction) | Telegram, Slack |
| `sync` | Can sync internal state to the platform's own representation | GitHub (labels, project boards) |

Not all plugins need all capabilities. Email can `send` but not `receive` in real-time (polling for replies is a trigger concern, not a comm concern).

---

## Status Query Interface (Gap #20 -- Resolved)

### The Problem

When Farzam sends "status" or "what have you tried on 47?" via Telegram, the system needs to: (1) recognize it's a query (not a task response), (2) parse intent, (3) route to the right data source, (4) compose a human-readable answer.

### Design: Query Router (Orchestrator-Owned)

The comm plugin handles inbound message delivery. The **Orchestrator** handles interpretation and response composition. This separation keeps comm plugins as dumb transport and the intelligence in the Orchestrator.

### Flow

```
1. Human sends "status" via Telegram
2. Telegram comm plugin receives message
3. Comm plugin emits Event Bus: comm.message_received {
     source: "telegram",
     sender: "farzam",
     content: "status",
     timestamp: ...
   }
4. Daemon receives event (the Daemon always handles comm.message_received --
   the Orchestrator is never interrupted for queries)
5. Disambiguates: query or task response? (see disambiguation below)
6. Recognized as query → routes to data sources:
   - "status" → Task Engine: get all active/blocked/review-pending tasks
7. Composes response using structured data + templates (no LLM needed)
8. Sends response via same comm plugin:
   "Currently working on 1 task:
    #47 (dark mode toggle) — Active, execution phase. ~60% through.
    No blockers."
```

### Query Types

| Query pattern | Data source | What's returned |
|---------------|------------|-----------------|
| "status" / "what are you doing" | Task Engine (all active tasks) | Summary of current work |
| "progress on #N" / "what have you tried on #N" | Task Engine (state) + Session/Memory (journal entries) | Detailed task progress |
| "why did you decide X" | Session/Memory (decision journal entries) | Decision reasoning with alternatives considered |
| "what errors" / "any blockers" | Session/Memory (error entries) + Task Engine (blocked tasks) | Error/blocker list |
| "cost" / "how much have you spent" | Safety Layer (cost status) | Cost summary by task and aggregate |

### Query vs Task Response Disambiguation

When a message arrives, the system checks:

1. Is there a pending question for this sender? (Task Engine: any task Blocked with `waiting_for` matching sender)
2. If yes → route as task response (to the Orchestrator handling that task)
3. If no → route as query (to query handler)
4. If ambiguous → ask: "Is this a reply to my question about #47, or a new request?"

**Key design point:** The comm plugin doesn't parse queries. It delivers raw messages. Query parsing is handled by the Daemon's query handler (keyword matching, not LLM intelligence). This means swapping Telegram for Slack doesn't require reimplementing query parsing.

---

## GitHub State Sync (Gap #22 -- Resolved)

### The Problem

Internal task state (Active, Blocked, Review-Pending, etc.) should be visible on GitHub without Farzam checking the Telegram bot. Labels, issue comments, and project board status should reflect reality.

### Design: GitHub Comm Plugin as State Sync Subscriber

The GitHub comm plugin subscribes to task state change events on the Event Bus and syncs state to GitHub. This is a natural extension of the comm plugin -- it's the GitHub "channel" keeping its representation current.

### Sync Targets

| Internal event | GitHub action |
|---------------|--------------|
| Task created (from GitHub issue) | Add label: `engineer:queued` |
| Task → Active | Update label: `engineer:active`. Add comment: "Picked up, starting research." |
| Task → Blocked | Update label: `engineer:blocked`. Add comment with blocker details. |
| Task → Review_Pending.Demo | Update label: `engineer:review`. (PR already exists as Draft) |
| Task → Review_Pending.Code | Update label: `engineer:review`. (PR marked Ready) |
| Task → Completed | Update label: `engineer:done`. Close issue (if auto-close configured). |
| Task → Failed | Update label: `engineer:failed`. Add comment with failure details. |
| Child tasks created | **Create GitHub issues** for each child (via `createIssue`). Add comment to parent issue: "Decomposed into #51, #52, ..." with checklist. Link child issues to parent. |
| Child completed | Update parent issue comment: check off completed child in checklist. |

### Child Issue Creation Flow

When the Orchestrator decomposes a task into children:

```
1. Orchestrator decides to decompose task #50
2. Orchestrator creates child tasks via Task Engine (gets internal IDs: 51-55)
3. Orchestrator creates GitHub issues for each child via GitHub comm plugin:
   createIssue(repo, { title: "JWT utils", body: "...", parent_issue: 50, labels: ["engineer:queued"] })
   → Returns: { number: 51, url: "..." }
4. Orchestrator updates each child task's external_ref via Task Engine:
   Task #51: external_ref = { type: "github_issue", repo: "owner/repo", number: 51 }
5. GitHub comm plugin adds checklist comment to parent issue #50:
   "Decomposed into #51, #52, #53, #54, #55"
```

This keeps the Orchestrator as the coordinator: it creates internal tasks (Task Engine), external representations (GitHub comm plugin), and links them. The GitHub sync then handles ongoing state changes for each child automatically.

### Label Scheme

Labels follow the pattern `engineer:{state}` -- simple, scannable. Labels are mutually exclusive (old label removed when new one is added).

| Label | Meaning |
|-------|---------|
| `engineer:queued` | Task understood, waiting for capacity |
| `engineer:active` | Agent is working on this |
| `engineer:blocked` | Needs human input |
| `engineer:review` | PR open, awaiting review |
| `engineer:done` | Completed |
| `engineer:failed` | Failed (details in comment) |

### Sync Ownership

The GitHub comm plugin owns this sync. It subscribes to `task.state_changed` events on the Event Bus. No other component needs to know about GitHub labels -- this is the GitHub plugin's responsibility.

### Milestone Comments

At key milestones (same events as notification cadence defined in Orchestrator), the GitHub comm plugin adds issue comments. This creates a timeline on the issue itself -- visible to anyone watching the repo, not just Telegram subscribers.

Example timeline on GitHub issue #47:

```
🤖 Picked up. Starting with research on the settings page and theme system.
   [engineer:active]

🤖 Draft PR #52 ready. Demo inside — dark mode toggle with smooth transition.
   [engineer:review]

🤖 Feedback applied: extracted to useThemeToggle hook. PR marked Ready.

🤖 Completed. PR #52 merged.
   [engineer:done]
```

### Configuration

```
github_sync: {
  labels: {
    enabled:       boolean       (default: true)
    prefix:        string        (default: "engineer:")
  }
  issue_comments: {
    enabled:       boolean       (default: true)
    milestones_only: boolean     (default: true -- only at milestone events, not every state change)
  }
  auto_close_on_complete: {
    enabled:       boolean       (default: true)
  }
  project_board: {
    enabled:       boolean       (default: false)
    project_id:    string?       (GitHub Projects board ID)
  }
}
```

**Project board sync:** Optional. If configured, tasks move through board columns matching their states (Queued, Active, Review, Done). Deferred to Layer 3 for detailed column mapping.

---

## Comm Plugin Registration

Comm plugins register in the Registry like all plugins:

```
Registry.registerComm({
  id: "telegram",
  platform: "telegram",
  capabilities: ["send", "receive", "query"],
  config: {
    bot_token:    string
    chat_id:      string          (default chat for notifications)
  }
})

Registry.registerComm({
  id: "github",
  platform: "github",
  capabilities: ["send", "receive", "sync"],
  config: {
    token:        string
    default_org:  string?
    sync:         github_sync     (sync configuration above)
  }
})

Registry.registerComm({
  id: "email",
  platform: "email",
  capabilities: ["send"],
  config: {
    smtp:         SMTPConfig
    from_address: string
  }
})
```

---

## Interaction with Other Components

| Component | Interaction | Direction |
|-----------|-------------|-----------|
| **Orchestrator** | Sends notifications and questions via comm plugins. Receives inbound messages (via Event Bus). Composes all outbound content. Parses queries and composes responses. | Orchestrator -> Comm Plugin (outbound), Comm Plugin -> Event Bus -> Orchestrator (inbound) |
| **Event Bus** | Comm plugins emit `comm.message_received` for inbound messages. Subscribe to `task.state_changed` for state sync. Subscribe to milestone events for issue comments. All outbound sends are logged as events. | Bidirectional |
| **Registry** | Comm plugins register at startup. Orchestrator queries Registry for available comm channels. | Comm Plugin -> Registry (registration), Orchestrator -> Registry (lookup) |
| **Daemon** | Daemon handles `comm.message_received` events for query routing. Disambiguates query vs task response. Composes responses from Task Engine + Session/Memory data. | Comm Plugin → Event Bus → Daemon (inbound), Daemon → Comm Plugin (responses) |
| **Task Engine** | Daemon's query handler reads task state for status responses. GitHub sync reads task state for label updates. | Indirect (via Daemon or Event Bus) |
| **Session/Memory** | Daemon's query handler reads journal entries for "what have you tried?" and decision queries. | Indirect (via Daemon) |
| **Safety Layer** | Daemon's query handler reads cost status for cost queries. | Indirect (via Daemon) |
| **People Directory** | Outbound messages use People Directory to resolve contact details (user_id -> platform handle, preferred channel). | Orchestrator -> People Directory -> Comm Plugin |

---

## Gaps Resolved

| # | Gap | Resolution |
|---|-----|-----------|
| 20 | Status query interface | Query Router pattern: comm plugins are dumb transport. Orchestrator parses intent, routes to data sources (Task Engine, Session/Memory, Safety Layer), composes response. Query vs task-response disambiguation via pending question check. |
| 22 | GitHub state sync | GitHub comm plugin subscribes to `task.state_changed` events on Event Bus. Syncs labels (`engineer:{state}`), milestone comments on issues, child task checklists, and optionally project board columns. All configurable. |

---

## Open Questions for Layer 3

- **Query parsing sophistication**: Keyword matching? LLM-based intent recognition? How complex can queries get before the system misinterprets? (Layer 3)
- **Email comm plugin design**: Email is mentioned as the universal fallback. Full design for email-based interaction. (Layer 3)
- **GitHub project board sync**: Detailed column mapping, card management, board creation. (Layer 3)
- **Comm plugin error handling**: What if Telegram API is down? Message queuing? Retry with backoff? Fallback to another channel? (Layer 3)
- **Multi-channel notification preferences**: Some events to Telegram, some to email? Per-event routing config? (Layer 3)
- **Message threading**: How does the system maintain conversation threads across messages? Platform-specific threading (Telegram reply, GitHub issue thread, Slack thread). (Layer 3)
- **Rich media in messages**: Sending images (screenshots), files (logs), formatted tables. Platform-specific rendering capabilities. (Layer 3)
