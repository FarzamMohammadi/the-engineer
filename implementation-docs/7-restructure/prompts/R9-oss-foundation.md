# Phase R9: OSS Foundation

**Wave 4 (Parallel)** — Can run alongside R10.
**Branch:** `layer7/R9`
**Scope:** Root-level files and docs/ only. No changes to `src/`.

---

## Context

The Engineer is an autonomous software engineering agent — a fully self-directed system that receives tasks (via GitHub issues), researches codebases, plans solutions, executes changes, self-reviews, and ships PRs. It is built on a three-tier architecture (Core / Adapter / Plugin) with TypeScript, Node.js 22, SQLite, and a modular plugin system.

The project is approaching its first public release. All implementation is complete through Layer 6 (1,733+ tests). Layer 7 is a structural restructuring pass. This phase (R9) establishes the open-source foundation: community files, templates, and documentation that make the project welcoming, clear, and professional.

**Philosophy:** Read `docs/philosophy.md` — especially "Open Source for All" and "Documentation as Product." Every document earns its existence by saving someone time or preventing a mistake. The project demands extreme reliability, trustworthiness, clear documentation, configurable safety, and no vendor lock-in.

**Persona:** Read `docs/persona.md` — The Engineer is "the 100,000x engineer." Documentation should reflect this standard: precise, no fluff, actionable.

---

## Pre-Work: Read These Files

Before writing anything, read and understand:

1. `docs/persona.md` — project identity
2. `docs/philosophy.md` — core beliefs (especially "Open Source for All," "Documentation as Product," "Modular Everything")
3. `README.md` — current project overview
4. `implementation-docs/7-restructure/assessment.md` — the DX gaps that motivate this phase
5. `implementation-docs/1-system/architecture-tiers.md` — three-tier model
6. `implementation-docs/1-system/overview.md` — component overview
7. `implementation-docs/4-implementation/foundation.md` — tech stack decisions
8. `implementation-docs/4-implementation/plugins.md` — plugin system design
9. `implementation-docs/4-implementation/layout.md` — project layout
10. `implementation-docs/3-interactions/adapter-contracts.md` — adapter types (Trigger, Communication, LLM, Tool, GitHosting)
11. `package.json` — current dependencies and scripts
12. `src/adapters/` — adapter base classes (understand the SDK boundary)
13. `src/plugins/` — existing plugin implementations (understand the pattern)

---

## Deliverables

### 1. CONTRIBUTING.md (11 sections)

Create `CONTRIBUTING.md` at the project root. Sections:

