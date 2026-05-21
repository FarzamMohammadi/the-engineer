# Lifecycle Traces -- Layer 3

Three end-to-end scenarios traced through every component. This is the architecture's integration test -- proving that protocols, events, plugin contracts, and error propagation work together as a coherent system.

Part of **Layer 3** -- see [`layers.md`](../layers.md). Cross-references all four Layer 3 documents:
- **[Protocols](protocols.md)** -- the choreography (P1-P15)
- **[Event Catalog](event-catalog.md)** -- the vocabulary (30 events)
- **[Adapter Contracts](adapter-contracts.md)** -- the interfaces (5 adapter types + Registry + People Directory)
- **[Error Propagation](error-propagation.md)** -- the failure handling (7 chains, 6 patterns)

---

## How to Read These Traces

### Conventions (matching protocols.md)

- **Bold component names** indicate who acts at each step
- `→` indicates a direct synchronous call (request/response)
- `⟹` indicates an async event published to the Event Bus
- `(P#)` references a protocol in protocols.md (e.g., `(P3)` = Task Dispatch)
- `[Event: type]` references an event in event-catalog.md
- `[Contract: Type.method()]` references an adapter contract in adapter-contracts.md
- `(Chain #)` / `(Pattern #)` references error-propagation.md
- Steps grouped into **phases** with headers. Each step shows the acting component, what happens, and all cross-references.

### What Traces Show That Protocols Don't

Protocols define mechanics -- how each interaction works in isolation. Traces show the **data in motion**: what's actually in the dispatch package at step 22, what the checkpoint contains at step 30, what the event payload says at step 11. Traces also show how protocols **chain together** -- P2 feeds P3 feeds P4 feeds P7, with P10 running throughout.

For protocol mechanics (step-by-step within a single protocol), refer to protocols.md. These traces show the full picture across protocols.

---

## Coverage Matrix

### Protocol Coverage

| Protocol | Scenario 1 | Scenario 2 | Scenario 3 |
|----------|-----------|-----------|-----------|
| P1: System Startup | Yes | - | Yes (crash restart) |
| P2: Task Creation | Yes | Yes (parent + children) | - |
| P3: Task Dispatch | Yes | Yes (parent + children) | Yes (post-recovery) |
| P4: Phase Transition | Yes (all 7 phases) | Yes (with loopback) | Yes (interrupted) |
| P5: Decomposition | - | Yes | - |
| P6: Progressive Merge | - | Yes (with conflict) | - |
| P7: Action Pipeline | Yes (read + side-effect) | Yes (ask_human verdict) | Yes (deny) |
| P8: Preemption | - | Yes | - |
| P9: Task Resume | - | Yes (post-preemption) | Yes (post-crash) |
| P10: Cost Tracking | Yes (normal) | Yes (normal) | Yes (limit breach) |
| P11: Blocking | - | Yes (question + unblock) | Yes (timeout ladder) |
| P12: Question Batching | - | Yes | - |
| P13: Notification | Yes (milestones + sync) | Yes (GitHub + Telegram) | Yes (fallback chain) |
| P14: Status Query | Yes | - | - |
| P15: Crash Recovery | - | - | Yes (Scenario B) |

### Event Coverage

| Event | S1 | S2 | S3 |
|-------|:--:|:--:|:--:|
| trigger.new_event | x | x | - |
| trigger.pr_review | x | x | - |
| task.created | x | x | - |
| task.state_changed | x | x | x |
| task.children_all_done | - | x | - |
| task.feedback_received | x | x | - |
| action.rejected | - | - | x |
| cost.incurred | x | x | x |
| cost.limit_reached | - | - | x |
| preemption.requested | - | x | - |
| preemption.ready | - | x | - |
| timeout.reminder | - | - | x |
| timeout.self_unblock_check | - | - | x |
| timeout.alert | - | - | x |
| workspace.created | x | x | x |
| workspace.verified | - | x | x |
| workspace.cleaned | x | - | - |
| workspace.merge_conflict | - | x | - |
| git.branch_created | x | x | - |
| git.committed | x | x | - |
| git.pushed | x | x | x |
| git.pr_opened | x | x | - |
| git.pr_updated | x | - | - |
| git.pr_merged | x | - | - |
| git.merge_completed | - | x | - |
| health.stuck_detected | - | - | x |
| health.trigger_failure | - | - | x |
| health.config_reload_failed | - | - | x |
| comm.message_received | x | x | x |
| comm.message_sent | x | x | x |

### Plugin Contract Coverage

| Contract | S1 | S2 | S3 |
|----------|:--:|:--:|:--:|
| Adapter.initialize/healthCheck/shutdown | x | - | x |
| TriggerAdapter.poll() | x | x | x |
| CommunicationAdapter.sendMessage() | x | x | x |
| CommunicationAdapter.startListening/stopListening | x | - | x |
| CommunicationAdapter.syncTaskState() | x | x | x |
| GitHubCommPlugin.createIssue/commentOnIssue/updateIssue | x | x | - |
| GitHubCommPlugin.reconcileState() | - | - | x |
| LLMAdapter.complete() | x | x | x |
| LLMAdapter.getCapabilities() | - | - | x |
| ToolAdapter.execute() | x | x | - |
| GitHostingAdapter.createPR/updatePR/mergePR | x | x | - |
| GitHostingAdapter.getPRStatus/getReviewStatus | x | - | - |
| Registry.getPlugin/getPluginsByType | x | x | x |
| PeopleDirectory.resolveContact/getPerson | x | x | x |

### Error Propagation Coverage

| Chain / Pattern | S1 | S2 | S3 |
|----------------|:--:|:--:|:--:|
| Chain 1: LLM Provider Down | - | - | x |
| Chain 2: Event Bus Down | - | - | x |
| Chain 3: Comm Failure During Block | - | - | x |
| Chain 4: Checkpoint Storage Failure | - | - | x |
| Chain 5: Cascade Failure | - | - | x |
| Chain 6: Workspace/Git Failure | - | x | x |
| Chain 7: Config Hot-Reload Failure | - | - | x |
| Pattern 1: Checkpoint-then-fail | - | - | x |
| Pattern 2: Retry-with-backoff | x | x | x |
| Pattern 3: Fallback-channel | - | - | x |
| Pattern 4: Ephemeral-reconstruction | - | - | x |
| Pattern 5: Degrade-and-continue | x | x | x |
| Pattern 6: Graceful-halt | - | - | x |

---

## Scenario 1: Happy Path

**"Add dark mode toggle to settings page"**

Farzam opens GitHub issue #47 on repo `acme/webapp`. The Engineer picks it up, works through all 7 phases, creates a Draft PR for demo, gets approval, marks Ready for code review, gets approved, merges, and completes. Farzam sends a status query via Telegram mid-execution.

This is the baseline lifecycle. Every other scenario builds on this foundation.

---

### System Startup (P1)

| Step | Component | Action | Protocol | Events | Contracts |
|------|-----------|--------|----------|--------|-----------|
| 1 | **Daemon** | Starts, loads system configuration | (P1.1) | - | - |
| 2 | **Event Bus** | Initializes persistence layer, begins accepting events and subscriptions | (P1.2) | - | - |
| 3 | **Registry** | Loads plugin manifests. Initializes in dependency order: Safety Layer, GitHubCommPlugin, TelegramCommPlugin, ClaudeCodeProvider, BashTool, GitHubHostingPlugin, GitHubIssuesTrigger (triggers last) | (P1.3) | - | `Contract: Adapter.initialize(config)` on each |
| 4 | **Safety Layer** | Loads policy config (scope rules, cost limits, autonomy). Replays cost events to rebuild accumulators (empty -- fresh system) | (P1.4) | (replays `cost.incurred`) | `→ EventBus.replay()` |
| 5 | **People Directory** | Loads people config. Farzam: owner+reviewer, contacts: [telegram (primary), github (secondary)], notification_level: milestones | (P1.5) | - | - |
| 6 | **Daemon** | Queries Task Engine for non-terminal tasks -- none found (fresh system). Empty priority queue | (P1.6-7) | - | `→ TaskEngine.getTasksByState()` |
| 7 | **Daemon** | Registers Event Bus subscriptions: `task.*`, `preemption.ready`, `comm.message_received`, `cost.limit_reached`, `workspace.*`, `git.*`. Starts main loop | (P1.8-9) | - | - |

System ready. Trigger polling begins.

---

### Task Creation (P2)

| Step | Component | Action | Protocol | Events | Contracts |
|------|-----------|--------|----------|--------|-----------|
| 8 | **Daemon** | Polls GitHub trigger at its declared `poll_interval` (e.g., 30s) | (P2.1) | - | `Contract: TriggerAdapter.poll()` |
| 9 | **GitHubIssuesTrigger** | Returns `TriggerEvent`: `{idempotency_key: "github:issue:acme/webapp:47", event_type: "issue_assigned", title: "Add dark mode toggle to settings page", external_ref: "https://github.com/acme/webapp/issues/47", repo: "acme/webapp", body: "Users want to toggle between light and dark themes..."}` | (P2.1) | - | - |
| 10 | **Daemon** | Deduplicates by `idempotency_key` -- not in dedup set, not in Task Engine `external_refs`. New work | (P2.2) | - | - |
| 11 | **Daemon** | Records trigger event for audit | (P2.3) | `⟹ trigger.new_event` `{source: "github_issues", event_type: "issue_assigned", title: "Add dark mode toggle..."}` | - |
| 12 | **Daemon** | Creates task via Task Engine | (P2.4) | - | `→ TaskEngine.createTask({title, external_ref, repo: "acme/webapp", source: "github-issues-trigger", priority: 50, parent_id: null})` |
| 13 | **Task Engine** | Creates task #47 in Intake. Validates repo. Populates `task.team[]` from People Directory: `[{id: "farzam", role: "owner"}, {id: "farzam", role: "reviewer"}]`. Transitions Intake → Queued (Intake is transient) | (P2.5) | `⟹ task.created` `{task_id: 47, parent_id: null, source: "trigger.github", priority: 50, repo: "acme/webapp"}` | `→ PeopleDirectory.getByRole("owner")` |
| | | | | `⟹ task.state_changed` `{task_id: 47, from_state: "Intake", to_state: "Queued"}` | |
| 14 | **Daemon** | Receives `task.created` → adds #47 to priority queue at priority 50 | (P2.6) | - | - |
| 15 | **GitHubCommPlugin** | Receives `task.created` via Event Bus subscription → adds `engineer:queued` label to issue #47. If GitHub API fails: retry with backoff (Pattern 2), then degrade (Pattern 5 -- label sync is best-effort) | (P2.7) | - | `Contract: GitHubCommPlugin.updateIssue(repo, 47, {labels_add: ["engineer:queued"]})` |

