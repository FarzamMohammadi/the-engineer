# Expert Panel Review

Run plans, architecture, code, or proposed changes through a panel of three independent engineering perspectives. Each panelist reads the actual artifacts before rendering judgment. Findings are synthesized into convergence points — where all panelists agree, that is where you act first.

---

## Why This Matters

A single perspective — no matter how skilled — has blind spots. The Architect sees structural problems but might miss implementation pitfalls. The Pragmatist catches practical issues but might not see the systemic pattern. The Critical Reviewer finds missing pieces but might not weigh feasibility. The value is in the convergence: when three independent minds, each with different priorities, all point at the same problem, that problem is real.

---

## The Panel

Three perspectives. Each covers a strategic angle that the others miss. Every panelist is powered by a full persona file in the `personas/` directory alongside this skill. The complete persona text must be included in the panelist's prompt — not a summary.

### 1. Technical Architect

**Persona file:** `personas/technical-architect.md`

The structural thinker. Evaluates boundaries, contracts, data flow, scalability, and decision reversibility. Sees the system as a whole and judges whether the parts fit together correctly.

**What they catch that others miss:** One-way doors disguised as two-way doors. Operational blind spots. Coupling that prevents scaling. Decisions that work for v1 but block v2. Layers that do not respect each other's boundaries.

**Key questions:**
- Are the boundaries between components clear and correctly placed?
- Which decisions are one-way doors? Were they made with appropriate scrutiny?
- What breaks at 10x complexity? What is the weakest structural link?
- What is over-engineered? What is under-engineered?
- Does the architecture serve the product, or does the product serve the architecture?
- Grade each dimension 1-10 with reasoning: boundary clarity, contract quality, simplicity, operational readiness, extensibility, error model, data model

### 2. Pragmatic Senior Engineer

**Persona file:** `personas/pragmatic-senior-engineer.md`

The implementation realist. Evaluates whether plans will actually work when built, where complexity is underestimated, and where integration pain will occur. Thinks bottom-up from concrete details.

**What they catch that others miss:** Deceptively complex "simple" tasks. Missing implementation steps. Integration pain between components that look fine in isolation. Ordering mistakes that increase risk. Over-engineering for problems that do not exist yet.

**Key questions:**
- Simulate building this. Where does the first obstacle appear?
- Which parts will take 3x longer than expected? Why?
- What implicit steps are missing from the plan?
- Where will integration between components cause pain?
- What is the right implementation order to de-risk the hardest parts?
- Where is the plan over-engineered for the actual problem? What would a simpler version look like?

### 3. Critical Reviewer

**Persona file:** `personas/critical-reviewer.md`

The blind spot finder. Systematically identifies what is missing, challenges assumptions, and stress-tests plans through adversarial thinking. Approaches the work as an outsider, unattached to the decisions that led to it.

**What they catch that others miss:** Assumptions nobody stated because they seemed obvious. Missing error handling, rollback strategies, and failure modes. Second-order effects. Problems that could be avoided entirely rather than solved. Stakeholders and systems that were not considered.

**Key questions:**
- What assumptions does this plan make? Which are validated and which are hopes?
- What is NOT in the plan that should be?
- For every major decision, what alternatives were considered? If none were, why not?
- What is the worst-case scenario? What is the blast radius of the worst decision?
- Does this need to exist at all? Could the problem be avoided rather than solved?
- What would you need to see to be convinced this plan is correct?

---

## Project Context Discovery

Before launching any panelists, discover and inject the project's own principles. Panelists review against the project's values, not just generic engineering wisdom.

### Step 0: Read Project Foundations

Search for and read these files (in order of priority). Include their content as mandatory context in every panelist's prompt:

1. **Philosophy / principles:** `docs/philosophy.md`, `PHILOSOPHY.md`, `docs/principles.md`
2. **Architecture:** `docs/architecture/`, `ARCHITECTURE.md`, `docs/architecture.md`
3. **Contributing guide:** `CONTRIBUTING.md`

If any of these files exist, extract the key principles and include them verbatim in every panelist prompt under a `## PROJECT PRINCIPLES (non-negotiable)` header. These are hard constraints the panelists must evaluate against.

### Step 0b: Calibrate "Defer vs Do"

Do NOT default to "defer this to later." Panelists evaluate each item on its merits:

- If something is architecturally necessary for the system to be correct, it must be done now regardless of complexity.
- If something is a genuine optimization that can be added later without architectural debt, it can be deferred.
- The question is never "is this too complex?" — it is "does the architecture require this to be correct?"

Panelists who reflexively defer complexity are not being rigorous.

---

## The Process

### Step 1: Define the Focus

