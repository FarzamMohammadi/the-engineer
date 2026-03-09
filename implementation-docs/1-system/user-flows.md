# User Flows

Concrete end-to-end flows from Farzam's perspective. Validates Layer 1 architecture from the user's experience, not just the architect's. Part of **Layer 1.5** — intermediary validation before Layer 2.

See [`../layers.md`](../layers.md) for where this fits. See [`relationships.md`](relationships.md) for the component architecture these flows trace through.

---

## Grounding

These flows assume Farzam's actual setup:

| Aspect | Choice |
|--------|--------|
| **Triggers** | GitHub Issues |
| **Code workflow** | GitHub PRs (Draft → Ready → Merge) |
| **Real-time comms** | Telegram bot |
| **Code-level comms** | GitHub PR comments, issue comments |
| **Autonomy level** | High (solo founder, trusts the agent) |

---

## Key Design Decision: Two-Stage PR Review (Demo Gate)

Every PR goes through two stages. Feedback can arrive at either stage and must always be applied.

| Stage | PR state | What's reviewed | The question being answered |
|-------|----------|----------------|---------------------------|
| **Demo Review** | Draft | Working demo — screenshots, recordings, preview links, temporary TUI for backend | "Did you build the right thing?" |
| **Code Review** | Ready | The code itself — style, structure, edge cases, tests | "Did you build it right?" |

**Demo-ability principle:** Everything is demo-able. Frontend: screenshots, recordings, preview deployments. Backend: a temporary functional TUI built solely to demonstrate behavior. Tests verify correctness; demos prove it *works*.

**Feedback rule:** Reviewer comments at ANY stage trigger the Engineer to iterate. Stage doesn't gate feedback — it gates the *question being answered*.

---

## Flow 1: Task Assignment → Delivery (Happy Path)

A simple, clean task from assignment to merge. No blockers, no surprises.

### The scenario
Farzam wants a dark mode toggle added to the settings page.

### Step by step

| # | Who | What happens | What Farzam sees |
|---|-----|-------------|-----------------|
| 1 | **Farzam** | Creates GitHub issue #47: "Add dark mode toggle to settings page." Includes brief description and acceptance criteria. | The issue he just wrote. |
| 2 | **System** | Trigger plugin (GitHub Issues) detects new issue → Event Bus → Task Engine creates task (Intake). Task Engine evaluates issue → moves to Queued. Daemon checks capacity → moves to Active. | — |
| 3 | **System** | Orchestrator sends Telegram message to Farzam. | **Telegram**: "Picked up #47: Add dark mode toggle. Starting with research on the current settings page and theme system." |
| 4 | **System** | Orchestrator runs through phases: researches codebase, identifies the settings page structure, checks for existing theme utilities, forms a plan, executes. Workspace Manager creates isolated branch. | — (Farzam goes about his day) |
| 5 | **System** | Orchestrator completes implementation. Self-reviews. Builds demo artifacts (screenshots of toggle in both states, screen recording of transition). Opens Draft PR #52 on GitHub. Sends Telegram notification. | **Telegram**: "Draft PR #52 ready for #47. Demo inside — dark mode toggle with smooth transition. Take a look when you can." |
| 6 | **Farzam** | Opens Draft PR on GitHub. | **GitHub PR #52 (Draft)**: Demo section at the top — screenshots (light/dark), screen recording of toggle, how to test locally. Below: summary of changes, decisions made, files touched. |
| 7 | **Farzam** | Reviews the demo. It works, looks good. Approves the demo by submitting a GitHub review with approval on the Draft PR. | Standard GitHub review approval flow. |
| 8 | **System** | Trigger plugin detects Draft PR approval → Event Bus → Task Engine. Orchestrator cleans up demo artifacts (removes temporary files, squashes demo-only commits). Marks PR as Ready. | **GitHub**: PR #52 status changes from Draft to Ready. |
| 9 | **Farzam** | Does code review. Leaves a comment: "Extract the theme toggle logic into a custom hook." | Normal GitHub code review flow. |
| 10 | **System** | Trigger plugin detects review comment → Event Bus → Orchestrator. Applies feedback, pushes update. Comments on PR: "Extracted to `useThemeToggle` hook. Updated." | **GitHub**: New commit on PR, reply to review comment. |
| 11 | **Farzam** | Reviews again. Code looks good. Approves. | GitHub review approval. |
| 12 | **System** | Trigger plugin detects approval on Ready PR → Orchestrator merges PR → Task Engine transitions to Completed → closes GitHub issue #47. Sends Telegram summary. | **Telegram**: "#47 done. PR #52 merged. Dark mode toggle is live." **GitHub**: Issue #47 closed, PR #52 merged. |

