# Status

## Current Phase

**CLI-Only LLM Pivot — DONE.** Full CLI-only adapter contract with three-layer usage and quota tracking. Dashboard testing skipped (deferred to Full Rebuild).

## Last Session

Session 066 (2026-03-22): Two major deliverables. (1) CLI-Only LLM Pivot — removed all API-oriented abstractions (`CompletionRequest`/`CompletionResult` → `InferenceRequest`/`InferenceResult`), renamed `complete()`→`infer()`, unified cost tracking, flattened config. (2) Three-layer usage & quota tracking — enriched InferenceResult with per-call token/cache breakdown, added `getQuotaStatus()` to LLMAdapter, switched Claude Code plugin to `stream-json --verbose` for rate_limit_event parsing, wired `updateTracking()` (fixes dashboard showing 0), added `cost.quota_exhausted` event, token accumulation in cost tracker, dashboard quota/token display, and LLM plugin integration guide.

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
- **S066**: Claude CLI `--print --output-format json` returns full token breakdown (input, output, cache_creation, cache_read) + modelUsage per-model + total_cost_usd
- **S066**: Claude CLI `--output-format stream-json --verbose` emits `rate_limit_event` with status (allowed/denied), resetsAt, rateLimitType — this is the quota detection signal
- **S066**: Claude Code status line receives `rate_limits.five_hour` and `rate_limits.seven_day` with `used_percentage` + `resets_at` — but only in interactive mode, not `--print`
- **S066**: `updateTracking()` on TaskEngine was never called — dashboard always showed 0 tokens/cost. Now wired in orchestrator after each phase.
