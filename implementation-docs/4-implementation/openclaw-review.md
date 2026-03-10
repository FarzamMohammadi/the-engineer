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

### High Priority

**1. Plugin manifest as standalone file** → Session 26
OpenClaw uses `openclaw.plugin.json` per plugin — metadata separate from code. Enables UI generation, enable/disable before loading, config schema validation. Our `PluginManifest` is embedded in code; a standalone file would be better.

**2. Multi-tier Vitest configs** → Session 28
They run 6+ test tiers with smart coverage thresholds (70% lines, 55% branches) and process isolation (`pool: "forks"`). We should adopt: unit, integration, e2e, plugin configs from day 1.

**3. Plugin SDK as curated re-export** → Session 25/26
OpenClaw exports `openclaw/plugin-sdk` — curated surface for plugin authors. Maps directly to our "accessibility promise." Potential `packages/plugin-sdk/` in our monorepo.

**4. `doctor` health check command** → Session 27
`openclaw doctor` validates config, ports, tokens, risky configs. 30+ checks. A `the-engineer doctor` command aligns with our health monitoring design.

**5. Process safety hardening** → Session 26
No `shell: true` for untrusted args. Windows cmd.exe injection prevention. npm/npx special handling. Signal forwarding to child processes. Critical for our BashToolPlugin.

### Medium Priority

**6. Rolling file logging** → Session 27
Daily rolling files (500MB cap, 24h prune), subsystem routing, never blocks on I/O failures. Complements our Event Bus audit trail with operational logging.

**7. Config format: evaluate JSON5** → Session 25
OpenClaw uses JSON5 (comments + trailing commas). Worth evaluating alongside YAML/TOML.

**8. Lane-based command queue** → future
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
