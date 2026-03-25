---
name: investigate-project
description: "Perform end-to-end investigation, analysis, and comparative review of an external open-source project against The Engineer. Use this skill whenever the user wants to analyze, investigate, review, or compare an external project, GitHub repository, or open-source tool. Also trigger when the user mentions adding to considered-projects, doing a competitive analysis, or evaluating whether a project has ideas worth adopting. Takes a GitHub URL as input."
argument-hint: <github-url>
---

# Investigate Project

Perform a thorough, multi-perspective investigation of an external open-source project and produce a comparative analysis document against The Engineer. The output matches the established format in `implementation-docs/considered-projects/`.

The goal is an honest, thorough analysis — not marketing. We want to understand what the project actually is (not what it claims to be), what it does well, what The Engineer does better, and what patterns are worth adopting. The document should be useful months later as a reference for architectural decisions.

---

## Step 1: Understand the Format

Read 1-2 existing analyses from `implementation-docs/considered-projects/` to internalize the established structure and tone. These are the gold standard — match their depth, honesty, and table-driven comparison style.

The standard structure is:
1. **What [Project] Is** — honest description of what's actually built (not what the README claims)
2. **Direct Comparison** — table-driven comparison across all relevant dimensions
3. **Architectural Analysis** — what they do well, what The Engineer does better
4. **Patterns Worth Studying/Adopting** — concrete ideas that could improve The Engineer
5. **Where We Stand** — honest assessment with summary tables

---

## Step 2: Launch Parallel Research

Launch 3 Explore sub-agents simultaneously, each with a distinct research focus. Every agent should use WebFetch to read actual file contents from the repository — not just README summaries.

### Agent 1: Broad Overview + Technical Architecture
Research focus:
- What is this project? What problem does it solve?
- What's actually built vs. what's just documentation/prompts?
- Read the actual source code — entry points, core modules, key classes
- Tech stack, dependencies, package.json/requirements.txt
- How mature is it? (stars, contributors, release history, recent activity)
- Testing approach — read actual test files, understand coverage and quality
- What's the deployment model? Library, CLI, daemon, service?

### Agent 2: Methodology, Workflow & Design Patterns
Research focus:
- How does the project structure its workflow/pipeline?
- What phases/stages does it define? How do they compare to The Engineer's 7-phase pipeline?
- State management — formal state machine? Ad-hoc? None?
- How does it handle task lifecycle, decomposition, review?
- Safety model — authorization, cost control, scope boundaries
- Plugin/extensibility architecture — contracts, discovery, lifecycle
- Communication model — how does it interact with users/systems?

### Agent 3: Novel Ideas & Applicability to The Engineer
Research focus:
- What unique or novel concepts does this project introduce?
- Read explanation docs, design docs, architecture docs in detail
- For each novel idea: how does it compare to The Engineer's current approach?
- Could any patterns improve The Engineer's RRPIR pipeline, review phases, decomposition, or prompt architecture?
- What about their memory/learning system, context management, or error handling?
- Are there anti-patterns or known failures that validate The Engineer's choices?

Tell each agent to be thorough — read actual file contents via WebFetch, not just directory listings. Substance over summaries.

---

## Step 3: Synthesize the Analysis

Once all agents return, synthesize their findings into a single comprehensive document. This is where the real work happens — don't just concatenate agent outputs.

### Synthesis principles:
- **Be honest about what's actually built.** If the project is mostly prompt templates, say so. If it has sophisticated runtime orchestration, acknowledge it. Read the code, not just the marketing.
- **Identify the categorical relationship.** Is this a competitor? A complementary tool? A framework we could build on? Something in a completely different category? Frame the comparison accordingly.
- **Tables over prose for comparisons.** Dimension-by-dimension tables are scannable and honest. Use them for every major comparison section.
- **Concrete over abstract for patterns.** When identifying patterns worth adopting, describe what they are, why they matter, and how they'd integrate into The Engineer's architecture. Include file paths and component names.
- **Acknowledge genuine strengths.** Every project does something well. Find it and explain it clearly, even if The Engineer's approach is stronger overall.

### Writing the document:

**Section 1: What [Project] Is**
- Lead with what the project actually IS in one clear sentence
- Describe the real architecture (what code exists, what runs at runtime)
- List core components with what each does
- Tech stack table
- State model (or lack thereof)
- Safety model (or lack thereof)
- Current maturity and activity

**Section 2: Direct Comparison**
- Start with the fundamental identity difference (table)
- Architecture comparison (table)
- Workflow/pipeline comparison (table)
- Safety & authorization comparison (table)
- Technology comparison (table)
- Any domain-specific comparisons that are relevant

**Section 3: Architectural Analysis**
- "What [Project] Does Well" — numbered list with genuine analysis. Explain WHY each thing is good and whether The Engineer has an equivalent.
- "What The Engineer Does Better" (or "What The Engineer Does That [Project] Cannot" if they're in different categories) — numbered list explaining the structural advantages.

**Section 4: Patterns Worth Adopting**
- Numbered list of concrete patterns with:
  - What the pattern is
  - Why it matters
  - How it would integrate into The Engineer's existing architecture
- Only include patterns that are genuinely useful — not everything novel is worth adopting

**Section 5: Where We Stand**
- Honest assessment paragraph (no cheerleading, no false modesty)
- Summary table: "What [Project] Contributes to Our Thinking" with Value and Integration Path columns
- Closing paragraph on the fundamental difference

---

## Step 4: Write the Document

Write the final document to `implementation-docs/considered-projects/<project-name>.md`.

Use kebab-case for the filename derived from the project name (e.g., `bmad-method.md`, `openclaw.md`).

Include the header:
```markdown
# [Project Name] — Comparative Analysis

**Project:** [Project Name](GitHub URL) (license, stars)
**Analyzed:** YYYY-MM-DD
**Purpose:** Understand where The Engineer stands relative to [Project Name] on architecture, technology, and design.

---
```

---

## Quality Checklist

Before finishing, verify:
- [ ] Document reads as an honest technical analysis, not a sales pitch for The Engineer
- [ ] Every claim about the external project is based on actual code/docs read, not assumptions
- [ ] Tables are used for all major comparisons (scannable, not buried in prose)
- [ ] Patterns worth adopting include concrete integration paths (component names, file references)
- [ ] The categorical relationship is clearly stated upfront
- [ ] Both strengths and limitations of The Engineer are acknowledged where relevant
- [ ] Format matches existing analyses in `implementation-docs/considered-projects/`
