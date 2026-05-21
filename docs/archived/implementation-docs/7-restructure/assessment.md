# Layer 7 Assessment — Structural Restructuring

## Current State (Pre-Restructure)

Working MVP: 1,733+ tests, Layers 0-6 complete. Three-tier architecture (Core/Adapter/Plugin) is sound but complexity accumulated across 19 build phases and 6 refinement phases.

## Problems Identified

### God Objects
| Component | LOC | Functions/Methods | Concerns Mixed |
|-----------|-----|-------------------|----------------|
| Daemon | 1,964 | 70+ | tick scheduling, trigger polling, preemption, notifications, review handling, health monitoring, stuck detection, aging, PID management, signal handling |
| Orchestrator | 1,724 | 35 | phase pipeline, workspace lifecycle, PR creation, decomposition, LLM calling, cost emission, notifications, preemption |
| SafetyLayer | 992 | ~20 | cost accounting (spend windows, snapshots, limits) + policy evaluation (verdicts, autonomy, judgment) |

### Mid-Tier Bloat
| Component | LOC | Decomposition Opportunity |
|-----------|-----|---------------------------|
| TaskEngine | 642 | State machine + queries + permissions |
| SessionMemory | 606 | Sessions + journal + checkpoints + knowledge |
| Registry | 564 | Discovery + lifecycle + health |

### Architectural Gaps
- **Implicit event wiring** — `subscribe()` calls scattered across constructors and factories. No single source of truth for event topology.
- **Hardcoded plugin registration** — `bootstrap.ts` manually wires 6 plugins with inline manifests.
- **Concrete class dependencies** — components reference classes, not interfaces. Harder to swap/test.
- **No component lifecycle protocol** — plugins have formal lifecycle, Core components don't.
- **No tagged errors** — ad-hoc `throw new Error(string)` throughout.
- **327+ raw string references** — `"queued"`, `"active"`, etc. instead of Zod enum constants.

### Security Gaps
- Command injection surface in BashTool (no pattern blocking)
- Secret leakage to LLM context (output sanitized, input not)
- Workspace escape via symlinks (no realpath canonicalization)
- GIT_* env wildcard passthrough
- No input validation on safety scope parameters

### Resilience Gaps
- No LLM retry/circuit breaker (transient failures = task failure)
- No adaptive polling (rate limits ignored)
- No data retention (events/traces grow unbounded)
- No subscriber timeout guard

### DX Gaps
- CLI lacks colors, progress indicators, output formatting
- No plugin scaffolding (`engineer create-plugin`)
- No interactive setup wizard
- No `--dry-run`, `--json`, `engineer why` commands
- No CONTRIBUTING.md, issue templates, CHANGELOG

## Research Sources (6 Deep Passes)

1. **Internal audit** — lifecycle, errors, config, DI, test infrastructure
2. **Framework patterns** — Fastify (scoped plugins), VS Code (contributes), Terraform (config versioning), Effect-TS (tagged errors), OpenTelemetry (trace context)
3. **Security/resilience** — OWASP for agents, circuit breakers, optimistic locking, event-state atomicity
4. **DX/CLI/OSS** — gh CLI, Vercel, Docker patterns, contribution workflows, changesets
5. **Agent frameworks** — SWE-agent (constraint-driven tools), Aider (context ranking), AutoCodeRover (test-driven validation), OpenHands (event stream), Cline (hooks)
6. **Cross-domain** — Aviation (sterile cockpit), Toyota TPS (andon cord), Medicine (SBAR handoffs), Military (OODA loop), Journalism (editorial gates)
