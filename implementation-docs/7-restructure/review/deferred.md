# Deferred Findings

Accumulated across all merge rounds. Nothing gets lost.

## Round 1 — 1-bootstrap-wiring.md

### Lens A (Structure & Organization)
- `bootstrap.test.ts` not needed — bootstrap is tested via E2E tests

### Lens D (Error Handling & Edge Cases)
- **F9:** SIGTERM during bootstrap (<2s window) — accepted gap, OS reclaims resources on exit
- **F10:** Plugin cleanup on config load failure — lightweight risk, non-critical plugins deregistered without shutdown()

### Lens E (Security & Trust Boundaries)
- Event validation (integrity not trust) — payload validation is about data integrity, not a trust boundary; deferred until external plugins exist
- EventTopology publisher enforcement — theoretical risk until external/untrusted plugins exist
- Config error exposure — acceptable for desktop DX (single-user desktop app, not a server)
