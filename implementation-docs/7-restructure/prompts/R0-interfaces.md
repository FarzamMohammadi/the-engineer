# R0 — Interface Foundation + Zod Enums + Shared Factory

**Wave 1 (Sequential) — Must complete before any Wave 2 phase begins.**

You are implementing a structural restructuring phase for The Engineer, an autonomous software engineering agent. This is a refactoring task: no new features, no behavior changes. Every test that passes before must pass after.

---

## 1. Identity Preamble

Before writing any code, read these files to understand the project's identity and principles:

- `docs/persona.md` — who The Engineer is
- `docs/philosophy.md` — core beliefs driving every decision
- `implementation-docs/0-foundation/philosophy.md` — builder-specific principles

Key takeaways you must internalize:
- Minimalism: small orchestrator, few broad tools, full context visibility
- Modularity: every component follows the registry pattern, everything is swappable
- Say It Once: no repetition, docs are source of truth
- Derive from Proven Systems: OS kernels, CI/CD pipelines, journaling filesystems

---

## 2. Architecture Catchup

Read these docs to understand the architecture:

- `implementation-docs/1-system/architecture-tiers.md` — three-tier model (Core / Adapter / Plugin)
- `implementation-docs/1-system/overview.md` — components + tier classification
- `implementation-docs/2-components/` — all 8 component Layer 2 designs (skim for interface understanding)
- `implementation-docs/3-interactions/adapter-contracts.md` — 5 adapter types + Registry
- `implementation-docs/4-implementation/foundation.md` — tech stack decisions
- `implementation-docs/4-implementation/layout.md` — project layout, config system

---

## 3. Decision Log Review

Read the Layer 7 assessment and decisions:

- `implementation-docs/7-restructure/assessment.md` — problems identified (327+ raw strings, no interfaces, hardcoded plugin registration)
- `implementation-docs/7-restructure/decisions.md` — new decisions (D166+)
- `implementation-docs/decisions.md` — historical decisions for context (skim relevant ones)

Key decisions to be aware of:
- D65-D74: Technology stack (TypeScript, Zod, ESM)
- D75-D89: Data structures and schemas
- D102-D108: Plugin system and adapter implementation
- D143: The Engineer IS the agent; LLMs are inference-only

---

## 4. Current Code Deep-Read

Read ALL of these files before making any changes:

### Schemas (source of Zod enums)
- `src/schemas/task.ts` — TaskStateSchema, SubStateSchema, ActionClassSchema, CascadePolicySchema, and all sub-schemas
- `src/schemas/events.ts` — EventTypeSchema, all payload schemas
- `src/schemas/session-memory.ts` — SessionEndReasonSchema, JournalEntryTypeSchema, CheckpointReasonSchema, KnowledgeScopeSchema, KnowledgeDomainSchema, KnowledgeConfidenceSchema
- `src/schemas/adapters.ts` — AdapterTypeSchema, PluginManifest, adapter-specific types
- `src/schemas/config.ts` — SafetyConfig, AutonomyLevelSchema, all config schemas
- `src/schemas/orchestrator.ts` — PhaseSchema, AgentAction, phase outputs
- `src/schemas/ephemeral.ts` — ephemeral types
- `src/schemas/observability.ts` — observability types
- `src/schemas/index.ts` — barrel export

### Core components (consumers of raw strings)
- `src/core/event-bus/index.ts`
- `src/core/task-engine/index.ts`
- `src/core/safety-layer/index.ts`
- `src/core/action-pipeline/index.ts`
- `src/core/session-memory/index.ts`
- `src/core/registry/index.ts`
- `src/core/workspace-manager/index.ts`
- `src/core/people-directory/index.ts`
- `src/core/daemon/index.ts`
- `src/core/daemon/query-handler.ts`
- `src/core/daemon/logging.ts`
- `src/core/orchestrator/index.ts`
- `src/core/orchestrator/agent-loop.ts`
- `src/core/orchestrator/action-executor.ts`
- `src/core/orchestrator/phase-tools.ts`
- `src/core/orchestrator/prompts/*.ts` (all prompt files)
- `src/core/observability/index.ts`
- `src/core/observability/blob-store.ts`

