# OpenClaw Review — Reference for The Engineer

Deep review of [OpenClaw](https://github.com/openclaw/openclaw) — a TypeScript-based personal AI assistant with plugin system, daemon, multi-channel communication, and agent orchestration. Similar technology choices to The Engineer. Reviewed during Session 23 to validate decisions and identify patterns to adopt.

---

## Technology Validation

Every foundation decision (#65-#74) is confirmed by OpenClaw's production codebase:

| Our Decision | OpenClaw's Choice |
|---|---|
| TypeScript, strict mode | Same |
| Node.js 22 LTS | `"engines": { "node": ">=22.12.0" }` |
| pnpm | `"packageManager": "pnpm@10.23.0"`, workspaces |
| ESM only | `"type": "module"`, NodeNext |
| SQLite | `node:sqlite` + `sqlite-vec` (we use `better-sqlite3` for stability) |
| Vitest | 6+ configs: unit, e2e, live, gateway, channels, extensions |

Where we differ: They use `node:sqlite` (experimental, we chose stable `better-sqlite3`), oxlint+oxfmt (we chose Biome), JSON5 config (we haven't decided yet).

---

## Patterns to Adopt

### High Priority — ALL ADOPTED

**1. Plugin manifest as standalone file** → **ADOPTED** Session 26 (Decision #102)
OpenClaw uses `openclaw.plugin.json` per plugin — metadata separate from code. We adopted `engineer.plugin.yaml` per plugin with YAML format matching our config convention.

**2. Multi-tier Vitest configs** → **ADOPTED** Session 28 (Decision #119)
They run 6+ test tiers with smart coverage thresholds (70% lines, 55% branches) and process isolation (`pool: "forks"`). We adopted three tiers (unit/integration/e2e), same thresholds, `forks` globally. Also adopted `coverage.all: false` and strategic exclusions.

**3. Plugin SDK as curated re-export** → **ADOPTED** Session 25/26 (Decision #105)
OpenClaw exports `openclaw/plugin-sdk`. We implemented `src/adapters/index.ts` as the curated SDK boundary. Future extraction to `packages/plugin-sdk/`.

**4. `doctor` health check command** → **ADOPTED** Session 27 (Decision #116)
`openclaw doctor` validates config, ports, tokens, risky configs. We implemented `engineer doctor` with 10 check categories and pre-flight subset on startup.

**5. Process safety hardening** → **ADOPTED** Session 26 (Decision #108)
No `shell: true`, explicit bash, signal forwarding, workspace confinement, env allowlist, output limits. All five rules adopted.

### Medium Priority

**6. Rolling file logging** → **ADOPTED** Session 27 (Decision #110)
Daily rolling files (500MB cap, 7-day retention) via pino + pino-roll. Complements Event Bus audit trail.

**7. Config format: evaluate JSON5** → **RESOLVED** Session 25 (Decision #90)
Evaluated JSON5 alongside YAML/TOML. Chose YAML for deep nesting readability and comments.

**8. Lane-based command queue** → deferred (post-v1)
Named queues with configurable concurrency per operation type. Draining pattern for graceful shutdown. Useful when we go multi-task.

### Low Priority (post-v1)

**9. Hook system for plugins** — 26 lifecycle hooks that let plugins modify behavior (not just observe). Our Event Bus + adapter contracts handle this differently, but hooks add value on top.

**10. Sandboxed plugin runtime** — Constrained runtime object for plugins. Our Safety Layer + Action Pipeline already gate actions, but a formal runtime object could make the boundary cleaner.

**11. Plugin discovery from filesystem** — Scan workspace/global paths for plugins. For now our Registry handles discovery; filesystem scanning is future.

---

## Architectural Comparison

| Aspect | OpenClaw | The Engineer |
|--------|----------|--------------|
| Purpose | Personal AI assistant | Autonomous software engineer |
| Core pattern | Gateway (HTTP/WS server) | Daemon (polling loop) |
| Agent execution | Embeds Pi agent (ACP/RPC) | Orchestrator with 7-phase pipeline |
| Plugin contracts | Implicit in API surface | Explicit adapter types + capability gates |
| Event system | Hooks (plugin-centric) | Event Bus (audit-centric) |
| State machine | Session-based | Task-based (7 states, sub-states, permissions) |
| Security | Audit command + sandboxing | Safety Layer + Action Pipeline (middleware gates) |
| Deployment | OS daemon (launchd/systemd/schtasks) | TBD (Session 27) |

**Key difference:** OpenClaw's adapters are implicit in the plugin API surface. Ours are explicit with formal adapter types (TriggerAdapter, CommunicationAdapter, etc.) and capability gates. Our approach is more formal, which matters for a system that needs strict safety guarantees.

**Their plugin system is more mature.** Session 26 should study their plugin loader, manifest system, and SDK pattern closely.

---

## OpenClaw's Tech Stack (for reference)

```
Language:     TypeScript (strict)
Runtime:      Node.js >= 22.12
Packages:     pnpm 10.x (workspaces)
Modules:      ESM (NodeNext)
Storage:      node:sqlite + sqlite-vec
Build:        tsdown (esbuild-based)
Lint:         oxlint + oxfmt
Validation:   Zod
Testing:      Vitest (6+ configs)
HTTP:         Express 5
Telegram:     grammY
Git:          N/A (not a code agent)
Key deps:     @mariozechner/pi-agent-core, commander, yaml, croner
```
