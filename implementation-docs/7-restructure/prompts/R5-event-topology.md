# Phase R5: Declarative Event Topology

## Identity

You are an implementation agent for **The Engineer** -- an autonomous software engineering agent built in TypeScript/Node.js. You are executing Phase R5 of Layer 7 (Structural Restructuring). You operate with zero prior context. Everything you need is in this prompt.

Read `docs/persona.md` and `docs/philosophy.md` before starting -- they define who The Engineer is and how it thinks. Your work must embody those principles.

---

## Architecture Catchup

The Engineer is a three-tier system:

- **Core** (invariant brain): EventBus, TaskEngine, Orchestrator, Daemon, Registry, SafetyLayer, ActionPipeline, SessionMemory, WorkspaceManager, PeopleDirectory
- **Adapters** (stable contracts): TriggerAdapter, CommunicationAdapter, LLMAdapter, ToolAdapter, GitHostingAdapter
- **Plugins** (swappable implementations): GitHubTrigger, GitHubComm, GitHubHosting, TelegramComm, ClaudeCodeLLM, BashTool

Tech stack: TypeScript (strict), Node.js 22 LTS, pnpm, ESM, SQLite (better-sqlite3), Zod, Vitest, Biome.

### Key Files to Read First

Read these files to understand the current state before making changes:

1. `src/schemas/events.ts` -- All 33 event types, payload schemas, EventPayloads mapped type, `eventPayloadSchemas` runtime registry
2. `src/core/event-bus/index.ts` -- EventBus class: publish (typed + general overloads), subscribe (glob patterns), replay, deliver
3. `src/cli/bootstrap.ts` -- Where all Core components are wired together (manual EventBus subscriptions happen here and in component constructors)
4. `src/core/daemon/index.ts` -- Daemon subscribes to events in its factory function
5. `src/core/safety-layer/index.ts` -- SafetyLayer subscribes to `cost.incurred` in constructor
6. `src/core/registry/index.ts` -- Registry publishes health events
7. `src/core/orchestrator/index.ts` -- Orchestrator publishes cost/workspace/git events
8. `implementation-docs/3-interactions/event-catalog.md` -- Event Catalog (30 events, 10 groups)
9. `implementation-docs/7-restructure/assessment.md` -- Problem statement (implicit event wiring, no topology)
10. `implementation-docs/7-restructure/decisions.md` -- Decision log (D166+)

### Related Layer 7 Context

This phase runs in **Wave 3** (parallel with R6, R7, R8). It depends on Wave 1 (R0: Interface Foundation) and Wave 2 being complete. R0 establishes shared interfaces and Zod enum constants that this phase builds upon.

---

## Problem Statement

From the assessment:
> **Implicit event wiring** -- `subscribe()` calls scattered across constructors and factories. No single source of truth for event topology.

Currently:
- Components call `eventBus.subscribe()` directly in constructors/factories with hardcoded string patterns
- No way to answer "which components publish/subscribe to which events?" without grep
- No runtime payload validation on publish (schemas exist but are never checked)
- Plugin events are untyped (`PublishInputGeneral`)
- No dashboard-friendly graph of the event flow

---

## Exact Specifications

### 1. Create `src/core/event-bus/topology.ts`

This file defines the declarative event topology system.

#### EventDeclaration type

```typescript
/** A single event type declaration -- who publishes it, what its payload looks like. */
export interface EventDeclaration<T extends string = string> {
  /** The event type string (e.g., "task.created"). */
  type: T;
  /** Human-readable description. */
  description: string;
  /** Zod schema for runtime payload validation. */
  payloadSchema: ZodType;
  /** Which component(s) publish this event. */
  publishers: string[];
  /** Which component(s) subscribe to this event (populated at registration time). */
  subscribers: string[];
}
```

#### EventTopology class