### Bootstrap and CLI
- `src/cli/bootstrap.ts`
- `src/cli/commands/*.ts` (all command files)

### Adapters
- `src/adapters/base.ts`
- `src/adapters/*.ts` (all adapter files)

### Plugins
- `src/plugins/trigger/github-trigger/index.ts`
- `src/plugins/communication/github-comm/index.ts`
- `src/plugins/communication/telegram-comm/index.ts`
- `src/plugins/git-hosting/github-hosting/index.ts`
- `src/plugins/llm/claude-code-llm/index.ts`
- `src/plugins/tool/bash-tool/index.ts`

### Test helpers
- `test/helpers/mock-factories.ts`
- `test/helpers/test-task-engine.ts`
- `test/helpers/test-safety-layer.ts`
- `test/helpers/test-session-memory.ts`
- `test/helpers/test-event-bus.ts`
- `test/helpers/test-registry.ts`
- `test/helpers/test-orchestrator.ts`
- `test/helpers/test-daemon.ts`
- `test/helpers/integration-context.ts`

### Test files (for all core components — you will update imports)
- `src/core/event-bus/index.test.ts`
- `src/core/task-engine/index.test.ts`
- `src/core/safety-layer/index.test.ts`
- `src/core/action-pipeline/index.test.ts`
- `src/core/session-memory/index.test.ts`
- `src/core/registry/index.test.ts`
- `src/core/workspace-manager/index.test.ts`
- `src/core/daemon/index.test.ts`
- `src/core/orchestrator/index.test.ts`
- All prompt test files in `src/core/orchestrator/prompts/`

---

## 5. Exact Specifications

### 5A. Export Zod Enum Constants from Schemas

In each schema file that defines a `z.enum(...)`, export the `.enum` property as a named constant object. This gives consumers type-safe access to individual enum values without raw string literals.

**Pattern to apply in every schema file with z.enum:**

```typescript
// BEFORE (already exists):
export const TaskStateSchema = z.enum(["intake", "queued", "active", ...]);
export type TaskState = z.infer<typeof TaskStateSchema>;

// ADD after each enum:
/** Constant enum values for TaskState. Use instead of raw strings. */
export const TaskStates = TaskStateSchema.enum;
// Usage: TaskStates.intake, TaskStates.queued, TaskStates.active, etc.
```

Apply this pattern to ALL Zod enums across ALL schema files:

**`src/schemas/task.ts`:**
- `TaskStates` from `TaskStateSchema`
- `SubStates` from `SubStateSchema`
- `CascadePolicies` from `CascadePolicySchema`
- `ActionClasses` from `ActionClassSchema`
- `TeamMemberRoles` from `TeamMemberRoleSchema`
- `RelatedTypes` from `RelatedTypeSchema`

**`src/schemas/events.ts`:**
- `EventTypes` from `EventTypeSchema`

**`src/schemas/session-memory.ts`:**
- `SessionEndReasons` from `SessionEndReasonSchema`
- `JournalEntryTypes` from `JournalEntryTypeSchema`
- `CheckpointReasons` from `CheckpointReasonSchema`
- `KnowledgeScopes` from `KnowledgeScopeSchema`
- `KnowledgeDomains` from `KnowledgeDomainSchema`
- `KnowledgeConfidences` from `KnowledgeConfidenceSchema`

**`src/schemas/config.ts`:**
- `AutonomyLevels` from `AutonomyLevelSchema`

**`src/schemas/adapters.ts`:**
- `AdapterTypes` from `AdapterTypeSchema` (if exists)
- Any other enums in adapters.ts

**`src/schemas/orchestrator.ts`:**
- `Phases` from `PhaseSchema` (or whatever the phase enum is named)
- Any other enums

These constants MUST be re-exported through `src/schemas/index.ts` (they already will be via the `export *` statements, but verify).

### 5B. Create Interface Files

Create `src/core/interfaces/` directory with these files:

**`src/core/interfaces/event-bus.interface.ts`:**
```typescript
import type { Event, EventType, EventPayloads } from "../../schemas/events.js";

export type EventCallback = (event: Event) => void;

export interface PublishInput<T extends EventType> {
  type: T;
  source: string;
  task_id: string | null;
  payload: EventPayloads[T];
}

export interface PublishInputGeneral {
  type: string;
  source: string;
  task_id: string | null;
  payload: Record<string, unknown>;
}

export interface IEventBus {
  publish<T extends EventType>(input: PublishInput<T>): Event;
  publish(input: PublishInputGeneral): Event;
  subscribe(subscriberId: string, pattern: string, callback: EventCallback): void;
  unsubscribe(subscriberId: string, pattern: string): void;
  replay(subscriberId: string, pattern: string, callback: EventCallback): void;
  getEventsForTask(taskId: string): Event[];
  getEventsSince(afterSequence: number): Event[];
}
```

**`src/core/interfaces/task-engine.interface.ts`:**
```typescript
import type { ActionClass, SubState, Task, TaskState, StateTransition } from "../../schemas/task.js";

export interface CreateTaskInput {
  title: string;
  repo: string;
  source: string;
  external_ref?: import("../../schemas/task.js").ExternalRef | null;
  parent_id?: string | null;
  description?: string;
  source_text?: string;
  acceptance_criteria?: string[];
  priority?: number;
  cascade_policy?: import("../../schemas/task.js").CascadePolicy;
  clone_url?: string | null;
}

export interface TransitionResult {
  success: boolean;
  reason?: string;
}

export interface PermissionResult {
  allowed: boolean;
  reason?: string;
  conditional?: string;
}

export type UpdatableField =
  | "phase" | "cascade_policy" | "session_id" | "description" | "source_text"
  | "external_ref" | "workspace" | "review" | "blocked" | "children"
  | "team" | "related" | "decisions" | "child_summaries" | "acceptance_criteria"
  | "priority" | "repo" | "clone_url";

export interface ITaskEngine {
  createTask(input: CreateTaskInput): Task;
  requestTransition(taskId: string, toState: TaskState, toSub: SubState | null, reason: string, triggeredBy: string): TransitionResult;
  checkPermission(taskId: string, actionClass: ActionClass): PermissionResult;
  getTask(id: string): Task | null;
  getTasksByState(state: TaskState): Task[];
  getQueuedByPriority(): Task[];
  getChildren(parentId: string): Task[];
  getStateHistory(taskId: string): StateTransition[];
  updateTaskField(taskId: string, field: UpdatableField, value: unknown): void;
  updateTracking(taskId: string, tokens: number, costUsd: number, computeMs: number): void;
}
```

**`src/core/interfaces/safety-layer.interface.ts`:**
```typescript
import type { ActionClass } from "../../schemas/task.js";
import type { ResponseTimeout, SafetyConfig } from "../../schemas/config.js";

export interface SafetyQuery {
  type: "can_i" | "should_i_ask" | "cost_check";
  context: {
    task_id: string;
    repo: string;
    action_class?: ActionClass;
    decision_category?: string;
    details: Record<string, unknown>;
  };
}

export interface SafetyVerdict {
  allowed: boolean;
  action: "proceed" | "ask_human" | "deny";
  reason: string;
  warnings?: string[];
}

export interface CostStatus {
  per_task_usd: number;
  daily_usd: number;
  monthly_usd: number;
  warnings: string[];
}

export interface ISafetyLayer {
  evaluateAction(taskId: string, actionClass: ActionClass, details: Record<string, unknown>): SafetyVerdict;
  consultJudgment(query: SafetyQuery): SafetyVerdict;
  getCostStatus(taskId?: string): CostStatus;
  getTimeoutPolicy(): ResponseTimeout;
  updateConfig(newConfig: SafetyConfig): void;
  checkAutoMergeAllowed(repo: string): boolean;
}
```