**State after step 15:** Task #47 exists in Queued. Team populated. No workspace yet. Priority queue: [#47].

---

### Task Dispatch (P3)

| Step | Component | Action | Protocol | Events | Contracts |
|------|-----------|--------|----------|--------|-----------|
| 16 | **Daemon** | Scheduling evaluation: #47 is highest-priority Queued task. `active_working_count (0) < max_concurrent (1)`. No dependency blockers. Selects #47 | (P3.1) | - | - |
| 17 | **Daemon** | Requests state transition | (P3.2) | `⟹ task.state_changed` `{task_id: 47, from_state: "Queued", to_state: "Active", to_sub: "Working", reason: "scheduled"}` | `→ TaskEngine.requestTransition(47, "Active.Working", "scheduled")` |
| 18 | **Task Engine** | Creates workspace for task | (P3.3) | - | `→ WorkspaceManager.createWorkspace(47, "acme/webapp", "main", null)` |
| 19 | **Workspace Manager** | `git fetch origin` → creates branch `engineer/47-dark-mode` from `main` → `git worktree add` | (P3.3) | `⟹ workspace.created` `{task_id: 47, repo: "acme/webapp", branch: "engineer/47-dark-mode", base_branch: "main"}` | - |
| | | | | `⟹ git.branch_created` `{task_id: 47, branch: "engineer/47-dark-mode", from_ref: "main"}` | |
| 20 | **Task Engine** | Receives `workspace.created` → updates `task.workspace = {branch: "engineer/47-dark-mode", worktree_path: "/worktrees/47-dark-mode"}` | (P3.4) | - | - |
| 21 | **Daemon** | Assembles Dispatch package | (P3.5) | - | `→ SessionMemory.getLatestCheckpoint(47)` → null (new task) |
| | | | | | `→ SessionMemory.queryKnowledge("repo", "acme/webapp")` → repo patterns |
| | | | | | `→ SessionMemory.queryKnowledge("user")` → user preferences |

**Dispatch package contents:**
```
{
  task: { id: 47, title: "Add dark mode toggle...", state: "Active.Working",
          repo: "acme/webapp", team: [{id: "farzam", role: "owner"}],
          workspace: { branch: "engineer/47-dark-mode", worktree_path: "..." },
          cost: { llm_tokens: 0, llm_cost_usd: 0 }, priority: 50 },
  resume_from: null,
  knowledge: {
    repo: [{ domain: "frontend", key: "css_framework", body: "Uses Tailwind CSS" }],
    user: [{ key: "code_style", body: "Prefers functional components" }]
  }
}
```

| Step | Component | Action | Protocol | Events | Contracts |
|------|-----------|--------|----------|--------|-----------|
| 22 | **Daemon** | Hands Dispatch to Orchestrator (process-level hand-off) | (P3.6) | - | - |
| 23 | **Orchestrator** | Creates new Session. Enters `intake-analysis` phase. Logs journal | (P3.7) | - | `→ SessionMemory.createSession(47)` |
| | | | | | `→ SessionMemory.appendJournal(session_id, {type: "phase_change", summary: "Task started, entering intake-analysis"})` |

**State after step 23:** Orchestrator executing. Workspace ready. Session active. Knowledge loaded.

---

### Phase Pipeline (P4, P7, P10)

The Orchestrator works through all 7 phases. Each phase follows the same rhythm: LLM reasoning (cost events), actions through the pipeline (Gate 1 + Gate 2), checkpoint at phase boundary. We trace key moments rather than every LLM call.

**intake-analysis:**