### Component trace

```
GitHub Issue ──→ Trigger Plugin ──→ Event Bus ──→ Task Engine (Intake→Queued→Active)
                                                       │
                                              Daemon assigns to Orchestrator
                                                       │
                                              Orchestrator (research→plan→execute→self-review)
                                                       │
                                              Workspace Mgr (branch, commits)
                                                       │
                                              Orchestrator → Draft PR + demo artifacts
                                                       │
                                              Comm Plugin (Telegram notification)
                                                       │
                                              ← Farzam reviews demo on GitHub →
                                                       │
                                              Trigger Plugin detects approval
                                                       │
                                              Orchestrator cleans demo, PR→Ready
                                                       │
                                              ← Farzam code reviews on GitHub →
                                                       │
                                              Orchestrator applies feedback
                                                       │
                                              Trigger Plugin detects final approval
                                                       │
                                              Orchestrator merges → Task Engine (Completed)
```

### Gaps this flow reveals

| # | Gap | Notes |
|---|-----|-------|
| **F1-1** | Demo approval mechanism | How does the system distinguish "demo approved" from "code approved"? Both are GitHub review approvals. Proposal: demo approval = approval on a Draft PR. Code approval = approval on a Ready PR. The PR state itself is the discriminator. |
| **F1-2** | Sub-states within Active | Active now contains: working, demo-review-pending, code-review-pending. These aren't in the current state machine. |
| **F1-3** | Notification cadence | When does the Engineer send Telegram messages vs stay silent? This flow has 3 messages (pickup, draft ready, done). Is that the right amount? |
| **F1-4** | Demo artifact lifecycle | Where do demo artifacts live? On the branch (cleaned up before Ready)? In PR comments (permanent)? Separate deploy? |

---

## Flow 2: Mid-Task Interaction (Blocked ↔ Active)

The Engineer hits ambiguity and needs Farzam's input.

### The scenario
While working on the dark mode toggle, the Engineer discovers the settings page uses inline styles, not CSS variables. Needs a design call.

### Step by step

| # | Who | What happens | What Farzam sees |
|---|-----|-------------|-----------------|
| 1 | **System** | Orchestrator is in research/planning phase for #47. Discovers inline styles throughout the settings page. Identifies two viable approaches. Checks Safety Layer (passive): "Can I make this architectural decision alone?" Config says: structural refactoring decisions require human input. | — |
| 2 | **System** | Task Engine: Active → Blocked. Orchestrator composes a precise, actionable question. Sends via Telegram. | **Telegram**: "Question on #47 (dark mode toggle): The settings page uses inline styles. Two options: **(A)** Refactor to CSS variables first, then add dark mode — cleaner, +2 hours. **(B)** Add dark mode with inline styles — faster, creates tech debt. Which approach?" |
| 3 | **Farzam** | Reads the message on his phone. Replies: "A. Do it right." | His own Telegram reply. |
| 4 | **System** | Comm plugin (Telegram) receives response → Event Bus → Orchestrator. Records decision in task context. Task Engine: Blocked → Active. Sends brief confirmation. | **Telegram**: "Going with CSS variables refactor first. Resuming." |
| 5 | **System** | Orchestrator continues work with the chosen approach. | — |

### What makes this interaction good

- **Precise, not vague**: Two concrete options with trade-offs. Not "what should I do about the styles?"
- **Easy to answer**: Farzam can reply in 3 words from his phone.
- **Context included**: Issue number, what the problem is, what each option means.
- **Confirmation sent**: Farzam knows his answer was received and work resumed.
- **Decision recorded**: The choice is logged in the task context for audit trail.

### Edge case: Farzam doesn't respond

| Time elapsed | What happens | What Farzam sees |
|-------------|-------------|-----------------|
| 0 | Question sent. Task is Blocked. | Telegram message. |
| Configurable interval (e.g., 4 hours) | Engineer sends a gentle reminder. | **Telegram**: "Still waiting on your input for #47 (CSS variables vs inline styles). No rush — I'll continue when you respond." |
| Longer interval (e.g., 24 hours) | Engineer checks if it can self-unblock: "Is there a reasonable default? Can I research further?" If yes, proposes a default and proceeds unless overridden. If no, stays Blocked. | **Telegram**: "Going with Option A (CSS variables) for #47 since it's the cleaner approach. Override if you'd prefer otherwise." OR continues waiting silently. |