**`src/core/interfaces/session-memory.interface.ts`:**
```typescript
import type {
  Checkpoint, JournalEntry, KnowledgeEntry, KnowledgeScope, Session, SessionEndReason,
} from "../../schemas/session-memory.js";

export interface CreateSessionInput {
  taskId: string;
  previousSessionId?: string | null;
  resumedFromCheckpoint?: string | null;
}

export interface AddJournalEntryInput {
  sessionId: string;
  taskId: string;
  phase: string;
  type: import("../../schemas/session-memory.js").JournalEntryType;
  summary: string;
  detail?: string | null;
  actionType?: string | null;
  findingType?: string | null;
  decisionKey?: string | null;
  errorDetail?: string | null;
  commTarget?: string | null;
  tags?: string[];
}

export interface CreateCheckpointInput {
  sessionId: string;
  taskId: string;
  phase: string;
  phaseProgress: string;
  contextSummary: string;
  keyFindings: string[];
  openQuestions: string[];
  nextAction: string;
  lastEventId: string;
  workspaceRef: { branch: string; last_commit: string } | null;
  reason: import("../../schemas/session-memory.js").CheckpointReason;
  journalOffset: number;
}

export interface StoreKnowledgeInput {
  scope: KnowledgeScope;
  repoScope?: string | null;
  domain: import("../../schemas/session-memory.js").KnowledgeDomain;
  key: string;
  body: string;
  confidence: import("../../schemas/session-memory.js").KnowledgeConfidence;
  evidence: import("../../schemas/session-memory.js").KnowledgeEvidence[];
  sourceTaskId: string;
  sourcePhase: string;
}

export interface JournalQueryFilters {
  type?: import("../../schemas/session-memory.js").JournalEntryType;
  phase?: string;
  tags?: string[];
  since?: string;
}

export interface ISessionMemory {
  createSession(input: CreateSessionInput): Session;
  endSession(id: string, reason: SessionEndReason): void;
  addJournalEntry(input: AddJournalEntryInput): JournalEntry;
  queryJournal(taskId: string, filters?: JournalQueryFilters): JournalEntry[];
  createCheckpoint(input: CreateCheckpointInput): Checkpoint;
  getLatestCheckpoint(taskId: string): Checkpoint | null;
  storeKnowledge(input: StoreKnowledgeInput): KnowledgeEntry;
  getKnowledge(scope: KnowledgeScope, repoScope?: string | null): KnowledgeEntry[];
  supersedeKnowledge(oldId: string, newId: string): void;
  confirmKnowledge(id: string): void;
  getSessionChain(taskId: string): Session[];
}
```

**`src/core/interfaces/action-pipeline.interface.ts`:**
```typescript
import type { ActionClass } from "../../schemas/task.js";

export interface ExecuteInput<T> {
  taskId: string;
  actionClass: ActionClass;
  details: Record<string, unknown>;
  requestedBy: string;
  executeFn: () => T | Promise<T>;
  notifyFn?: (result: T) => void;
}

export type PipelineResult<T> =
  | { outcome: "executed"; result: T }
  | { outcome: "rejected"; gate: "task_engine" | "safety_layer"; reason: string }
  | { outcome: "ask_human"; reason: string; warnings?: string[] }
  | { outcome: "error"; reason: string; error: unknown };

export interface IActionPipeline {
  execute<T>(input: ExecuteInput<T>): Promise<PipelineResult<T>>;
}
```

**`src/core/interfaces/index.ts`** (barrel):
```typescript
// Interface contracts for Core components
export type { IEventBus, EventCallback, PublishInput, PublishInputGeneral } from "./event-bus.interface.js";
export type { ITaskEngine, CreateTaskInput, TransitionResult, PermissionResult, UpdatableField } from "./task-engine.interface.js";
export type { ISafetyLayer, SafetyQuery, SafetyVerdict, CostStatus } from "./safety-layer.interface.js";
export type { ISessionMemory, CreateSessionInput, AddJournalEntryInput, CreateCheckpointInput, StoreKnowledgeInput, JournalQueryFilters } from "./session-memory.interface.js";
export type { IActionPipeline, ExecuteInput, PipelineResult } from "./action-pipeline.interface.js";
```

