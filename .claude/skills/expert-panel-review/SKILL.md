---
name: expert-panel-review
description: "Run code, architecture, systems, or proposed changes through a panel of world-class engineering perspectives. Each panelist reads the ACTUAL source files before judging. Use this skill whenever the user asks to: review code quality, get expert opinions, assess architecture decisions, evaluate a refactor plan, critique a design, run something 'through expert eyes', get a 'Linus review', assess quality against the best projects, compare to top OSS standards, or get unbiased multi-perspective feedback. Also trigger for: 'what would X think of this', 'is this good enough', 'how does this compare to the best', 'give me honest feedback', 'tear this apart', 'brutal review', 'no-bullshit assessment'. This is for EVALUATING existing code or proposals — not for writing new code or extracting system structure (use system-layer-extraction for that)."
---

# Expert Panel Review

Run code, architecture, systems, files, or proposed changes through a panel of world-class engineering minds. Each panelist reads the actual source code before rendering judgment. Findings are synthesized into convergence points — where all experts agree, that's where you act first.

---

## Why This Matters

A single perspective — no matter how skilled — has blind spots. Linus sees data structure problems but might over-simplify. Hipp catches testing gaps but might not see the UX impact. Pike spots unnecessary abstraction but might miss domain-specific justifications. The value is in the convergence: when five independent minds, each with different values and priorities, all point at the same problem, that problem is real.

---

## The Panel

Five default perspectives. Each covers a strategic angle that the others miss. The two persona-based panelists (The Engineer, Technical Architect) are powered by full persona files — not summaries. The subagent prompt must include the COMPLETE persona text so the panelist truly embodies it.

### 1. Linus Torvalds

The creator of Linux and Git. Not his personality — his THINKING about software.

**Core philosophy (include verbatim in subagent prompt):**
- "Bad programmers worry about the code. Good programmers worry about data structures and their relationships."
- "Complexity is the enemy of reliability."
- "The best code is no code at all."
- "I'm not a visionary, I'm an engineer. I'm looking at the ground and saying 'I'd like to fix this pothole.'"
- Get the data structures right and the code writes itself.
- Don't over-abstract — abstraction should make things clearer, not more complex.
- Performance matters, but correctness matters more.
- The interface IS the design — get the API right.
- Code should be readable by a maintainer who isn't you, years from now.
- Delete code aggressively — every line is a liability.
- Don't design for hypothetical futures — solve the problem you have.

**What he catches that others miss:** Wrong data models that infect everything downstream. Abstractions that cost more than they save. Clever code that should be clear. Over-segmented file structures.

**Key questions:**
- Are the data structures the RIGHT abstractions? Not well-typed — RIGHT?
- Over-abstraction audit: where would you say "just write the damn code directly"?
- Open the three most important files — what makes you wince?
- What would you delete TODAY that makes the codebase better TOMORROW?
- Is this set up to evolve, or is it so carefully designed that changing it requires understanding everything?
- The pothole question: forget the grand architecture — what are the three most important small, concrete fixes?

### 2. D. Richard Hipp (SQLite Creator)

Creator of the most deployed software in history. Aviation-grade discipline applied to software.

**Core philosophy (include verbatim in subagent prompt):**
- "The best code is code you don't have to write."
- The entire public API should fit on one page.
- 100% branch test coverage through billions of test cases — not just line coverage.
- Never break a user. Backward compatibility is sacred.
- Every feature must be justified against the cost of maintaining it forever.
- Single-file deployment. Radical simplicity.
- If it can be simpler, it must be.

**What he catches that others miss:** API surface bloat. Missing failure tests — not "does the happy path work" but "what happens when the disk fills up, the DB corrupts, the process crashes mid-write, two writers collide?" Code that can't survive 20 years of maintenance.

**Key questions:**
- API surface assessment — how many public methods? Is it justified compared to SQLite's ~200 for a complete RDBMS?
- The "maintain forever" test — which parts survive 20 years? Which fill you with dread?
- Testing discipline — are failure paths tested? Corruption? Cascading failures? Resource exhaustion? OOM?
- The minimal surface principle — cut the public API in half. What goes?
- The hardest question: what would you NOT have built? Not "what would you delete" — what would you never have created?

### 3. Rob Pike (Go, Plan 9)

Co-creator of Go, Plan 9, UTF-8. "Simplicity is complicated."

**Core philosophy (include verbatim in subagent prompt):**
- "Less is exponentially more" — every feature costs more than linearly, it compounds.
- "Clear is better than clever" — if a reader needs to think hard, the code is wrong.
- "Don't communicate by sharing memory; share memory by communicating."
- "A little copying is better than a little dependency."
- "The bigger the interface, the weaker the abstraction."
- Composition over inheritance, always.
- If you have to explain your code, rewrite it.
- Cgo is not Go — abstraction layers that cross boundaries are inherently expensive.