```typescript
export class EventTopology {
  private declarations = new Map<string, EventDeclaration>();

  /**
   * Register event declarations from a component.
   * Called during bootstrap for each Core component and plugin.
   * @param componentId - The component registering its events (e.g., "task-engine", "daemon")
   * @param events - Array of EventDeclaration objects this component publishes
   */
  registerPublisher(componentId: string, events: EventDeclaration[]): void;

  /**
   * Register a subscription interest.
   * Called during bootstrap. Records that `subscriberId` listens to `eventType`.
   * @param subscriberId - The component subscribing
   * @param eventType - The event type or glob pattern (e.g., "task.*")
   */
  registerSubscriber(subscriberId: string, eventType: string): void;

  /**
   * Get the declaration for a specific event type.
   * Returns undefined if the event type is not registered.
   */
  getDeclaration(eventType: string): EventDeclaration | undefined;

  /**
   * Get all registered declarations.
   */
  getAllDeclarations(): EventDeclaration[];

  /**
   * Validate a payload against the declared schema for the given event type.
   * Returns { valid: true } or { valid: false, errors: string[] }.
   * Returns { valid: true } for unknown event types (forward compatibility).
   */
  validatePayload(eventType: string, payload: Record<string, unknown>): {
    valid: boolean;
    errors?: string[];
  };

  /**
   * Get the full event topology graph for dashboard visualization.
   * Returns an object mapping event types to their publishers and subscribers.
   */
  getGraph(): EventTopologyGraph;
}

export interface EventTopologyGraph {
  events: Array<{
    type: string;
    description: string;
    publishers: string[];
    subscribers: string[];
  }>;
  components: Array<{
    id: string;
    publishes: string[];
    subscribes: string[];
  }>;
}
```

### 2. Add `EVENTS` Export to Every Core Component

Each Core component that publishes events must export an `EVENTS` constant: an array of `EventDeclaration` objects describing every event it publishes. This creates a single source of truth per component.

Components and their published events (derive from `src/schemas/events.ts` and actual publish calls in each component):

| Component | File | Events Published |
|-----------|------|-----------------|
| TaskEngine | `src/core/task-engine/index.ts` | `task.created`, `task.state_changed` |
| SafetyLayer | `src/core/safety-layer/index.ts` | `cost.limit_reached` |
| WorkspaceManager | `src/core/workspace-manager/index.ts` | `workspace.created`, `workspace.verified`, `workspace.cleaned`, `workspace.merge_conflict` |
| Registry | `src/core/registry/index.ts` | `health.plugin_unhealthy`, `health.plugin_failed`, `health.plugin_recovered` |
| Orchestrator | `src/core/orchestrator/index.ts` | `cost.incurred`, `git.branch_created`, `git.committed`, `git.pushed`, `git.pr_opened`, `git.pr_updated`, `task.children_all_done` |
| Daemon | `src/core/daemon/index.ts` | `trigger.new_event`, `trigger.pr_review`, `health.stuck_detected`, `health.trigger_failure`, `preemption.requested`, `preemption.ready`, `timeout.reminder`, `timeout.self_unblock_check`, `timeout.alert`, `comm.message_sent`, `review.poll_completed` |
| ActionPipeline | `src/core/action-pipeline/index.ts` | `action.rejected` |

**Important:** Grep each component's source for `.publish(` calls to verify the exact events. The table above is a starting guide -- the source code is truth.

Each `EVENTS` array entry should reference the corresponding Zod payload schema from `src/schemas/events.ts`. Example:

```typescript
import type { EventDeclaration } from "../event-bus/topology.js";
import { TaskCreatedPayloadSchema, TaskStateChangedPayloadSchema } from "../../schemas/events.js";

export const EVENTS: EventDeclaration[] = [
  {
    type: "task.created",
    description: "Emitted when a new task is created in the system",
    payloadSchema: TaskCreatedPayloadSchema,
    publishers: ["task-engine"],
    subscribers: [], // populated by topology registration
  },
  {
    type: "task.state_changed",
    description: "Emitted when a task transitions between states",
    payloadSchema: TaskStateChangedPayloadSchema,
    publishers: ["task-engine"],
    subscribers: [],
  },
];
```

### 3. Optional Runtime Payload Validation

Add an optional `validateOnPublish` flag to EventBus (default: `false` in production, `true` in tests).

