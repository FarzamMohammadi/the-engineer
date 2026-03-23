# RRPIR — The Engineer's Methodology

**Requirements Gathering → Research → Planning → Implementation → Review**

This is The Engineer's methodology for completing software engineering tasks. Inspired by HumanLayer's RPI and Burleigh's RPIR, but with two original contributions: Requirements Gathering as a universal fallback (any phase can invoke it), and a multi-phase configurable Review pipeline. Built on top of a CLI-native architecture where the CLI tools do the heavy lifting and The Engineer orchestrates them.

---

## CLI-Native Leverage

The Engineer wraps CLI coding tools — it does not compete with them.

Claude Code, Codex, OpenCode, Gemini CLI: each has a dedicated team building agentic capabilities (tool use, code search, plan mode, context management). We don't rebuild what they've built. We orchestrate them.

The Engineer's value is everything around the CLI call: phase sequencing, context engineering, file-based handoffs, crash recovery, workspace isolation, quality gates, requirements gathering from real people, PR lifecycle, communication. The CLI tool handles exploration, planning, and code generation natively. We provide the methodology that extracts maximum quality.

Same tool, different user. A junior engineer and a staff engineer use the same CLI. The staff engineer gets 10x better results because of how they set up context, what they ask for, and how they chain the work. The Engineer is that staff-level workflow — automated.

### Principles

- **Never reimplement CLI capabilities.** If the CLI can search code, read files, run commands — let it. Don't build a JSON action loop that does the same thing worse.
- **Invest in prompt engineering and phase design.** Our competitive advantage is HOW we use the tools, not building our own tools.
- **CLI-agnostic framing.** Prompts work across all CLI tools. No per-tool special-casing in the prompt layer.
- **Let CLI tool developers improve our product for free.** When Claude Code ships better search or Gemini CLI adds new capabilities, The Engineer benefits automatically.

---

## Architecture Decisions

### CLI-Native Agent Architecture

**Revises D143** (Layer 6, Session 052). D143 established that "The Engineer IS the agent. LLM providers are inference-only" and built a custom agent loop (agent-loop.ts, action-executor.ts, phase-tools.ts) that parsed JSON actions from the LLM and executed them. This served its purpose during initial implementation but artificially limited the CLI tools to text-in/text-out inference while rebuilding their native capabilities in our own code.

**New direction:** CLI tools are full agents with native capabilities. The Engineer orchestrates them — providing context, sequencing phases, managing file handoffs, handling crash recovery. The CLI runs in the worktree with full permissions. It handles its own exploration/execution loop natively. The Orchestrator provides prompts + deliverable expectations and reads results from files.

**What this removes:** `agent-loop.ts`, `action-executor.ts`, `phase-tools.ts`, `json-parser.ts` — our custom JSON action loop. Phased removal across Sessions 069-072.

**What stays unchanged:** Orchestrator (phase pipeline, transitions), Safety Layer (cost limits between phases), Workspace Manager (worktree isolation), Event Bus, Session Memory, Dashboard, People Directory, PR Manager, all plugins, config system, DB layer, CLI commands.

### Requirements Gathering as Universal Fallback

**Revises the intake_analysis phase design** (Layer 2, orchestrator.md; implemented Layer 6, Session 052). The original Layer 2 design intended intake_analysis to "parse requirements, identify gaps, assess complexity." During Layer 6 implementation, it was reduced to primarily complexity assessment and fast-path routing. This decision restores and elevates it.

Any phase can invoke Requirements Gathering when it gets stuck and needs human input. Just like a real engineer who stops mid-implementation to ask "what do I need here?" — the task blocks, the right people are contacted (via People Directory + Communication plugins), answers arrive, context is updated, and the calling phase resumes. Agile, not waterfall.

### Intake Analysis → Requirements Gathering

**Revises the fast-path decision** (D141, Layer 6). D141 established phase tool restrictions and fast-path routing where trivial tasks skipped research/planning. In practice, fast-path consistently reduced PR quality. This decision removes fast-path entirely. Every task gets full RRPIR. Quality over speed.

The `intake_analysis` phase is renamed to `requirements_gathering` and elevated to its original design intent: gather all information needed, identify gaps, reach out to people. Research can signal "lightweight planning is fine" but never skip it.

### Multi-Phase Configurable Review Pipeline

