# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Core components: EventBus, TaskEngine, SafetyLayer, ActionPipeline, SessionMemory, WorkspaceManager, Orchestrator, Daemon, Registry, PeopleDirectory
- Three-tier architecture: Core / Adapter / Plugin with strict boundary enforcement
- Five adapter types: TriggerAdapter, CommunicationAdapter, LLMAdapter, ToolAdapter, GitHostingAdapter
- Six plugins: GitHub Trigger, GitHub Communication, GitHub Hosting, Telegram Communication, Claude Code LLM, Bash Tool
- Seven-phase orchestration pipeline: intake analysis, research, planning, execution, self-review, demo prep, integration
- Agent loop engine with per-phase tool restrictions and action execution
- Full prompt pipeline with complexity-adaptive strategies
- Task decomposition with sequential child task execution
- CLI with 8 commands: start, stop, status, logs, init, doctor, install, config validate
- War room dashboard with real-time SSE updates
- Plugin discovery, scaffolding, and hook system
- Declarative event topology
- SQLite persistence with WAL mode and migration system
- Multi-file YAML configuration with hot-reload support
- Dual-channel notifications (GitHub issues + Telegram)
- Git worktree isolation per task
- Cost tracking with configurable limits and autonomy levels
- 1,733+ tests across unit, integration, and E2E tiers