1. **Welcome** — Brief, warm intro. Link to Code of Conduct. Mention that contributions of all sizes matter.
2. **Development Setup** — Prerequisites (Node.js 22, pnpm, git), clone, install, build, test commands. Copy-pasteable.
3. **Project Structure** — Brief tour of `src/` (core/, adapters/, plugins/, schemas/, cli/, config/, db/, dashboard/, utils/). Reference `implementation-docs/` for deep architecture docs.
4. **Running Tests** — Three tiers (unit, integration, e2e). Commands for each. Coverage expectations (70/55 from testing.md Decision #119).
5. **Code Style** — Biome for linting+formatting. No ESLint/Prettier. `pnpm lint` and `pnpm format` commands. Mention the "all" preset with specific exceptions.
6. **Commit Conventions** — Describe the commit style used in the project (look at `git log` for the actual pattern). Keep it simple.
7. **Pull Request Process** — Fork, branch, small focused PRs, tests required, description template reference.
8. **Writing Plugins** — Brief intro, link to `docs/plugin-development.md` for full guide.
9. **Reporting Bugs** — Link to issue template. What to include (reproduction steps, environment, expected vs actual).
10. **Suggesting Features** — Link to feature request template. Emphasize alignment with project philosophy.
11. **Getting Help** — Where to ask questions (issues, discussions if enabled).

### 2. .github/ISSUE_TEMPLATE/bug_report.md

GitHub issue template for bug reports. Use YAML front matter (`name`, `description`, `labels`, `assignees`). Sections:

- Description (what happened)
- Steps to reproduce (numbered)
- Expected behavior
- Actual behavior
- Environment (Node version, OS, The Engineer version)
- Logs/screenshots (optional)
- Additional context (optional)

### 3. .github/ISSUE_TEMPLATE/feature_request.md

GitHub issue template for feature requests. YAML front matter. Sections:

- Problem statement (what problem does this solve)
- Proposed solution
- Alternatives considered
- Additional context
- Alignment with philosophy (which principle from `docs/philosophy.md` does this support)

### 4. .github/PULL_REQUEST_TEMPLATE.md

PR template. Sections:

- Summary (what and why)
- Changes (bulleted list)
- Testing (how was this tested)
- Checklist (tests pass, lint clean, docs updated if needed, no secrets committed)

### 5. CODE_OF_CONDUCT.md

Use the Contributor Covenant v2.1. Standard text. Specify enforcement contact (use a placeholder email like `conduct@the-engineer.dev` with a comment that it should be updated).

### 6. CHANGELOG.md

Create with keep-a-changelog format (https://keepachangelog.com/). Include:

- Header explaining the format and that the project adheres to Semantic Versioning
- An `[Unreleased]` section
- Subsection categories: Added, Changed, Deprecated, Removed, Fixed, Security
- Populate `[Unreleased]` with a summary of the current state: "Initial implementation complete through Layer 6. All core components, adapter system, plugin implementations, CLI, dashboard, and 1,733+ tests."

### 7. docs/architecture.md

High-level architecture documentation with Mermaid diagrams. This is the public-facing architecture overview. Sections:

1. **Overview** — What The Engineer is, how it works at a high level (receives task, researches, plans, executes, reviews, ships).
2. **Three-Tier Architecture** — Core / Adapter / Plugin tiers explained. Mermaid diagram showing the tiers and their relationships.
3. **Core Components** — Brief description of each: EventBus, TaskEngine, SafetyLayer, ActionPipeline, SessionMemory, WorkspaceManager, Orchestrator, Daemon, Registry, PeopleDirectory. Mermaid diagram showing component relationships and data flow.
4. **Task Lifecycle** — The 7-phase pipeline (intake_analysis through integration). Mermaid state diagram.
5. **Task State Machine** — States (intake, queued, active, blocked, review_pending, done, failed, cancelled) with sub-states. Mermaid state diagram. Reference `implementation-docs/1-system/task-states.md` for the CPU-derived model.
6. **Plugin System** — How plugins implement adapters, manifest format, five-phase loading. Brief example.
7. **Event Bus** — Pub/sub with persistence, replay for state reconstruction, glob pattern subscriptions.
8. **Safety Model** — Two gates (Task Engine permission + Safety Layer policy), cost tracking, autonomy levels.
9. **Further Reading** — Links to `implementation-docs/` for detailed design docs, `docs/plugin-development.md` for plugin creation.

Use Mermaid diagrams liberally. At least 4 diagrams (tier overview, component relationships, task lifecycle, state machine). Keep text concise — this is a reference, not a tutorial.

### 8. docs/plugin-development.md

Guide for creating custom plugins. Sections:

1. **Introduction** — What plugins are, how they fit in the architecture (implement adapter contracts).
2. **Adapter Types** — The 5 types (TriggerAdapter, CommunicationAdapter, LLMAdapter, ToolAdapter, GitHostingAdapter) with brief descriptions of what each does. Reference `src/adapters/` for base classes.
3. **Plugin Manifest** — `engineer.plugin.yaml` format. Show a complete example manifest with all fields explained.
4. **Creating a Plugin** — Step-by-step:
   - Create directory under `src/plugins/{adapter-type}/{plugin-name}/`
   - Create manifest YAML
   - Extend the appropriate adapter base class
   - Implement required abstract methods
   - Handle configuration via `onInit(config)`
   - Implement `doHealthCheck()`
   - Implement `onShutdown()`
5. **Example Plugin** — Walk through creating a simple TriggerAdapter plugin (e.g., a cron-based trigger or file-watcher trigger). Show complete code.
6. **Testing Your Plugin** — How to use the contract compliance suites from `test/helpers/contract-suites/`. Show how to import and call `runXxxContractSuite()`.
7. **Configuration** — How plugin config is resolved via Registry's `configResolver` callback. Where config lives in the YAML config hierarchy.
8. **Lifecycle** — The 5 phases (discover, validate, order, load, initialize). Health state machine (healthy/unhealthy/failed). What happens at each phase.
9. **Best Practices** — Error handling (use `createAdapterError()`), capability declaration, side effect reporting for tools, graceful shutdown.

For code examples, look at existing plugins in `src/plugins/` to ensure accuracy. Reference the actual abstract method signatures from `src/adapters/`.

---

## Constraints

- **No `src/` changes.** This phase is root-level and docs/ only.
- **Accuracy matters.** Every code example, command, and file path must be verified against the actual codebase. Read the real source before writing examples.
- **No fluff.** Every sentence earns its place. Follow "Documentation as Product" from the philosophy.
- **Link, don't duplicate.** Reference `implementation-docs/` for deep details. These docs are the public-facing layer.

---

## Verification Steps

After creating all files:

1. **File existence** — Verify all 8 files exist at their correct paths:
   - `CONTRIBUTING.md`
   - `.github/ISSUE_TEMPLATE/bug_report.md`
   - `.github/ISSUE_TEMPLATE/feature_request.md`
   - `.github/PULL_REQUEST_TEMPLATE.md`
   - `CODE_OF_CONDUCT.md`
   - `CHANGELOG.md`
   - `docs/architecture.md`
   - `docs/plugin-development.md`

2. **No src/ changes** — Run `git diff --name-only` and confirm no files under `src/` are modified.

3. **Mermaid syntax** — Verify all Mermaid diagrams in `docs/architecture.md` use valid syntax (check for common errors: missing `end`, unclosed brackets, invalid arrow syntax).

4. **Code examples accuracy** — Every code snippet in `docs/plugin-development.md` must reference real class names, method signatures, and types from the codebase. Verify against `src/adapters/` and `src/plugins/`.

5. **Links validity** — All internal links (to other docs, to source files) must point to real paths.

6. **CONTRIBUTING.md commands** — Every shell command in CONTRIBUTING.md must actually work. Verify against `package.json` scripts.

7. **Tests still pass** — `pnpm test` passes (no regressions from doc-only changes).

8. **Lint clean** — `pnpm lint` passes.

9. **Typecheck clean** — `pnpm typecheck` passes (if applicable — doc-only changes shouldn't affect this, but verify).

10. **Git status** — Only the expected files appear as new/modified.

---

## Commit

When complete, commit on branch `layer7/R9` with message:

```
R9: Add OSS foundation files

CONTRIBUTING.md, issue/PR templates, CODE_OF_CONDUCT.md,
CHANGELOG.md, docs/architecture.md, docs/plugin-development.md
```