### Component trace

```
Orchestrator (hits ambiguity) → Safety Layer (passive check) → "ask human"
       │
Task Engine (Active → Blocked, reason: awaiting architectural decision)
       │
Orchestrator → Comm Plugin (Telegram) → Farzam
       │
Farzam → Telegram → Comm Plugin → Event Bus → Orchestrator
       │
Task Engine (Blocked → Active) → Orchestrator resumes
```

### Gaps this flow reveals

| # | Gap | Notes |
|---|-----|-------|
| **F2-1** | Response timeout policy | What happens when the human doesn't respond? Configurable escalation: reminder → self-unblock → stay blocked. Needs design. |
| **F2-2** | Question batching | If the Engineer has 3 questions, send them together or one at a time? Batching is more efficient for the human. One-at-a-time is simpler for the system. |
| **F2-3** | Decision recording | Where are decisions stored? Part of the task context? Separate decision log? Both? |
| **F2-4** | Autonomy boundary config | The Safety Layer needs a config model for "what decisions can the agent make alone?" This is more nuanced than just cost caps. |

---

## Flow 3: Review Feedback Loop (Draft + Ready)

The full review lifecycle with feedback at both stages. Stress-tests Gap #3 (post-ship state).

### The scenario
The dark mode PR is up for review. Farzam has feedback at both the demo and code stages.

### Step by step

| # | Who | What happens | What Farzam sees |
|---|-----|-------------|-----------------|
| 1 | **System** | Draft PR #52 is open with demo (screenshots, recording). Engineer sends Telegram notification. | **Telegram**: "Draft PR #52 ready for #47. Demo inside." |
| 2 | **Farzam** | Opens PR. Reviews demo. The toggle animation is too slow. Leaves PR comment: "Animation is too slow — 200ms max." | GitHub PR comment on Draft. |
| 3 | **System** | Trigger plugin detects PR comment → Event Bus → Task Engine (still Active, sub-state: demo-review). Orchestrator reads feedback, applies fix (animation → 150ms), updates demo recording, pushes to branch. Replies on PR. | **GitHub**: New commit. Reply: "Fixed — animation now 150ms. Updated recording above." |
| 4 | **Farzam** | Watches the updated recording. Looks good. Submits GitHub review: Approve. | GitHub review approval on Draft PR. |
| 5 | **System** | Trigger plugin detects approval on Draft PR → Orchestrator cleans demo artifacts → marks PR as Ready. | **GitHub**: PR status → Ready. Demo artifacts cleaned from code (recordings/screenshots stay in PR description as history). |
| 6 | **Farzam** | Does code review on the Ready PR. Finds a magic number. Comments: "The 150ms should be a named constant, not a magic number." | GitHub code review comment. |
| 7 | **System** | Trigger plugin detects comment → Orchestrator applies feedback → pushes. Replies. | **GitHub**: New commit. Reply: "Extracted to `TOGGLE_ANIMATION_MS` constant." |
| 8 | **Farzam** | Reviews again. Everything's clean. Approves. | GitHub review approval on Ready PR. |
| 9 | **System** | Trigger plugin detects approval on Ready PR → Orchestrator merges → Task Engine: Completed. | **GitHub**: PR merged, issue closed. **Telegram**: "#47 done." |

### State transitions during review

```
Active (working)
  → Active (demo-review-pending)     -- Draft PR opened
    → Active (working)               -- feedback received, applying
    → Active (demo-review-pending)   -- update pushed, awaiting re-review
    → Active (demo-approved)         -- demo approved, cleaning artifacts
  → Active (code-review-pending)     -- PR marked Ready
    → Active (working)               -- feedback received, applying
    → Active (code-review-pending)   -- update pushed, awaiting re-review
  → Completed                        -- code review approved, merged
```

### Gaps this flow reveals

