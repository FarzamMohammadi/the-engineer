# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project will adhere to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) once it reaches `v1.0.0`. Preview releases use the `-preview` suffix and make no stability guarantees — interfaces, configuration shapes, and behavior may change between preview tags.

## [Preview — active development]

The current development cut. Tagged as `v0.1.0-preview` and superseded by future `v0.x.0-preview` tags as slice work progresses.

### What's in

**Architecture**

- Three-tier model: Core / Adapter / Plugin, with Core blind to which plugins exist
- Adapter types: `TriggerAdapter`, `CommunicationAdapter`, `LLMAdapter`, `GitHostingAdapter`
- Reference plugins (one per adapter per platform):
  - Trigger: `github-trigger`
  - Communication: `github-comm`, `telegram-comm`
  - LLM: `claude-code-llm`, `gemini-cli-llm`, `opencode-llm`
  - Git hosting: `github-hosting`
- Core components: EventBus, TaskEngine, SafetyLayer, ActionPipeline, SessionMemory, WorkspaceManager, Orchestrator, Daemon, Registry, PeopleDirectory
- Orchestration pipeline: requirements gathering → research → planning → execution → self-review → demo prep → integration
- Post-PR engineering loop: iterates on review comments and CI failures, merges after maintainer sign-off
- Agent loop with per-phase tool restrictions and action execution
- Task decomposition with sequential child-task execution
- Git worktree isolation per task

**CLI**

- `engineer start` — first-run setup, then runs the daemon in the foreground
- `engineer stop` — graceful shutdown
- `engineer status` — running state and task queue depth
- `engineer logs` — daemon log viewer (`--follow`, `--json`)
- `engineer doctor` — health checks across multiple categories
- `engineer why <task-id>` — explain a task's decision trail
- `engineer retry <task-id>` — re-queue a failed task
- All commands accept `--home <path>` for a custom data directory

**Infrastructure**

- SQLite persistence with WAL mode and a migration system
- Multi-file YAML configuration with hot-reload support
- Event bus as a Core component (full audit trail)
- Cost tracking with configurable limits and autonomy levels
- War-room dashboard (Hono + SSE, React 19 SPA)
- Dual-channel notifications (GitHub issues + Telegram)

**Quality**

- Unit, integration, and E2E test tiers, run on every push and PR
- Strict TypeScript (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noExplicitAny`)
- Biome + knip (unused exports) + madge (circular deps) in CI

### Known gaps

Work remaining before `v1.0.0`. Each item is tracked through the project's vertical-slice roadmap.

- The trigger-and-requirements flow is mid-rework — dedup story, idempotency keys, and watermark handling are not yet final.
- Documentation continues to consolidate. Some long-form areas overlap until later slices.
- No npm publish yet. Install is `git clone` + `pnpm run setup`.
- No automated versioning. Tags are cut manually at slice milestones.
- Plugin authoring guide is partial — adapter contracts are documented, full how-tos are still being written.

### Not yet here

Larger items deliberately out of scope for the preview:

- Multi-machine / distributed daemon
- A public plugin registry
- Web-based setup or hosted deployment
- Plugin sandboxing beyond workspace boundaries
