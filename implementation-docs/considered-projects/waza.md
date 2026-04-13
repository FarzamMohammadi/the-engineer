# Waza — Comparative Analysis

**Project:** [Waza](https://github.com/tw93/Waza) (MIT, 3,000+ stars)
**Analyzed:** 2026-04-13
**Purpose:** Understand where The Engineer stands relative to Waza on architecture, methodology, and design — and identify patterns worth adopting.

---

## 1. What Waza Is

Waza is a **curated collection of eight slash-command skills for Claude Code** that encode real engineering practices into structured, reproducible AI-assisted workflows. The name references the Japanese martial arts term for technique mastered through practice. It is NOT an autonomous agent, runtime, or orchestration system — it's a methodology toolkit that runs inside an existing AI CLI.

Created by Tw93, distilled from 300+ real development sessions and 500 hours of practice. Launched March 12, 2026; latest release v3.8.0 "Forge" (April 12, 2026). Extremely active — multiple commits/day, rapid iteration (v3.0.0 → v3.8.0 in one week).

### Architecture

Waza has no runtime architecture. It's a file tree of Markdown methodology documents, shell scripts, and Python utilities that Claude Code loads on demand:

```
skills/
├── think/SKILL.md              # Pre-implementation design validation
├── design/SKILL.md + refs/     # Frontend design with aesthetic commitment
├── check/SKILL.md + agents/    # Code review with specialist activation
├── hunt/SKILL.md               # Systematic debugging
├── write/SKILL.md + refs/      # Prose refinement (bilingual)
├── learn/SKILL.md              # Six-phase research methodology
├── read/SKILL.md + scripts/    # URL/PDF content extraction
└── health/SKILL.md + agents/   # Configuration audit
```

Each skill is self-contained: SKILL.md (core methodology, 3-6KB), optional `references/` (detailed anti-pattern catalogs, writing rules), optional `agents/` (specialist personas), optional `scripts/` (shell/Python execution).

### The Eight Skills

| Skill | Purpose | Key Pattern |
|-------|---------|-------------|
| `/think` | Pre-implementation design validation | 4 attack angles (dependency failure, scale explosion, rollback cost, premise collapse) |
| `/design` | Frontend UI with intentional aesthetic direction | Direction lock (5 questions before code), mid-build drift checks |
| `/check` | Post-task code review | Tiered depth (Quick/Standard/Deep), specialist reviewer activation, adversarial pass |
| `/hunt` | Systematic debugging | Root cause in one testable sentence before touching code |
| `/write` | Prose refinement | Language detection → bilingual rules (EN/ZH), AI slop detection |
| `/learn` | Research methodology | 6-phase pipeline (collect→digest→outline→fill→refine→self-review) |
| `/read` | Content extraction | Proxy cascade (defuddle→jina→web search→local), platform-specific routing |
| `/health` | Claude Code configuration audit | Six-layer stack analysis (CLAUDE.md→rules→skills→hooks→subagents→verifiers) |

### Tech Stack

| Component | Choice |
|-----------|--------|
| Primary language | Shell (68.5%) |
| Secondary language | Python (26.9%) |
| Build/test | Makefile + smoke tests |
| CI | GitHub Actions (ubuntu-latest, jq, ripgrep, python3) |
| Distribution | NPM-based skill installation (`npx skills add tw93/Waza`) |
| Platform | Claude Code, Codex (skill consumer, not standalone) |

### State Model

No formal state machine. Each skill defines implicit phase progression with approval gates:
- `/think`: draft → stress test → user approval → handoff (blocks execution)
- `/learn`: phase 1-6 with explicit "do not skip Phase 5" gates
- `/check`: scope verify → classify → hard stops → specialist review → autofix → verify → sign-off
- `/hunt`: hypothesis → signal validation → fix → confirmation

### Safety Model

Approval-gated, not autonomous. Hard stops block progression:
- `/think` rejects plans with TBD/TODO placeholders
- `/check` flags destructive auto-execution, missing credential validation, unknown identifiers
- `/hunt` rejects patches applied to symptoms without root cause
- `/health` asks confirmation before drafting fixes
- Statusline monitors context window usage and rate limits (color-coded thresholds)

### Current Maturity

| Metric | Value |
|--------|-------|
| Stars | 3,017 |
| Forks | 180 |
| Contributors | 2 (tw93: 236 commits, liby: 3 commits) |
| Open Issues | 1 |
| License | MIT |
| Latest | v3.8.0 (April 12, 2026) |
| Activity | Extremely active (daily commits) |

---

## 2. Direct Comparison

### Fundamental Identity

| Dimension | Waza | The Engineer |
|-----------|------|-------------|
| **Identity** | Methodology skill collection for an existing CLI | Full autonomous engineering agent |
| **What runs** | Nothing — Markdown loaded by Claude Code on demand | Daemon process with event bus, task engine, orchestrator |
| **Ambition** | Make AI-assisted development more rigorous | Replace a small engineering team |
| **Agency** | Human invokes skills manually (`/think`, `/check`) | System receives tasks, reasons through phases, ships PRs autonomously |
| **Scope** | 8 named practices for one developer | End-to-end task lifecycle: poll → intake → research → plan → execute → review → demo → integrate |
| **State** | Implicit phase gates within each skill | Formal state machine (7 states, 25 transitions, permission table) |
| **Persistence** | None (stateless between invocations) | SQLite (events, tasks, sessions, journal, checkpoints, knowledge) |

### Architecture

| Dimension | Waza | The Engineer |
|-----------|------|-------------|
| **Runtime** | No runtime — file tree consumed by host CLI | Daemon + 13 Core components + plugin ecosystem |
| **Components** | 8 SKILL.md files + reference docs + scripts | 9 Core + 5 Adapter types + swappable plugins |
| **Event system** | None | Core component (30 events, persistent, replayable, audit trail) |
| **Plugin model** | Marketplace skill registration (marketplace.json) | Formal plugin system: manifests, five-phase lifecycle, health state machine, capability gates |
| **Communication** | User reads terminal output | Multi-channel (GitHub comments + Telegram), fire-and-forget |
| **Database** | None | SQLite with WAL, 7 tables, migrations |
| **Testing** | Shell smoke tests, Makefile targets | Three-tier Vitest (1,437 unit + integration + E2E tests) |

### Workflow & Pipeline

| Dimension | Waza | The Engineer |
|-----------|------|-------------|
| **Task intake** | Human types `/think` | Daemon polls triggers, creates task in Intake state |
| **Research** | `/learn` (6-phase, human-driven) | Orchestrator research phase (LLM-driven, automated) |
| **Planning** | `/think` (2-3 options, attack angles) | Orchestrator planning phase (complexity-adaptive, LLM-generated) |
| **Execution** | Implied (no explicit skill) | Orchestrator execution phase with tool adapter through action pipeline |
| **Review** | `/check` (tiered depth, specialist reviewers) | Orchestrator self-review phase + two-stage PR (draft→ready) |
| **Debugging** | `/hunt` (hypothesis-first, root cause) | No explicit debugging methodology |
| **Demo** | Not addressed | Demo-prep phase + draft PR as demo gate |
| **Integration** | Not addressed | Integration phase + progressive merge policy |
| **Decomposition** | Not addressed | Parent-child hierarchy, dependency DAG, supervised decomposition |

### Safety & Authorization

| Dimension | Waza | The Engineer |
|-----------|------|-------------|
| **Authorization model** | Human approval at phase gates | Two-gate Action Pipeline (Task Engine state + Safety Layer policy) |
| **Cost control** | Statusline monitoring (context %, rate limits) | Per-task cost tracking with snapshots, autonomy verdicts, budget limits |
| **Scope enforcement** | Each skill documents "not for" boundaries | Phase-determines-allowed-actions state machine (failsafe) |
| **Destructive op guard** | `/check` hard stops | Safety Layer evaluateAction + Git worktree isolation |
| **Audit trail** | None | Event Bus (every action persisted, replayable) |

---

## 3. Architectural Analysis

### What Waza Does Well

1. **Methodology specificity within phases.** Each skill doesn't just name a phase — it encodes the exact decision criteria, failure modes, and hard stops for that phase. `/think` has four specific attack angles (dependency failure, scale explosion, rollback cost, premise collapse). `/hunt` requires root cause stated as one testable sentence with file:line specificity. `/check` classifies diffs into three tiers with different reviewer activation. This is the difference between "we have a planning phase" and "here's exactly how planning works, what quality looks like, and when to reject."

2. **Adversarial analysis as a first-class concern.** The `/check` skill activates an adversarial pass for deep diffs: assumption violations, composition failures, cascade scenarios, abuse cases. This isn't linting or compliance — it's active threat modeling applied to every significant code change. Security and architecture reviewers are separate personas with distinct evaluation criteria.

3. **Anti-pattern catalogs as operational reference.** `design-reference.md` (17KB) names specific failures: border-left oversizing, `background-clip: text` gradients, generic rounded-rect cards, 26 fonts to reject. `write-en.md` names specific prose anti-patterns: negative parallelism, rhetorical questions with answers, dramatic fragmentation. These aren't vague guidelines — they're executable checklists.

4. **Rationalization trap detection.** `/hunt` flags phrases like "I'll just try this" and "one more restart" as rationalization signals. `/check` flags "should work now," "probably correct," "trivial change" as insufficient reasoning. These are meta-rules that guard against overconfidence — catching the psychological failure mode, not just the technical one.

5. **Bilingual quality enforcement.** Parallel Chinese and English documentation with different strategies per language (write-zh.md is 26KB vs. write-en.md at 9KB). Not translation — genuine cultural adaptation of quality standards.

6. **Scope discipline.** Each skill explicitly documents what it is NOT for. `/think` is not for code. `/check` is not for debugging. `/health` is not for code review. This prevents misapplication and keeps each practice focused.

### What The Engineer Does That Waza Cannot

1. **Autonomous task execution.** The Engineer receives tasks, reasons through seven phases, and ships PRs without human intervention. Waza requires a human to invoke each skill at the right time. This is the fundamental categorical difference — Waza is a methodology; The Engineer is an agent.

2. **Persistent state and audit trail.** Every action, decision, and transition is persisted in SQLite via the Event Bus. Tasks have formal lifecycle with 25 transitions. Sessions have checkpoints for resumption. Waza is stateless — nothing persists between skill invocations.

3. **Task decomposition and orchestration.** The Engineer decomposes complex tasks into parent-child hierarchies, manages dependencies, coordinates sequential execution, and aggregates results. Waza operates on one skill at a time with no task hierarchy.

4. **Safety as a runtime system.** The Engineer's Safety Layer is a pipeline middleware with active policy evaluation, cost tracking, and autonomy verdicts — enforced at execution time, not by convention. Waza relies on the human to respect hard stops.

5. **Multi-channel communication.** The Engineer proactively notifies via GitHub comments and Telegram at five trigger points (pickup, PR created, completion, error, cost limit). Waza produces terminal output for the developer sitting at the keyboard.

6. **Git worktree isolation.** Each task gets an isolated worktree — real filesystem isolation, not just a convention. Waza has no execution isolation model.

7. **Learning across tasks.** Session/Memory stores knowledge entries with content-hash upsert and per-repo isolation. Journal tracks decisions for observability. Waza starts fresh every invocation.

---

## 4. Patterns Worth Adopting

### 1. Attack Angles Framework for Planning

**What:** `/think`'s four stress tests applied to every design before approval: (1) dependency failure — what degrades gracefully vs. catastrophically? (2) scale explosion — what breaks at 10x? (3) rollback cost — how hard is state recovery? (4) premise collapse — what if core assumptions are wrong?

**Why it matters:** The Engineer's planning phase generates plans via LLM, but doesn't systematically stress-test them against specific failure categories. Attack angles would catch fragile plans before execution begins.

**Integration path:** Add attack angle evaluation to `src/core/orchestrator/prompts/planning.ts`. After the LLM generates a plan, the planning phase prompt could include a stress-test section requiring the LLM to evaluate the plan against these four dimensions. Plans that fail any dimension get flagged for revision before transitioning to execution.

### 2. Tiered Review Depth with Specialist Activation

**What:** `/check` classifies diffs as Quick (<100 lines), Standard (100-500), or Deep (500+). Quick gets baseline review only. Standard activates security and architecture reviewers. Deep adds an adversarial pass. Specialists are separate personas with distinct evaluation criteria.

**Why it matters:** The Engineer's self-review phase runs the same depth regardless of change scope. A one-line bug fix gets the same review as a 500-line refactor, wasting context and time on trivial changes while potentially under-reviewing complex ones.

**Integration path:** Add scope classification logic to `src/core/orchestrator/prompts/self-review.ts`. Classify the diff size and sensitivity, then adjust the self-review prompt to activate appropriate specialist perspectives. The adversarial pass (assumption violations, composition failures, cascade scenarios, abuse cases) maps directly into the existing self-review quality gate.

### 3. Rationalization Trap Detection

**What:** Meta-rules that flag phrases indicating overconfidence: "should work now," "probably correct," "trivial change," "I'll just try this," "one more restart." If these appear in reasoning, force expanded verification before proceeding.

**Why it matters:** LLMs (and humans) exhibit overconfidence after making changes. The Engineer's self-review could rubber-stamp its own execution phase output without genuine critical evaluation. This is a psychological failure mode that technical testing alone doesn't catch.

**Integration path:** Add a rationalization check to the self-review loopback logic in `src/core/orchestrator/orchestrator.ts` (the `checkSelfReviewLoopback` helper). If the self-review output contains confidence markers without evidence, trigger the loopback (needs_work → execution) regardless of the LLM's stated verdict.

### 4. Anti-Pattern Catalogs as Prompt Reference

**What:** Waza maintains detailed reference documents (design-reference.md at 17KB, write-en.md at 9KB, persona-catalog.md) that name specific failures, forbidden patterns, and quality thresholds. These aren't guidelines — they're executable checklists loaded into context when relevant.

**Why it matters:** The Engineer's prompts in `src/core/orchestrator/prompts/` provide structure and context but lack the specificity of named anti-patterns. "Review the code for issues" is weaker than "check for these 15 specific failure modes."

**Integration path:** Build anti-pattern catalogs as reference documents (e.g., `src/core/orchestrator/prompts/references/security-patterns.md`, `architecture-patterns.md`). Load relevant catalogs into self-review and planning prompts based on the task type. Start with the patterns Waza documents (security reviewer traces, architecture coupling checks) and grow organically from real task failures.

### 5. Root-Cause-First Debugging Methodology

**What:** `/hunt` requires stating the root cause as "one testable sentence" with file:line specificity before writing any fix. Same symptom after fix = hypothesis was wrong, restart diagnosis. Three failed hypotheses = surface findings to human.

**Why it matters:** The Engineer has no explicit debugging methodology. When execution-phase code changes cause test failures, the system currently loops (self-review → execution) without a structured debugging approach. Without root-cause discipline, it can apply symptomatic patches that introduce new bugs.

**Integration path:** When `checkSelfReviewLoopback` triggers a needs_work → execution loop, inject `/hunt`-style methodology into the execution prompt: require hypothesis formation, signal validation, and root cause confirmation before applying fixes. Track loop count — three loops without resolution should escalate to human (aligns with existing max-3 loopback limit).

### 6. Evidence-Based Progression Gates

**What:** Waza blocks phase progression without evidence. `/learn` Phase 5 is mandatory before publishing. `/think` requires zero TBD/TODO placeholders before approval. `/hunt` requires "progress signals" (matching logs, predictable next errors) before declaring a fix.

**Why it matters:** The Engineer's state machine enforces valid transitions, but phase completion is currently determined by the LLM's output parsing, not by evidence verification. A planning phase could "complete" with vague plans; an execution phase could "complete" with untested code.

**Integration path:** Strengthen phase transition logic in `processPhaseCompletion()`. Add validation that phase outputs contain required evidence — e.g., planning output must not contain placeholder language; execution output must reference test results; self-review must include specific file:line citations for findings.

---

## 5. Where We Stand

Waza and The Engineer are in **fundamentally different categories**. Waza is a methodology toolkit — a set of practices that make a human developer more rigorous when using AI. The Engineer is an autonomous agent that performs those practices itself. The relationship is closer to "cookbook vs. chef" than "competitor vs. competitor."

That said, Waza's methodology depth is genuinely impressive. Where The Engineer has sophisticated runtime infrastructure (event bus, state machine, action pipeline, safety layer), Waza has sophisticated process knowledge (attack angles, adversarial analysis, rationalization traps, anti-pattern catalogs). The Engineer has the machinery to act; Waza has the judgment to act well.

The highest-value adoption is bringing Waza's methodology specificity into The Engineer's phase prompts. The Engineer already has the infrastructure for phase transitions, quality gates, and loopback — what it needs is the detailed "here's what good planning/review/debugging actually looks like" that Waza encodes.

### Summary: What Waza Contributes to Our Thinking

| Pattern | Value | Integration Path |
|---------|-------|-----------------|
| Attack angles for planning | High | Add stress-test section to planning prompts |
| Tiered review depth | High | Scope classification in self-review prompts |
| Rationalization trap detection | High | Meta-rules in self-review loopback logic |
| Anti-pattern reference catalogs | High | Reference docs loaded into phase prompts |
| Root-cause-first debugging | Medium-High | Inject methodology into execution loopback prompts |
| Evidence-based progression gates | Medium | Strengthen phase output validation |
| Multi-layer safety audit framework | Medium | Verify safety rules exist at intent+knowledge+control layers |
| Bilingual quality enforcement | Low (for now) | Relevant if internationalizing |

### The Fundamental Difference

Waza trusts the human to invoke the right skill at the right time and to respect hard stops. The Engineer removes the human from the loop — the Daemon polls, the Orchestrator reasons, the Safety Layer enforces, and the Event Bus audits. Waza's insight is that process rigor matters as much as runtime sophistication. The Engineer's insight is that process rigor can be encoded into an autonomous system. The strongest version of The Engineer would have both: the runtime to act independently AND the methodology depth to act well.