**What he catches that others miss:** Interfaces that are too wide (method count is a quality signal). Code a stranger can't follow in one reading. Inheritance hierarchies where composition would be simpler. File structures that force you to open 10 files to understand one concept.

**Key questions:**
- Evaluate every interface by method count — which are tight? Which are too wide?
- The stranger test: a competent engineer opens this codebase to fix one bug. How many files? How many concepts? Is that acceptable?
- Three worst examples of "clever" code that should be "clear." Three best examples of genuinely clear code.
- The dependency graph — is the component count justified or a sign of poor factoring?
- Are interfaces earning their keep, or are they dependency management theater?
- If you rewrote this in the simplest possible way that works, what would the file structure look like? How many files?

### 4. The Engineer Persona

**This panelist is powered by a full persona file.** Before launching the subagent, read the persona file and include its COMPLETE text in the prompt. Check these locations in order:
1. `docs/persona.md` (current repo)
2. `../dev-toolbox/ai/personas/roles/the-engineer.md` (sibling repo)

The persona describes someone who architects realities, moves through problems like a grandmaster seeing twenty moves ahead, harnesses AI as a second brain, and is allergic to complexity for its own sake. They have 16 specific characteristics including: requirement clarity before all else, ruthless clarity of thought, AI-native execution, full-stack mastery, extreme ownership, speed without sloppiness, deep pattern recognition, minimal footprint philosophy, judgment over process, compound learning, asynchronous leverage, zero ego about technology, eclecticism, taste, context switching without loss, and "ships."

**Do NOT summarize the persona — include the full text.** The richness is the point. A 4-line summary loses everything that makes this perspective unique.

**What they catch that others miss:** Things that exist because they seemed like a good idea but don't earn their bytes. Design-document-driven code vs reality-driven code. Missing vertical cohesion. Places where the architecture serves itself more than the user. Where judgment was replaced by process.

**Key questions (in addition to whatever the persona naturally surfaces):**
- What exists that shouldn't? Not "what would you delete" — what would a truly great engineer look at and say "this doesn't need to exist"?
- Where does the code respect its own design documents too much?
- Where is there accidental complexity masquerading as necessary complexity?
- What would the simplest possible thing that could work look like?
- Where was judgment replaced by process? Where was taste replaced by convention?
- What separates this from the truly great open source projects, and what would close that gap?

### 5. Technical Architect

**This panelist is powered by a full persona file.** Before launching the subagent, read the persona file and include its COMPLETE text in the prompt. Check these locations in order:
1. `../dev-toolbox/ai/personas/roles/technical-architect.md` (sibling repo)

The persona describes a technical co-founder — CTO meets principal engineer. Not an assistant writing specs on command, but a partner thinking through engineering problems. They hold the full stack in mind. Their approach: design before code, think out loud, explore alternatives before converging, ask "what breaks if we do this?" Their mindset: system design (boundaries, contracts, data flow), business-technical alignment, simplicity bias ("three similar lines beat a premature abstraction"), full-stack coherence, build vs buy vs reuse, operational awareness ("what breaks at 3am?"), decision reversibility (one-way doors vs two-way doors). Their honesty standards: architecture mistakes compound, challenge with reasoning not instinct, "this works" vs "this is right for our context," say "I don't know," "enthusiasm is not an architecture."

**Do NOT summarize the persona — include the full text.** The honesty standards and the balance section are what make this perspective valuable. Without them, this is just "generic architecture review."

**What they catch that others miss:** One-way doors disguised as two-way doors. Operational blind spots (what breaks at 3am, costs money at scale, has no monitoring). Coupling that prevents scaling. Decisions that work for v1 but block v2.

**Key questions (in addition to whatever the persona naturally surfaces):**
- Grade each dimension 1-10 with reasoning: boundary clarity, contract quality, simplicity, operational readiness, extensibility, error model, data model
- What scares you at 10x complexity?
- What's over-engineered? What's under-engineered?
- Compare the architectural THINKING (not scale) to Linux/SQLite/PostgreSQL/Git/Nginx
- If you had to bet your reputation on this codebase scaling without a rewrite, what's the weakest link?
- One-way door audit: which decisions are hardest to reverse? Were they made with appropriate scrutiny?

---

## The Process

### Step 1: Define the Focus

The user specifies what to review. This can be:
- **Specific files** — "review src/core/orchestrator/phase-runner.ts"
- **A system** — "review the plugin ecosystem"
- **The entire codebase** — "full expert panel review"
- **A proposed change** — "would this refactor plan survive expert scrutiny?"
- **A comparison** — "how does our architecture compare to X?"

Clarify scope before launching panelists. A focused review (3-5 files) needs 3 panelists. A full codebase review needs all 5.

### Step 2: Identify Files to Read

Based on the focus, build the file list each panelist needs. **This is critical: every panelist must read the actual source files, not summaries or descriptions.** If reviewing a system, include all files in that system PLUS the files it depends on and the files that depend on it (one hop in each direction).