| # | Gap | Notes |
|---|-----|-------|
| **F3-1** | Active sub-states need formal design | The state machine needs interior states for the review lifecycle. These are not just phases — they involve external waiting (like Blocked, but the task isn't truly blocked, it's in review). |
| **F3-2** | Review-pending vs Blocked | When awaiting review, the task isn't "Blocked" (it's not stuck on missing info). It's more like "awaiting external judgment." Different from Blocked. Needs its own semantics. |
| **F3-3** | Demo artifact storage strategy | Screenshots/recordings should persist in PR description (history). Temporary code (TUI for backend demos) should be removed from the branch. Two different artifact types. |
| **F3-4** | Re-review detection | How does the system know the reviewer has re-reviewed after feedback was applied? GitHub's "changes requested" → "approved" transition? Or just watching for new approval events? |

---

## Flow 4: Monitoring & Observability

Farzam wants to check in on what The Engineer is doing.

### The scenario
It's 3pm. Farzam wonders what progress has been made today.

### Step by step

| # | Who | What happens | What Farzam sees |
|---|-----|-------------|-----------------|
| 1 | **Farzam** | Sends Telegram message: "status" | His own message. |
| 2 | **System** | Comm plugin (Telegram) receives "status" → interprets as status query (not a task-related response). Queries Task Engine for all active/blocked tasks. Formats summary. | **Telegram**: "Currently working on 1 task: **#47** (dark mode toggle) — Active, in execution phase. Research done, plan approved, implementing CSS variable refactor. ~60% through execution. No blockers." |
| 3 | **Farzam** | Wants more detail. Sends: "what have you tried so far on 47?" | His own message. |
| 4 | **System** | Comm plugin routes to session log query for task #47. Summarizes key actions and decisions. | **Telegram**: "#47 progress: (1) Researched settings page — found inline styles throughout. (2) Asked you about refactoring approach — you chose CSS variables. (3) Refactored 12 components to CSS variables. (4) Currently implementing the toggle component. Key decision: using CSS custom properties on `:root` for theme switching." |
| 5 | **Farzam** | Wants to understand a specific decision. Sends: "why :root and not a React context?" | His own message. |
| 6 | **System** | Comm plugin routes to decision trace for task #47. Finds the reasoning. | **Telegram**: "Considered React Context vs CSS custom properties. Chose CSS because: (1) no re-render overhead on theme switch, (2) works with any component library including third-party, (3) simpler — no provider wrapper needed. Trade-off: less programmatic control, but not needed for this use case." |

### Alternative: GitHub-based monitoring

Farzam can also check status without Telegram:
- **GitHub Issues**: Active tasks have labels (e.g., `engineer:active`, `engineer:blocked`). Issue comments show progress updates at key milestones.
- **GitHub Projects** (optional): A board showing Intake → Active → Review → Done.

### Gaps this flow reveals

| # | Gap | Notes |
|---|-----|-------|
| **F4-1** | Status query interface | The Telegram bot needs to understand non-task messages like "status", "what are you doing", "progress on #47". This is a command interface, not just a comm channel. |
| **F4-2** | Session log queryability | Session logs need to be queryable — not just append-only text. The system needs to answer "what have you tried?" and "why did you decide X?" from structured records. |
| **F4-3** | GitHub status sync | Should GitHub issues/labels reflect current internal state? If yes, that's a sync responsibility — who owns it? |
| **F4-4** | Proactive status updates | Beyond responding to queries — should the Engineer proactively send periodic updates on long tasks? "Been working on #47 for 3 hours, here's where I am." Configurable cadence. Relates to existing Gap #4. |

---

## Flow 5: Self-Decomposition (User's View)

Farzam assigns something too big for a single task. The Engineer breaks it down.

### The scenario
Farzam wants to migrate authentication from session-based to JWT.

### Step by step