**Revises the self-review design** (Layer 2, orchestrator.md; implemented Layer 6, Session 055). The original self-review was a single monolithic phase with a quality gate (ship_it/needs_work/fundamental_issues). This decision replaces it with a configurable pipeline of focused review phases — each as a separate CLI session with a fresh context window and focused lens (security, code quality, requirements verification, etc.). Findings are consolidated, then a final refinement pass fixes everything before the PR goes out. Extensible via config.

---

## The Phase Pipeline

### Overview

```
Requirements Gathering (universal fallback — any phase can invoke)
      |          ↕           ↕            ↕           ↕          ↕
      v
  Research  →  Planning  →  Implementation  →  Review   →  Demo/PR  →  Integration
      ↑                                       Pipeline
      |
  (loop back if research needs more info)
```

Every task gets the full pipeline. No fast-path. Research can signal "lightweight planning is fine" but never skip it.

### How Phases Call CLI Tools

```
Orchestrator → buildPrompt() → LLM.infer(prompt, { cwd: worktree })
    → CLI runs natively in worktree (reads, searches, writes, runs commands)
    → CLI returns text summary + writes deliverable files to thoughts/
    → Orchestrator reads deliverable files from worktree
    → Orchestrator parses structured signals from CLI text output
    → Route to next phase (or fallback to Requirements Gathering)
```

Each phase = one CLI session. Fresh context window. File-based handoffs between phases (compaction principle — each session gets a clean context with just the accumulated files).

---

## Phase Definitions

### 1. Requirements Gathering (R)

**Purpose:** Gather all context needed for the task. Assess completeness. Reach out to people when information is missing. This is what a real engineer does first — make sure you understand the ask before diving in.

**Input:** Task description (from trigger), People Directory contacts
**Deliverable:** `thoughts/requirements.md`
**Contacts:** People Directory entries (PM, designer, tech lead, etc.) via Communication plugins

**Prompt framing:**
- "You are gathering requirements for this task."
- "Read the task description carefully. Identify gaps, ambiguities, missing context."
- "Check the team directory: [people directory data]. Determine if you need input from anyone."
- "If you have enough context, write your findings to `thoughts/requirements.md` and signal ready."
- "If you need more information, specify WHO to contact, WHAT to ask, and WHY."

**Behavior:**
- Sufficient context → writes `thoughts/requirements.md`, proceeds to Research
- Gaps found → specifies questions + contacts, task goes to `blocked` state
- Response arrives (trigger polling) → re-runs, reads prior requirements.md + new response, updates file
- Loop continues until satisfied

**Requirements file template:**
```markdown
# Requirements: [Task Title]

## Task Description
[Original task from trigger source]

## Gathered Context
[Everything we know — from task, from responses, from context]

## Questions Asked
### [Person/Role] — [Date]
**Q:** [Question]
**A:** [Answer, or PENDING]

## Assessment
[Is this enough to proceed to research? What's still unclear?]

## Team Contacts Referenced
- [Name] ([Role]) — [What they provided]
```

### 2. Research (R)

**Purpose:** Deep codebase exploration. Build understanding of what exists, patterns, conventions, dependencies.

**Input:** `thoughts/requirements.md` (on disk in worktree)
**Deliverable:** `thoughts/research.md`
**CLI mode:** Full permissions in worktree

**Prompt framing:**
- "You are in research mode. Read `thoughts/requirements.md` first for full task context."
- "Explore the codebase. Document what exists, how it works, what patterns to follow."
- "Do NOT make code changes. Do NOT plan solutions."
- "If you discover you need more information from people, signal 'need_more_info' with specifics."
- "Write findings to `thoughts/research.md`."

**Behavior:**
- Normal: explores, writes `thoughts/research.md`, proceeds to Planning
- Needs info: signals back to Requirements Gathering with what's needed
- Can signal: "this is simple enough for lightweight planning" (informs planning depth)

**Research file template:**
```markdown
# Research: [Task Title]

## Task Context
[Brief — full details in requirements.md]

## Codebase Analysis
[What exists, how it works, relevant architecture]

## Relevant Files
- `path/to/file.ts` — [why relevant, what it does]

## Patterns & Conventions
[Coding style, test patterns, directory structure, naming]

## Dependencies & Integration Points
[What this change touches, what depends on it, ripple effects]

## Complexity Assessment
[Simple/moderate/complex — informs planning depth]

## Open Questions
[Anything still unclear after research]

## Key Findings
[Most important discoveries that should guide planning]
```