Determine what is being reviewed. This can be:
- **A plan** — "review this implementation plan before we start building"
- **Specific files** — "review src/core/orchestrator/phase-runner.ts"
- **A system** — "review the plugin loading pipeline"
- **A proposed change** — "would this refactor plan survive expert scrutiny?"

Clarify scope before launching panelists.

### Step 2: Identify Artifacts to Read

Based on the focus, build the artifact list each panelist needs. Every panelist must read the actual source material — not summaries or descriptions. If reviewing code, include all files in the system PLUS one hop of dependencies in each direction.

Always include the project foundation files from Step 0 in every panelist's artifact list.

For a plan review, every panelist reads the full plan plus any referenced files.

For code review, distribute strategic slices:
- **Technical Architect:** Cross-system dependencies, integration patterns, config, the happy-path data flow end-to-end
- **Pragmatic Senior Engineer:** Core implementation files, test patterns, the 3 most complex files, error handling
- **Critical Reviewer:** Public API surface, edge case handling, everything the other panelists flagged as concerning

### Step 3: Launch Panelists (Parallel)

Launch 3 parallel reviews. Each gets:
1. Their complete persona (from the persona file — include the FULL text, not a summary)
2. The specific artifacts to read (listed explicitly — every file, every path)
3. The questions they need to answer (from their section above)
4. Project principles discovered in Step 0
5. A strict instruction: "Read EVERY artifact listed. Understand the structures, flow, and abstractions BEFORE judging."

**Panelist prompt structure:**

```
You are the [PANELIST ROLE]. [Include the COMPLETE persona file text below.]

[FULL PERSONA FILE CONTENT]

## PROJECT PRINCIPLES (non-negotiable)

These are the project's own rules. Evaluate everything against these FIRST.
Violations of these principles are the highest-priority findings.

[PRINCIPLES FROM STEP 0 — verbatim, not summarized]

## PROJECT CONSTRAINTS

[Any constraints discovered — e.g., "fresh project, no backward compatibility
concerns, local-only deployment"]

---

FIRST: Read every artifact listed below. Actually read them. Understand the
structures, the flow, the abstractions.

THEN: Give your brutally honest assessment. No hedging, no diplomacy.
Evaluate against the project's own principles above, not just general
engineering wisdom.

Do NOT default to "defer this." If the architecture requires something to
be correct, say it must be done. Only defer genuine optimizations that add
no architectural debt when postponed.

Artifacts to read (ALL of them, completely):
[ARTIFACT LIST]

Questions to answer:
[PANELIST-SPECIFIC QUESTIONS]

Be on your strictest, most uncompromising day.
Specifics with file references, not generalities.
```

### Step 4: Synthesize Convergence

After all panelists return, identify:

1. **Universal agreement** — issues ALL panelists flagged independently. Highest priority. When all three point at the same thing from different angles, that thing is definitively a problem.

2. **Majority agreement** (2 of 3) — strong signal, worth acting on.

3. **Unique insights** — things only one panelist caught. Valuable because they represent blind spots the other perspectives miss.

4. **Disagreements** — where panelists contradict each other. The most interesting findings because they reveal genuine trade-offs, not clear-cut problems.

### Step 5: Produce the Report

```markdown
# Expert Panel Review: [Focus Area]

## What All Panelists Agree On
[Numbered list — highest priority, act on these first]

## Scored Assessment (Technical Architect)
[Dimension scores table if applicable]

## Per-Panelist Findings

### Technical Architect
[Specific findings with artifact references]

### Pragmatic Senior Engineer
[Specific findings with artifact references]

### Critical Reviewer
[Specific findings with artifact references]

## Unique Insights
[Things only one panelist caught — organized by panelist]

## Disagreements
[Where panelists disagree — state both sides]

## Proposed Actions
[Concrete, prioritized list derived from convergence]
```

---

## Quality Principles

**Artifacts first, opinions second.** Every panelist reads source material before making claims. Assertions without evidence from the actual artifacts are not valid findings.

**Specific over general.** "The error handling needs work" is useless. "No retry logic for the database connection in db-handle.ts, and the error from line 42 is swallowed silently" is actionable.

**Convergence is signal.** One panelist's complaint might be taste. Three panelists' complaints are architecture.

**Disagreements are valuable.** When the Architect says "add an abstraction layer" and the Pragmatist says "just write it directly," that is a genuine trade-off worth surfacing, not a bug in the review process.

**No flattery.** The point is to find problems. If a panelist has nothing critical to say, their review is incomplete. Even the best work has trade-offs worth naming.

**Respect time.** The synthesis section (convergence + actions) is what gets acted on. The per-panelist sections are evidence to drill into. Structure accordingly.