| # | Who | What happens | What Farzam sees |
|---|-----|-------------|-----------------|
| 1 | **Farzam** | Creates GitHub issue #50: "Migrate auth from sessions to JWT." Brief description, no sub-task breakdown. | The issue he wrote. |
| 2 | **System** | Trigger → Task Engine (Intake → Queued → Active). Orchestrator begins research phase. Reads the entire auth system. Determines this is too large for one task. | — |
| 3 | **System** | Orchestrator switches to "tech lead" mode. Creates a decomposition plan. Sends to Farzam for approval before creating sub-tasks. | **Telegram**: "Issue #50 (JWT migration) is too large for a single task. Here's my breakdown: **1.** Add JWT library + token generation utils **2.** Create auth middleware (verify, refresh) **3.** Migrate login/register endpoints **4.** Migrate protected routes (15 endpoints) **5.** Remove session code + cleanup. Dependency order: 1→2→(3,4 parallel)→5. Want me to proceed with this plan, or adjust?" |
| 4 | **Farzam** | Reviews the plan. Replies: "Looks good. Go." | His Telegram reply. |
| 5 | **System** | Task Engine creates 5 child tasks under parent #50. Orchestrator creates 5 GitHub sub-issues (#51-#55), each linked to #50. Parent task #50 enters a "supervising" sub-state. | **GitHub**: 5 new issues appear, each referencing #50. Issue #50 gets updated: "Decomposed into #51, #52, #53, #54, #55." |
| 6 | **System** | Daemon picks up #51 (first in dependency order). Orchestrator begins work. Parent task #50 monitors child progress. | **Telegram**: "Starting sub-task #51: JWT library + token generation." |
| 7 | **Farzam** | Can track progress by checking issue #50 (overview) or individual sub-issues. | **GitHub #50**: Shows progress — "#51 ✓ Done, #52 In Progress, #53-#55 Queued" |
| 8 | **System** | #51 completes (PR merged). #52 starts. #51's output (JWT utils) is available as context for #52. | **Telegram**: "#51 done. Starting #52: auth middleware." |
| 9 | **System** | #52 completes. #53 and #54 can now run. Daemon checks capacity — if concurrent execution is supported, both start. Otherwise, sequential. | **Telegram**: "#52 done. Starting #53 and #54 (can run in parallel)." |
| 10 | **System** | #53 fails — JWT token format is incompatible with the mobile app's expectations. Cascade failure policy activates. | — |
| 11 | **System** | Default policy: pause siblings, notify parent. #54 is paused. Parent task #50 evaluates the failure. Determines it needs human input. Reaches out to Farzam. | **Telegram**: "Problem with #53 (migrate login/register): JWT token format conflicts with mobile app's expected format. The mobile app expects `{user_id, role}` but our JWT has `{sub, permissions[]}`. Options: **(A)** Match mobile app's format (simpler, but non-standard JWT claims). **(B)** Update mobile app to handle standard claims (correct, but requires mobile release). This blocks #53 and #54. #55 is waiting on both." |
| 12 | **Farzam** | Replies: "B. We need to do it right. I'll handle the mobile update separately, add a note that mobile needs updating." | His Telegram reply. |
| 13 | **System** | Orchestrator records decision. #53 resumes with approach B. Adds a note to #50 about mobile app dependency. #54 resumes. | **Telegram**: "Resuming #53 with standard JWT claims. Noted: mobile app update needed separately." |
| 14 | **System** | All sub-tasks complete. Parent #50 does final integration check. Opens a summary PR or verifies all sub-PRs are merged correctly. | **Telegram**: "JWT migration complete. All 5 sub-tasks done. Summary: [link to #50]. Note: mobile app still needs JWT format update (tracked separately)." |
| 15 | **System** | Task Engine: Parent #50 → Completed. All child issues closed. | **GitHub**: All 6 issues (#50-#55) closed. |

### Parent task states during decomposition

```
Parent #50:
  Active (researching)
    → Active (decomposing)           -- creating plan
    → Active (awaiting-plan-approval) -- waiting for Farzam to approve plan
    → Active (supervising)           -- children executing, parent monitors
      → Blocked (child-failure)      -- child #53 failed, needs input
      → Active (supervising)         -- unblocked, children resume
    → Active (integrating)           -- all children done, final check
  → Completed
```

### Gaps this flow reveals

