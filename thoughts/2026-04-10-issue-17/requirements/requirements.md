# Requirements: Cross-CLI Portable Skills System

## Task Description
Decouple skills from CLI-specific locations (`.claude/skills/`) so they work with any CLI tool The Engineer orchestrates. Skills should be portable, accessible from worktrees, and injected via the orchestrator's existing system prompt mechanism.

Source: GitHub Issue #17

## Gathered Context

### Current State

**Skills today** live in `.claude/skills/` — a Claude Code-specific directory. Claude Code's native skill system reads them automatically. This ties skills to one CLI tool, violating the Agent-Agnostic Protocol.

**Skills already copied to `resources/`**: A prior commit (`2d2cc88`) added `commit` and `expert-panel-review` skills to `resources/skills/`. The `resources/README.md` states these are "static artifacts shipped with The Engineer and copied to `~/.engineer/` at startup" and "resolved by path and read from disk." However, **no code loads or uses them yet** — they are inert files.

**Two skills in scope** (from `resources/skills/`):
1. `commit/SKILL.md` — commit strategy, grouping, message formatting
2. `expert-panel-review/SKILL.md` — multi-perspective code review through expert personas (with 3 persona files in `personas/`)

**Six skills in `.claude/skills/`** (4 are NOT in `resources/` and are NOT in scope): `investigate-project`, `skill-creator`, `system-layer-extraction`, `wrap-session`. These are development-time skills for the owner, not orchestrator-controlled skills.

### Architecture (How CLIs Are Controlled Today)

The orchestrator controls CLI tools through three levers:
1. **System prompt** — `buildCliNativeSystemPrompt(phase)` assembles identity + operating standards + RRPIR methodology + security boundary + phase guidance. Passed via `--system-prompt` flag.
2. **Phase prompt** — `buildXxxPrompt(ctx)` assembles task context, prior phase references, instructions. Passed via stdin.
3. **Working directory** — `cwd` set to the worktree path so CLI operates in the target repo.

The `InferenceRequest` schema has: `{ prompt, system_prompt, cwd, trace_output_path }`.

**Key insight**: The orchestrator already controls what the CLI knows via system prompt and phase prompt. Skills can be injected through this same mechanism — no CLI-specific registration needed.

### Three-Tier Architecture Constraints
- **Core** (orchestrator, task engine, etc.) never knows which plugins exist (Plugin Blindness)
- **Adapters** define stable contracts (`LLMAdapter.infer(InferenceRequest)`)
- **Plugins** implement adapters (ClaudeCodeLLM, GeminiCliLLM, OpencodeLLM)
- Skills injection belongs in **Core** (orchestrator prompt assembly) — it's CLI-agnostic by design

### Where Skills Would Be Injected

The prompt assembly pipeline:
1. `system.ts` → `buildCliNativeSystemPrompt(phase)` — identity, standards, methodology, phase guidance
2. Phase-specific builders (e.g., `execution.ts`) → task context, prior phases, instructions
3. Phase handlers in `phase-handlers.ts` → call `llmCaller.runPhaseWithCli(phase, taskId, systemPrompt, prompt, ...)`

Skills are phase-dependent:
- `commit` — relevant during execution, self-review, integration (phases where code is committed)
- `expert-panel-review` — relevant during self-review

### Skills Format

Skills are markdown documents with a consistent structure:
- Title and description
- Operational guidance (steps, decision trees, workflows)
- No metadata headers or frontmatter beyond what's in the markdown itself

They are **declarative instructions** — the CLI reads them and follows the guidance. They are not code.

## What Needs To Be Built

### 1. Skill Loading Mechanism
A module that:
- Reads skill files from a known location (likely `~/.engineer/resources/skills/` or the repo's `resources/skills/`)
- Returns skill content as strings, keyed by skill name
- Handles missing skills gracefully (warn, don't crash)

### 2. Skill-to-Phase Mapping
A configuration or convention that determines which skills are available in which phases:
- `commit` → execution, self-review, integration
- `expert-panel-review` → self-review
- Extensible for future skills

### 3. System Prompt or Phase Prompt Enhancement
Inject skill content into the prompts sent to CLIs:
- Either append to system prompt (via `buildCliNativeSystemPrompt`) 
- Or append to phase prompt (via phase-specific builders)
- Skills should be clearly delimited so the CLI can identify them

### 4. Remove `.claude/skills/` Dependency for In-Scope Skills
- The two in-scope skills (`commit`, `expert-panel-review`) should work via prompt injection, not `.claude/skills/`
- Other skills in `.claude/skills/` (owner's dev tools) are out of scope — leave them

### 5. Resource Installation (if needed)
- `resources/README.md` says files are "copied to `~/.engineer/` at startup"
- If this mechanism doesn't exist yet, it may need to be built
- **Alternative**: read directly from the repo's `resources/` directory at build/runtime — simpler, no copy step

### 6. Tests
- Skill loading: reads files, handles missing skills, returns correct content
- Phase-to-skill mapping: correct skills for correct phases
- Prompt assembly: skills appear in prompt output for relevant phases
- Integration: existing tests must pass

## Design Decisions to Make in Research/Planning

1. **Where to read skills from**: `resources/skills/` in the repo (simpler, available at build time) vs `~/.engineer/resources/skills/` (runtime, matches README.md claim). The repo path is simpler and avoids a copy mechanism.

2. **System prompt vs phase prompt**: Skills could go in either. System prompt is shared across all phases, so phase-specific skills would bloat phases that don't need them. Phase prompt is already phase-specific — better fit. But system prompt has the advantage of being a single injection point.

3. **Skill content embedding vs reference**: Embed full skill markdown into the prompt (larger prompts but self-contained) vs reference a file path the CLI can read (smaller prompts but depends on CLI file access). Embedding is more portable — the CLI doesn't need to know where skills live on disk.

## Edge Cases

- **Missing skill files**: Warn and continue. A missing skill shouldn't crash the pipeline.
- **Large skills**: `expert-panel-review` includes 3 persona files. All content needs to fit within prompt/context limits. Monitor token usage.
- **Process restart mid-operation**: Skills are stateless — just markdown read from disk. No cleanup needed.
- **Resource installation failure**: If using copy-to-`~/.engineer/`, handle startup failure. If reading from repo, this isn't an issue.
- **Skills not needed for a phase**: Don't inject them. Unnecessary token usage.

## Acceptance Criteria (from issue)

- [ ] Skills are accessible from any CLI running in any worktree
- [ ] Both starting skills are included and functional
- [ ] No CLI-specific registration (no `.claude/commands/`, no Codex equivalent)
- [ ] No `.gitignore` entries needed for skills
- [ ] System prompt communicates skill availability to the CLI
- [ ] Existing tests pass, new behavior has tests

## Assessment

**Ready to proceed.** The task is well-defined with clear acceptance criteria. The architecture is understood — the orchestrator already controls CLIs via system/phase prompts, and skills are just markdown content to inject. The main design decisions (where to read from, where to inject) are research/planning phase concerns with clear tradeoffs.

**Complexity: complex** — This touches Core prompt assembly, requires a new skill-loading module, affects multiple phases, needs phase-to-skill mapping, and requires tests across the prompt pipeline. Not a single-file change.

## Questions Asked
None — all unknowns were resolvable through codebase exploration.

## Team Contacts Referenced
None needed — requirements are clear from the issue and codebase.
