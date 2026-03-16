# Phase 0-1: CLI Entry & Bootstrap — Component Wiring

Phases 0 and 1 are combined here because they run sequentially in a single startup path.

---

## Flow

```
engineer start [CLI]
    │
    ▼
Phase 0: runStart()                          ← src/cli/commands/start.ts
    ├─ resolveSubdirs(engineerHome)          → create ~/.engineer/{config,data,run,traces,config/plugins}
    ├─ loadConfigDir(dirs.config)            → parse YAML, resolve env vars → ConfigBundle
    ├─ runPreFlightChecks(engineerHome)      → 6 doctor categories
    ├─ [--dry-run] → show summary, exit 0
    ├─ [--daemon]  → spawnBackground(), exit 0
    │
    ▼
Phase 1: bootstrap()                         ← src/cli/bootstrap.ts
    ├─ createLogger()                        → pino + pino-roll
    ├─ createDatabase()                      → better-sqlite3, WAL mode
    ├─ createCoreComponents()                → 7 core components (see below)
    ├─ new HookRegistry()
    ├─ new Registry()
    ├─ createObserver()                      → BlobStore + ObservabilityStore + Observer
    ├─ new PeopleDirectory()
    ├─ new Orchestrator()
    ├─ createDataLifecycleManager()
    ├─ createDaemon()
    ├─ registerEventSubscriptions()          → 5 daemon subscribers in topology
    ├─ loadBuiltinPlugins()                  → Phase 2
    │
    ▼
    return { daemon, topology, logger, cleanup }
    │
    ▼
    launchDashboard(dirs)                    → spawn React dashboard on port 3847
    register SIGTERM/SIGINT handlers
    await daemon.start()                     → Phase 3
```

---

## Production Files

| # | File | Role |
|---|------|------|
| 1 | `src/cli/commands/start.ts` | CLI entry: dirs, config, pre-flight, dry-run, background mode |
| 2 | `src/cli/bootstrap.ts` | Wires all 12+ components, loads plugins |
| 3 | `src/core/system.ts` | `createCoreComponents()` — wires 7 core components in dependency order |

---

## Phase 0: CLI Entry (`start.ts`)

### Steps

1. **Directory creation** — `resolveSubdirs(engineerHome)` creates:
   - `~/.engineer/config/`
   - `~/.engineer/config/plugins/`
   - `~/.engineer/data/`
   - `~/.engineer/run/`
   - `~/.engineer/traces/`

2. **Config loading** — `loadConfigDir(dirs.config)` parses YAML from config dir, resolves `$ENV_VAR` references, returns `ConfigBundle` with all subsystem configs

3. **Pre-flight checks** — `runPreFlightChecks()` runs 6 doctor categories. Critical failure = exit 1, warnings = continue

4. **Dry-run mode** — `--dry-run` flag: discovers enabled plugins, prints summary, exits 0

5. **Background mode** — `--daemon` flag: spawns detached child process, parent exits 0

6. **Dashboard** — `launchDashboard(dirs)` spawns React app on port 3847, writes PID to `~/.engineer/run/dashboard.pid`

7. **Signal handlers** — SIGTERM/SIGINT → `daemon.stop()` + cleanup

---

## Phase 1: Bootstrap (`bootstrap.ts` + `system.ts`)

### Component Creation Order (dependency DAG)

| # | Component | Constructor | Dependencies |
|---|-----------|-------------|--------------|
| 1 | Logger | `createLogger(loggingConfig, engineerHome)` | config |
| 2 | Database | `createDatabase(dbPath, { cacheSizeMb })` | — |
| 3 | EventTopology | `new EventTopology()` | — |
| 4 | EventBus | `new EventBus(db, { topology, subscriberWarnThresholdMs })` | db, topology |
| 5 | TaskEngine | `new TaskEngine(db, eventBus)` | db, eventBus |
| 6 | SafetyLayer | `new SafetyLayer(db, eventBus, safetyConfig)` | db, eventBus, config |
| 7 | ActionPipeline | `new ActionPipeline(taskEngine, safetyLayer, eventBus)` | taskEngine, safetyLayer, eventBus |
| 8 | SessionMemory | `new SessionMemory(db)` | db |
| 9 | WorkspaceManager | `new WorkspaceManager(eventBus, workspaceConfig)` | eventBus, config |
| 10 | HookRegistry | `new HookRegistry()` | — |
| 11 | Registry | `new Registry({ eventBus, healthCheckIntervalMs, ... hookRegistry })` | eventBus, hookRegistry |
| 12 | Observer | `createObserver(db, blobStore)` via BlobStore + ObservabilityStore | db |
| 13 | PeopleDirectory | `new PeopleDirectory({ people: config.people })` | config |
| 14 | Orchestrator | `new Orchestrator({ eventBus, registry, taskEngine, ... })` | all above |
| 15 | DataLifecycleManager | `createDataLifecycleManager({ db, eventBus, config, ... })` | db, eventBus |
| 16 | Daemon | `createDaemon(config.daemon, { all deps })` | all above |

### Topology Publisher Registrations

After component creation, publishers are registered in the event topology:

| Publisher | Events |
|-----------|--------|
| `task-engine` | task.created, task.state_changed, task.field_updated, task.priority_aged |
| `action-pipeline` | action.executed, action.rejected, action.ask_human, action.error |
| `safety-layer` | cost.incurred, cost.limit_reached |
| `workspace-manager` | workspace.created, workspace.verified, workspace.cleaned |
| `registry` | health.plugin_unhealthy, health.plugin_failed, health.plugin_recovered |
| `orchestrator` | (orchestrator events) |
| `daemon` | trigger.new_event, health.trigger_failure, health.stuck_detected, etc. |

### Event Subscriber Registrations

| Subscriber ID | Event | Handler |
|---------------|-------|---------|
| `orchestrator` | `preemption.requested` | Sets preemption flag in Orchestrator |
| `safety_layer` | `cost.incurred` | CostTracker accumulation |
| `daemon:cost` | `cost.limit_reached` | HealthMonitor.addCostLimitTask() |
| `daemon:comm` | `comm.message_received` | Query handler |
| `daemon:state-sync` | `task.state_changed` | NotificationRouter.syncStateToCommPlugin() |
| `daemon:children-done` | `task.children_all_done` | Re-dispatch parent for integration |
| `daemon:feedback` | `task.feedback_received` | ReviewHandler.handleFeedbackEvent() |

---

## Test Files

| File | Type |
|------|------|
| `src/cli/bootstrap.test.ts` | Unit |
| `src/core/system.test.ts` | Unit (if exists) |
| `test/e2e/daemon-lifecycle.e2e.test.ts` | E2E — full startup/shutdown |
