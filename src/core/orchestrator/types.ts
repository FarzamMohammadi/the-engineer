import type { Phase, PhaseOutput } from "../../schemas/orchestrator.js";
import type { IActionPipeline } from "../interfaces/action-pipeline.interface.js";
import type { IEventBus } from "../interfaces/event-bus.interface.js";
import type { ISafetyLayer } from "../interfaces/safety-layer.interface.js";
import type { ISessionMemory } from "../interfaces/session-memory.interface.js";
import type { ITaskEngine } from "../interfaces/task-engine.interface.js";
import type { IWorkspaceManager } from "../interfaces/workspace-manager.interface.js";
import type { ObservabilityStore } from "../observability/index.js";
import type { IObserver } from "../observer/types.js";
import type { PeopleDirectory } from "../people-directory/index.js";
import type { Registry } from "../registry/index.js";

// ── Shared Dependencies ────────────────────────────────────────────────────

/** Shared dependencies available to all Orchestrator subsystems. */
export interface OrchestratorContext {
  eventBus: IEventBus;
  registry: Registry;
  taskEngine: ITaskEngine;
  safetyLayer: ISafetyLayer;
  actionPipeline: IActionPipeline;
  sessionMemory: ISessionMemory;
  workspaceManager: IWorkspaceManager;
  peopleDirectory: PeopleDirectory;
  observability: ObservabilityStore | null;
  observer: IObserver | null;
}

// ── Per-Execution State ────────────────────────────────────────────────────

/** Per-execution state — scoped to a single executeTask() call, not the class. */
export interface PipelineState {
  traceId: string;
  sessionId: string;
  loopbackCount: number;
}

// ── Process Phase Result ───────────────────────────────────────────────────

/** Discriminated union of executeTask outcomes. */
export type ExecuteTaskResult =
  | { outcome: "completed"; phaseOutputs: Map<Phase, PhaseOutput> }
  | { outcome: "review_pending"; phase: Phase; phaseOutputs: Map<Phase, PhaseOutput> }
  | { outcome: "decomposed"; childTaskIds: string[]; phaseOutputs: Map<Phase, PhaseOutput> }
  | { outcome: "preempted"; lastPhase: Phase; checkpointId: string }
  | { outcome: "error"; phase: Phase; reason: string };

/** Return type of processPhaseCompletion. */
export interface ProcessPhaseResult {
  phases: Phase[];
  loopbackIndex: number | null;
  preemptionResult: ExecuteTaskResult | null;
  decompositionResult: ExecuteTaskResult | null;
  reviewPendingResult: ExecuteTaskResult | null;
}
