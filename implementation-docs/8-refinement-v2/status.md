# Status

## Current Phase

**Dashboard — Simple Rebuild — DONE.** Full 8-tab instrument panel with SSE real-time streaming. Audited Observer (13 types), EventBus (35 types), agent loop callbacks. Backend: new `/api/observations` and `/api/stream` (SSE) endpoints. Frontend: complete rewrite with Overview, Tasks, Agent Loop, Observations, Events, Cost, Decisions, Errors tabs.

## Last Session

Session 065 (2026-03-22): Built the Dashboard Simple Rebuild. Audited all data export surfaces (Observer, EventBus, agent loop callbacks, blob store). Created 2 new API endpoints (observations query + SSE stream). Rewrote index.html from scratch — 8 tabs, SSE-driven real-time, type-specific observation rendering, blob store links for LLM prompts/responses, cross-tab navigation. Clean dark theme without decorative elements. Added flicker-free 3-second auto-refresh with updateIfChanged() and ID-based fingerprinting.

## Next

Manual test the dashboard against a live run to verify data flows correctly through all 8 tabs. Then begin **CLI-Only LLM Pivot** — remove API-based LLM adapter, redesign for CLI tool integration.

## Open Questions

- Which CLI tools besides Claude CLI should we support first? (Codex, Gemini CLI, OpenCode — order TBD)
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
