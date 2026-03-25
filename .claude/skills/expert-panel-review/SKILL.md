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

Five default perspectives. Each covers a strategic angle that the others miss.

### 1. Linus Torvalds
**Lens:** Data structures, over-abstraction, practical simplicity
**What he catches that others miss:** Wrong data models, abstractions that cost more than they save, clever code that should be clear code
**Key questions he answers:**
- Are the data structures right? Not "well-typed" — the RIGHT abstractions?
- Is this over-abstracted? Would a simpler design work?
- What makes you wince when you read the actual code?
- What would you delete today?

### 2. D. Richard Hipp (SQLite Creator)
**Lens:** Radical simplicity, minimal API surface, testing discipline, "maintain forever"
**What he catches that others miss:** API bloat, missing failure tests (corruption, cascading, resource exhaustion), unnecessary observability layers, code that can't survive 20 years
**Key questions he answers:**
- How large is the public API surface? Is it justified?
- Which parts would you maintain with confidence? Which fill you with dread?
- Are failure paths tested? Corruption? Cascading failures?
- What would you NOT have built?

### 3. Rob Pike (Go, Plan 9)
**Lens:** "Less is exponentially more," interface design, clarity over cleverness, composition
**What he catches that others miss:** Interfaces that are too wide, code a stranger can't follow, inheritance where composition would be simpler, unnecessary indirection
**Key questions he answers:**
- "The bigger the interface, the weaker the abstraction" — which interfaces are too wide?
- The stranger test: how many files to understand one bug?
- Where is the code clever when it should be clear?
- What's the simplest honest file structure?

### 4. The Engineer Persona
**Lens:** Taste, judgment, minimal footprint, "every line earns its place"
**What they catch that others miss:** Things that exist because they seemed like a good idea but don't earn their bytes, design-document-driven code vs reality-driven code, missing vertical cohesion
**Key questions they answer:**
- What exists that a truly great engineer would say "this doesn't need to exist"?
- Does the code respect its own design documents too much?
- Where is there accidental complexity masquerading as necessary complexity?
- What would the simplest possible thing that works look like?

### 5. Technical Architect
**Lens:** System design rigor, decision reversibility, operational awareness, scaling risks
**What they catch that others miss:** One-way doors disguised as two-way doors, operational blind spots (what breaks at 3am?), coupling that prevents scaling, missing error taxonomies
**Key questions they answer:**
- Grade each dimension (boundaries, contracts, simplicity, ops readiness, extensibility, error model, data model)
- What scares you at 10x complexity?
- What's over-engineered? What's under-engineered?
- Compare the architectural thinking to Linux/SQLite/PostgreSQL/Git/Nginx

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