### 3. Planning (P)

**Purpose:** Create a precise, actionable implementation plan from research findings.

**Input:** `thoughts/research.md`, `thoughts/requirements.md` (on disk)
**Deliverable:** `thoughts/plan.md`
**CLI mode:** Full permissions (reads code to verify assumptions, writes plan)

**Prompt framing:**
- "Read `thoughts/research.md` and `thoughts/requirements.md`."
- "Create a precise implementation plan. Do NOT write implementation code."
- "If you need more information to plan properly, signal 'need_more_info'."
- "Write the plan to `thoughts/plan.md`."

**Can invoke Requirements Gathering** if planning reveals gaps.

**Plan file template:**
```markdown
# Plan: [Task Title]

## Approach
[High-level description of what we'll build and how]

## Phases

### Phase 1: [Name]
- [ ] [Specific action with file path]
- [ ] [Specific action with file path]
- **Verify:** [How to confirm this phase works]

### Phase 2: [Name]
- [ ] [Specific action with file path]
- [ ] [Specific action with file path]
- **Verify:** [How to confirm this phase works]

## Risks & Mitigations
- **Risk:** [What could go wrong] → **Mitigation:** [How to handle it]

## Test Strategy
[What tests to write, what to verify, edge cases]

## Success Criteria
- [ ] [Measurable criterion]
- [ ] [Measurable criterion]
```

**Checkboxes are live progress trackers.** Implementation updates them. Crash recovery reads them.

**Decomposition:** If plan includes a "## Decomposition" section, the Orchestrator routes to the decomposition handler to create child tasks.

### 4. Implementation (I)

**Purpose:** Implement the plan. Write code, tests, iterate.

**Input:** `thoughts/plan.md`, `thoughts/research.md`, `thoughts/requirements.md` (on disk)
**Deliverable:** Code changes in worktree + updated `thoughts/plan.md` (checkboxes checked)
**CLI mode:** Full permissions (read, write, bash, git)

**Prompt framing:**
- "Read `thoughts/plan.md`. This is your implementation guide."
- "Implement each phase. Update checkboxes to `[x]` as you complete steps."
- "Run tests after each phase. Fix failures before moving on."
- "Follow conventions from `thoughts/research.md`."
- "If you get stuck and need input from people, signal 'need_more_info'."

**Can invoke Requirements Gathering** if implementation reveals unknowns.

**Crash recovery:** Checked boxes in `thoughts/plan.md` show progress. On resume, CLI reads the plan and continues from where it left off.

### 5. Review Pipeline (R)

**Purpose:** Quality assurance through multiple focused lenses. Not one monolithic review — separate CLI sessions for each concern.

**Deliverable:** `thoughts/review/*.md` files, then `thoughts/refinements.md`

**Default review phases (configurable in `orchestrator.yaml`):**

```yaml
rrpir:
  review_phases:
    - requirements_check    # Did we hit all acceptance criteria?
    - security_review       # Injection, auth, trust boundaries
    - code_quality          # Naming, patterns, complexity, refactoring
    # Future: test_coverage, performance_review, accessibility, etc.
```

**Each review phase:**
- Separate CLI session (fresh context, focused lens)
- Reads code changes (git diff), plan, research, requirements
- Produces findings file: `thoughts/review/{phase-name}.md`
- Can invoke Requirements Gathering if review reveals ambiguous requirements

**Final review step: Refinement**
- Reads ALL review findings from `thoughts/review/*.md`
- Consolidates into `thoughts/refinements.md`
- Executes the fixes in a CLI session
- If no fixes needed → straight to Demo/PR

**Loopback:** If refinements are substantial, can loop back to Implementation with updated plan. Max loopback count prevents infinite cycles.

### 6. Demo/PR

**Purpose:** Commit, push, create draft PR with clear narrative.

**Input:** All worktree changes, all thoughts/ files
**Deliverable:** Draft PR on GitHub

**Prompt framing:**
- "Prepare this work for review. Commit with clear messages."
- "Write a PR description referencing the plan and research."
- "The thoughts/ directory will be included in the PR for reviewer context." (or cleaned up per config)

