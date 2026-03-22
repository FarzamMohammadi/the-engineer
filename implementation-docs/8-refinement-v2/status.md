# Status

## Current Phase

**CLI-Only LLM Pivot — IN PROGRESS.** Removing all API-oriented LLM abstractions. Redesigning adapter contract for CLI-only integration (`InferenceRequest`/`InferenceResult`). Renaming `complete`/`doComplete` to `infer`/`doInfer`.

Dashboard testing decision: **skipped entirely** — deferred to Dashboard Full Rebuild at end of Layer 8. No session should bother with simple dashboard testing.

## Last Session

Session 066 (2026-03-22): CLI-Only LLM Pivot. Removed API-oriented `CompletionRequest`/`CompletionResult` schemas, replaced with minimal `InferenceRequest`/`InferenceResult`. Stripped `provider_type`, token counts, and dual api/cli accumulator from cost tracking. Renamed `complete()`/`doComplete()` to `infer()`/`doInfer()` across adapter, plugin, and orchestrator.

## Next

**Multi-CLI Plugin Integration** — build OpenCode and Gemini CLI plugins, test all three against real repos.

## Open Questions

- RPI file location: `thoughts/` directory (like Goose) or different convention?

## Findings Log

Accumulated discoveries across sessions. Each entry tagged with session number.

- **S064**: Happy path works end-to-end (trigger → PR creation → feedback rework)
- **S064**: Dashboard shows limited data — need to verify Observer/trace export coverage
- **S064**: LLM blocked during feedback rework attempt, system got stuck — resilience gap in error recovery from CLI failures
- **S065**: Observer exports 13 observation types with full context (trace_id, task_id, phase, session_id) — comprehensive
- **S065**: ObserverStream pub/sub was designed for SSE but never exposed as HTTP endpoint — now bridged via SQLite polling
- **S065**: Existing dashboard had 4 tabs and polling only. New dashboard: 8 tabs, SSE, all 13 observation types + 35 event types
- **S065**: Blob store deduplication works well for LLM prompts — linked via `/api/blob/:prefix/:hash` instead of inlining
