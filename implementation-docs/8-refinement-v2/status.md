# Status

## Current Phase

**CLI-Only LLM Pivot — DONE.** Full CLI-only adapter contract with three-layer usage and quota tracking. Dashboard testing skipped (deferred to Full Rebuild).

## Last Session

Session 066 (2026-03-22): Massive session — CLI-Only LLM Pivot + three-layer usage/quota tracking + quota API integration + dashboard quota display + plugin docs restructure with LLM-guided setup. 11 commits, 55+ files. Discovered Anthropic's `/api/oauth/usage` endpoint for real quota percentages, integrated it with cross-platform credential access (macOS Keychain + file fallback), 30-min caching to handle aggressive rate limits (~5 requests per token). Dashboard split into Session Quota + Long-Term Quota cards. Fixed observation field bug (input vs output). Plugin docs restructured into `llm-adapter/` directory with `prompt.md` for LLM-guided interactive setup. OS-specific plugin selection documented as future consideration.

## Next

1. **Code quality review** — holistic review of all session 066 changes for maintainability, complexity, and clean separation of concerns
2. **Verify quota API on fresh token** — current token is rate-limited from debugging. Once it rotates (~5h), verify dashboard shows real percentages
3. **Multi-CLI Plugin Integration** — build OpenCode and Gemini CLI plugins

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
- **S066**: Anthropic's `/api/oauth/usage` returns real quota percentages (five_hour, seven_day, seven_day_sonnet) but has aggressive per-token rate limit (~5 requests then 429). Token rotates every ~5h, resetting the limit.
- **S066**: `observe()` stores data in `input` field, NOT `output` — `output` is for span end-data only. Dashboard was reading wrong field for quota.
- **S066**: `claude.ai/api/organizations/.../usage` is Cloudflare-protected (browser-only), cannot be used programmatically.
- **S066**: Claude Code stores OAuth credentials in macOS Keychain (`Claude Code-credentials`) and potentially `~/.claude/.credentials.json` as fallback on other platforms.
