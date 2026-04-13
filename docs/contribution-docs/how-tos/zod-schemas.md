# Zod Schemas & Enum Constants

How schemas, types, and runtime enum constants work in The Engineer.

---

## Overview

All data structures are defined as Zod schemas in `src/schemas/`. Types are always inferred from schemas — never manually written. Enum-like values use the `z.enum()` + `.enum` pattern to provide compile-time types AND runtime constant objects in a single declaration.

```
src/schemas/
  task.ts            — Task state machine, transitions, permissions
  events.ts          — Event types, payloads, event registry
  orchestrator.ts    — Phases, outputs, agent actions, decomposition
  config.ts          — All configuration schemas
  adapters.ts        — Adapter types, contracts, plugin interfaces
  session-memory.ts  — Sessions, journal, checkpoints, knowledge
  ephemeral.ts       — Daemon runtime state, dispatch, cost tracking
  observer.ts        — Observation types, queries, blob refs
  index.ts           — Barrel export
```

---

## The Core Pattern: Schema + Type + Const Enum

Every enum-like value follows a three-part export:

```typescript
// 1. Zod schema (source of truth)
export const TaskStateSchema = z.enum([
  "intake", "queued", "active", "blocked",
  "review_pending", "completed", "failed",
]);

// 2. TypeScript type (inferred, never manual)
export type TaskState = z.infer<typeof TaskStateSchema>;

// 3. Runtime const enum (what code uses)
export const TaskStates = TaskStateSchema.enum;
```

**Usage:**
```typescript
// Always use the const enum — never raw strings
if (task.state === TaskStates.active) { ... }
taskEngine.getTasksByState(TaskStates.queued);
```

**Why all three?**
- **Schema** — runtime validation (parsing config, API payloads, DB rows)
- **Type** — compile-time type checking (function signatures, interfaces)
- **Const enum** — runtime values without string literals (refactorable, autocomplete, typo-proof)

### Naming Convention

| Part | Pattern | Example |
|------|---------|---------|
| Schema | `XxxSchema` | `TaskStateSchema`, `PhaseSchema` |
| Type | `Xxx` | `TaskState`, `Phase` |
| Const enum | `Xxxs` (plural) | `TaskStates`, `Phases` |

### All Instances in the Codebase

| File | Schema | Type | Const Enum |
|------|--------|------|------------|
| `task.ts` | `TaskStateSchema` | `TaskState` | `TaskStates` |
| `task.ts` | `SubStateSchema` | `SubState` | `SubStates` |
| `task.ts` | `CascadePolicySchema` | `CascadePolicy` | `CascadePolicies` |
| `task.ts` | `ActionClassSchema` | `ActionClass` | `ActionClasses` |
| `task.ts` | `TeamMemberRoleSchema` | `TeamMemberRole` | `TeamMemberRoles` |
| `task.ts` | `RelatedTypeSchema` | `RelatedType` | `RelatedTypes` |
| `events.ts` | `EventTypeSchema` | `EventType` | `EventTypes` |
| `orchestrator.ts` | `PhaseSchema` | `Phase` | `Phases` |
| `orchestrator.ts` | `ComplexitySchema` | `Complexity` | `Complexities` |
| `config.ts` | `AutonomyLevelSchema` | `AutonomyLevel` | `AutonomyLevels` |
| `config.ts` | `ReviewPhaseNameSchema` | `ReviewPhaseName` | `ReviewPhaseNames` |
| `config.ts` | `TimeoutStageActionSchema` | `TimeoutStageAction` | `TimeoutStageActions` |
| `adapters.ts` | `AdapterTypeSchema` | `AdapterType` | `AdapterTypes` |
| `adapters.ts` | `AdapterErrorSeveritySchema` | `AdapterErrorSeverity` | `AdapterErrorSeverities` |
| `adapters.ts` | `MessageTypeSchema` | `MessageType` | `MessageTypes` |
| `adapters.ts` | `MergeStrategySchema` | `MergeStrategy` | `MergeStrategies` |
| `adapters.ts` | `NotificationLevelSchema` | `NotificationLevel` | `NotificationLevels` |
| `adapters.ts` | `SideEffectTypeSchema` | `SideEffectType` | `SideEffectTypes` |
| `adapters.ts` | `PluginHealthStateSchema` | `PluginHealthState` | `PluginHealthStates` |
| `session-memory.ts` | `SessionEndReasonSchema` | `SessionEndReason` | `SessionEndReasons` |
| `session-memory.ts` | `JournalEntryTypeSchema` | `JournalEntryType` | `JournalEntryTypes` |
| `session-memory.ts` | `CheckpointReasonSchema` | `CheckpointReason` | `CheckpointReasons` |
| `session-memory.ts` | `KnowledgeScopeSchema` | `KnowledgeScope` | `KnowledgeScopes` |
| `session-memory.ts` | `KnowledgeConfidenceSchema` | `KnowledgeConfidence` | `KnowledgeConfidences` |
| `session-memory.ts` | `KnowledgeDomainSchema` | `KnowledgeDomain` | `KnowledgeDomains` |
| `observer.ts` | `ObservationTypeSchema` | `ObservationTypeValue` | `ObservationTypes` |
| `observer.ts` | `ObservationLevelSchema` | `ObservationLevel` | `ObservationLevels` |
| `observer.ts` | `ObservationStatusSchema` | `ObservationStatus` | `ObservationStatuses` |
| `ephemeral.ts` | `PrioritySourceSchema` | `PrioritySource` | `PrioritySources` |
| `ephemeral.ts` | `PreemptionStatusSchema` | `PreemptionStatus` | `PreemptionStatuses` |
| `notifications.ts` | `NotificationKindSchema` | `NotificationKind` | `NotificationKinds` |