When enabled, `EventBus.publish()` calls `topology.validatePayload()` before persisting. If validation fails:
- In development/test: throw an error (catch bugs early)
- In production: log a warning via `console.warn` but still publish (don't break the system)

Modify the `EventBus` constructor to optionally accept an `EventTopology` instance:

```typescript
constructor(db: Database.Database, options?: { topology?: EventTopology; validateOnPublish?: boolean });
```

### 4. Type-Safe Publish with Payload Inference

The existing `PublishInput<T>` already provides compile-time type safety. This phase preserves that. The topology adds runtime validation on top (opt-in). No changes needed to the publish signature.

### 5. Wire Topology in Bootstrap

Modify `src/cli/bootstrap.ts` to:
1. Create an `EventTopology` instance
2. Register all Core component `EVENTS` arrays via `topology.registerPublisher()`
3. Register all known subscriptions via `topology.registerSubscriber()`
4. Pass the topology to the `EventBus` constructor
5. Make the topology available to the dashboard (pass it through to Daemon or expose via a getter)

### 6. Export `topology.getGraph()` for Dashboard

The `getGraph()` method returns a serializable object that the War Room dashboard can consume. The dashboard endpoint is out of scope for this phase -- just ensure the method exists and returns correct data.

---

## Refinement Checklist

Before writing any code, verify:

- [ ] Read all 7 component source files listed above and confirm which events each actually publishes (grep for `.publish(`)
- [ ] Read `src/schemas/events.ts` to confirm all 33 event types and their payload schemas
- [ ] Read `src/cli/bootstrap.ts` to understand current wiring
- [ ] Confirm no existing `topology.ts` file exists in the codebase
- [ ] Check if any component subscribes to events outside its constructor (search for `.subscribe(` across all core components)

During implementation:

- [ ] Every `EventDeclaration` references the correct Zod schema from `src/schemas/events.ts`
- [ ] The `EVENTS` array in each component matches actual `.publish()` calls (no missing, no phantom)
- [ ] `EventTopology.validatePayload()` handles unknown event types gracefully (returns valid)
- [ ] `EventTopology.getGraph()` output is JSON-serializable (no Zod objects, functions, etc.)
- [ ] Bootstrap wiring is complete -- every component's EVENTS registered, every subscription recorded
- [ ] Existing tests still pass (no breaking changes to EventBus API)
- [ ] New tests cover: registration, validation (valid + invalid + unknown), graph generation, integration with EventBus

---

## Verification Steps

Run these commands after implementation:

```bash
# 1. Type check passes
pnpm typecheck

# 2. Lint passes
pnpm lint

# 3. All existing tests still pass
pnpm test

# 4. New topology tests pass
pnpm test -- --reporter=verbose src/core/event-bus/topology.test.ts

# 5. Verify every component has EVENTS export (manual grep)
grep -r "export const EVENTS" src/core/

# 6. Verify bootstrap wires topology
grep -n "topology" src/cli/bootstrap.ts
```

---

## Test Requirements

Create `src/core/event-bus/topology.test.ts` with tests covering:

1. **Registration**: registerPublisher adds declarations, registerSubscriber records subscribers
2. **Lookup**: getDeclaration returns correct declaration, undefined for unknown types
3. **Validation**: validatePayload accepts valid payloads, rejects invalid ones, passes unknown types
4. **Graph**: getGraph returns correct structure with all publishers and subscribers
5. **Integration**: EventBus with topology and validateOnPublish=true rejects bad payloads
6. **Integration**: EventBus with topology and validateOnPublish=false logs warning but publishes
7. **Completeness**: Every event type in EventTypeSchema has a corresponding declaration registered

---

## Commit Instructions

When complete, create a single commit:

```
Add declarative event topology (R5)

- EventTopology class with declaration registry and runtime validation
- EVENTS export on every Core component (single source of truth)
- Optional validateOnPublish mode on EventBus
- topology.getGraph() for dashboard visualization
- Bootstrap wiring for topology registration
```

Do NOT push. The commit stays local.

---

## Constraints

- Do not modify event type strings or payload schemas -- topology wraps existing schemas
- Do not change the EventBus public API signature (additive only)
- Do not add new dependencies -- use only Zod (already a dependency)
- Keep `validateOnPublish` off by default -- it is opt-in for tests
- Biome lint must pass (`pnpm lint`)
- TypeScript strict mode must pass (`pnpm typecheck`)
- All existing tests must continue to pass