### 7. Integration (for decomposed tasks)

**Purpose:** Merge child task branches, run integration tests.
Unchanged from current design — only applies to parent tasks with children.

---

## Requirements Gathering as Universal Fallback

**Any phase can invoke Requirements Gathering.** The mechanism:

1. CLI signals `need_more_info` in its output (structured signal)
2. Signal includes: what information is needed, suggested contacts (or "unknown")
3. Orchestrator catches the signal in post-phase processing
4. Orchestrator appends the question to `thoughts/requirements.md` as PENDING
5. Orchestrator sends the question via Communication plugins (to specific people or task owner)
6. Task transitions to `blocked` state with reason "awaiting_info"
7. When response arrives (trigger polling), task unblocks
8. Requirements Gathering phase runs: reads requirements.md, incorporates response, updates file
9. **Returns to the phase that requested info** — not back to Research, to the exact calling phase

The calling phase resumes with updated context. All thoughts/ files are still on disk. Research continues researching. Implementation continues implementing. Review continues reviewing.

This is the agile approach: don't push forward blindly. Stop, gather what you need, resume with confidence.

---

## File-First Architecture (Session 069)

**Supersedes the Signal Protocol section below.** Phase outputs are metadata only. Actual content lives in `thoughts/` files. Each phase writes two files:

1. **`{phase}.md`** — the rich human-readable deliverable (requirements doc, research findings, plan, etc.)
2. **`session-result.json`** — structured metadata the Orchestrator reads to decide what's next

The Orchestrator never parses CLI text output for signals. Instead, it reads `session-result.json` after the CLI exits. This is more robust than text-based signal parsing — JSON files are deterministic, validatable, and survive CLI output formatting variations.

### session-result.json

Pre-filled as a template with valid options before the CLI runs:

```json
{
  "status": "<ready | need_more_info | error>",
  "next_phase": "<research | requirements_gathering | planning | execution | review | demo_prep | integration>",
  "summary": "<one-line summary of what you accomplished>"
}
```

The CLI fills in actual values. If untouched (placeholders remain), the Orchestrator detects this and continues the same CLI session via `getContinueArgs()` with a nudge prompt. After 1 retry, falls back to expected next phase with a warning.

### Insurance layers

1. **Template pre-fill** — Orchestrator writes session-result.json with placeholder options before CLI runs
2. **Post-session validation** — After CLI exits, read + validate. Detect unfilled placeholders.
3. **Continue-session retry** — If invalid, continue the same CLI session with a nudge. CLI retains all context.
4. **Prompt reinforcement** — Every phase prompt ends with session-result.json instructions and valid values.
5. **Graceful fallback** — After 1 retry, proceed with expected next phase + log warning.

### Phase outputs as metadata

`PhaseOutput.data` for CLI-native phases contains metadata about what happened:

```typescript
// Requirements Gathering output
{ deliverable_path, signal_status, contact, question, assessment }

// Research output
{ deliverable_path, signal_status, contact, question, complexity_hint }
```

The rich content lives in the `.md` file. The `.md` accumulates across reruns — if requirements gathering loops back, the same `requirements.md` gets updated, not replaced. Each phase reads prior phases' `.md` files directly from disk.

### Separation of Concerns: Routing vs. Content (Session 070)

session-result.json is pure state routing — three fields (status, next_phase, summary). It answers "what happened?" and "where next?" All rich context — ambiguities, questions, findings, reasoning — lives in the `.md` deliverable files.

When a phase encounters ambiguity, it documents everything in its `.md` file and signals `need_more_info` in session-result.json. Requirements Gathering reads the calling phase's `.md` file to understand what's unclear. Only Requirements Gathering interacts with people (via People Directory) — other phases never specify contacts or questions in session-result.json.

This separation keeps the routing layer simple and validatable while letting the content layer be as rich and free-form as the LLM needs it to be.

---

## ~~Signal Protocol~~ (Superseded)

~~Every CLI call must end with a structured signal line for the Orchestrator to parse.~~

**Replaced by session-result.json files (Session 069).** See "File-First Architecture" above. The signal protocol was fragile (LLMs are inconsistent with structured output in free text). File-based routing is deterministic and validatable.

---

## thoughts/ Directory Structure

Task-scoped with `{date}-{thoughts_id}` naming. `thoughts_id` comes from the trigger plugin (e.g., `issue-42` from GitHub).

