---
name: system-layer-extraction
description: "Deep architectural investigation that extracts, documents, and maps every system in a codebase. Use this skill whenever the user asks to: extract layers, map systems, analyze architecture, investigate codebase structure, document system boundaries, create a system map, understand how systems relate, audit dependencies, assess isolation, or do any form of comprehensive architectural analysis. Also trigger when the user says things like 'I want to see all the layers', 'map out the systems', 'what are the moving parts', 'how is this structured', or 'give me the full picture of the architecture'. This is NOT for reviewing code quality or individual files — it's for understanding the full system topology."
---

# System Layer Extraction

Investigate an entire codebase file-by-file to extract every system, map their boundaries, dependencies, state, lifecycle, and isolation potential. Produce a comprehensive layered architecture document and interactive visualization.

This is slow, thorough work. The value comes from reading actual source code — not READMEs, not architecture docs, not summaries. Every file gets read. Every import gets traced. The output is a document that makes the invisible structure visible.

---

## Why This Matters

Codebases accumulate structure over time that nobody fully sees. Systems intertwine. Dependencies form that aren't in any diagram. State gets shared in ways the original authors didn't intend. This skill makes all of that explicit — so you can refactor with confidence, onboard new contributors faster, and identify where isolation is strong vs where it's fragile.

---

## The Process

### Step 1: Set Up

Create a working branch so the output files don't pollute the main branch:

```bash
git checkout -b system-layer-extraction
```

### Step 2: Map the Territory

Before reading any code, get the full picture of what exists:

```bash
# All non-test source files, sorted
find src -name "*.ts" ! -name "*.test.ts" ! -name "*.spec.ts" | sort

# All source directories
find src -type d | sort

# Line counts per directory (rough sizing)
find src -name "*.ts" ! -name "*.test.ts" | xargs wc -l | sort -n
```

This gives you the raw material: how many files, how they're organized, where the mass is.

### Step 3: Group Files Into Investigation Areas

Divide all source files into 5-8 logical groups based on directory structure and apparent concern. Each group becomes one subagent's assignment. Typical groupings:

- **Entry points + CLI + Bootstrap** — how the system starts, wires, and presents to users
- **Communication infrastructure** — event bus, observer/logging, streaming
- **Core domain services** — task engine, safety, authorization, memory, workspace
- **Intelligence/orchestration** — the brain, phase pipeline, prompts, LLM interaction
- **Plugin ecosystem** — adapters, registry, hooks, concrete plugin implementations
- **Data layer** — database, config, schemas, migrations
- **UI/Dashboard** — if present, the monitoring/visualization layer
- **Cross-cutting** — utilities, shared types, interfaces

### Step 4: Deep Investigation (Parallel Subagents)

Launch Explore subagents in parallel (batches of 3-5). Each subagent gets:
- A specific list of files to read (ALL of them, completely — not summaries)
- A reporting template (below)

**Subagent prompt template:**

```
You are investigating [AREA NAME] of a codebase. Your job is to do a VERY THOROUGH
analysis. For EACH file listed below, you MUST read the ENTIRE file. Then produce a
detailed report.

Files to read (ALL of them, completely):
[LIST EVERY FILE]

For EACH system you find, report:
1. Purpose: What is this system's core responsibility?
2. Public API: What does it export? What functions/classes are the entry points?
3. Internal structure: How is it decomposed? What are the sub-modules?
4. Dependencies: What other systems does it import from? List every import from
   outside its own directory.
5. Dependents: What imports this system?
6. State: What state does it manage? Singletons, globals, caches?
7. Lifecycle: When does it start/stop? Long-lived or short-lived?
8. Cross-cutting concerns: Logging, error handling, event emission patterns?
9. Smells or concerns: Anything misplaced, doing too much, or tightly coupled?

Be extremely thorough. Read every file completely.
```

### Step 5: Cross-System Analysis (Additional Subagents)

After the per-area investigations return, launch 1-2 more subagents focused on cross-cutting concerns:

**Dependency mapping subagent:** For every directory, grep all imports that reference files outside that directory. Map who imports from whom. Build the full import graph.

**Shared state subagent:** Search for: global variables, singletons, module-level mutable state, shared database tables (which systems read/write the same tables), shared event types (who publishes vs subscribes to what), any circular import chains.

### Step 6: Synthesize the Document

Take ALL subagent findings and produce a single comprehensive document. Structure:

```markdown
# [Project Name] — System Layer Specification

## 1. System Map (Overview)
- ASCII/text diagram showing all systems organized by layer
- Layer hierarchy from foundation (no deps) to interface (depends on everything)
- Total counts: systems, layers, files, tests

## 2. Per-System Deep Analysis
For each system (ordered by layer, bottom-up):
- **Files** (table: file | purpose)
- **Public API** (key exports, methods, factories)
- **Dependencies** (what it imports from outside its directory)
- **Dependents** (what imports it)
- **State** (what mutable state it manages)
- **Lifecycle** (when created, how long it lives, shutdown behavior)
- **Isolation Assessment** (score 1-10 with reasoning)
- **Concerns** (specific issues found)

## 3. Cross-System Dependency Graph
- Text diagram showing system-to-system dependencies
- Categorized by type: direct import, event bus, shared DB, etc.

## 4. Shared State Analysis
- Global mutable state inventory
- Shared DB table map (table → exclusive writer → readers)
- Event pub/sub map (event → publishers → subscribers)

## 5. Circular Dependency Audit
- Result (found / not found)
- If found: the specific chains

## 6. Isolation Assessment
- Table: system | score | blocking issues
- Extraction readiness ranking

## 7. Architectural Strengths
- What's genuinely good (be specific, reference files)

## 8. Architectural Concerns
- Categorized: layer violations, duplication, missing abstractions,
  information loss, operational risks, dead/unused code
- Table: issue | severity | location
```

### Step 7: Create the Visualization

Produce a self-contained HTML file (`system-layers-visual.html`) that visualizes the architecture:

- Layers as rows, systems as interactive boxes within each layer
- Click a system to see: description, public API, events published, dependencies (highlighted), dependents (highlighted), files, concerns
- Unrelated systems dim when one is selected
- Flow indicators between layers showing integration patterns
- Stats (system count, file count, dependency count, etc.)
- Dark theme, clean typography, responsive

The HTML should be fully self-contained (inline CSS/JS, no external dependencies).

### Step 8: Commit

```bash
git add [output files]
git commit -m "Add system layer specification with N extracted systems"
```

---

## Quality Principles

**Read every file.** Subagents must read actual source code, not descriptions or summaries. A system analysis based on file names and directory structure is useless. The value is in what the code actually does, not what it's named.

**Trace every import.** Dependencies aren't obvious from directory structure. A file in `core/workspace-manager/` might import from `core/orchestrator/` — that's a layer violation you'd never find without reading imports.

**Score isolation honestly.** A system that imports from 2 other systems and is imported by 1 is more extractable than one that imports from 8 and is imported by 12. The score should reflect this. 10/10 means "could be a separate package today with zero changes." 5/10 means "tightly coupled, extraction would require significant refactoring."

**Include what's good AND what's bad.** Architecture analysis that only finds problems is useless for prioritization. Name the strengths so they're protected during refactoring.

**Be specific.** "The error handling could be improved" is worthless. "9 separate error files with no common hierarchy — retry logic in llm-caller.ts matches errors by substring instead of error code" is actionable.