| # | Gap | Notes |
|---|-----|-------|
| **F5-1** | Decomposition approval flow | Should the Engineer always ask before creating sub-tasks? Or only for large decompositions? Configurable threshold? |
| **F5-2** | Parent task sub-states | The parent task has a distinct lifecycle while supervising: it's Active but not "working" in the traditional sense. Needs its own sub-state (supervising). |
| **F5-3** | Child-to-parent knowledge flow | When child #51 produces JWT utils, child #52 needs to know about them. How does sibling knowledge sharing actually work? (Confirms existing Gap #7) |
| **F5-4** | Cascade failure configuration | The default policy (pause siblings, notify parent) is one option. Users might want: fail-fast, best-effort, or manual. Needs configurable cascade policy. (Confirms existing Gap #9) |
| **F5-5** | Progress tracking on GitHub | How does the parent issue show child progress? Labels? Checkboxes? Automated comments? |
| **F5-6** | Concurrent execution | Can the system work on #53 and #54 simultaneously? Single-agent philosophy says one agent with full context — but that means sequential, not parallel. Tension with the architecture. (Confirms existing Gap #8) |

---

## Gap Summary

### New gaps discovered by user flows

| # | Gap | Found in flow | Severity | Notes |
|---|-----|--------------|----------|-------|
| 13 | **Demo approval mechanism** | Flow 1, 3 | High | PR state (Draft vs Ready) discriminates demo vs code approval. Needs formal design. |
| 14 | **Active sub-states** | Flow 1, 3, 5 | Critical | Active contains: working, demo-review-pending, code-review-pending, supervising, integrating. Current state machine doesn't model these. |
| 15 | **Notification cadence** | Flow 1, 4 | Medium | When to Telegram vs stay silent. Too many = noise, too few = blind. Needs a cadence model. |
| 16 | **Demo artifact lifecycle** | Flow 1, 3 | Medium | Two types: visual (stay in PR description), code (temporary TUI, cleaned up). Different handling. |
| 17 | **Response timeout policy** | Flow 2 | High | Configurable escalation when human doesn't respond: reminder → self-unblock → stay blocked. |
| 18 | **Question batching** | Flow 2 | Low | Multiple questions: batch or one-at-a-time? |
| 19 | **Autonomy boundary config** | Flow 2 | High | Safety Layer needs a nuanced config model beyond cost caps — what *types* of decisions can the agent make alone? |
| 20 | **Status query interface** | Flow 4 | Medium | Telegram bot needs to understand commands ("status", "progress on #47"). Command parsing for the comm channel. |
| 21 | **Session log queryability** | Flow 4 | High | Logs must be queryable, not just append-only. Support "what have you tried?" and "why did you decide X?" |
| 22 | **GitHub state sync** | Flow 4, 5 | Medium | Who owns syncing internal task state to GitHub labels/issue status? |
| 23 | **Decomposition approval threshold** | Flow 5 | Medium | Always ask before decomposing? Or only above a size threshold? |
| 24 | **Review-pending semantics** | Flow 3 | High | Waiting for review is NOT the same as Blocked. It's a different kind of external wait — the task is "done for now" pending judgment, not stuck on missing info. |

### Existing gaps confirmed or refined

| Original # | Gap | Status after user flows |
|------------|-----|----------------------|
| 1 | Fast-path for trivial tasks | Confirmed — Flow 1 happy path is simple enough that some tasks don't need Telegram notification at pickup. |
| 2 | Mid-phase checkpointing | Confirmed — multi-session tasks (Flow 5) need checkpoint/resume. |
| 3 | Post-ship state | **Refined** — now understood as two-stage: demo-review-pending and code-review-pending. Richer than originally thought. |
| 4 | Proactive status | Confirmed — Flow 4 shows both reactive (query) and proactive (periodic update) needs. |
| 5 | Cumulative cost tracking | Confirmed — not directly tested by flows but still needed. |
| 6 | Task hierarchy | Confirmed — Flow 5 demonstrates parent-child relationships in detail. |
| 7 | Cross-task knowledge sharing | Confirmed — Flow 5 step 8 shows child-to-sibling knowledge flow. |
| 8 | Concurrent execution | **Tension found** — Flow 5 wants parallel sub-tasks, but single-agent philosophy says one agent. Needs resolution. |
| 9 | Cascade failure detection | Confirmed — Flow 5 steps 10-13 demonstrate cascade failure handling. |
| 10 | Parent as tech lead | Confirmed — Flow 5 shows parent supervising, making decisions about child failures. |
| 11 | Multi-repo workspace | Not tested — no multi-repo flow designed yet. |
| 12 | Scheduling/priority | Partially tested — Flow 5 shows sequencing but not preemption. |

### Combined gap count

- Original Layer 1 gaps: 12
- New gaps from user flows: 12 (numbered 13-24)
- **Total gaps for Layer 2: 24**

---

## Resolved Questions

### Auto-merge after approval?
**Configurable per repo.** Some repos allow auto-merge after approval, others require the owner to click merge. Default: wait for owner.

### What if the demo is rejected entirely?
**Same as any feedback — act like a real engineer.** Read the feedback, understand what went wrong, ask clarifying questions if needed. If the feedback means tweaking a few things, tweak them. If it means the requirements were misunderstood, loop back to requirements gathering and redo from there. There is no special "rejection policy" — the Engineer uses judgment to determine the right response, just like a real engineer would. The architecture's job is to enable looping back to any phase, not to prescribe the response.

### Conflicting reviewer feedback?
**Facilitate consensus like a real engineer.** Don't pick a side, don't escalate to "the boss." Engage both reviewers in the PR thread, discuss the trade-offs, try to reach consensus. Tag all involved parties. Reviewers are in the People Directory — the Engineer knows who they are and how to reach them. If consensus can't be reached in the PR, escalate to the repo owner. This is what a real engineer does.

### Proactive updates on long-running tasks?
**Both, configurable.** Default: milestone-based (send updates when meaningful things happen — sub-task completed, blocker hit, PR opened). Optional: daily digest on top. User chooses their preferred cadence.

### How does the architecture enable "looping back to any phase"?
**Formal state machine transition, not just Orchestrator judgment.** The Orchestrator *decides* to loop back (e.g., "this review feedback means my requirements were wrong, I need to redo research"). But the Task Engine *enforces* the transition — it's a recorded state change that updates what actions are permitted. This matters because the state machine is a security boundary (see below).

### Backend demo TUI — who builds it?
**Hybrid: base TUI project + task-specific extensions.** A pre-built base TUI project is always available — wired into foundational things (API calls, auth, data display). The Engineer builds on top of it in an isolated worktree for each task's specific backend changes. The worktree is throwaway (cleaned up when the PR merges), but the base persists and improves over time. This is the first instance of a larger pattern: **DevEx for the Engineer** — pre-built infrastructure that makes the Engineer more effective at its job.

---

## State Machine as Security Boundary

Emerged from discussion of the open questions. This is a significant architectural input for Layer 2.

**The state machine is not just a workflow tracker — it's a permission gate.** Each state defines what actions are LEGAL. Actions outside that set are hard-blocked, regardless of what the Orchestrator wants to do.

| State/Phase | Allowed | Blocked |
|------------|---------|---------|
| Research | Read files, search code, web search, ask questions | Git push, create PR, merge, deploy |
| Planning | Read, search, write plans, ask questions | Git push, create PR, merge, deploy |
| Execution | Read, write code, run tests, git commit (local) | Create PR, merge, deploy |
| Demo Review | Read, respond to feedback, update demo | Merge, deploy, new feature commits |
| Code Review | Read, respond to feedback, fix code | Merge (unless auto-merge configured), deploy |
| Completed | Nothing — task is done | Everything |

This is **defense in depth** layered on top of the Safety Layer:
- **Safety Layer** checks *what* you're doing against rules (cost caps, scope, forbidden actions)
- **State machine** checks *when* you're doing it against the current phase
- Both must agree for any action to proceed

If the Orchestrator tries to push code while in research phase, the state machine blocks it before the Safety Layer even sees it. This catches bugs in the Orchestrator's logic, not just policy violations.

**Looping back changes permissions.** When the Orchestrator loops from code-review back to requirements, the permission set resets — no more code pushes allowed until execution phase is reached again. The state transition is recorded in the audit trail.

This makes the state machine a **failsafe**. Even if the LLM hallucinates, even if the Orchestrator has a bug, the state machine prevents structurally impossible actions.

---

## DevEx for the Engineer

The Engineer is our developer. Just like we'd set up tooling for a human engineer, we set up tooling for The Engineer.

**First instance: Demo TUI base project.** A maintained project the Engineer builds on for backend demos. But this pattern extends — as we discover what the Engineer needs to be effective, we build it.

Examples that may emerge:
- Base TUI for backend demos
- Testing harness templates
- Common development environment configs
- Reference documentation the Engineer consults frequently

This is not premature — it's a design principle: **invest in the Engineer's DevEx**. The more effective its tools, the higher the quality of its output. We'll discover specific needs as we design Layer 2 and beyond.

## Open Questions

(All previous questions resolved. New questions for Layer 2.)

- What is the exact taxonomy of Active sub-states? (Layer 2: Task Engine)
- How granular should state-machine permissions be? Per-tool? Per-action-class? (Layer 2: Task Engine + Safety Layer)
- What other "DevEx for the Engineer" tooling will emerge? (Discovered iteratively)