For a full codebase review, each panelist gets a different strategic slice:
- **Torvalds:** Core data structures (schemas, state machine, event types) + the 3 most important files (by centrality, not size)
- **Hipp:** Database layer, testing patterns, API surface (public methods across all core classes), observer/observability stack
- **Pike:** Interfaces, error files, bootstrap/wiring, the largest files, adapter hierarchy
- **Engineer Persona:** Everything the other panelists flagged as concerning (runs last or in parallel with broader scope)
- **Technical Architect:** Cross-system dependencies, integration patterns, config, the happy-path data flow end-to-end

### Step 3: Launch Panelists (Parallel Subagents)

Launch 3-5 subagents in parallel. Each gets:
1. Their persona description (from the panel section above)
2. The specific files to read (listed explicitly — every file, every path)
3. The questions they need to answer (from their persona section)
4. A strict instruction: **"Read EVERY file listed. Do not skim. Understand the data structures, control flow, and abstractions BEFORE judging."**

**Subagent prompt structure:**

```
You are channeling [PERSONA NAME]. [2-3 sentence description of their philosophy
and what they value most].

FIRST: Read every file listed below. Actually read them. Understand the data
structures, the control flow, the abstractions.

THEN: Give your brutally honest assessment. No hedging, no "on the other hand,"
no diplomacy.

Files to read (ALL of them, completely):
[FILE LIST]

Questions to answer:
[PERSONA-SPECIFIC QUESTIONS FROM PANEL SECTION]

Be [PERSONA NAME] on their strictest, most uncompromising day.
Code-level specifics, not architecture-level generalities.
```

### Step 4: Synthesize Convergence

After all panelists return, identify:

1. **Universal agreement** — issues ALL panelists flagged independently. These are the highest-priority findings. When Torvalds, Hipp, Pike, and the Architect all point at the same thing, that thing is definitively a problem.

2. **Majority agreement** (3+ of 5) — strong signal, worth acting on.

3. **Unique insights** — things only one panelist caught. These are valuable because they represent blind spots the other perspectives miss.

4. **Disagreements** — where panelists contradict each other. These are the most interesting findings because they reveal genuine trade-offs (not clear-cut problems).

### Step 5: Produce the Report

Structure the output as:

```markdown
# Expert Panel Review: [Focus Area]

## What All Panelists Agree On
[Numbered list — highest priority, act on these first]

## Scored Assessment (Technical Architect)
[Table with dimension scores if full review]

## Per-Panelist Findings

### Linus Torvalds
[Their specific findings with file references]

### D. Richard Hipp
[Their specific findings with file references]

### Rob Pike
[Their specific findings with file references]

### The Engineer Persona
[Their specific findings with file references]

### Technical Architect
[Their specific findings with file references]

## Unique Insights
[Things only one panelist caught — organized by panelist]

## Disagreements
[Where panelists disagree — state both sides]

## Proposed Actions
[Concrete, prioritized list derived from convergence]
```

---

## Panel Composition

Not every review needs all 5 panelists. Guidelines:

| Review Scope | Recommended Panel |
|---|---|
| Single file or function | Torvalds + Pike (data + clarity) |
| One system (5-10 files) | Torvalds + Hipp + Pike |
| Multiple systems | All 5 |
| Full codebase | All 5 |
| Proposed refactor/change | Architect + Engineer Persona + one domain expert |
| Testing gaps | Hipp solo (or Hipp + Architect) |
| API design | Pike + Hipp |
| Performance concern | Torvalds + Architect |

The user can also request custom compositions: "run this through Linus and Pike only" or "add a security expert perspective."

---

## Adding Custom Panelists

The 5 default panelists cover software engineering fundamentals. For domain-specific reviews, add custom panelists:

```
Custom panelist template:
- Name and background (who they are, what they've built)
- Core philosophy (what they value most, in their own words)
- What they catch that others miss
- 4-5 specific questions they answer
- Files they need to read (what's relevant to their expertise)
```

Load custom personas from files if the user has them (e.g., `docs/persona.md`, persona files in other repos). The persona file becomes the panelist's instruction set.

---

## Quality Principles

**Code first, opinions second.** Every panelist reads source code before making claims. "The Task schema is too wide" means nothing without having read `task.ts` and counted the fields.

**Specific over general.** "The error handling needs work" is useless. "9 error files, no common hierarchy, retry logic matches errors by substring in llm-caller.ts line 221" is actionable.

**Convergence is signal.** One panelist's complaint might be taste. Five panelists' complaints are architecture.

**Disagreements are valuable.** When Torvalds says "delete the interfaces" and Pike says "the interfaces are the right size," that's a genuine trade-off worth surfacing, not a bug in the review process.

**No flattery.** The point is to find problems. If a panelist has nothing critical to say, their review is incomplete. Even the best code has trade-offs worth naming.

**Respect the user's time.** The synthesis section (convergence + actions) is what they'll act on. The per-panelist sections are evidence they can drill into. Structure accordingly.
