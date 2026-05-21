# Phase 2: Plugin Loading & Initialization

---

## Flow

```
loadBuiltinPlugins(registry, pluginConfigDir, observer)
    │
    ▼
Scan ~/.engineer/config/plugins/ for YAML files
    → build enabledIds set from filenames
    │
    ▼
Filter BUILTIN_PLUGINS by enabledIds
    │
    ▼
For each enabled plugin:
    │
    ├─ 1. Create instance    → plugin.create()  (e.g., new GitHubTriggerPlugin())
    ├─ 2. Register           → registry.register(manifest, instance)
    ├─ 3. Load config        → loadPluginConfig(path, id, critical)
    ├─ 4. Initialize         → registry.initializePlugin(id, config)
    └─ 5. Error handling     → critical: throw / non-critical: deregister + warn
```

---

## Production Files

| # | File | Role |
|---|------|------|
| 1 | `src/plugins/builtin.ts` | 6 plugin manifests + factory functions |
| 2 | `src/plugins/loader.ts` | `loadBuiltinPlugins()`: discovery, config loading, init orchestration |
| 3 | `src/cli/bootstrap.ts` | Calls `loadBuiltinPlugins()`, wires all 16 components |
| 4 | `src/core/registry/index.ts` | Registry class: register, init, type lookups |
| 5 | `src/core/registry/lifecycle.ts` | LifecycleManager: plugin storage, init ordering |
| 6 | `src/core/registry/health.ts` | HealthMonitor: health state machine per plugin |

---

## 6 Built-in Plugins

| Plugin ID | Type | Critical | Capabilities | Key Config |
|-----------|------|----------|-------------|------------|
| `github-trigger` | trigger | yes | poll | `github_token`, `repos[]`, `labels[]`, `poll_interval_ms` |
| `claude-code-llm` | llm | yes | complete | (provider config) |
| `bash-tool` | tool | yes | read, write, test, git-local | `blocked_patterns`, `timeout_ms` |
| `github-comm` | communication | no | send, sync, issue_management | `github_token` |
| `telegram-comm` | communication | no | send | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` |
| `github-hosting` | git_hosting | yes | PR lifecycle (9 methods) | `github_token` |

---

## 5-Phase Loading Lifecycle

### Phase 1: Discovery
- Scans `~/.engineer/config/plugins/` for `*.yaml` files
- Filename = plugin ID (e.g., `github-trigger.yaml`)
- Filters `BUILTIN_PLUGINS` to only those with matching config files

### Phase 2: Registration
- `registry.register(manifest, instance)` → stores in LifecycleManager
- Assigns `initOrder` (sequential counter, 1-based)
- Invalidates type cache
- Rejects duplicate IDs

### Phase 3: Config Loading
- `loadPluginConfig(configPath, pluginId, critical)`
- Parses YAML → resolves `$ENV_VAR` references
- Critical plugin config failure → throw (aborts startup)
- Non-critical failure → log warning, deregister, continue

### Phase 4: Initialization
- `registry.initializePlugin(pluginId, config)` (async)
- Calls adapter's `initialize(config)` method
- Each plugin does one-time setup (API auth, connection test, etc.)
- Critical failure → throw
- Non-critical failure → deregister, continue

### Phase 5: Health Check Loop
- Started later in Phase 3 (Daemon startup): `registry.startHealthCheckLoop()`
- `setInterval(healthCheckAll, 60_000)` — every 60s
- Per-plugin health state machine: `healthy → unhealthy → failed`

---

## Health State Machine

```
healthy ──(first failure)──→ unhealthy
unhealthy ──(N consecutive failures)──→ failed     [N = consecutiveFailuresThreshold, default 3]
unhealthy/failed ──(successful check)──→ healthy
```

### Events Emitted

| Event | Trigger |
|-------|---------|
| `health.plugin_unhealthy` | First failure (healthy → unhealthy) |
| `health.plugin_failed` | N consecutive failures (unhealthy → failed) |
| `health.plugin_recovered` | Success after failure (→ healthy) |

---

## Critical vs Non-Critical

| Behavior | Critical (4 plugins) | Non-Critical (2 plugins) |
|----------|---------------------|-------------------------|
| Config load error | Aborts startup | Deregister + warn |
| Init error | Aborts startup | Deregister + warn |
| Runtime health failure | State machine tracking | State machine tracking |
| System without it | Cannot function | Degraded (no notifications) |

---

## Test Files

| File | Type |
|------|------|
| `src/core/registry/index.test.ts` | Unit — registration, init, lookups |
| `src/core/registry/lifecycle.test.ts` | Unit — lifecycle manager |
| `src/core/registry/health.test.ts` | Unit — health state machine |
| `test/helpers/contract-suites/` | 5 contract compliance suites (one per adapter type) |
| `test/helpers/fake-plugins/` | 5 fake plugins for testing |