| Step | Component | Action | Protocol | Events | Contracts |
|------|-----------|--------|----------|--------|-----------|
| 24 | **Orchestrator** | Reads issue body and existing settings page code. Read action -- Gate 1 only, no Gate 2 (Decision #50) | (P7.1-2) | - | `→ TaskEngine.checkPermission(47, "read")` → permitted |
| 25 | **Orchestrator** | Uses BashTool to read files in worktree | (P7.9) | - | `Contract: ToolAdapter.execute("read", {path: "src/pages/Settings.tsx"})` |
| 26 | **Orchestrator** | Calls LLM to analyze requirements and existing code | - | - | `Contract: LLMAdapter.complete({prompt: "Analyze this settings page...", options: {max_tokens: 4096}})` |
| 27 | **Orchestrator** | Emits cost event from completion result usage data | (P10.1-2) | `⟹ cost.incurred` `{task_id: 47, provider_id: "claude-code", provider_type: "cli", operation: "analysis", usage_units: 1}` | - |
| 28 | **Safety Layer** | Receives `cost.incurred`. Updates `cli_usage["claude-code"].requests_used += 1`. Checks against limits -- within bounds | (P10.5-6) | - | - |
| 29 | **Task Engine** | Receives `cost.incurred`. Updates `task.cost.llm_tokens += tokens_in + tokens_out` | (P10.4) | - | - |
| 30 | **Orchestrator** | Completes intake-analysis. Creates mandatory phase-boundary checkpoint | (P4.1-2) | - | `→ SessionMemory.createCheckpoint(session_id, checkpoint_data)` |

**Checkpoint contents at step 30:**
```
{
  phase: "intake-analysis",
  phase_progress: "Analyzed issue requirements and existing settings page structure",
  context_summary: "Task #47: Add dark mode toggle to settings page in acme/webapp.
    Settings page is at src/pages/Settings.tsx, uses Tailwind CSS. Existing theme
    system uses CSS variables defined in styles/theme.css. Toggle should be added
    to the Appearance section. Need to add localStorage persistence.",
  key_findings: ["Existing CSS variable theme system in styles/theme.css",
                  "Settings page has Appearance section at line 142",
                  "No existing dark mode implementation"],
  open_questions: [],
  next_action: "Research existing theme patterns and dark mode implementations in the codebase",
  reason: "phase_transition"
}
```

| Step | Component | Action | Protocol | Events | Contracts |
|------|-----------|--------|----------|--------|-----------|
| 31 | **Orchestrator** | Captures knowledge learned during analysis | (P4.3) | - | `→ SessionMemory.storeKnowledge({scope: "repo", repo_scope: "acme/webapp", domain: "frontend", key: "theme_system", body: "CSS variables in styles/theme.css", confidence: 0.9})` |
| 32 | **Orchestrator** | Updates task phase, logs journal, enters research phase | (P4.4-7) | - | `→ TaskEngine.updateTaskField(47, "phase", "research")` |
| | | | | | `→ SessionMemory.appendJournal(session_id, {type: "phase_change", summary: "Completed intake-analysis, entering research"})` |

**research → planning → execution → self-review:**

These phases follow the same pattern. Key actions during execution:

| Step | Component | Action | Protocol | Events | Contracts |
|------|-----------|--------|----------|--------|-----------|
| 33 | **Orchestrator** | (execution phase) Writes toggle component. Side-effect -- full Action Pipeline. Gate 1: `write` permitted in Active.Working. Gate 2: scope check -- file is within `acme/webapp` repo boundary | (P7.3-6) | - | `→ TaskEngine.checkPermission(47, "write")` → permitted |
| | | | | | `→ SafetyLayer.evaluate({type: "can_i", action_class: "write", path: "src/components/ThemeToggle.tsx"})` → `{allowed: true}` |
| 34 | **Orchestrator** | Writes the file via tool | (P7.9) | - | `Contract: ToolAdapter.execute("file_write", {path: "src/components/ThemeToggle.tsx", content: "..."})` |
| | | Side effects reported: `[{type: "file_written", details: {path: "src/components/ThemeToggle.tsx", bytes: 1847}}]` | | | |
| 35 | **Orchestrator** | Git commit -- side-effect pipeline | (P7.3-10) | `⟹ git.committed` `{task_id: 47, sha: "a1b2c3d", message: "Add ThemeToggle component", files_changed: 1}` | `→ TaskEngine.checkPermission(47, "git-local")` → permitted |
| | | | | | `→ SafetyLayer.evaluate({type: "can_i", action_class: "git-local"})` → proceed |
| | | | | | `→ WorkspaceManager.commit(47, "Add ThemeToggle component")` |
| 36 | **Orchestrator** | Runs tests -- side-effect pipeline | (P7) | - | `→ TaskEngine.checkPermission(47, "test")` → permitted |
| | | | | | `→ SafetyLayer.evaluate({type: "can_i", action_class: "test"})` → proceed |
| | | | | | `Contract: ToolAdapter.execute("run_tests", {})` |
| 37 | **Orchestrator** | Multiple cost events emitted throughout execution and self-review (one per LLM call) | (P10) | `⟹ cost.incurred` (multiple) | - |

---

### Status Query Interlude (P14)

Partway through execution, Farzam sends a status query via Telegram. This runs in the Daemon's event loop -- the Orchestrator is not interrupted.

| Step | Component | Action | Protocol | Events | Contracts |
|------|-----------|--------|----------|--------|-----------|
| 38 | **TelegramCommPlugin** | Receives message from Farzam: "how's it going?" | - | `⟹ comm.message_received` `{source: "telegram", sender: "farzam", content: "how's it going?"}` | - |
| 39 | **Daemon** | Receives `comm.message_received`. Checks: any tasks Blocked for farzam? No. Treats as query | (P14.2-3) | - | `→ TaskEngine.getBlockedTasksForPerson("farzam")` → [] |
| 40 | **Daemon** | Parses query: keywords match `status_overview` | (P14.4) | - | - |
| 41 | **Daemon** | Queries Task Engine for all non-terminal tasks | (P14.5a) | - | `→ TaskEngine.getTasksByState()` |
| 42 | **Daemon** | Composes response from template (no LLM): | (P14.6) | - | - |

**Status response:**
```
Currently working on 1 task:
  #47 (dark mode toggle) -- Active, execution phase. ~50% through.

No blockers. No tasks in review. 0 queued.
```

| Step | Component | Action | Protocol | Events | Contracts |
|------|-----------|--------|----------|--------|-----------|
| 43 | **Daemon** | Sends response via Telegram (same channel as query) | (P14.7) | `⟹ comm.message_sent` `{type: "status_response", channel: "telegram"}` | `Contract: CommunicationAdapter.sendMessage(target, message)` |

---

### Demo Prep and Draft PR (P4, P7, P13)

| Step | Component | Action | Protocol | Events | Contracts |
|------|-----------|--------|----------|--------|-----------|
| 44 | **Orchestrator** | Enters demo-prep phase. Pushes branch -- side-effect pipeline: Gate 1 (`git-remote` permitted in Working), Gate 2 (scope: branch `engineer/47-dark-mode` is within allowed pattern) | (P7.3-10) | `⟹ git.pushed` `{task_id: 47, branch: "engineer/47-dark-mode", head_sha: "e4f5g6h"}` | `→ TaskEngine.checkPermission(47, "git-remote")` → permitted |
| | | | | | `→ SafetyLayer.evaluate({type: "can_i", action_class: "git-remote", branch: "engineer/47-dark-mode"})` → proceed |
| | | | | | `→ WorkspaceManager.push(47)` |
| 45 | **Orchestrator** | Creates Draft PR -- side-effect pipeline | (P7) | `⟹ git.pr_opened` `{task_id: 47, pr_number: 51, draft: true, title: "Add dark mode toggle to settings page", base_branch: "main", head_branch: "engineer/47-dark-mode"}` | `Contract: GitHostingAdapter.createPR({repo: "acme/webapp", branch: "engineer/47-dark-mode", base: "main", title: "...", body: "...", draft: true, reviewers: ["farzam"]})` |
| 46 | **Task Engine** | Receives `git.pr_opened` → updates `task.review = {pr_number: 51, pr_state: "draft"}` | - | - | - |
| 47 | **Orchestrator** | Sends milestone notification: Draft PR ready | (P13.1-6) | `⟹ comm.message_sent` `{type: "milestone", task_id: 47}` | `→ PeopleDirectory.resolveContact("farzam", "telegram")` |
| | | Checks Farzam's notification_level ("milestones") -- this qualifies. Checks quiet hours -- outside. Sends | | | `Contract: CommunicationAdapter.sendMessage(target, {content: "Draft PR #51 ready for demo review: Add dark mode toggle to settings page", type: "milestone"})` |
| 48 | **Orchestrator** | Requests transition to Review-Pending.Demo | - | `⟹ task.state_changed` `{task_id: 47, from_state: "Active", from_sub: "Working", to_state: "Review-Pending", to_sub: "Demo"}` | `→ TaskEngine.requestTransition(47, "Review-Pending.Demo")` |
| 49 | **GitHubCommPlugin** | Receives `task.state_changed` via Event Bus subscription. Autonomous sync: removes `engineer:active`, adds `engineer:review-pending`. Posts milestone comment on issue | (P13.7) | - | `Contract: GitHubCommPlugin.updateIssue(repo, 47, {labels_add: ["engineer:review-pending"], labels_remove: ["engineer:active"]})` |
| | | | | | `Contract: GitHubCommPlugin.commentOnIssue(repo, 47, "Draft PR #51 ready for demo review")` |

**State after step 49:** Task in Review-Pending.Demo. Working slot freed. PR #51 open as Draft. Farzam notified via Telegram. GitHub labels updated.

---

### Demo Review Feedback

| Step | Component | Action | Protocol | Events | Contracts |
|------|-----------|--------|----------|--------|-----------|
| 50 | **GitHubIssuesTrigger** | Next poll detects PR review on Draft PR #51: Farzam approves with comment "Looks great! Maybe add a subtle transition animation when toggling" | - | - | `Contract: TriggerAdapter.poll()` |
| | | Returns `TriggerEvent` with `event_type: "pr_review_received"`, `metadata: {task_id: 47, pr_number: 51, review_type: "approved", pr_state: "draft", reviewer: "farzam", comment: "Looks great! Maybe add..."}` | | | |
| 51 | **Daemon** | Emits trigger event, then translates to task feedback | - | `⟹ trigger.pr_review` `{task_id: 47, review_type: "approved", pr_state: "draft", reviewer: "farzam"}` | - |
| 52 | **Task Engine** | Daemon routes feedback through Task Engine | - | `⟹ task.feedback_received` `{task_id: 47, stage: "demo", feedback_type: "approved", reviewer: "farzam", content: "Looks great! Maybe add..."}` | - |
| 53 | **Daemon** | Demo approved -- transitions task back to Active.Working to address feedback and mark Ready | - | `⟹ task.state_changed` `{from_state: "Review-Pending", from_sub: "Demo", to_state: "Active", to_sub: "Working"}` | `→ TaskEngine.requestTransition(47, "Active.Working", "demo_approved")` |
| 54 | **Orchestrator** | Receives feedback. Incorporates animation suggestion. Makes changes, commits, pushes. Cost events for each LLM call | (P7, P10) | `⟹ git.committed`, `⟹ git.pushed`, `⟹ cost.incurred` (multiple) | `Contract: LLMAdapter.complete()`, `→ WorkspaceManager.commit()`, `→ WorkspaceManager.push()` |
| 55 | **Orchestrator** | Updates PR: marks Ready (`draft: false`) | - | `⟹ git.pr_updated` `{task_id: 47, pr_number: 51, draft: false, previous_draft: true, update_type: "marked_ready"}` | `Contract: GitHostingAdapter.updatePR("acme/webapp", 51, {draft: false})` |
| 56 | **Orchestrator** | Requests transition to Review-Pending.Code | - | `⟹ task.state_changed` `{to_state: "Review-Pending", to_sub: "Code"}` | `→ TaskEngine.requestTransition(47, "Review-Pending.Code")` |
| 57 | **Orchestrator** | Sends milestone: PR ready for code review | (P13) | `⟹ comm.message_sent` `{type: "milestone"}` | `Contract: CommunicationAdapter.sendMessage(target, "PR #51 for #47 is ready for code review")` |
| 58 | **GitHubCommPlugin** | Autonomous state sync: updates labels, posts milestone comment | (P13.7) | - | `Contract: GitHubCommPlugin.updateIssue()`, `Contract: GitHubCommPlugin.commentOnIssue()` |

---

### Code Review and Completion

| Step | Component | Action | Protocol | Events | Contracts |
|------|-----------|--------|----------|--------|-----------|
| 59 | **GitHubIssuesTrigger** | Detects code review approval on Ready PR #51 | - | - | `Contract: TriggerAdapter.poll()` |
| 60 | **Daemon** | Processes review: trigger.pr_review → task.feedback_received (stage: "code", approved) | - | `⟹ trigger.pr_review`, `⟹ task.feedback_received` `{stage: "code", feedback_type: "approved"}` | - |
| 61 | **Daemon** | Transitions: Review-Pending.Code → Active.Working (for integration) | - | `⟹ task.state_changed` `{to_state: "Active", to_sub: "Working", reason: "code_review_approved"}` | `→ TaskEngine.requestTransition()` |
| 62 | **Orchestrator** | Enters integration phase. Checks auto-merge config for repo. Merge action through pipeline: Gate 1 (`merge` permitted in Active.Working, conditional on auto-merge config -- configured). Gate 2: Safety Layer evaluates merge scope | (P7.3-10) | - | `→ TaskEngine.checkPermission(47, "merge")` → permitted (auto-merge configured) |
| | | | | | `→ SafetyLayer.evaluate({type: "can_i", action_class: "merge"})` → proceed |
| 63 | **Orchestrator** | Checks PR is mergeable, then merges | - | - | `Contract: GitHostingAdapter.getPRStatus("acme/webapp", 51)` → `{mergeable: true, checks_passing: true}` |
| | | | | | `Contract: GitHostingAdapter.getReviewStatus("acme/webapp", 51)` → `{approved: true}` |
| | | | | `⟹ git.pr_merged` `{task_id: 47, pr_number: 51, merge_strategy: "squash", merge_sha: "x9y8z7", into_branch: "main"}` | `Contract: GitHostingAdapter.mergePR("acme/webapp", 51, "squash")` |
| 64 | **Task Engine** | Receives `git.pr_merged` → transitions to Completed | - | `⟹ task.state_changed` `{to_state: "Completed"}` | - |
| 65 | **Workspace Manager** | Terminal state reached -- cleans up worktree. Branch preserved (merged into main, branch ref kept for history) | - | `⟹ workspace.cleaned` `{task_id: 47, branch_preserved: true}` | - |
| 66 | **Orchestrator** | Final journal entry, ends session | - | - | `→ SessionMemory.appendJournal(session_id, {type: "phase_change", summary: "Task completed. PR #51 merged."})` |
| | | | | | `→ SessionMemory.endSession(session_id, "completed")` |
| 67 | **Orchestrator** | Sends completion milestone | (P13) | `⟹ comm.message_sent` `{type: "milestone"}` | `Contract: CommunicationAdapter.sendMessage(target, "Task #47 completed. PR #51 merged into main.")` |
| 68 | **GitHubCommPlugin** | Autonomous sync: updates label to `engineer:completed`, closes issue, adds completion comment | (P13.7) | - | `Contract: GitHubCommPlugin.updateIssue(repo, 47, {state: "closed", labels_add: ["engineer:completed"], labels_remove: ["engineer:review-pending"]})` |

**Final state:** Task #47 Completed. PR #51 merged. Issue closed. Worktree cleaned. Session ended. All cost tracked.

---

### Fast-Path Variant

If this were a trivial task (e.g., fix a typo -- ≤2 files, no ambiguity, <30 min estimate), the Orchestrator would detect fast-path eligibility during intake-analysis and:

- **Skip** research, planning, and demo-prep phases (steps 32-33 and demo flow)
- **Collapse** all milestone notifications into one: "Fixed typo in Settings.tsx (#47). PR #51 ready for review."
- **Total phases**: intake-analysis → execution → self-review → integration (4 instead of 7)

The Action Pipeline, cost tracking, and state machine work identically. Only the Orchestrator's internal phase sequence changes.

---

## Scenario 2: Complex Path

**"Refactor authentication module to support OAuth2"**

GitHub issue #52 on repo `acme/api-server`. The Engineer determines during planning that this needs decomposition into 2 children: Child A ("Add OAuth2 provider interface") and Child B ("Migrate existing JWT auth to new interface" -- depends on A). During child A's execution, an urgent task #53 preempts it. After preemption resolves, child A resumes, completes, and progressive merge into the parent hits a merge conflict. Child B then completes. Parent enters Integrating for final assembly.

This scenario exercises coordination: decomposition, preemption, resume, merge conflict, blocking questions, question batching, and sibling knowledge flow.

---

### Task Creation and Dispatch (P2, P3)

Same pattern as Scenario 1 steps 8-23. Abbreviated:

| Step | Component | Action | Protocol | Events | Contracts |
|------|-----------|--------|----------|--------|-----------|
| 1 | **Daemon/Trigger** | Polls, discovers issue #52, deduplicates, creates task via Task Engine | (P2) | `⟹ trigger.new_event`, `⟹ task.created` `{task_id: 52}`, `⟹ task.state_changed` `{Intake→Queued}` | `Contract: TriggerAdapter.poll()`, `→ TaskEngine.createTask()` |
| 2 | **Daemon** | Dispatches #52: Queued → Active.Working. Workspace created on branch `engineer/52-oauth2-refactor` | (P3) | `⟹ task.state_changed` `{Queued→Active.Working}`, `⟹ workspace.created`, `⟹ git.branch_created` | `→ WorkspaceManager.createWorkspace()`, `→ SessionMemory.createSession()` |
| 3 | **Orchestrator** | Works through intake-analysis and research phases. Multiple LLM calls with cost tracking. Discovers scope: 20+ files across auth module | (P4, P10) | `⟹ cost.incurred` (multiple) | `Contract: LLMAdapter.complete()`, `→ SessionMemory.createCheckpoint()` x2 |

---

### Planning with Decomposition and Blocking Questions (P5, P7, P11, P12)

| Step | Component | Action | Protocol | Events | Contracts |
|------|-----------|--------|----------|--------|-----------|
| 4 | **Orchestrator** | During planning, determines task needs decomposition: Child A ("OAuth2 provider interface"), Child B ("Migrate JWT auth", depends on A) | (P5.1) | - | - |
| 5 | **Orchestrator** | Checks autonomy for decomposition via Action Pipeline Gate 2 | (P5.2, P7.5) | - | `→ SafetyLayer.evaluate({type: "autonomy_check", category: "task_decomposition", context: {child_count: 2}})` → verdict: `ask_human` |
| 6 | **Orchestrator** | Also has an architectural question from research: "Should we maintain backward compat with old JWT tokens during migration?" Creates question record with urgency: "blocking" | (P12.1) | - | - |
| 7 | **Orchestrator** | Adds both questions to batch. Batch window starts (30s). No other work possible -- both are blocking. Batch flushes immediately | (P12.2-4) | - | - |

**Question batch sent to Farzam:**
```
Questions on #52 (OAuth2 refactor):

1. I'd like to decompose this into two sub-tasks:
   (A) Add OAuth2 provider interface
   (B) Migrate existing JWT auth to new interface (depends on A)
   Approve? (A) Yes (B) No, work as single task

2. Should we maintain backward compatibility with existing JWT tokens
   during migration?
   (A) Yes, 6-month deprecation window
   (B) No, clean break

Reply with numbers, e.g., '1:A 2:B'
```

| Step | Component | Action | Protocol | Events | Contracts |
|------|-----------|--------|----------|--------|-----------|
| 8 | **Orchestrator** | Transitions to Blocked | (P11.4) | `⟹ task.state_changed` `{Active.Working → Blocked, reason: "awaiting_human_input"}` | `→ TaskEngine.requestTransition(52, "Blocked", "awaiting_human_input")` |
| 9 | **Orchestrator** | Resolves contact, sends question batch via Telegram | (P11.5-6, P12.5) | `⟹ comm.message_sent` `{type: "question", task_id: 52}` | `→ PeopleDirectory.resolveContact("farzam", "telegram")` |
| | | | | | `Contract: CommunicationAdapter.sendMessage(target, formatted_batch)` |
| 10 | **Daemon** | Receives `task.state_changed` (Blocked). Starts timeout timers: reminder at 4hr, self_unblock_check at 24hr, alert at 48hr | (P11.7) | - | `→ SafetyLayer.getTimeoutPolicy()` |

---

### Human Response and Unblocking (P11, P12)

| Step | Component | Action | Protocol | Events | Contracts |
|------|-----------|--------|----------|--------|-----------|
| 11 | **TelegramCommPlugin** | Receives Farzam's reply: "1:A 2:A" | - | `⟹ comm.message_received` `{sender: "farzam", content: "1:A 2:A", reply_to: message_id}` | - |
| 12 | **Daemon** | Receives event. Checks: #52 is Blocked with `waiting_for: "farzam"`. Routes as task response | (P11.9-10) | - | `→ TaskEngine.getBlockedTasksForPerson("farzam")` → [#52] |
| 13 | **Orchestrator** | Structured parsing succeeds: Q1=A (decomposition approved), Q2=A (backward compat, 6-month window) | (P12.8a) | - | - |
| 14 | **Orchestrator** | Applies answers. Logs decisions in journal | (P11.12, P12.9) | - | `→ SessionMemory.appendJournal(session_id, {type: "decision", summary: "Decomposition approved"})` |
| | | | | | `→ SessionMemory.appendJournal(session_id, {type: "decision", summary: "Backward compat: 6-month window"})` |
| 15 | **Daemon** | Cancels timeout timers. Transitions Blocked → Queued | (P11.13-14) | `⟹ task.state_changed` `{Blocked → Queued, reason: "unblocked"}` | `→ TaskEngine.requestTransition(52, "Queued", "unblocked")` |
| 16 | **Daemon** | Re-dispatches #52 via resume flow (has checkpoint) | (P9) | `⟹ task.state_changed` `{Queued → Active.Working, reason: "resumed"}` | `→ WorkspaceManager.verifyWorkspace()` |
| | | | | `⟹ workspace.verified` `{status: "valid"}` | `→ SessionMemory.getLatestCheckpoint(52)` |
| 17 | **Orchestrator** | Context reconstruction from checkpoint. Resumes in planning phase with approval context | (P9.7-11) | - | `→ SessionMemory.createSession(52, prev_session_id)` |

---

### Child Creation (P5)

| Step | Component | Action | Protocol | Events | Contracts |
|------|-----------|--------|----------|--------|-----------|
| 18 | **Orchestrator** | Creates Child A via Task Engine | (P5.4) | `⟹ task.created` `{task_id: "52A", parent_id: 52}` | `→ TaskEngine.createTask({title: "Add OAuth2 provider interface", parent_id: 52, priority: 50, dependencies: []})` |
| | | | | `⟹ task.state_changed` `{Intake→Queued}` | |
| 19 | **Orchestrator** | Creates Child B (depends on A) | (P5.4) | `⟹ task.created` `{task_id: "52B", parent_id: 52}` | `→ TaskEngine.createTask({title: "Migrate JWT auth", parent_id: 52, priority: 50, dependencies: ["52A"]})` |
| | | | | `⟹ task.state_changed` `{Intake→Queued}` | |
| 20 | **Orchestrator** | Creates GitHub issues for each child, updates parent issue with checklist | (P5.5-6) | - | `Contract: GitHubCommPlugin.createIssue(repo, {title: "Add OAuth2 provider interface", labels: ["engineer:queued"], parent_issue: 52})` |
| | | | | | `Contract: GitHubCommPlugin.createIssue(repo, {title: "Migrate JWT auth", labels: ["engineer:queued"], parent_issue: 52})` |
| | | | | | `Contract: GitHubCommPlugin.commentOnIssue(repo, 52, "Decomposed into: - [ ] #53A: OAuth2 interface - [ ] #53B: Migrate JWT")` |
| 21 | **Task Engine** | Transitions parent: Active.Working → Active.Supervising. Slot freed | (P5.7) | `⟹ task.state_changed` `{from_sub: "Working", to_sub: "Supervising"}` | - |
| 22 | **Daemon** | Receives `task.created` for children. Child A eligible (no deps). Child B blocked on A | (P5.8) | - | - |
| 23 | **Orchestrator** | Logs decomposition in journal | (P5.9) | - | `→ SessionMemory.appendJournal(session_id, {type: "decision", summary: "Decomposed into 2 children: A (OAuth2 interface), B (JWT migration, depends on A)"})` |

**State:** Parent #52 is Supervising (no slot consumed). Child A is Queued. Child B is Queued but blocked on A.

---

### Child A: Dispatch, Work, and Preemption (P3, P4, P8)

| Step | Component | Action | Protocol | Events | Contracts |
|------|-----------|--------|----------|--------|-----------|
| 24 | **Daemon** | Dispatches Child A. Workspace on branch `engineer/52/52A-oauth2-interface` (branched from parent branch) | (P3) | `⟹ task.state_changed` `{Queued→Active.Working}`, `⟹ workspace.created`, `⟹ git.branch_created` `{branch: "engineer/52/52A-oauth2-interface"}` | `→ WorkspaceManager.createWorkspace(52A, repo, parent_branch: "engineer/52-oauth2-refactor")` |
| 25 | **Orchestrator** | Works through intake-analysis, research, planning (scope well-defined from parent). Enters execution. Multiple LLM calls | (P4, P10) | `⟹ cost.incurred` (multiple) | `Contract: LLMAdapter.complete()` (multiple) |

**Preemption -- urgent task arrives:**

| Step | Component | Action | Protocol | Events | Contracts |
|------|-----------|--------|----------|--------|-----------|
| 26 | **GitHubIssuesTrigger** | Polls, discovers urgent issue #53 "Critical: API auth bypass in production" with label `priority:critical` mapping to priority 95 | (P2) | `⟹ trigger.new_event`, `⟹ task.created` `{task_id: 53, priority: 95}`, `⟹ task.state_changed` `{Intake→Queued}` | `Contract: TriggerAdapter.poll()`, `→ TaskEngine.createTask()` |
| 27 | **Daemon** | Scheduling tick: #53 (priority 95) vs Child A (priority 50). Delta = 45 ≥ preemption_threshold (20). Initiates preemption | (P8.1) | - | - |
| 28 | **Daemon** | Emits preemption request. Starts 60s timeout | (P8.2-3) | `⟹ preemption.requested` `{target_task_id: "52A", preempting_task_id: 53, priority_delta: 45}` | - |
| 29 | **Orchestrator** | Receives preemption signal. Finishes current atomic op (LLM call in progress -- lets it complete). Does not start new ops | (P8.4) | - | - |
| 30 | **Orchestrator** | Creates preemption checkpoint | (P8.5) | - | `→ SessionMemory.createCheckpoint(session_id, checkpoint_data)` |

**Preemption checkpoint contents:**
```
{
  phase: "execution",
  phase_progress: "Implemented 3 of 5 OAuth2 provider interface methods",
  context_summary: "Child A of #52: Adding OAuth2 provider interface to acme/api-server.
    Created src/auth/providers/oauth2.ts with base interface. Implemented authorize(),
    callback(), refreshToken(). Remaining: revokeToken(), getUserProfile(). Tests
    written for completed methods.",
  key_findings: ["Existing auth middleware at src/auth/middleware.ts needs adapter",
                 "Token storage uses Redis via src/auth/store.ts"],
  open_questions: [],
  next_action: "Implement revokeToken() and getUserProfile() methods",
  reason: "preemption",
  workspace_ref: { branch: "engineer/52/52A-oauth2-interface", last_commit: "f1e2d3c" }
}
```

| Step | Component | Action | Protocol | Events | Contracts |
|------|-----------|--------|----------|--------|-----------|
| 31 | **Orchestrator** | Logs journal, ends session, emits ready signal | (P8.6-8) | `⟹ preemption.ready` `{task_id: "52A", checkpoint_id: "chk_7", phase: "execution"}` | `→ SessionMemory.appendJournal()`, `→ SessionMemory.endSession(reason: "preempted")` |
| 32 | **Daemon** | Cancels preemption timeout. Transitions Child A: Active.Working → Queued | (P8.9-11) | `⟹ task.state_changed` `{Active.Working → Queued, reason: "preempted"}` | `→ TaskEngine.requestTransition("52A", "Queued", "preempted")` |
| 33 | **Daemon** | Dispatches #53 via P3. Creates workspace, Orchestrator begins working on critical fix | (P3) | `⟹ task.state_changed` `{Queued→Active.Working}`, `⟹ workspace.created` | `→ WorkspaceManager.createWorkspace()` |

**(Task #53 works and completes -- follows Scenario 1 pattern. Working slot freed.)**

---

### Child A Resume (P9)

| Step | Component | Action | Protocol | Events | Contracts |
|------|-----------|--------|----------|--------|-----------|
| 34 | **Daemon** | After #53 completes, evaluates queue. Child A is highest-priority Queued task. Detects resume (checkpoint exists) | (P9.1) | - | `→ SessionMemory.getLatestCheckpoint("52A")` → checkpoint `chk_7` |
| 35 | **Daemon** | Transitions: Queued → Active.Working (resumed) | (P9.2) | `⟹ task.state_changed` `{Queued → Active.Working, reason: "resumed"}` | `→ TaskEngine.requestTransition("52A", "Active.Working", "resumed")` |
| 36 | **Daemon** | Verifies workspace: worktree intact, branch at expected commit `f1e2d3c` | (P9.3-4a) | `⟹ workspace.verified` `{status: "valid", current_commit: "f1e2d3c"}` | `→ WorkspaceManager.verifyWorkspace()` |
| 37 | **Daemon** | Assembles Dispatch with checkpoint and knowledge (may include new knowledge from #53's work) | (P9.5) | - | `→ SessionMemory.getLatestCheckpoint("52A")`, `→ SessionMemory.queryKnowledge()` |
| 38 | **Orchestrator** | Receives Dispatch. Creates new Session linked to previous. Context reconstruction from checkpoint: seeds LLM with `context_summary`, injects `key_findings`, reads `next_action` ("Implement revokeToken() and getUserProfile()"). Cross-checks workspace -- commit matches. Resumes in execution phase | (P9.7-11) | - | `→ SessionMemory.createSession("52A", prev_session_id)` |
| | | | | | `→ SessionMemory.appendJournal(session_id, {type: "phase_change", summary: "Resumed from checkpoint in execution phase. Previous session ended due to preemption."})` |
| 39 | **Orchestrator** | Completes remaining execution (revokeToken, getUserProfile), self-review, integration. Pushes. Transitions to Completed | (P4, P7) | `⟹ git.committed`, `⟹ git.pushed`, `⟹ cost.incurred` (multiple), `⟹ task.state_changed` `{Active.Working → Completed}` | Various |

---

### Progressive Merge with Conflict (P6)

| Step | Component | Action | Protocol | Events | Contracts |
|------|-----------|--------|----------|--------|-----------|
| 40 | **Task Engine** | Detects Child A completion. Initiates progressive merge | (P6.1-2) | - | `→ WorkspaceManager.mergeBranch("engineer/52/52A-oauth2-interface", "engineer/52-oauth2-refactor")` |
| 41 | **Workspace Manager** | Attempts merge -- CONFLICT in `src/auth/middleware.ts` (parent branch had notes from planning phase) | (P6.3) | `⟹ workspace.merge_conflict` `{task_id: 52, source_branch: "engineer/52/52A-oauth2-interface", target_branch: "engineer/52-oauth2-refactor", conflicting_files: ["src/auth/middleware.ts"]}` | - |
| 42 | **Daemon** | Receives conflict event. Transitions parent: Supervising → Working (consumes slot for conflict resolution) | (P6.8) | `⟹ task.state_changed` `{from_sub: "Supervising", to_sub: "Working"}` | `→ TaskEngine.requestTransition(52, "Active.Working")` |
| 43 | **Daemon** | Dispatches parent to Orchestrator for conflict resolution | (P6.9, P3) | - | - |
| 44 | **Orchestrator** | Resolves merge conflict (has full write + git permissions in Active.Working). The conflict is straightforward -- parent's planning notes vs child's implementation. Keeps child's implementation, commits resolution | (P6.10) | `⟹ git.committed` `{message: "Resolve merge conflict in middleware.ts"}` | `→ WorkspaceManager.commit(52, "Resolve merge conflict in middleware.ts")` |
| 45 | **Workspace Manager** | Merge now complete | - | `⟹ git.merge_completed` `{task_id: 52, source_branch: "engineer/52/52A-oauth2-interface", target_branch: "engineer/52-oauth2-refactor"}` | - |
| 46 | **Orchestrator** | Generates Child A completion summary. Attaches to parent context | (P6.5) | - | `→ TaskEngine.attachChildSummary(52, "52A", "Added OAuth2 provider interface: authorize(), callback(), refreshToken(), revokeToken(), getUserProfile(). Tests passing. Adapter pattern for existing middleware.")` |
| 47 | **Task Engine** | Checks: all children done? No (Child B still Queued). Transitions parent back: Working → Supervising (slot freed) | (P6.6) | `⟹ task.state_changed` `{from_sub: "Working", to_sub: "Supervising"}` | - |
| 48 | **TelegramCommPlugin** | Receives `workspace.merge_conflict` event → notifies Farzam of conflict and resolution | (P6.11, P13) | `⟹ comm.message_sent` `{type: "notification"}` | `Contract: CommunicationAdapter.sendMessage(target, "Merge conflict in #52 (middleware.ts) resolved automatically")` |

**State:** Parent #52 back to Supervising. Child A's code merged into parent branch. Child B now eligible (A is Completed).

---

### Child B: Work and Completion (P3, P4, P6)

| Step | Component | Action | Protocol | Events | Contracts |
|------|-----------|--------|----------|--------|-----------|
| 49 | **Daemon** | Child B's dependency (A) is Completed. Dispatches B. Branch `engineer/52/52B-migrate-jwt` from parent branch (which now includes A's merged code) | (P3) | `⟹ task.state_changed` `{Queued→Active.Working}`, `⟹ workspace.created` | `→ WorkspaceManager.createWorkspace("52B", repo, parent_branch: "engineer/52-oauth2-refactor")` |
| 50 | **Orchestrator** | Child B's Dispatch package includes Child A's summary (sibling knowledge through parent context). Orchestrator knows A's interface details without re-discovering them | (P3.5) | - | - |

**Dispatch package for Child B includes:**
```
{
  task: { id: "52B", parent_id: 52, dependencies: ["52A"], ... },
  resume_from: null,
  knowledge: {
    repo: [...],
    user: [...],
    parent_context: {
      child_summaries: [{
        child_id: "52A",
        summary: "Added OAuth2 provider interface: authorize(), callback()..."
      }]
    }
  }
}
```

| Step | Component | Action | Protocol | Events | Contracts |
|------|-----------|--------|----------|--------|-----------|
| 51 | **Orchestrator** | Works through all phases for Child B. Completes successfully | (P4, P7, P10) | `⟹ cost.incurred` (multiple), `⟹ task.state_changed` `{Active.Working → Completed}` | Various |
| 52 | **Task Engine** | Child B completes. Progressive merge into parent -- succeeds (no conflict this time) | (P6.1-4) | `⟹ git.merge_completed` `{source: "engineer/52/52B-migrate-jwt", target: "engineer/52-oauth2-refactor"}` | `→ WorkspaceManager.mergeBranch()` |
| 53 | **Task Engine** | All children in terminal state (both Completed). Emits all-done | (P6.6) | `⟹ task.children_all_done` `{parent_task_id: 52, child_ids: ["52A", "52B"], all_succeeded: true}` | - |
| 54 | **Daemon** | Receives `children_all_done`. Transitions parent: Supervising → Integrating | (P6.6) | `⟹ task.state_changed` `{from_sub: "Supervising", to_sub: "Integrating"}` | `→ TaskEngine.requestTransition(52, "Active.Integrating")` |
| 55 | **Daemon** | Dispatches parent for integration work | (P3) | - | - |

---

### Parent Integration and Review

| Step | Component | Action | Protocol | Events | Contracts |
|------|-----------|--------|----------|--------|-----------|
| 56 | **Orchestrator** | Parent enters integration phase. Runs integration tests ensuring children's code works together. Pushes combined code. Creates Draft PR | (P4, P7) | `⟹ git.pushed`, `⟹ git.pr_opened` `{task_id: 52, draft: true}` | `Contract: GitHostingAdapter.createPR({draft: true, title: "Refactor auth module to support OAuth2"})` |
| 57 | **Orchestrator** | Transitions to Review-Pending.Demo | - | `⟹ task.state_changed` `{Active.Integrating → Review-Pending.Demo}` | `→ TaskEngine.requestTransition()` |
| 58 | **Orchestrator** | Sends milestone notification | (P13) | `⟹ comm.message_sent` `{type: "milestone"}` | `Contract: CommunicationAdapter.sendMessage()` |

**(Demo review → code review → merge follows Scenario 1's pattern at steps 50-68.)**

**Protocols exercised:** P2, P3, P4, P5, P6 (with conflict), P7 (proceed + ask_human), P8, P9, P10, P11, P12, P13.

---

## Scenario 3: Resilience Path

**"Update API rate limiting middleware"**

Task #60 on `acme/api-server` is already in execution phase (system was running, task created and dispatched earlier). A cascade of failures tests every error propagation chain and recovery pattern: LLM failover, cost limit breach, communication plugin failure, config reload failure, Daemon crash, trigger failures, and Event Bus outage.

This scenario demonstrates that the architecture degrades gracefully, preserves work, and recovers to consistent state.

---

### Part 1: LLM Provider Failure with Auto-Failover (Chain 1)

Task #60 is in Active.Working, execution phase. The Orchestrator calls the LLM for code generation.

| Step | Component | Action | Protocol | Events | Contracts | Error Ref |
|------|-----------|--------|----------|--------|-----------|-----------|
| 1 | **Orchestrator** | Calls LLM for code generation | - | - | `Contract: LLMAdapter.complete({prompt: "Generate rate limiting middleware..."})` | - |
| 2 | **ClaudeCodeProvider** | Returns fatal error | - | - | Returns `AdapterError {code: "auth_failed", retryable: false, severity: "fatal"}` | Chain 1 |
| 3 | **Daemon** | Detects fatal provider error. Checks provider priority list in config: `[claude-code, openrouter]`. Switches active provider to openrouter | - | - | `→ Registry.getPluginsByType("llm_provider")` | Chain 1 (fallback) |
| 4 | **Daemon** | Retries same prompt on OpenRouterProvider | - | - | `Contract: LLMAdapter.complete()` (via openrouter) → succeeds | Chain 1 (transparent) |
| 5 | **Orchestrator** | Receives completion result transparently (provider switch invisible to Orchestrator). Emits cost event with new provider | (P10.1-2) | `⟹ cost.incurred` `{task_id: 60, provider_id: "openrouter", provider_type: "api", operation: "code_generation", spend_usd: 0.12}` | - | - |
| 6 | **Orchestrator** | Sends notification about provider switch | (P13) | `⟹ comm.message_sent` `{type: "notification"}` | `Contract: CommunicationAdapter.sendMessage(target, "Switched LLM provider: claude-code → openrouter (auth failure)")` | - |

**Outcome:** Task continues working with OpenRouter. Cost tracking switches to dollar-based (API type). Farzam notified of switch.

---

### Part 2: Cost Limit Breach (P10, Pattern 1)

The switch to an API provider (dollar-based) changes cost dynamics. After several more LLM calls:

| Step | Component | Action | Protocol | Events | Contracts | Error Ref |
|------|-----------|--------|----------|--------|-----------|-----------|
| 7 | **Safety Layer** | Receives `cost.incurred` (from step 5 and subsequent calls). Updates accumulators: `api_spend.per_task[60] = $4.85`. Checks: per-task limit = $5.00. **BREACH** at next LLM call adding $0.18 | (P10.5-7) | `⟹ cost.limit_reached` `{task_id: 60, limit_type: "per_task", current_spend: 5.03, limit_value: 5.00, provider_type: "api", resets_at: null}` | - | - |
| 8 | **Daemon** | Receives `cost.limit_reached`. Determines affected task: only #60 (per-task limit). Signals Orchestrator to checkpoint and stop | (P10.8-9) | - | - | - |
| 9 | **Orchestrator** | Finishes current atomic op (file write completes). Creates checkpoint | (P10.10) | - | `→ SessionMemory.createCheckpoint(session_id, {reason: "cost_limit", phase: "execution", context_summary: "...", next_action: "Continue implementing rate limit rules"})` | Pattern 1 |
| 10 | **Orchestrator** | Logs journal, ends session | (P10.10) | - | `→ SessionMemory.appendJournal(session_id, {type: "error", summary: "Cost limit reached: $5.03 / $5.00 per-task. Stopping."})` | - |
| | | | | | `→ SessionMemory.endSession(session_id, "cost_limit")` | |
| 11 | **Daemon** | Transitions #60: Active.Working → Blocked | (P10.11) | `⟹ task.state_changed` `{Active.Working → Blocked, reason: "cost_limit_reached"}` | `→ TaskEngine.requestTransition(60, "Blocked", "cost_limit_reached")` | - |

**Task #60 blocked details:** `{reason: "Cost limit reached", needed: "Budget increase or limit reset", waiting_for: "farzam"}`

---

### Part 3: Communication Plugin Failure During Cost Alert (Chain 3, Patterns 2+3)

| Step | Component | Action | Protocol | Events | Contracts | Error Ref |
|------|-----------|--------|----------|--------|-----------|-----------|
| 12 | **TelegramCommPlugin** | Receives `cost.limit_reached` (subscriber). Attempts to send alert to Farzam → FAILS | - | - | `Contract: CommunicationAdapter.sendMessage()` → `AdapterError {code: "network_error", retryable: true, retry_after: 5s}` | Chain 3 |
| 13 | **Core** | Retries with backoff: attempt 2 (after 5s) → fails. Attempt 3 (after 10s with jitter) → fails. Max retries exhausted | - | - | `Contract: CommunicationAdapter.sendMessage()` x2 (both fail) | Pattern 2 |
| 14 | **Core** | Drives fallback: looks up Farzam in People Directory `contacts[]`: [telegram (failed), github, email]. Tries github | - | - | `→ PeopleDirectory.resolveContact("farzam", "github")` | Pattern 3 |
| | | | | | `Contract: CommunicationAdapter.sendMessage()` (via GitHubCommPlugin) | |
| 15 | **GitHubCommPlugin** | Sends cost alert as comment on issue #60: "Cost limit reached: $5.03 / $5.00 per-task limit. Task blocked. Increase budget or reply 'unblock #60'." | - | `⟹ comm.message_sent` `{type: "alert", channel: "github"}` | - | Pattern 3 (success) |

**Outcome:** Alert delivered via fallback channel (GitHub instead of Telegram). Plugins are unaware of fallback -- each just sends or fails.

---

### Part 4: Timeout Ladder (P11)

| Step | Component | Action | Protocol | Events | Contracts | Error Ref |
|------|-----------|--------|----------|--------|-----------|-----------|
| 16 | **Daemon** | Starts timeout timers for #60 Blocked state | (P11.7) | - | `→ SafetyLayer.getTimeoutPolicy()` | - |
| 17 | **Daemon** | 4 hours pass. Reminder threshold reached | (P11.16) | `⟹ timeout.reminder` `{task_id: 60, blocked_since: "...", elapsed: "4h", question_summary: "Cost limit reached"}` | - | - |
| 18 | **TelegramCommPlugin** | Still down. Reminder send fails. Core falls back to GitHub -- posts reminder comment on issue #60 | - | `⟹ comm.message_sent` `{type: "notification", channel: "github"}` | `Contract: CommunicationAdapter.sendMessage()` (telegram fails, github succeeds) | Pattern 2, Pattern 3 |
| 19 | **Daemon** | 24 hours pass. Self-unblock check threshold reached. Daemon evaluates: cost-blocked tasks cannot self-unblock (requires budget change, not autonomy). Check fires, takes no action | (P11.17) | `⟹ timeout.self_unblock_check` `{task_id: 60, blocked_since: "...", elapsed: "24h", can_self_unblock: false, reason: "cost_limit_block"}` | - | - |

---

### Part 5: Config Hot-Reload Failure (Chain 7, Pattern 5)

Meanwhile, someone edits the Safety Layer config file (attempting to increase the cost limit, but introduces a YAML syntax error):

| Step | Component | Action | Protocol | Events | Contracts | Error Ref |
|------|-----------|--------|----------|--------|-----------|-----------|
| 20 | **Safety Layer** | Detects config file change. Attempts hot-reload. Validation fails (malformed YAML at line 42) | - | - | - | Chain 7 |
| 21 | **Safety Layer** | Rejects reload. Keeps previous valid config. System continues with old cost limits | - | `⟹ health.config_reload_failed` `{component: "safety_layer", config_file: "safety.yml", error: "YAML parse error at line 42", running_config: "previous"}` | - | Chain 7, Pattern 5 |
| 22 | **Communication Plugin** | Receives `health.config_reload_failed` (subscriber). Sends alert. Telegram still down -- falls back to GitHub | - | `⟹ comm.message_sent` `{type: "alert"}` | `Contract: CommunicationAdapter.sendMessage()` (github) | Pattern 3 |

**Outcome:** System operates with stale (but valid) policy. Human alerted to fix the config file.

---

### Part 6: Stuck Detection (Health Monitoring)

Meanwhile, the Orchestrator for a different task (#55, running on a second working slot) has not progressed in over 2 hours:

| Step | Component | Action | Protocol | Events | Contracts | Error Ref |
|------|-----------|--------|----------|--------|-----------|-----------|
| 23 | **Daemon** | Health monitor tick. Detects Orchestrator for task #55 has not emitted any events or checkpoints in 2h15m (stuck threshold: 2h) | - | `⟹ health.stuck_detected` `{task_id: 55, condition: "no_progress", last_activity: "2h15m ago", threshold: "2h"}` | - | - |
| 24 | **GitHubCommPlugin** | Receives `health.stuck_detected` (subscriber). Posts alert on issue #55 | - | `⟹ comm.message_sent` `{type: "alert"}` | `Contract: CommunicationAdapter.sendMessage()` | - |

**Outcome:** Human alerted to investigate task #55. Daemon continues monitoring. (Task #55 is unrelated to our main #60 trace -- shown here for `health.stuck_detected` coverage.)

---

### Part 7: Daemon Crash and Recovery (P15 Scenario B, Pattern 4)

The Daemon process crashes unexpectedly (e.g., OOM kill).

| Step | Component | Action | Protocol | Events | Contracts | Error Ref |
|------|-----------|--------|----------|--------|-----------|-----------|
| 25 | **Daemon** | CRASHES. Process terminates unexpectedly | - | - | - | - |
| 26 | **Daemon** | Restarts. Begins P1 (System Startup) from step 1 | (P15.8, P1) | - | - | Pattern 4 |
| 27 | **Event Bus** | Initializes persistence layer | (P1.2) | - | - | - |
| 28 | **Registry** | Re-initializes all plugins. TelegramCommPlugin.initialize() -- now succeeds (network recovered during downtime) | (P1.3) | - | `Contract: Adapter.initialize(config)` on each | - |
| 29 | **Safety Layer** | Reloads policy (still the valid previous config -- bad reload was rejected pre-crash). Replays `cost.incurred` events to rebuild accumulators | (P1.4, P15.11) | (replays `cost.incurred` events) | `→ EventBus.replay({type: "cost.incurred", since: billing_window_start})` | Pattern 4 |

**Rebuilt cost accumulators:** `api_spend.per_task[60] = $5.03` (matches pre-crash state exactly -- events are the durable record).

| Step | Component | Action | Protocol | Events | Contracts | Error Ref |
|------|-----------|--------|----------|--------|-----------|-----------|
| 30 | **Daemon** | Queries Task Engine for non-terminal tasks. Finds: #60 in Blocked state (cost_limit), #55 in Active.Working (orphaned -- was running when Daemon crashed). Transitions #55 to Queued with checkpoint | (P15.9, P1.6-7) | `⟹ task.state_changed` `{#55: Active.Working → Queued, reason: "crash_recovery"}` | `→ TaskEngine.getTasksByState()` | Pattern 4 |
| 31 | **Daemon** | Rebuilds all ephemeral state from persistent sources | (P15.10) | - | See below | Pattern 4 |

**Ephemeral state reconstruction:**
```
Priority queue:     (empty -- no Queued tasks)     ← from TaskEngine
Timeout timers:     #60 blocked 5h ago, set        ← from TaskEngine timestamps +
                    remaining thresholds               SafetyLayer.getTimeoutPolicy()
Cost accumulators:  api_spend.per_task[60] = $5.03  ← from EventBus replay
Dedup set:          ["github:issue:acme/api-server:60", ...]  ← from TaskEngine.getAllExternalRefs()
Pending preemption: null (abandoned)                ← reset on restart
Working slot count: 0                               ← from TaskEngine (no Active.Working)
```

| Step | Component | Action | Protocol | Events | Contracts | Error Ref |
|------|-----------|--------|----------|--------|-----------|-----------|
| 32 | **Daemon** | Checks plugin health -- all healthy now (Telegram recovered). Starts main loop. Sends restart notification | (P15.12, 15) | `⟹ comm.message_sent` `{type: "alert"}` | `Contract: Adapter.healthCheck()` on all |
| | | | | | `Contract: CommunicationAdapter.sendMessage(target, "System restarted. Resuming operations.")` | |

---

### Part 8: GitHub State Reconciliation (Decision #58)

| Step | Component | Action | Protocol | Events | Contracts | Error Ref |
|------|-----------|--------|----------|--------|-----------|-----------|
| 33 | **GitHubCommPlugin** | Recovery detected (plugin re-initialized). Daemon triggers state reconciliation (P15 step 15): compares Task Engine states against GitHub labels for all non-terminal tasks | (P15.15) | - | `Contract: GitHubCommPlugin.reconcileState([{task_id: 60, external_ref: "issue #60", expected_state: "Blocked", expected_label: "engineer:blocked"}])` | Pattern 5 |
| 34 | **GitHubCommPlugin** | Finds mismatch: #60 has `engineer:active` on GitHub but should be `engineer:blocked`. Fixes label. Posts catch-up comment about cost limit | - | - | `Contract: GitHubCommPlugin.updateIssue(repo, 60, {labels_add: ["engineer:blocked"], labels_remove: ["engineer:active"]})` | - |

**Outcome:** GitHub state now matches internal state. Reconciliation is idempotent -- safe to run multiple times.

---

### Part 9: Cascade Failure (Chain 5)

Task #55 (the stuck task from Part 6) had been decomposed into children #55A and #55B. After the Daemon crash recovery re-queued it, #55A is dispatched and fails:

| Step | Component | Action | Protocol | Events | Contracts | Error Ref |
|------|-----------|--------|----------|--------|-----------|-----------|
| 35 | **Orchestrator** | Working on child #55A. Encounters unrecoverable error (test suite fails repeatedly, exhausts retries). Transitions to Failed | (P4) | `⟹ task.state_changed` `{#55A: Active.Working → Failed, reason: "unrecoverable_test_failure"}` | `→ TaskEngine.requestTransition("55A", "Failed")` | - |
| 36 | **Task Engine** | Child #55A enters Failed state. Parent #55 has cascade policy: `pause-siblings` (default). Evaluates siblings: #55B is Queued. Transitions #55B → Blocked (cascade) | (P5) | `⟹ task.state_changed` `{#55B: Queued → Blocked, reason: "cascade_pause_sibling_failed"}` | - | Chain 5 |
| 37 | **Daemon** | Receives child failure and cascade events. Notifies owner: "Task #55A failed. Sibling #55B paused (cascade policy: pause-siblings). Parent #55 waiting for resolution." | - | `⟹ comm.message_sent` `{type: "alert"}` | `Contract: CommunicationAdapter.sendMessage()` | Chain 5 |

**Outcome:** Cascade policy prevents wasted work on #55B. Human decides whether to fix #55A's issue and retry, or restructure the decomposition. (Task #55 is a side thread -- our main trace continues with #60.)

---

### Part 10: Human Unblocks Task (P10, P11)

| Step | Component | Action | Protocol | Events | Contracts | Error Ref |
|------|-----------|--------|----------|--------|-----------|-----------|
| 38 | **TelegramCommPlugin** | Farzam sends "unblock #60" via Telegram (now recovered) | - | `⟹ comm.message_received` `{source: "telegram", sender: "farzam", content: "unblock #60"}` | - | - |
| 39 | **Daemon** | Receives event. Checks: #60 is Blocked with `waiting_for: "farzam"`. Routes as task response. Processes unblock command | (P11.9, P10.14) | - | `→ TaskEngine.getBlockedTasksForPerson("farzam")` → [#60] | - |
| 40 | **Daemon** | Cancels timeout timers. Transitions #60: Blocked → Queued | (P10.13-14) | `⟹ task.state_changed` `{Blocked → Queued, reason: "cost_limit_resolved"}` | `→ TaskEngine.requestTransition(60, "Queued", "cost_limit_resolved")` | - |

---

### Part 11: Trigger Plugin Failure (Health Monitoring)

Meanwhile, the GitHub trigger starts failing:

| Step | Component | Action | Protocol | Events | Contracts | Error Ref |
|------|-----------|--------|----------|--------|-----------|-----------|
| 41 | **Daemon** | Polls GitHubIssuesTrigger. Returns error. Increments consecutive failure counter: 1 | (P2.1 failure) | - | `Contract: TriggerAdapter.poll()` → `AdapterError {code: "rate_limited", retryable: true}` | Pattern 2 |
| 42 | **Daemon** | Next polls fail. Counter reaches threshold (3) | - | - | `Contract: TriggerAdapter.poll()` (fails x2 more) | - |
| 43 | **Daemon** | Emits health alert | - | `⟹ health.trigger_failure` `{trigger_id: "github-issues", consecutive_failures: 3, last_error: "rate_limited"}` | - | Pattern 5 |
| 44 | **TelegramCommPlugin** | Receives event (subscriber). Sends alert: "GitHub trigger has failed 3 consecutive polls (rate_limited). Polling continues." | - | `⟹ comm.message_sent` `{type: "alert"}` | `Contract: CommunicationAdapter.sendMessage()` | - |

**Outcome:** Trigger plugin is degraded but continues polling. Human alerted. Next successful poll resets the counter.

---

### Part 12: Task Resume with Workspace Recovery (P9, Chain 6)

| Step | Component | Action | Protocol | Events | Contracts | Error Ref |
|------|-----------|--------|----------|--------|-----------|-----------|
| 45 | **Daemon** | Scheduling evaluation: #60 is Queued. Working slot available. Detects resume (checkpoint exists from cost_limit stop) | (P9.1) | - | `→ SessionMemory.getLatestCheckpoint(60)` → checkpoint with `reason: "cost_limit"` | - |
| 46 | **Daemon** | Transitions: Queued → Active.Working. Requests workspace verification | (P9.2-3) | `⟹ task.state_changed` `{Queued → Active.Working, reason: "resumed"}` | `→ TaskEngine.requestTransition(60, "Active.Working", "resumed")` | - |
| | | | | | `→ WorkspaceManager.verifyWorkspace(task.workspace)` | |
| 47 | **Workspace Manager** | Worktree directory missing (lost when Daemon crashed -- process cleanup). But branch `engineer/60-rate-limiting` exists in git. Recreates worktree from branch | (P9.4b) | `⟹ workspace.verified` `{status: "recoverable", recovery_action: "recreated_from_branch"}` | - | Chain 6 |
| | | | | `⟹ workspace.created` `{task_id: 60, branch: "engineer/60-rate-limiting"}` | | |
| 48 | **Daemon** | Assembles Dispatch with checkpoint and knowledge | (P9.5) | - | `→ SessionMemory.getLatestCheckpoint(60)`, `→ SessionMemory.queryKnowledge()` | - |
| 49 | **Orchestrator** | Context reconstruction. Notes: provider is now openrouter, budget was $5 (human unblocked without increasing -- may hit limit again). Resumes in execution phase | (P9.7-11) | - | `→ SessionMemory.createSession(60, prev_session_id)` | - |

---

### Part 13: Checkpoint Storage Failure (Chain 4)

During resumed work, the Orchestrator attempts a phase transition checkpoint:

| Step | Component | Action | Protocol | Events | Contracts | Error Ref |
|------|-----------|--------|----------|--------|-----------|-----------|
| 50 | **Orchestrator** | Completes execution phase. Attempts phase-boundary checkpoint | (P4.2) | - | `→ SessionMemory.createCheckpoint(session_id, checkpoint_data)` → FAILS (disk full) | Chain 4 |
| 51 | **Orchestrator** | Retries once | - | - | `→ SessionMemory.createCheckpoint()` → FAILS again | Chain 4 |
| 52 | **Orchestrator** | Phase transition context: cannot guarantee resume safety. But branch commits are preserved. Logs critical error. Continues working (work is more valuable than stopping, and commits provide recovery path) | - | - | `→ SessionMemory.appendJournal(session_id, {type: "error", summary: "Checkpoint storage failed. Commits preserved. Continuing with degraded resume safety."})` | Chain 4, Pattern 5 |

**(In a phase transition context, the Orchestrator may choose to fail the task if checkpoint is critical. Here it continues -- a judgment call. If this were preemption or cost limit, the consequences differ per Chain 4 in error-propagation.md.)**

---

### Part 14: Push Failure and Retry (Chain 6, Pattern 2)

| Step | Component | Action | Protocol | Events | Contracts | Error Ref |
|------|-----------|--------|----------|--------|-----------|-----------|
| 53 | **Orchestrator** | Pushes branch through Action Pipeline. Gates pass | (P7.3-6) | - | `→ TaskEngine.checkPermission(60, "git-remote")` → permitted | - |
| | | | | | `→ SafetyLayer.evaluate({type: "can_i", action_class: "git-remote"})` → proceed | |
| 54 | **Workspace Manager** | `git push` fails -- network timeout | (P7.9) | (no event -- action didn't complete) | `→ WorkspaceManager.push(60)` → fails | Chain 6, Pattern 2 |
| 55 | **Orchestrator** | Retries with backoff: attempt 2 → succeeds | - | `⟹ git.pushed` `{task_id: 60, branch: "engineer/60-rate-limiting"}` | `→ WorkspaceManager.push(60)` → succeeds | Pattern 2 |

---

### Part 15: Action Pipeline Rejection (P7)

During self-review, the Orchestrator tries to write to a file outside the repo scope:

| Step | Component | Action | Protocol | Events | Contracts | Error Ref |
|------|-----------|--------|----------|--------|-----------|-----------|
| 56 | **Orchestrator** | Attempts to write to `/etc/nginx/rate-limit.conf` (scope violation). Gate 1 passes (write permitted in Active.Working). Gate 2 rejects | (P7.3-8) | `⟹ action.rejected` `{task_id: 60, action_class: "write", gate: "safety_layer", reason: "Path /etc/nginx/rate-limit.conf is outside repo scope acme/api-server"}` | `→ TaskEngine.checkPermission(60, "write")` → permitted | - |
| | | | | | `→ SafetyLayer.evaluate({type: "can_i", action_class: "write", path: "/etc/nginx/rate-limit.conf"})` → `{allowed: false, reason: "outside repo scope"}` | |
| 57 | **Orchestrator** | Receives denial. Adjusts strategy -- adds nginx config instructions to PR description instead of modifying the file directly. Logs decision | - | - | `→ SessionMemory.appendJournal(session_id, {type: "decision", summary: "Cannot modify nginx config (outside scope). Adding deployment instructions to PR."})` | - |

---

### Part 16: 48-Hour Alert Escalation

If task #60 had remained blocked longer (it didn't -- Farzam unblocked it), the 48-hour alert would fire:

**(This is shown for coverage. In our timeline, Farzam responded before 48 hours. But the mechanism is:)**

| Step | Component | Action | Protocol | Events | Contracts | Error Ref |
|------|-----------|--------|----------|--------|-----------|-----------|
| - | **Daemon** | 48-hour threshold reached | (P11.19) | `⟹ timeout.alert` `{task_id: 60, escalation: "all_channels_notified"}` | - | - |
| - | **Communication Plugin** | Receives event → sends alert on ALL configured channels for Farzam simultaneously (not sequential fallback -- best-effort on every channel) | (P11.19) | `⟹ comm.message_sent` (multiple) | `Contract: CommunicationAdapter.sendMessage()` on telegram, github, email | - |

---

### Part 17: Event Bus Down -- Graceful Halt (Chain 2, Pattern 6)

After task #60 resumes and continues working, the Event Bus storage becomes inaccessible:

| Step | Component | Action | Protocol | Events | Contracts | Error Ref |
|------|-----------|--------|----------|--------|-----------|-----------|
| 58 | **Event Bus** | Storage becomes inaccessible (disk I/O error) | - | - | - | Chain 2 |
| 59 | **Daemon** | Detects Event Bus failure (health check or failed event publish) | - | - | - | Chain 2 |
| 60 | **Daemon** | Initiates graceful halt. Stops trigger polling. Stops scheduling. No new work accepted | (P15.17) | - | - | Pattern 6 |
| 61 | **Daemon** | Signals Orchestrator to checkpoint and stop (same pattern as preemption/shutdown) | (P15.18) | - | - | Pattern 6 |
| 62 | **Orchestrator** | Finishes current atomic op. Creates checkpoint via direct Session/Memory call (not via Event Bus -- it's down) | (P15.18) | - | `→ SessionMemory.createCheckpoint(session_id, {reason: "system_halt", phase: "self-review"})` | Pattern 1 |
| 63 | **Orchestrator** | Ends session | - | - | `→ SessionMemory.endSession(session_id, "system_halt")` | - |
| 64 | **Daemon** | Transitions #60: Active.Working → Queued. State transition is synchronous (Task Engine call), but `task.state_changed` event cannot be persisted (Event Bus down) | (P15.19) | (`⟹ task.state_changed` -- CANNOT BE DELIVERED) | `→ TaskEngine.requestTransition(60, "Queued", "system_halt")` | Chain 2 |
| 65 | **Daemon** | Attempts alert. Communication plugins may not receive Event Bus subscriptions, but direct `sendMessage()` calls still work. Also writes to stderr as last resort | - | - | `Contract: CommunicationAdapter.sendMessage(target, "SYSTEM HALT: Event Bus storage failure. Checkpointed all work. Manual intervention required.")` | Pattern 6 |
| 66 | **Daemon** | System halted. Waits for Event Bus recovery or human intervention. All work checkpointed, all tasks in safe states | - | - | - | Chain 2 |

**(When Event Bus recovers, Daemon restarts via P15 Scenario C. Task #60 resumes via P9. Cost accumulators rebuilt from Event Bus replay -- any events lost during the brief outage cause minor under-count, logged as warning. Task eventually completes.)**

**Error chains exercised:** Chain 1 (LLM failover), Chain 2 (Event Bus halt), Chain 3 (comm failure during block), Chain 4 (checkpoint storage), Chain 5 (cascade failure), Chain 6 (workspace recovery + push failure), Chain 7 (config reload).

**Recovery patterns exercised:** Pattern 1 (checkpoint-then-fail at cost limit and halt), Pattern 2 (retry-with-backoff on comm send, push, trigger poll), Pattern 3 (fallback-channel for cost alert and reminder), Pattern 4 (ephemeral-reconstruction after Daemon crash), Pattern 5 (degrade-and-continue for config reload, trigger failure, checkpoint storage), Pattern 6 (graceful-halt on Event Bus down).

---

## Coverage Verification

### Protocol Coverage: 15/15

Every protocol appears in at least one scenario. P1 and P14 appear only in Scenario 1. P5, P6, P8, P12 appear only in Scenario 2. P15 appears only in Scenario 3. All others appear in multiple scenarios, providing cross-scenario validation.

### Event Coverage: 30/30

All 30 events from the event catalog are emitted (with `⟹`) in at least one scenario. `comm.message_sent` appears across all three. `timeout.self_unblock_check` is emitted in Scenario 3 (cost-blocked task, Daemon evaluates but cannot self-unblock). `timeout.alert` is shown as a mechanism note in Scenario 3 (Part 16).

### Plugin Contract Coverage: Complete

All 5 plugin types exercised:
- **Trigger**: `poll()` in all three scenarios
- **Comm**: `sendMessage()` in all three, `startListening/stopListening` in S1/S3, `syncTaskState()` throughout (via Event Bus subscription), `reconcileState()` in S3
- **LLM Provider**: `complete()` in all three, `getCapabilities()` implicit in S3 failover
- **Tool**: `execute()` in S1 and S2
- **Git Hosting**: `createPR/updatePR/mergePR` in S1 and S2, `getPRStatus/getReviewStatus` in S1

Core components:
- **Registry**: plugin discovery in all scenarios
- **People Directory**: contact resolution in all scenarios

### Error Propagation Coverage: 7/7 chains, 6/6 patterns

All 7 error chains and all 6 recovery patterns are exercised in Scenario 3. Chain 6 (merge conflict) is additionally covered in Scenario 2.

### Gaps Found

None. The three scenarios together provide complete coverage of all Layer 3 specifications. Any future additions to protocols, events, or contracts should be traced through these scenarios (or a new scenario added) to verify integration.

---

## Cross-Reference Index

For quick lookup when verifying a specific component's behavior across scenarios:

| Component | Scenario 1 Steps | Scenario 2 Steps | Scenario 3 Steps |
|-----------|-----------------|-----------------|-----------------|
| Daemon | 1-7, 8-15, 16-22, 38-43 | 1-2, 10, 15-16, 22, 24, 26-28, 32-33, 34-35, 49, 54-55 | 3, 8, 11, 16-19, 23-24, 25-32, 37, 39-44, 46, 59-66 |
| Task Engine | 13, 17-20, 29, 46, 48, 52, 60, 62, 64 | 1, 2, 18-19, 21, 40, 47, 52-54 | 11, 30, 36, 40, 64 |
| Orchestrator | 23-37, 44-48, 54-57, 62-67 | 3-9, 14, 17-20, 23, 25, 38-39, 44, 46, 50-51, 56-58 | 1, 5-6, 9-10, 35, 49-57, 62-63 |
| Safety Layer | 4, 28, 33, 62 | 5, 10 | 7, 20-21, 29 |
| Event Bus | 2, (all events) | (all events) | 27, 58-59, 64-66 |
| Session/Memory | 21, 23, 30-32, 66 | 3, 14, 17, 23, 38 | 9-10, 45, 48-49, 62-63 |
| Workspace Manager | 19, 65 | 24, 36, 40-42, 45, 49, 52 | 47, 54-55 |
| Registry | 3, 25 | - | 28, 32, 3 |
| People Directory | 5, 13, 47 | 9, 18 | 14, 33 |

---

## Layer 2 → Layer 3 Reconciliation

Layer 3 refined several Layer 2 designs as interactions between components were formalized. Layer 2 docs capture valid design history; Layer 3 is authoritative where they differ. The event-catalog.md "Changes from Layer 2" section covers the Event Bus model evolution in detail. This table covers all remaining evolutions:

| Evolution | Layer 2 Source | Superseding Layer 3 Doc | Summary |
|-----------|---------------|------------------------|---------|
| Event Bus pre-processing → Action Pipeline | event-bus.md §Pre-Processing | event-catalog.md §Action Pipeline | Safety checks moved from Event Bus interceptor to Action Pipeline (Gate 1 + Gate 2). Event Bus is pure pub/sub. |
| Orchestrator direct subscriptions → Daemon routing | event-bus.md §Subscriptions | event-catalog.md §Subscription Lifecycle, protocols.md P1/P3 | Orchestrator no longer subscribes directly to Event Bus. Daemon routes relevant events as part of dispatch. |
| CommunicationAdapter callback → event emission | comm-plugins.md §Interface | adapter-contracts.md §CommunicationAdapter | Inbound messages emit `comm.message_received` events via core, replacing direct callback pattern. |
| Workspace Manager PR ops → Git Hosting Plugin | workspace-manager.md §PR Management | adapter-contracts.md §GitHostingAdapter | PR/branch operations separated into dedicated plugin type. Workspace Manager delegates to Git Hosting Plugin. |
| Registry formalized as core component | (not in Layer 2) | adapter-contracts.md §Registry | Full registry design: discovery, health checking, lifecycle management, primary plugin designation. |
| People Directory formalized as core component | (not in Layer 2) | adapter-contracts.md §People Directory | Full People Directory design: contacts schema, fallback chains, role-based lookup. |
| LLM provider failover | (not in Layer 2) | error-propagation.md Chain 1, adapter-contracts.md §LLMAdapter | Auto-failover to next provider in priority list on fatal provider error. |
| Communication fallback chains | (not in Layer 2) | error-propagation.md Chain 3, adapter-contracts.md §Fallback | People Directory `contacts[]` ordered list drives fallback when primary communication channel fails. |
| Health events added | (not in Layer 2) | event-catalog.md §health.* | Three health events: `stuck_detected`, `trigger_failure`, `config_reload_failed`. |
| `action.rejected` event added | (not in Layer 2) | event-catalog.md §action.rejected | Audit trail for Action Pipeline rejections (gate denials). |
| Plugin criticality concept | (not in Layer 2) | adapter-contracts.md §Adapter Manifest | `critical` field in plugin manifest determines startup/recovery behavior. |