### 5C. Make Concrete Classes Implement Interfaces

Update each concrete class to implement its interface:

- `EventBus` → `implements IEventBus`
- `TaskEngine` → `implements ITaskEngine`
- `SafetyLayer` → `implements ISafetyLayer`
- `SessionMemory` → `implements ISessionMemory`
- `ActionPipeline` → `implements IActionPipeline`

Each module file should re-export the interface types from its barrel for backward compatibility. For example, in `src/core/task-engine/index.ts`:

```typescript
import type { ITaskEngine } from "../interfaces/task-engine.interface.js";
// ... existing imports ...

// Re-export interface types so existing consumers don't break
export type { CreateTaskInput, TransitionResult, PermissionResult, UpdatableField } from "../interfaces/task-engine.interface.js";

export class TaskEngine implements ITaskEngine {
  // ... (no changes to implementation)
}
```

**Important:** The types that are currently defined in each module file (e.g., `CreateTaskInput` in `task-engine/index.ts`) must be REMOVED from the module file and imported from the interface file instead. The module file re-exports them for backward compatibility.

### 5D. Replace Raw String Literals with Enum Constants

Search the entire `src/` directory for raw string literals that match Zod enum values and replace them with the corresponding constant. This is the bulk of the work.

**Examples of replacements:**

```typescript
// BEFORE:
state: "intake"
// AFTER:
state: TaskStates.intake

// BEFORE:
type: "task.created"
// AFTER:
type: EventTypes["task.created"]

// BEFORE:
type: "action"
// AFTER (in journal context):
type: JournalEntryTypes.action

// BEFORE:
reason: "completed"
// AFTER (in session end context):
reason: SessionEndReasons.completed
```

**Rules for replacement:**
1. Only replace strings that are clearly enum values being used as enum values (not in user-facing messages, not in SQL strings, not in test descriptions).
2. String literals inside `ValidTransitions` and `PermissionTable` in `src/schemas/task.ts` are DEFINING the enum values — leave them as-is (they are the source of truth).
3. String literals in `z.enum([...])` definitions are DEFINING the enum — leave them as-is.
4. String literals in SQL queries stay as-is (e.g., `WHERE state = 'queued'`).
5. String literals in test `describe()`/`it()` descriptions stay as-is.
6. String literals in error messages and log messages stay as-is (they are human-readable).
7. When the enum key contains a dot (like `"task.created"`), use bracket notation: `EventTypes["task.created"]`.

**Files most likely to have raw string references (check all, but prioritize):**
- `src/core/task-engine/index.ts` — `"intake"`, `"queued"`, `"active"`, `"completed"`, `"failed"` in createTask, requestTransition
- `src/core/safety-layer/index.ts` — `"api"`, `"cli"`, `"read"`, `"git_remote"`, `"merge"`, `"write"`, cost event types
- `src/core/action-pipeline/index.ts` — `"read"`, `"action.rejected"`
- `src/core/daemon/index.ts` — many state references, event type references
- `src/core/orchestrator/index.ts` — phase names, state references, event types
- `src/core/orchestrator/agent-loop.ts` — action types
- `src/core/orchestrator/action-executor.ts` — action class references
- `src/core/orchestrator/phase-tools.ts` — action class references
- `src/core/workspace-manager/index.ts` — event types
- `src/core/registry/index.ts` — health event types
- All plugin files — event type and state references

### 5E. Create Shared System Factory

Create `src/core/system.ts`:

```typescript
/**
 * Shared factory for creating the full Core component graph.
 *
 * Used by bootstrap.ts and test helpers to avoid duplicating wiring logic.
 * This is NOT a service locator — it creates and returns a plain object.
 * Components receive their dependencies through constructor injection.
 */
import type Database from "better-sqlite3";

import type { SafetyConfig, WorkspaceConfig } from "../schemas/config.js";
import { ActionPipeline } from "./action-pipeline/index.js";
import { EventBus } from "./event-bus/index.js";
import type { IActionPipeline } from "./interfaces/action-pipeline.interface.js";
import type { IEventBus } from "./interfaces/event-bus.interface.js";
import type { ISafetyLayer } from "./interfaces/safety-layer.interface.js";
import type { ISessionMemory } from "./interfaces/session-memory.interface.js";
import type { ITaskEngine } from "./interfaces/task-engine.interface.js";
import { SafetyLayer } from "./safety-layer/index.js";
import { SessionMemory } from "./session-memory/index.js";
import { TaskEngine } from "./task-engine/index.js";
import { WorkspaceManager } from "./workspace-manager/index.js";

export interface CoreComponents {
  eventBus: IEventBus;
  taskEngine: ITaskEngine;
  safetyLayer: ISafetyLayer;
  actionPipeline: IActionPipeline;
  sessionMemory: ISessionMemory;
  workspaceManager: WorkspaceManager;
}

export interface CreateCoreInput {
  db: Database.Database;
  safetyConfig: SafetyConfig;
  workspaceConfig: WorkspaceConfig;
}

/**
 * Create all Core components with proper dependency wiring.
 * Does NOT create Registry, Orchestrator, Daemon, or PeopleDirectory —
 * those have additional dependencies (config, logger, etc.).
 */
export function createCoreComponents(input: CreateCoreInput): CoreComponents {
  const eventBus = new EventBus(input.db);
  const taskEngine = new TaskEngine(input.db, eventBus);
  const safetyLayer = new SafetyLayer(input.db, eventBus, input.safetyConfig);
  const actionPipeline = new ActionPipeline(taskEngine, safetyLayer, eventBus);
  const sessionMemory = new SessionMemory(input.db);
  const workspaceManager = new WorkspaceManager(eventBus, input.workspaceConfig);

  return { eventBus, taskEngine, safetyLayer, actionPipeline, sessionMemory, workspaceManager };
}
```

### 5F. Update bootstrap.ts to Use Shared Factory

Update `src/cli/bootstrap.ts` to use `createCoreComponents()` for steps 3-9 (EventBus through WorkspaceManager). The remaining components (Registry, PeopleDirectory, Observability, Orchestrator, Daemon) are wired after since they have additional dependencies.

---

## 6. Refinement Checklist

Before considering this phase complete, verify:

- [ ] Every `z.enum(...)` in `src/schemas/` has a corresponding exported `XxxValues` or `Xxxs` constant
- [ ] All constants are accessible through `src/schemas/index.ts` barrel
- [ ] Every interface file has correct imports and all methods match the concrete class
- [ ] Every concrete class has `implements IXxx` and it compiles
- [ ] Type exports are re-exported from module barrels (backward compatibility)
- [ ] Raw string replacements do NOT touch: enum definitions, SQL strings, test descriptions, error messages
- [ ] `src/core/system.ts` compiles and the types are correct
- [ ] `src/cli/bootstrap.ts` still works with the shared factory
- [ ] No circular imports introduced (interfaces depend only on schemas, not on implementations)

---

## 7. Verification Steps

Run these commands and ensure they all pass:

```bash
# Type checking — must have zero errors
npx tsc --noEmit

# All tests must pass — no regressions
pnpm test

# Lint — must have zero errors
pnpm lint

# Verify no circular imports (interfaces should not import implementations)
# Manually check: src/core/interfaces/*.ts should only import from ../../schemas/
```

---

## 8. Commit Instructions

Create a single commit with conventional commit format:

```
refactor(core): extract interfaces, export Zod enum constants, add shared system factory

- Create src/core/interfaces/ with IEventBus, ITaskEngine, ISafetyLayer,
  ISessionMemory, IActionPipeline contracts
- Export Zod enum constants (TaskStates, EventTypes, etc.) from all schema files
- Replace 327+ raw string literals with type-safe enum constants
- Add src/core/system.ts shared factory for Core component creation
- Update bootstrap.ts to use shared factory
- All concrete classes implement their interfaces
- Re-export types from module barrels for backward compatibility

Part of Layer 7 structural restructuring (Phase R0).
```