```
<worktree>/
  thoughts/
    2026-03-22-issue-42/           # Task-scoped directory
      requirements/
        requirements.md            # Requirements gathered, Q&A with stakeholders
        session-result.json        # Routing metadata for Orchestrator
      research/
        research.md                # Codebase analysis, patterns, findings
        session-result.json
      planning/
        plan.md                    # Implementation plan with checkboxes
        session-result.json
      implementation/
        session-result.json        # Code changes are in worktree, not .md
      review/
        requirements-check.md      # Acceptance criteria verification
        security-review.md         # Security findings
        code-quality.md            # Quality/refactoring findings
        session-result.json
      refinements/
        refinements.md             # Consolidated fixes from review pipeline
        session-result.json
```

All directories + session-result.json templates created upfront at workspace setup. Files accumulate through the pipeline. Each phase reads prior phases' files. Files appear in PRs (unless configured otherwise). Reviewers see the full reasoning chain.

---

## Config

New `rrpir` section in `orchestrator.yaml`:

```yaml
rrpir:
  include_thoughts_in_pr: true     # Include thoughts/ dir in PRs (default: true)
  review_phases:                    # Configurable review pipeline
    - requirements_check
    - security_review
    - code_quality
  max_requirements_loops: 5        # Max requirements gathering round-trips before human escalation
  max_review_loopbacks: 3          # Max review → implementation loopbacks
```

---

## Design Concerns & Open Items

### 1. Signal Parsing Reliability (Session 069)

LLMs are inconsistent with structured output in free text. The `ENGINEER_SIGNAL` protocol must be enforced by the prompt and parsed gracefully. If the signal is missing, default to "ready." Design exact schema in Session 069.

### 2. Universal Fallback Return-to-Phase Routing (Session 070)

When any phase invokes Requirements Gathering, we need to route back to the exact calling phase. Add a `return_to_phase` field on the task or dispatch. When `need_more_info` is signaled: store the calling phase, block, wait for response, run Requirements Gathering, then jump to the stored phase.

### 3. Cost Management (Session 071)

A complex task = 7-8+ CLI calls. Safety Layer checks between phases (already does this). Start review pipeline with just `requirements_check` by default. Consider per-task cost budget with human approval escalation.

### 4. Cross-Task Knowledge Accumulation (Future)

Research for task #5 should benefit from findings in tasks #1-4 in the same repo. Future: extract key findings as repo-scoped knowledge entries in Session Memory.

### 5. Decomposition Timing (Session 070)

Keep decomposition at planning for now. Research can signal "likely needs decomposition" but the decision waits for planning where full scope is visible.

### 6. Estimation & Time-Boxing (Future)

Planning phase could output expected duration. Communicated to stakeholders via notification. Not critical for RRPIR launch.

---

## What We Built On

RRPIR is The Engineer's methodology. It builds on work by others:

- [HumanLayer ACE / RPI](https://github.com/humanlayer/advanced-context-engineering-for-coding-agents/blob/main/ace-fca.md) — the original Research → Plan → Implement pattern, context compaction, ~200 line artifact target
- [Goose RPI](https://block.github.io/goose/docs/tutorials/rpi/) — `thoughts/` directory convention, checkboxes for progress tracking, session isolation between phases
- [Tyler Burleigh RPIR](https://tylerburleigh.com/blog/2026/02/22/) — added Review as a fourth phase, fresh sessions between stages, PLAN-CHECKLIST.md
- [LinearB / Dex Horthy](https://linearb.io/blog/dex-horthy-humanlayer-rpi-methodology-ralph-loop) — Ralph loops, context compaction as core principle
- [patrob RPI Strategy](https://github.com/patrob/rpi-strategy) — FAR/FACTS quality scoring scales for validating outputs
- [DeepWiki](https://deepwiki.com/humanlayer/advanced-context-engineering-for-coding-agents/3.2-planning-phase) — planning phase analysis, 15-20% context utilization target

**What's ours:**
- Requirements Gathering as a first-class phase with People Directory integration
- Universal fallback — any phase can invoke Requirements Gathering when stuck
- Multi-phase configurable Review pipeline (not one monolithic review)
- CLI-native architecture — letting CLI tools be agents, not stripping them to inference
- File-based crash recovery via plan checkboxes
