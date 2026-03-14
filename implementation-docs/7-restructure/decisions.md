# Layer 7 Decisions

Decisions made during the Layer 7 structural restructuring. Continues from D165 (Layer 6).

---

## D166: Centralized Observer (Langfuse-inspired)

**Phase:** R-0 (Wave 0)
**Decision:** Add a centralized Observer module (`src/core/observer/`) with a single `observations` table, span nesting via `parent_observation_id`, and real-time streaming support. Langfuse-inspired design for production observability without external dependencies.
**Rationale:** War Room dashboard and future debugging need structured traces. Single table with span hierarchy is simpler than distributed tracing.

## D167: Core Interfaces Extracted to `src/core/interfaces/`

**Phase:** R0 (Wave 1)
**Decision:** Extract TypeScript interfaces for all core components (`IEventBus`, `ITaskEngine`, `ISafetyLayer`, `ISessionMemory`, `IActionPipeline`) into dedicated interface files. Zod enum constants exported as `const` objects. Shared component factory pattern.
**Rationale:** Enables dependency inversion — components depend on interfaces, not implementations. Required for clean decomposition in Waves 2-4.

## D168: Component Decomposition Strategy

**Phase:** R1-R4 (Wave 2)
**Decision:** Decompose monolithic components into focused sub-modules:
- SafetyLayer → CostTracker + PolicyEngine
- TaskEngine → state-machine + queries + permissions (with optimistic locking)
- SessionMemory → sessions + journal + checkpoints + knowledge
- Registry → discovery + lifecycle + health
- Daemon → trigger-poller + task-scheduler + preemption + notification-router + health-monitor + review-handler
- Orchestrator → phase-runner + workspace-lifecycle + pr-manager + decomposition-handler + llm-caller
**Rationale:** No file exceeds ~400 LOC. Each sub-module has a single responsibility. Parallel development via worktrees validated the approach.

## D169: Declarative Event Topology

**Phase:** R5 (Wave 3)
**Decision:** Replace ad-hoc `eventBus.subscribe()` calls with a declarative `EventTopology` class that registers all subscriptions at startup with named handlers and validates at boot time.
**Rationale:** Makes event wiring auditable, prevents orphaned subscriptions, enables the Observer to track all event flows.

## D170: Plugin Auto-Discovery + Scaffolding CLI

**Phase:** R6 (Wave 3)
**Decision:** Plugins are auto-discovered from `src/plugins/` via manifest scanning. `engineer create-plugin` CLI scaffolds new plugins. Hook system for plugin lifecycle events. Config versioning support.
**Rationale:** Reduces manual registration boilerplate. Makes plugin development self-service for OSS contributors.

## D171: CLI Polish — Renamed Commands

**Phase:** R7 (Wave 3)
**Decision:** `stop` → `shutdown`, `init` → `prepare` (seed templates) + new `init` (directory setup). Added `dashboard`, `why`, `setup` commands. Colors, progress indicators, `--dry-run` support.
**Rationale:** Command names should describe what they do. `shutdown` is clearer than `stop`. Separating seed generation (`prepare`) from directory creation (`init`) follows the principle of single responsibility.

## D172: Security Hardening Layer

**Phase:** R8 (Wave 3)
**Decision:** Command injection blocking in BashToolPlugin (blocklist + shell metachar detection), workspace escape prevention (path traversal guards), secret sanitization at 16 chokepoints. All security checks are pure functions with dedicated test coverage.
**Rationale:** An autonomous agent that runs shell commands must have defense-in-depth security. Workspace confinement prevents the agent from accessing files outside its assigned worktree.

## D173: OSS Foundation

**Phase:** R9 (Wave 4)
**Decision:** Added CONTRIBUTING.md, issue/PR templates, CHANGELOG.md, architecture diagrams, comprehensive plugin development guide. MIT license. Seed directory with annotated config templates.
**Rationale:** OSS readiness requires documentation, templates, and contribution guidelines before the first external contributor arrives.

## D174: Data Lifecycle Management

**Phase:** R10 (Wave 4)
**Decision:** Event/trace retention with configurable TTLs, query optimization with additional indexes, DB tuning (WAL checkpoint management), `subscriber_warn_threshold_ms` for slow subscriber detection.
**Rationale:** Without retention policies, the SQLite database grows unboundedly. Proactive cleanup prevents performance degradation in long-running daemons.

## D175: Typed Error Classes for Core Domains

**Phase:** REVIEW (Wave 5)
**Decision:** Replace 23 bare `throw new Error()` in core with 14 typed error classes across 6 new error files. Each error class carries domain-specific context (task ID, plugin ID, etc.).
**Rationale:** Typed errors enable precise catch clauses, better error messages, and structured error logging. Discovered during REVIEW audit.