---

## Alternative: `as const` Object Enum

When values don't need Zod validation (not parsed from external input), a plain `as const` object works:

```typescript
// src/core/orchestrator/types.ts
export const Outcomes = {
  completed: "completed",
  review_pending: "review_pending",
  decomposed: "decomposed",
  preempted: "preempted",
  error: "error",
} as const;

export type Outcome = (typeof Outcomes)[keyof typeof Outcomes];
```

**When to use which:**
- **`z.enum()`** — value is parsed from config, DB, API, or any external source
- **`as const`** — value is only constructed internally (discriminated unions, return types)

Another variant uses `as const satisfies` for additional type constraints:

```typescript
// src/schemas/observer.ts
export const ObservationType = {
  AGENT_ITERATION: "agent_iteration",
  LLM_CALL: "llm_call",
  // ...
} as const satisfies Record<string, ObservationTypeValue>;
```

---

## Discriminated Unions

For types with variant shapes (different fields depending on a discriminant), use `z.discriminatedUnion()`:

```typescript
// src/schemas/orchestrator.ts
export const AgentActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("read_file"),
    params: z.object({ path: z.string() }),
    thinking: z.string().optional(),
  }),
  z.object({
    action: z.literal("write_file"),
    params: z.object({ path: z.string(), content: z.string() }),
    thinking: z.string().optional(),
  }),
  // ...more variants
]);
export type AgentAction = z.infer<typeof AgentActionSchema>;
```

TypeScript automatically narrows the `params` type based on `action`:
```typescript
if (action.action === "write_file") {
  // action.params.content is available here
}
```

For discriminated unions built from TypeScript types (not Zod-parsed), use the `as const` pattern:

```typescript
// src/core/orchestrator/types.ts
export type ExecuteTaskResult =
  | { outcome: typeof Outcomes.completed; phaseOutputs: Map<Phase, PhaseOutput> }
  | { outcome: typeof Outcomes.error; phase: Phase; reason: string }
  // ...
```

---

## Typed Const Arrays with `as const satisfies`

For structured constant data that must match a type constraint:

```typescript
// src/schemas/task.ts — State machine transitions
export const ValidTransitions = [
  { from: "intake", to: "queued" },
  { from: "queued", to: "active", to_sub: "working" },
  // ...25 total
] as const satisfies ReadonlyArray<{
  readonly from: TaskState;
  readonly from_sub?: SubState;
  readonly to: TaskState;
  readonly to_sub?: SubState;
}>;
```

This gives you:
- **Compile-time literal types** — `ValidTransitions[0].from` is `"intake"`, not `string`
- **Type safety** — a typo in `from`/`to` values is a compile error
- **Runtime data** — iterable at runtime for validation logic

---

## Lazy Schemas (Circular References)

When schema A references schema B which references schema A:

```typescript
// src/schemas/orchestrator.ts
export const PlanningOutputSchema = z.object({
  approach: z.string(),
  decomposition_plan: z.lazy(() => LLMDecompositionPlanSchema).nullable(),
});
```

Use `z.lazy()` only for genuine circular dependencies. Prefer flattening when possible.

---

## Type-Safe Event Publishing with `satisfies`

Event payloads use `satisfies` to ensure the payload shape matches the event type:

```typescript
eventBus.publish({
  type: EventTypes["task.state_changed"],
  source: "task_engine",
  task_id: taskId,
  payload: { task_id: taskId, from_state, to_state, reason },
} satisfies PublishInput<"task.state_changed">);
```

A typo in the payload fields is a compile error. The `PublishInput<T>` type maps `EventType` to its payload schema.

---

## Runtime Schema Registry

For polymorphic validation (different schemas per event type):

```typescript
// src/schemas/events.ts
export const eventPayloadSchemas: Record<EventType, ZodType> = {
  "task.created": TaskCreatedPayloadSchema,
  "task.state_changed": TaskStateChangedPayloadSchema,
  // ...33 more
};
```

Used by `EventTopology.validatePayload()` to validate event payloads at runtime.

---

## Adding a New Enum

1. Define in the appropriate file in `src/schemas/`
2. Follow the three-part export (schema + type + const enum)
3. Re-export from `src/schemas/index.ts` if needed by other modules
4. Use the const enum everywhere — never raw strings

```typescript
// In src/schemas/yourfile.ts
export const StatusSchema = z.enum(["pending", "active", "done"]);
export type Status = z.infer<typeof StatusSchema>;
export const Statuses = StatusSchema.enum;

// In consuming code
import { Statuses } from "../schemas/yourfile.js";
if (item.status === Statuses.active) { ... }
```

---

## Rules

1. **Schemas are the single source of truth** — types are always `z.infer<typeof XxxSchema>`, never manually written
2. **Never use raw string literals** for values that have a const enum — use `TaskStates.active`, not `"active"`
3. **`z.enum()` for external data**, `as const` for internal-only values
4. **Naming:** `XxxSchema` (schema), `Xxx` (type), `Xxxs` (const enum, plural)
5. **Always export all three parts** when using `z.enum()`
6. **Use `satisfies`** for type-safe object literals (event payloads, const arrays)
7. **Use `z.discriminatedUnion()`** for variant types, not manual union of `z.object()`s
8. **Use `z.lazy()`** only for genuine circular references

---

## File Reference

| File | What's in it |
|------|-------------|
| `src/schemas/task.ts` | TaskState, SubState, ActionClass, ValidTransitions, PermissionTable |
| `src/schemas/events.ts` | EventType, 35+ payload schemas, eventPayloadSchemas registry |
| `src/schemas/orchestrator.ts` | Phase, PhaseOutput schemas, AgentAction discriminated union |
| `src/schemas/config.ts` | DaemonConfig, OrchestratorConfig, SafetyConfig, all subsystem configs |
| `src/schemas/adapters.ts` | AdapterType, adapter contracts, plugin health states |
| `src/schemas/session-memory.ts` | Session, journal, checkpoint, knowledge schemas |
| `src/schemas/ephemeral.ts` | Dispatch, cost accumulators, preemption state |
| `src/schemas/observer.ts` | ObservationType const, observation queries, row mappers |
| `src/core/orchestrator/types.ts` | Outcomes const (executeTask result discriminant) |
